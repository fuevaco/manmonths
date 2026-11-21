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

export function createTargetTransaction({ tempRoot = os.tmpdir() } = {}) {
  const snapshotRoot = path.join(tempRoot, 'lcaipack-transactions', randomUUID().replaceAll('-', ''));
  const files = [], trees = [], written = [];
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  return {
    get writtenPaths() { return [...written]; },
    snapshotFile(p) {
      const full = path.resolve(p);
      if (files.some(s => same(s.originalPath, full))) return;
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
        let deleteFailed = false;
        try { if (isDirectory(s.originalPath)) fs.rmSync(s.originalPath, { recursive: true }); } catch (e) { deleteFailed = true; firstFailure ??= e; }
        if (s.backupPath == null) { if (deleteFailed) residual.push(s.originalPath); continue; }
        try {
          const restored = copyDirectory(s.backupPath, s.originalPath, deleteFailed);
          if (!deleteFailed) continue;
          residual.push(s.originalPath);
          if (restored > 0) partially.push(s.originalPath);
        } catch (e) { residual.push(s.originalPath); firstFailure ??= e; }
      }
      for (const s of files) {
        try {
          if (s.backupPath == null) { if (isFile(s.originalPath)) fs.rmSync(s.originalPath); continue; }
          fs.mkdirSync(path.dirname(s.originalPath), { recursive: true });
          fs.copyFileSync(s.backupPath, s.originalPath);
        } catch (e) { residual.push(s.originalPath); firstFailure ??= e; }
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
  const exists = (c) => fs.existsSync(c);
  const compose = (s) => `${p}${ToolBackupMarker}${s}`;
  if (!exists(compose(stamp))) return compose(stamp);
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(stamp);
  if (m) {
    const moment = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    for (let offset = 1; offset <= 1000; offset++) {
      const c = compose(formatStamp(new Date(moment.getTime() + offset * 1000)));
      if (!exists(c)) return c;
    }
  }
  for (let ordinal = 2; ordinal <= 1000; ordinal++) { const c = `${compose(stamp)}-${ordinal}`; if (!exists(c)) return c; }
  throw new Error(`無法為 ${p} 產生不重複的備份檔名（既有備份過多）。`);
}

export function createDirectoryBackup(p, stamp) {
  const backup = resolveBackupPath(p, stamp);
  fs.mkdirSync(backup, { recursive: true });
  for (const f of listFiles(p)) {
    const target = path.join(backup, path.relative(p, f));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f, target);
  }
  return backup;
}
