// 從資料夾安裝的開發中版本（本機來源）：預檢、打包到暫存目錄，以及讀取來源資料夾的 lcpack.json。
// 對照 SourceFolderArtifactResolver：每次都重新打包到新建的系統暫存目錄（lcaipack-sideload-<guid>）、
// 計算 SHA-256，不使用受管快取（同版號內容可能已改變）；呼叫端在套用結束、取消或失敗後刪除暫存目錄。
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectSourceFolder, buildPackageZip } from './pack/index.mjs';
import { parseManifest } from './manifest-validator.mjs';
import { compareVersions } from './package-service.mjs';
import { RcError, ErrorCode } from './contract.mjs';
import { toolId, supportedTools } from './host-labels.mjs';

/** 收據的 sourcePath 原樣記錄；只在絕對路徑且為資料夾時視為存在（對照 InstalledPlatform.SourceFolderExists）。 */
export function sourceExists(folder) {
  try { return typeof folder === 'string' && path.isAbsolute(folder) && fs.statSync(folder).isDirectory(); }
  catch { return false; }
}

/** 讀來源資料夾的 lcpack.json（允許註解與尾逗號）；讀不到或格式錯誤時回傳 null，由呼叫端退回收據。 */
export function readSourceManifest(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null;
  try {
    const manifest = parseManifest(fs.readFileSync(path.join(folder, 'lcpack.json'), 'utf8'));
    return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
  } catch { return null; }
}

/** 來源 manifest 的內容清單（kind／id）；格式不對的項目略過。 */
export const manifestContents = manifest => (Array.isArray(manifest?.contents) ? manifest.contents : [])
  .filter(c => c && typeof c === 'object').map(c => ({ kind: String(c.kind ?? ''), id: String(c.id ?? '') }));

/**
 * 同一資源包多筆收據中「目前版本」那一筆（對照 InstalledViewModel.CurrentReceipt）：版號最高者；
 * 同版號同時有市集與本機來源時以本機來源為準（開發者正在測試的內容）。
 */
export function currentReceipt(receipts) {
  return [...receipts].sort((a, b) => compareVersions(b.packageVersion, a.packageVersion) ||
    (b.source === 'local' ? 1 : 0) - (a.source === 'local' ? 1 : 0))[0] ?? null;
}

export const sourceMissingMessage = folder => `來源資料夾已不存在，無法重新打包：${folder || "（未記錄）"}。請在「我的資源包」用「從資料夾安裝…」重新指定資料夾。`;
export const sourceMissingError = folder => new RcError(ErrorCode.sourceMissing, sourceMissingMessage(folder));

/**
 * 預檢（本機打包規則）後打包到新的暫存目錄。預檢有阻擋項時不打包，只回傳 { inspection }。
 * @returns {Promise<{inspection: object, artifact?: {folder: string, zipPath: string, sha256: string, tempDirectory: string, key: string, version: string, manifest: object}}>}
 */
export async function resolveSourceFolder(folder, { tempRoot = os.tmpdir() } = {}) {
  const inspection = await inspectSourceFolder(folder, { mode: 'install' });
  if (!inspection.ok) return { inspection };
  const tempDirectory = path.join(tempRoot, `lcaipack-sideload-${randomUUID().replaceAll('-', '')}`);
  try {
    const { zipPath, sha256 } = await buildPackageZip(folder, inspection, { outputDirectory: tempDirectory });
    return { inspection, artifact: { folder, zipPath, sha256, tempDirectory, key: inspection.manifest.key, version: inspection.manifest.version, manifest: inspection.manifest } };
  } catch {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    throw new RcError(ErrorCode.invalidPackage, '無法把來源資料夾打包成資源包，請確認資料夾可以讀取後重試');
  }
}

/** 刪除暫存打包產物；刪不掉不影響已完成的部署（同樣靜默略過）。 */
export async function disposeArtifact(artifact) {
  if (artifact?.tempDirectory) await rm(artifact.tempDirectory, { recursive: true, force: true }).catch(() => {});
}

/**
 * 本機開發中清單：全域收據中 source 為 local 的資源包。名稱讀來源資料夾的 lcpack.json，讀不到用識別碼。
 * @param {object[]} receipts  全域部署收據
 */
export function listLocalPackages(receipts) {
  const byKey = new Map();
  for (const r of receipts.filter(r => r.source === 'local')) {
    if (!byKey.has(r.packageKey)) byKey.set(r.packageKey, []);
    byKey.get(r.packageKey).push(r);
  }
  return [...byKey].map(([packageKey, records]) => {
    const current = currentReceipt(records);
    const sourcePath = current.sourcePath ?? null;
    const manifest = readSourceManifest(sourcePath);
    const name = typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name : packageKey;
    const tools = supportedTools.filter(tool => records.some(r => toolId(r) === tool.hostId)).map(({ hostId, label }) => ({ hostId, label }));
    return { packageKey, name, version: current.packageVersion, sourcePath, sourceExists: sourceExists(sourcePath), tools };
  }).sort((a, b) => a.packageKey < b.packageKey ? -1 : a.packageKey > b.packageKey ? 1 : 0);
}
