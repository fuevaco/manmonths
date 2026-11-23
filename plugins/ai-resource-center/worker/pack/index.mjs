import fs from 'node:fs/promises';
import path from 'node:path';
import { parseManifest, collectManifestProblems } from '../manifest-validator.mjs';
import { inspectSkill } from '../deploy/canonical-package.mjs';
import { ordinal } from '../deploy/digest.mjs';
import { isUnsafeRelativePath } from '../path-safety.mjs';
import { zipChunks } from './zip.mjs';
export { buildPackageZip } from './zip.mjs';

const denied = /\.(exe|dll|msi|bat|cmd|com|scr|ps1xml|zip|7z|rar)$/i;
const excluded = p => p.split('/').some(s => ['.git', 'node_modules'].includes(s.toLowerCase()));
const normalize = p => p.replaceAll('\\', '/').split('/').filter(s => s && s !== '.').join('/') || '.';
const array = v => Array.isArray(v) ? v : [];
const safe = p => typeof p === 'string' && p.trim() && !isUnsafeRelativePath(p);
const invalid = 'deployment.invalid-package';
export const MAX_PACKAGE_ZIP_BYTES = 100 * 1024 * 1024;

/** 唯讀來源預檢。blocking 全部收集；只有無法讀取的分支會停止走訪。 */
export async function inspectSourceFolder(folder, { mode } = {}) {
  if (!['install', 'upload'].includes(mode)) throw new TypeError('mode 必須為 install 或 upload');
  const blocking = [], disclosures = [], selected = new Map(), links = new Set();
  const add = (code, message, relative) => blocking.push({ code, message, ...(relative ? { path: relative } : {}) });
  let manifest = null, source;
  try { source = await fs.readFile(path.join(folder, 'lcpack.json'), 'utf8'); }
  catch { add(invalid, '來源資料夾找不到或無法讀取 lcpack.json', 'lcpack.json'); }
  if (source !== undefined) {
    let parsed = false;
    try { manifest = parseManifest(source); parsed = true; }
    catch { add(invalid, 'lcpack.json 不是有效的 JSON', 'lcpack.json'); }
    if (parsed) blocking.push(...collectManifestProblems(manifest));
    if (mode === 'upload') {
      try { JSON.parse(source.replace(/^\uFEFF/, '')); }
      catch { add(invalid, 'lcpack.json 必須是嚴格 JSON，不可有註解或尾逗號', 'lcpack.json'); }
      if (typeof manifest?.version === 'string' && manifest.version.includes('-')) add(invalid,
        `lcpack.json 的 version（${manifest.version}）不得帶前置發行後綴；前置發行請改用 Preview 通道表達`, 'lcpack.json');
    }
  }
  async function walk(relative, owner, ancestors = new Set(), recursive = true) {
    if (!safe(relative)) return;
    relative = normalize(relative);
    if (excluded(relative)) return;
    const full = path.join(folder, relative);
    try {
      if (mode === 'upload') {
        const segments = relative.split('/');
        for (let i = 1; i < segments.length; i++) {
          const parent = segments.slice(0, i).join('/');
          if ((await fs.lstat(path.join(folder, parent))).isSymbolicLink()) {
            if (!links.has(parent)) add(invalid, `資源包不得包含 symlink／reparse point：${parent}`, parent);
            links.add(parent); return;
          }
        }
      }
      const link = await fs.lstat(full);
      const stat = link.isSymbolicLink() ? await fs.stat(full) : link;
      if (stat.isDirectory() && !recursive) return;
      if (link.isSymbolicLink()) {
        links.add(relative);
        if (mode === 'upload') { add(invalid, `資源包不得包含 symlink／reparse point：${relative}`, relative); return; }
      }
      if (stat.isDirectory()) {
        if (!recursive) return;
        const real = await fs.realpath(full);
        if (ancestors.has(real)) return; // 本機模式允許連結，但不跟隨循環。
        const next = new Set([...ancestors, real]);
        for (const name of (await fs.readdir(full)).sort(ordinal)) await walk(`${relative}/${name}`, owner, next);
      } else if (stat.isFile()) {
        if (denied.test(relative)) add(invalid, `不允許可直接執行或封裝格式的檔案：${relative}（${path.posix.extname(relative)}）`, relative);
        if (!selected.has(relative.toLowerCase())) selected.set(relative.toLowerCase(), relative);
      }
    } catch { add(invalid, `${owner} 宣告的路徑不存在或無法讀取：${relative}`, relative); }
  }
  let rootNames = [];
  try { rootNames = (await fs.readdir(folder)).sort(ordinal); }
  catch { add(invalid, '來源資料夾不存在或無法讀取'); }
  for (const name of rootNames) await walk(name, '根目錄', new Set(), false);
  const readme = rootNames.find(n => n.toLowerCase() === 'readme.md' && selected.has(n.toLowerCase()));
  if (!readme) add(invalid, '根目錄缺少 README.md（前台說明書，必備）', 'README.md');
  else if (readme !== 'README.md') add(invalid, `README 檔名必須是大寫 README.md（目前為 ${readme}；大小寫敏感的檔案系統會踩雷）`, readme);
  for (const c of array(manifest?.contents)) {
    if (!c || c.kind === 'mcp' || !safe(c.path)) continue;
    await walk(c.path, `contents '${c.id}'`);
    if (c.kind !== 'skill' || (mode === 'upload' && [...links].some(p => normalize(c.path) === p || normalize(c.path).startsWith(p + '/')))) continue;
    const directory = path.join(folder, normalize(c.path));
    const entryPath = normalize(`${normalize(c.path)}/SKILL.md`);
    try {
      const actual = (await fs.readdir(directory)).find(n => n.toLowerCase() === 'skill.md');
      if (!actual) add(invalid, `contents '${c.id}'：Skill 目錄缺少 SKILL.md：${c.path}`, entryPath);
      else if (actual !== 'SKILL.md') add(invalid, `contents '${c.id}'：SKILL.md 檔名必須全大寫（目前為 ${actual}）`, `${normalize(c.path)}/${actual}`);
      else if (!(mode === 'upload' && links.has(entryPath))) {
        const profile = inspectSkill(await fs.readFile(path.join(directory, actual), 'utf8'));
        for (const error of profile.errors) add(invalid, `contents '${c.id}'：${error}`, entryPath);
        if (!profile.errors.length && profile.nonStandardKeys.length) disclosures.push({ code: 'deployment.non-standard-content-fields',
          message: `contents '${c.id}' 的 SKILL.md 使用非標準 frontmatter 欄位（原樣保留，不阻擋）：${profile.nonStandardKeys.join(', ')}`, path: entryPath });
      }
    } catch { add(invalid, `contents '${c.id}'：Skill 目錄不存在或無法讀取：${c.path}`, c.path); }
  }
  const commands = array(manifest?.setup?.commands).filter(c => c && typeof c === 'object');
  for (const c of commands) {
    await walk(c.script, `setup.commands '${c.commandId}' 的 script`);
    for (const p of array(c.payloads)) await walk(p, `setup.commands '${c.commandId}' 的 payload`);
  }
  const files = [...selected.values()].sort(ordinal);
  let totalBytes = 0;
  for (const relative of files) {
    try {
      const bytes = await fs.readFile(path.join(folder, relative)); totalBytes += bytes.length;
      const powershell = commands.some(c => c.runner === 'powershell' && (safe(c.script) && normalize(c.script) === relative ||
        /\.(ps1|psm1|psd1)$/i.test(relative) && array(c.payloads).some(p => safe(p) && (relative === normalize(p) || relative.startsWith(normalize(p) + '/')))));
      const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
        bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) || bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]));
      if (powershell && !bom && bytes.some(b => b > 0x7f)) add('deployment.setup-script-encoding',
        `設定腳本 ${relative}：請將此檔另存為 UTF-8 with BOM；否則在 Windows PowerShell 5.1 會執行失敗`, relative);
    } catch { add(invalid, `無法讀取來源檔案：${relative}`, relative); }
  }
  if (mode === 'upload') {
    try {
      let zipBytes = 0;
      for await (const chunk of zipChunks(folder, files)) zipBytes += chunk.length;
      if (zipBytes > MAX_PACKAGE_ZIP_BYTES) add(invalid, '資源包 ZIP 不可超過 100 MB');
    } catch { add(invalid, '無法計算資源包 ZIP 大小'); }
  }
  const contentCounts = { skill: 0, agent: 0, command: 0, prompt: 0, mcp: 0 };
  for (const c of array(manifest?.contents)) if (Object.hasOwn(contentCounts, c?.kind)) contentCounts[c.kind]++;
  return { ok: !blocking.length, blocking, disclosures, manifest,
    summary: { key: manifest?.key ?? null, name: manifest?.name ?? null, version: manifest?.version ?? null, type: manifest?.type ?? null,
      contentCounts, fileCount: files.length, totalBytes, hasFullGuide: files.includes('index.html') }, files };
}
