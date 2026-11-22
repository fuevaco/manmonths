// 觀測目的地目前狀態（對照 ResourceDrivers.cs 的 PathObserver）；只讀，不建立目錄。
import fs from 'node:fs';
import path from 'node:path';
import { ofBytes, ofTree, ordinal } from './digest.mjs';

export const PathState = Object.freeze({ missing: 'Missing', file: 'File', directory: 'Directory', configNode: 'ConfigNode' });
export const Missing = Object.freeze({ state: PathState.missing, sha256: null, treeSha256: null, length: null, lastWriteUtc: null });

const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };
export const isFile = (p) => statOf(p)?.isFile() === true;
export const isDirectory = (p) => statOf(p)?.isDirectory() === true;

/** 遞迴列出目錄下全部檔案（完整路徑）。 */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() || (e.isSymbolicLink() && isFile(full))) out.push(full);
      else if (e.isSymbolicLink() && isDirectory(full)) walk(full);
    }
  };
  walk(dir);
  return out;
}

/** 遞迴列出子目錄（完整路徑）。 */
export function listDirectories(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { const full = path.join(d, e.name); out.push(full); walk(full); } };
  walk(dir);
  return out;
}

export function observe(p) {
  if (isDirectory(p)) return observeTree(p);
  const stat = statOf(p);
  if (!stat?.isFile()) return Missing;
  return { state: PathState.file, sha256: ofBytes(fs.readFileSync(p)), treeSha256: null, length: stat.size, lastWriteUtc: stat.mtime.toISOString() };
}

export function observeTree(p) {
  if (isFile(p)) return observe(p);
  if (!isDirectory(p)) return Missing;
  const files = listFiles(p).map(full => ({ relative: path.relative(p, full).replaceAll('\\', '/'), full }))
    .sort((a, b) => ordinal(a.relative, b.relative));
  const tree = ofTree(files.map(f => ({ relativePath: f.relative, content: fs.readFileSync(f.full) })));
  const lastWrite = files.length === 0 ? statOf(p).mtimeMs : Math.max(...files.map(f => statOf(f.full)?.mtimeMs ?? 0));
  return { state: PathState.directory, sha256: null, treeSha256: tree, length: files.length, lastWriteUtc: new Date(lastWrite).toISOString() };
}

export const sameObservation = (expected, actual) =>
  expected.state === actual.state &&
  (expected.sha256 ?? '').toLowerCase() === (actual.sha256 ?? '').toLowerCase() &&
  (expected.treeSha256 ?? '').toLowerCase() === (actual.treeSha256 ?? '').toLowerCase();
