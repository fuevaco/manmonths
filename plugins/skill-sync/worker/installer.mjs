// 把已驗證的 skill 寫進目標資料夾，行為對齊 Orca 原生的技能安裝：
//   - 實體檔案放在共用資料夾 <目標>/.agents/skills/<name>/
//   - 再連結（Windows 用 junction，免管理員權限）到「目標已經有的」Agent 資料夾，例如 .claude/skills/<name>
//   - 你自己改過的副本預設不覆蓋；強制取代前會先備份
//   - 寫入先在同磁碟的暫存資料夾完成，再整個換上去；中途失敗不會留下半套檔案
//
// 本檔不依賴 Orca API，目標路徑與已安裝紀錄（record）都由呼叫端傳入，方便單獨測試。

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { NAME_RE, computeDigest, sha256Hex } from './spec.mjs';

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export const canonicalRoot = (base) => path.join(base, '.agents', 'skills');
export const skillDir = (base, name) => path.join(canonicalRoot(base), name);

function assertName(name) {
  if (!NAME_RE.test(String(name))) throw new Error(`不合法的 skill 名稱：${name}`);
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, prefix = '') {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (IGNORED_FILES.has(ent.name)) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(abs, rel)));
    else if (ent.isFile()) out.push({ path: rel, abs });
  }
  return out;
}

// 讀取資料夾內容並算出與遠端相同算法的摘要；資料夾不存在回 null
export async function hashDir(dir) {
  let list;
  try {
    list = await walk(dir);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
  const files = {};
  for (const f of list) files[f.path] = sha256Hex(await fs.readFile(f.abs));
  return { files, digest: computeDigest(Object.entries(files).map(([p, sha256]) => ({ path: p, sha256 }))) };
}

const sameFiles = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b || {}).length && ka.every((k) => a[k] === (b || {})[k]);
};

/**
 * 目前狀態：
 *  absent   目標沒有這個 skill
 *  current  內容與遠端完全相同
 *  update   由本外掛安裝、未被改過，遠端有新版
 *  modified 由本外掛安裝，但安裝後被改過
 *  foreign  已有同名資料夾，不是本外掛安裝的（可能是你自己寫的，或 Orca 原生安裝的）
 */
export function classify(local, record, remoteDigest) {
  if (!local) return 'absent';
  if (local.digest === remoteDigest) return 'current';
  if (!record) return 'foreign';
  return sameFiles(local.files, record.files) ? 'update' : 'modified';
}

export async function inspectSkill({ base, name, record, remoteDigest }) {
  assertName(name);
  const local = await hashDir(skillDir(base, name));
  return { state: classify(local, record, remoteDigest), local };
}

// ---------- 備份 ----------

export function backupRoot(homeDir = os.homedir()) {
  return path.join(homeDir, '.agents', '.skill-sync-backups');
}

async function backupDir(dir, name, homeDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupRoot(homeDir), `${stamp}-${name}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(dir, dest, { recursive: true });
  return dest;
}

// ---------- 連結到各 Agent 資料夾 ----------

function normalizeLinkDir(dir) {
  const d = String(dir || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!d || d.startsWith('/') || /^[A-Za-z]:/.test(d) || d.split('/').includes('..')) return null;
  if (d === '.agents/skills') return null; // 就是共用資料夾本身
  return d;
}

const same = async (a, b) => {
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b));
  } catch {
    return false;
  }
};

async function ensureLinks({ base, name, dir, linkDirs, previousLinks = [], previousFiles }) {
  const results = [];
  for (const raw of linkDirs) {
    const linkDir = normalizeLinkDir(raw);
    if (!linkDir) {
      if (String(raw || '').trim()) results.push({ dir: String(raw), mode: 'skipped', reason: 'invalid-dir' });
      continue;
    }
    const linkRoot = path.join(base, ...linkDir.split('/'));
    // 與 Orca 相同：只連結到「已經存在的」Agent 資料夾（.claude、.codex…），不替沒在用的 Agent 建資料夾
    if (!existsSync(path.dirname(linkRoot))) {
      results.push({ dir: linkDir, mode: 'skipped', reason: 'agent-dir-missing' });
      continue;
    }
    await fs.mkdir(linkRoot, { recursive: true });
    const linkPath = path.join(linkRoot, name);
    const st = await fs.lstat(linkPath).catch(() => null);
    if (!st) {
      try {
        await fs.symlink(dir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
        results.push({ dir: linkDir, mode: 'link' });
      } catch {
        await fs.cp(dir, linkPath, { recursive: true });
        results.push({ dir: linkDir, mode: 'copy' });
      }
    } else if (st.isSymbolicLink()) {
      results.push((await same(linkPath, dir)) ? { dir: linkDir, mode: 'link' } : { dir: linkDir, mode: 'conflict', reason: 'points-elsewhere' });
    } else if (st.isDirectory()) {
      // 先前由我們複製過去的副本（無法建立連結時的退路）：內容沒被改過才更新
      const prev = previousLinks.find((l) => l.dir === linkDir && l.mode === 'copy');
      const cur = prev && previousFiles ? await hashDir(linkPath) : null;
      if (prev && cur && sameFiles(cur.files, previousFiles)) {
        await fs.rm(linkPath, { recursive: true, force: true });
        await fs.cp(dir, linkPath, { recursive: true });
        results.push({ dir: linkDir, mode: 'copy' });
      } else {
        results.push({ dir: linkDir, mode: 'conflict', reason: 'exists' });
      }
    } else {
      results.push({ dir: linkDir, mode: 'conflict', reason: 'exists' });
    }
  }
  return results;
}

async function removeLinks({ base, name, dir, links = [], recordFiles }) {
  const out = [];
  for (const l of links) {
    const linkDir = normalizeLinkDir(l.dir);
    if (!linkDir) continue;
    const linkPath = path.join(base, ...linkDir.split('/'), name);
    const st = await fs.lstat(linkPath).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink() && (await same(linkPath, dir))) {
      await fs.unlink(linkPath);
      out.push({ dir: linkDir, removed: true });
    } else if (st.isDirectory() && l.mode === 'copy') {
      const cur = await hashDir(linkPath);
      if (cur && recordFiles && sameFiles(cur.files, recordFiles)) {
        await fs.rm(linkPath, { recursive: true, force: true });
        out.push({ dir: linkDir, removed: true });
      } else out.push({ dir: linkDir, removed: false, reason: 'modified' });
    } else {
      out.push({ dir: linkDir, removed: false, reason: 'not-ours' });
    }
  }
  return out;
}

// ---------- 安裝 / 移除 ----------

async function writeStaging(root, name, files) {
  const staging = path.join(root, `.skill-sync-tmp-${name}-${randomBytes(4).toString('hex')}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const f of files) {
      const abs = path.join(staging, ...f.path.split('/'));
      // 縱深防禦：spec 已拒絕 .. 與絕對路徑，這裡再確認一次沒有寫出暫存資料夾
      if (!abs.startsWith(staging + path.sep)) throw new Error(`不安全的路徑：${f.path}`);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.bytes);
      if (f.executable && process.platform !== 'win32') await fs.chmod(abs, 0o755);
    }
  } catch (e) {
    await fs.rm(staging, { recursive: true, force: true });
    throw e;
  }
  return staging;
}

/**
 * @returns {{action:'installed'|'updated'|'unchanged'|'adopted'|'skipped', reason?:string, record?:object, links:object[], backup?:string}}
 */
export async function installSkill({ base, name, version, digest, files, linkDirs = [], record, force = false, homeDir = os.homedir() }) {
  assertName(name);
  const dir = skillDir(base, name);
  const { state, local } = await inspectSkill({ base, name, record, remoteDigest: digest });

  if ((state === 'modified' || state === 'foreign') && !force) {
    return { action: 'skipped', reason: state, links: [] };
  }

  const filesMap = Object.fromEntries(files.map((f) => [f.path, sha256Hex(f.bytes)]));
  const makeRecord = (links) => ({
    name,
    version,
    digest,
    files: filesMap,
    installedAt: new Date().toISOString(),
    links
  });

  if (state === 'current') {
    const links = await ensureLinks({ base, name, dir, linkDirs, previousLinks: record?.links, previousFiles: record?.files });
    return { action: record ? 'unchanged' : 'adopted', record: makeRecord(links), links };
  }

  const root = canonicalRoot(base);
  await fs.mkdir(root, { recursive: true });
  const staging = await writeStaging(root, name, files);
  let backup;
  try {
    if (local) {
      if (state === 'modified' || state === 'foreign') backup = await backupDir(dir, name, homeDir);
      const old = `${dir}.old-${randomBytes(4).toString('hex')}`;
      await fs.rename(dir, old);
      try {
        await fs.rename(staging, dir);
      } catch (e) {
        await fs.rename(old, dir).catch(() => {});
        throw e;
      }
      await fs.rm(old, { recursive: true, force: true });
    } else {
      await fs.rename(staging, dir);
    }
  } catch (e) {
    await fs.rm(staging, { recursive: true, force: true });
    throw e;
  }
  const links = await ensureLinks({ base, name, dir, linkDirs, previousLinks: record?.links, previousFiles: record?.files });
  return {
    action: state === 'absent' ? 'installed' : 'updated',
    record: makeRecord(links),
    links,
    ...(backup ? { backup } : {})
  };
}

export async function removeSkill({ base, name, record, force = false, homeDir = os.homedir() }) {
  assertName(name);
  const dir = skillDir(base, name);
  const local = await hashDir(dir);
  if (!local) {
    const links = await removeLinks({ base, name, dir, links: record?.links, recordFiles: record?.files });
    return { action: 'removed', note: 'missing', links };
  }
  const pristine = record && sameFiles(local.files, record.files);
  if (!pristine && !force) return { action: 'skipped', reason: record ? 'modified' : 'foreign', links: [] };
  const links = await removeLinks({ base, name, dir, links: record?.links, recordFiles: record?.files });
  const backup = pristine ? undefined : await backupDir(dir, name, homeDir);
  await fs.rm(dir, { recursive: true, force: true });
  return { action: 'removed', links, ...(backup ? { backup } : {}) };
}

// ---------- Git 排除 ----------

function runGit(args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 5000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

// 寫入該 repo 的 .git/info/exclude（不動 .gitignore，也不會被 commit），
// 避免同步進來的 skill 讓每個專案的 git status 都多出一堆未追蹤檔案。
export async function ensureGitExclude(base, name, linkDirs = []) {
  const rel = await runGit(['rev-parse', '--git-path', 'info/exclude'], base);
  if (!rel) return false; // 不是 git 專案
  const file = path.resolve(base, rel);
  const patterns = [`/.agents/skills/${name}`];
  for (const raw of linkDirs) {
    const d = normalizeLinkDir(raw);
    if (d) patterns.push(`/${d}/${name}`);
  }
  try {
    const current = existsSync(file) ? await fs.readFile(file, 'utf8') : '';
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const add = patterns.filter((p) => !have.has(p));
    if (!add.length) return true;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    await fs.appendFile(file, `${sep}${add.join('\n')}\n`);
    return true;
  } catch {
    return false;
  }
}
