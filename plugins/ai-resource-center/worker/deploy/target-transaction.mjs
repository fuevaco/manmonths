// 單一部署目標的檔案交易（對照 Deployment/TargetTransaction.cs、ToolBackupNaming.cs）：
// 先快照、再寫入，任一步失敗即還原該目標本次全部變更。快照放在 OS 暫存區，不污染部署目標。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDirectory, isFile, listDirectories, listFiles } from './observer.mjs';
import { ToolBackupMarker } from './codex-roots.mjs';

export class RollbackIncompleteError extends Error {
  constructor(residualPaths, cause, partiallyRestoredPaths = []) {
    super(`rollback 未完整還原 ${residualPaths.length} 個路徑，需人工處理`);
    this.residualPaths = residualPaths; this.partiallyRestoredPaths = partiallyRestoredPaths; this.cause = cause;
  }
}

function copyDirectory(source, destination, bestEffort = false) {
  let restored = 0;
  fs.mkdirSync(destination, { recursive: true });
  for (const d of listDirectories(source)) fs.mkdirSync(path.join(destination, path.relative(source, d)), { recursive: true });
  for (const f of listFiles(source)) {
    const target = path.join(destination, path.relative(source, f));
    const wasMissing = !isFile(target);
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(f, target); } catch (e) { if (bestEffort) continue; throw e; }
    if (wasMissing) restored++;
  }
  return restored;
}

// 還原是否完整以最終內容為準：被占用且未改變的檔案即使無法覆寫，也不是殘留。
function differences(expected, actual) {
  try {
    let current = null;
    try { current = fs.statSync(actual); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (expected === null) return current ? [actual] : [];
    const original = fs.statSync(expected);
    if (!current || original.isDirectory() !== current.isDirectory() || original.isFile() !== current.isFile()) return [actual];
    if (original.isFile()) return fs.readFileSync(expected).equals(fs.readFileSync(actual)) ? [] : [actual];
    const names = new Set([...fs.readdirSync(expected), ...fs.readdirSync(actual)]);
    const expectedNames = new Set(fs.readdirSync(expected));
    return [...names].flatMap(name => differences(expectedNames.has(name) ? path.join(expected, name) : null, path.join(actual, name)));
  } catch { return [actual]; } // 無法驗證時仍如實列為未完整還原。
}

export function createTargetTransaction({ tempRoot = os.tmpdir() } = {}) {
  const snapshotRoot = path.join(tempRoot, 'lcaipack-transactions', randomUUID().replaceAll('-', ''));
  const files = [], trees = [], written = [];
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  return {
    get writtenPaths() { return [...written]; },
    snapshotFile(p) {
      const full = path.resolve(p);
      if (files.some(s => same(s.originalPath, full))) return;
      if (isDirectory(full)) { this.snapshotTree(full); return; }
      if (!isFile(full)) { files.push({ originalPath: full, backupPath: null }); return; }
      fs.mkdirSync(snapshotRoot, { recursive: true });
      const backup = path.join(snapshotRoot, `file-${String(files.length).padStart(5, '0')}.snapshot`);
      fs.copyFileSync(full, backup);
      files.push({ originalPath: full, backupPath: backup });
    },
    snapshotTree(dir) {
      const full = path.resolve(dir);
      if (trees.some(s => same(s.originalPath, full))) return;
      if (!isDirectory(full)) { trees.push({ originalPath: full, backupPath: null }); return; }
      const backup = path.join(snapshotRoot, `tree-${String(trees.length).padStart(5, '0')}`);
      copyDirectory(full, backup);
      trees.push({ originalPath: full, backupPath: backup });
    },
    recordWrite(p) { written.push(p); },
    rollback() {
      const residual = [], partially = [];
      let firstFailure = null;
      for (const s of trees) {
        let deleteFailed = false, restored = 0;
        try { if (isDirectory(s.originalPath)) fs.rmSync(s.originalPath, { recursive: true }); }
        catch (e) { deleteFailed = true; firstFailure ??= e; }
        if (s.backupPath !== null) {
          try { restored = copyDirectory(s.backupPath, s.originalPath, deleteFailed); }
          catch (e) { firstFailure ??= e; }
        }
        const remaining = differences(s.backupPath, s.originalPath);
        residual.push(...remaining);
        if (remaining.length && restored > 0) partially.push(...remaining);
      }
      for (const s of files) {
        try {
          if (s.backupPath == null) { if (isFile(s.originalPath)) fs.rmSync(s.originalPath); }
          else {
            fs.mkdirSync(path.dirname(s.originalPath), { recursive: true });
            fs.copyFileSync(s.backupPath, s.originalPath);
          }
        } catch (e) { firstFailure ??= e; }
        residual.push(...differences(s.backupPath, s.originalPath));
      }
      if (residual.length) throw new RollbackIncompleteError(residual, firstFailure, partially);
    },
    dispose() { try { fs.rmSync(snapshotRoot, { recursive: true, force: true }); } catch { /* 暫存快照清理失敗不影響結果 */ } }
  };
}

// ---------- 備份命名：<原名>.bak-lcaipack-<yyyyMMddHHmmss>，永不覆蓋既有備份 ----------
const pad = (n, w = 2) => String(n).padStart(w, '0');
const formatStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
export const newBackupStamp = (now = new Date()) => formatStamp(now);

export function resolveBackupPath(p, stamp) {
  return findAvailablePath(p, stamp, candidate => `${p}${ToolBackupMarker}${candidate}`);
}

function findAvailablePath(source, stamp, compose) {
  if (!fs.existsSync(compose(stamp))) return compose(stamp);
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(stamp);
  if (m) {
    const moment = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    for (let offset = 1; offset <= 1000; offset++) {
      const c = compose(formatStamp(new Date(moment.getTime() + offset * 1000)));
      if (!fs.existsSync(c)) return c;
    }
  }
  for (let ordinal = 2; ordinal <= 1000; ordinal++) {
    const candidate = compose(`${stamp}-${ordinal}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`無法為 ${source} 產生不重複的備份檔名（既有備份過多）。`);
}

const isWithinRoot = relative =>
  !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);

function skillArchiveRelativePath(source, userHome) {
  const relative = path.relative(userHome, source);
  if (isWithinRoot(relative)) return path.join('home', relative);

  const volume = path.parse(source).root;
  const pathOnVolume = source.slice(volume.length);
  if (volume.startsWith('\\\\')) return path.join('unc', volume.split(path.sep).filter(Boolean).join(path.sep), pathOnVolume);
  if (process.platform === 'win32') return path.join('drive', volume[0].toUpperCase(), pathOnVolume);
  return path.join('root', pathOnVolume);
}

export function createSkillBackup(sourcePath, stamp, { home, userHome }) {
  const source = path.resolve(sourcePath);
  const backupRoot = path.resolve(home, 'backups');
  if (isWithinRoot(path.relative(source, backupRoot))) {
    throw new Error('技能備份目錄不能位於技能資料夾內。');
  }

  const relativeSource = skillArchiveRelativePath(source, userHome);
  const backup = findAvailablePath(source, stamp, candidate => path.join(backupRoot, candidate, relativeSource));
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.mkdirSync(backup);
  for (const directory of listDirectories(source)) {
    fs.mkdirSync(path.join(backup, path.relative(source, directory)), { recursive: true });
  }
  for (const file of listFiles(source)) {
    const destination = path.join(backup, path.relative(source, file));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
  }
  return backup;
}
