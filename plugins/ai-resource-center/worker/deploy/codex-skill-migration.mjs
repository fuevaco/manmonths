// 與 LC-AI-Pack 的 CodexSkillMigration 共用收據、備份路徑與操作紀錄。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareVersions } from '../package-service.mjs';
import { isUnsafeRelativePath } from '../path-safety.mjs';
import { createOperationStore } from '../setup/operations.mjs';
import { parseManifest } from '../manifest-validator.mjs';
import { openCanonicalPackage } from './canonical-package.mjs';
import { createPathRules } from './canonical-root.mjs';
import { ofTree, ordinal } from './digest.mjs';
import { HostProfiles } from './host-profiles.mjs';
import { ReceiptStore, ownershipAddress, targetKeyOf } from './receipts.mjs';
import { tryAcquireTargetLock } from './target-lock.mjs';
import { createSkillBackup, newBackupStamp } from './target-transaction.mjs';

const host = HostProfiles.defaultSelection('codex');
const rules = createPathRules();
const lex = createPathRules({ resolveLinks: false }).normalize;
const safeId = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
function legacy(r) {
  return r.hostId === host.hostId && r.surfaceId === host.surfaceId && r.scope === 'global' &&
    r.kind === 'skill' && r.mutationKind === 'SyncTree' && safeId.test(r.contentId) &&
    path.isAbsolute(r.canonicalRoot) && path.isAbsolute(r.destinationPath) &&
    lex(r.destinationPath) === lex(path.join(r.canonicalRoot, 'skills', r.contentId)) &&
    r.normalizedAddress === ownershipAddress(rules, host, 'global', r.canonicalRoot, r.contentId);
}

function tree(dir) {
  let root;
  try { root = fs.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('技能項目不是一般目錄，已保留原檔。');
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push({ relativePath: path.relative(dir, full).replaceAll('\\', '/'), content: fs.readFileSync(full) });
      else throw new Error('技能內含連結或特殊檔案，已保留原檔。');
    }
  }
  visit(dir);
  return { files, hash: ofTree(files) };
}

function checkedBackup(dir, snapshot, options, result, note) {
  const backup = createSkillBackup(dir, newBackupStamp(), options);
  if (tree(backup)?.hash !== snapshot.hash || tree(dir)?.hash !== snapshot.hash) throw new Error('備份期間內容已變更。');
  result.backups.push(backup);
  note('備份 ' + backup);
}

async function recover(receipt, { home, downloads }) {
  if (receipt.source === 'local' && path.isAbsolute(receipt.sourcePath ?? '')) {
    const manifest = parseManifest(fs.readFileSync(path.join(receipt.sourcePath, 'lcpack.json'), 'utf8'));
    const item = manifest.contents?.find(c => c.kind === 'skill' && c.id === receipt.contentId);
    if (manifest.key === receipt.packageKey && manifest.version === receipt.packageVersion && item?.path && !isUnsafeRelativePath(item.path))
      return tree(path.join(receipt.sourcePath, item.path))?.files;
    return null;
  }
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(receipt.packageKey) || !/^[a-z0-9][a-z0-9._-]*$/i.test(receipt.packageVersion) ||
      !/^[a-f0-9]{64}$/i.test(receipt.packageSha256)) return null;
  const zip = receipt.packageSha256.toLowerCase() + '.zip';
  const paths = [path.join(home, 'cache', 'packages', receipt.packageKey, receipt.packageVersion, zip)];
  if (downloads?.dataDirectory) paths.push(path.join(downloads.dataDirectory, 'cache', receipt.packageKey, receipt.packageVersion, zip));
  function unpack(bytes) {
    const pkg = openCanonicalPackage({ bytes, expectedSha256: receipt.packageSha256 });
    const item = pkg.contents.find(c => c.id === receipt.contentId && c.kind === 'skill');
    return pkg.identity.key === receipt.packageKey && pkg.identity.version === receipt.packageVersion && item ? pkg.readTree(item.sourcePath) : null;
  }
  for (const file of paths) {
    if (fs.existsSync(file)) {
      try { return unpack(fs.readFileSync(file)); } catch { /* 再試另一個快取或精確版本下載。 */ }
    }
  }
  if (!downloads) return null;
  try {
    const artifact = await downloads.fetchVerified({ packageKey: receipt.packageKey, version: receipt.packageVersion, previewMode: receipt.channel === 'preview' });
    return unpack(artifact.bytes);
  } catch {
    // 市集回傳的錯誤內文不進入操作紀錄或通知。
    throw new Error('無法從市集取得 ' + receipt.packageVersion + ' 版技能內容。');
  }
}

function physical(p) {
  try { return lex(fs.realpathSync(p)); }
  catch (e) {
    if (!['ENOENT','ENOTDIR'].includes(e.code)) throw e;
    const parent = path.dirname(p);
    return parent === p ? lex(p) : lex(path.join(physical(parent), path.basename(p)));
  }
}
function foreignOwner(receipts, group, destination, userHome) {
  const first = group[0], address = ownershipAddress(rules, host, 'global', userHome, first.contentId);
  const paths = new Set([physical(destination), ...group.map(r => physical(r.destinationPath))]);
  return receipts.find(r => !group.includes(r) &&
    !(r.normalizedAddress === address && r.packageKey === first.packageKey && r.kind === 'skill' &&
      r.scope === 'global' && r.contentId === first.contentId && physical(r.destinationPath) === physical(destination)) &&
    (r.normalizedAddress === address || (path.isAbsolute(r.destinationPath) && paths.has(physical(r.destinationPath)))));
}

function publish(destination, currentHash, files, expected) {
  const work = path.join(path.dirname(destination), '.lcaipack-migrate-' + randomUUID());
  const stage = path.join(work, 'new'), previous = path.join(work, 'previous');
  fs.mkdirSync(stage, { recursive: true });
  try {
    for (const f of files) {
      if (isUnsafeRelativePath(f.relativePath)) throw new Error('技能內含無效的檔案路徑。');
      const full = path.join(stage, f.relativePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content, { flag: 'wx' });
    }
    if (tree(stage)?.hash !== expected || tree(destination)?.hash !== currentHash) throw new Error('共用技能在遷移期間已變更。');
    if (currentHash) fs.renameSync(destination, previous);
    try { fs.renameSync(stage, destination); }
    catch (e) { if (fs.existsSync(previous)) fs.renameSync(previous, destination); throw e; }
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true });
  } finally {
    if (!fs.existsSync(previous)) fs.rmSync(work, { recursive: true });
  }
}

async function migrateGroup(group, receipts, options, store, result, note) {
  const { userHome } = options, id = group[0].contentId;
  const destination = path.join(userHome, '.agents', 'skills', id);
  const address = ownershipAddress(rules, host, 'global', userHome, id);
  const shared = receipts.find(r => r.normalizedAddress === address && r.packageKey === group[0].packageKey);
  const candidates = [...group, ...(shared ? [shared] : [])].sort((a, b) => compareVersions(b.packageVersion, a.packageVersion) || ordinal(a.normalizedAddress, b.normalizedAddress));
  const best = candidates[0], expected = best.installedSha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('收據缺少技能雜湊。');
  const current = tree(destination);
  const copies = group.map(r => ({ receipt: r, snapshot: tree(r.destinationPath) }));
  let files = [current, ...copies.map(c => c.snapshot)].find(c => c?.hash === expected)?.files;
  if (!files) files = await recover(best, options);
  if (!files || ofTree(files) !== expected) throw new Error('找不到可驗證的 ' + best.packageVersion + ' 版技能內容。');
  if (current && (!shared || current.hash !== shared.installedSha256.toLowerCase())) checkedBackup(destination, current, options, result, note);
  if (current?.hash !== expected) publish(destination, current?.hash, files, expected);
  if (tree(destination)?.hash !== expected) throw new Error('共用技能驗證失敗。');
  // 先持久化可驗證的共用收據，再逐一清除舊副本。任意中斷後仍可依磁碟狀態接續。
  store.upsert([{ ...best, canonicalRoot: store.canonicalRoot, destinationPath: destination, normalizedAddress: address, hostProfileVersion: HostProfiles.find('codex').version }]);
  const physical = lex(fs.realpathSync(destination));
  for (const { receipt: r, snapshot } of copies) {
    if (!snapshot || lex(fs.realpathSync(r.destinationPath)) === physical) continue;
    if (snapshot.hash !== r.installedSha256.toLowerCase()) checkedBackup(r.destinationPath, snapshot, options, result, note);
    if (tree(r.destinationPath)?.hash !== snapshot.hash) throw new Error('舊技能在遷移期間已變更。');
    fs.rmSync(r.destinationPath, { recursive: true });
  }
  store.removeAddresses(group.map(r => r.normalizedAddress).filter(a => a !== address));
  note('已遷移 ' + id + ' ' + best.packageVersion);
}

async function acquireMigrationLock(home) {
  const directory = path.join(home, 'locks', 'codex-skill-migration');
  fs.mkdirSync(directory, { recursive: true });
  const mine = process.pid + '-' + randomUUID().replaceAll('-', '') + '.claim';
  const file = path.join(directory, mine);
  function live(name) {
    const pid = /^(\d+)-[a-f0-9]{32}\.claim$/.exec(name)?.[1];
    if (!pid || name === mine) return false;
    try { process.kill(Number(pid), 0); return true; }
    catch (e) { return e.code !== 'ESRCH'; }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    fs.writeFileSync(file, '', { flag: 'wx' });
    try { if (!fs.readdirSync(directory).some(live)) return () => fs.unlinkSync(file); }
    catch (e) { fs.unlinkSync(file); throw e; }
    fs.unlinkSync(file);
    await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 75));
  }
  throw new Error('另一個用戶端正在遷移 Codex 技能。');
}

export async function migrateCodexSkills(options) {
  const { home, userHome } = options, store = ReceiptStore.forGlobal({ home, userProfile: userHome });
  const result = { migrated: 0, blocked: [], backups: [] };
  const old = store.load().receipts.filter(legacy);
  if (!old.length) return result;
  const release = await acquireMigrationLock(home);
  try { await migratePackages(options, store, old, result); }
  finally { release(); }
  return result;
}

async function migratePackages(options, store, old, result) {
  const { home, userHome } = options;
  const ops = createOperationStore({ home });
  for (const key of new Set(old.map(r => r.packageKey))) {
    const locks = [], sharedKey = 'codex|codex-cli|global|' + store.canonicalRoot;
    let op;
    try {
      const keys = new Set([sharedKey, ...old.filter(r => r.packageKey === key).map(targetKeyOf)]);
      for (const k of [...keys].sort(ordinal)) {
        const lock = tryAcquireTargetLock(path.join(home, 'locks'), k, 1000);
        if (!lock) throw new Error('部署目標正在使用中。');
        locks.push(lock);
      }
      const receipts = store.load().receipts, rows = receipts.filter(r => r.packageKey === key && legacy(r));
      if (!rows.length) continue;
      if (rows.some(r => !keys.has(targetKeyOf(r)))) throw new Error('部署目標已變更，將於下次啟動接續。');
      const groups = Map.groupBy(rows, r => r.contentId);
      const version = rows.map(r => r.packageVersion).sort((a,b) => compareVersions(b,a))[0];
      op = ops.create({ kind: 'migrate', packageKey: key, packageVersion: version, scope: 'global', checkpoint: 'codex-skills' });
      const note = message => fs.appendFileSync(op.logPath, message + '\n');
      for (const [id, group] of groups) {
        const owner = foreignOwner(receipts, group, path.join(userHome, '.agents', 'skills', id), userHome);
        if (owner) throw new Error(id + ' 已由 ' + owner.packageKey + ' 擁有。');
      }
      for (const group of groups.values()) {
        await migrateGroup(group, receipts, options, store, result, note);
        result.migrated++;
      }
      ops.transition(op.operationId, 'succeeded', 'codex-skills');
    } catch (e) {
      const reason = key + '：' + e.message;
      result.blocked.push(reason);
      if (op) { fs.appendFileSync(op.logPath, reason + '\n'); ops.transition(op.operationId, 'failed', 'codex-skills', reason); }
    } finally { for (const lock of locks.reverse()) lock.release(); }
  }
}
