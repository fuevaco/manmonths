import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { packageInput } from './package-service.mjs';
import { badParams, ErrorCode, RcError } from './contract.mjs';
import { validatePackage, PackageLimits } from './package-validator.mjs';

export function createDownloadService({ session, packages, downloadDirectory = path.join(homedir(), 'Downloads'), maxDownloadBytes = PackageLimits.maxDownloadBytes }) {
  /**
   * 依 package key＋version 取得確切 ZIP 並驗證（SHA-256、ZIP 與 canonical 格式）。單獨下載與部署規劃共用。
   * @returns {Promise<{bytes: Buffer, sha256: string, manifest: object, detail: object, version: object}>}
   */
  async function fetchVerified(input) {
    packageInput(input, true);
    const client = await session.requireClient();
    const detail = await packages.details(client, input);
    const selected = detail.versions.find(v => v.version === input.version);
    const suffix = input.previewMode ? '?channel=preview' : '';
    const response = await packages.request(client, `api/market/packages/${encodeURIComponent(input.packageKey)}/versions/${encodeURIComponent(input.version)}/download${suffix}`, { maxBytes: maxDownloadBytes, responseType: 'bytes' });
    const bytes = response.bytes;
    const { sha256, manifest } = validatePackage(bytes, { ...input, sha256: selected.sha256, downloadSha256: response.headers['x-checksum-sha256'] });
    return { bytes, sha256, manifest, detail, version: selected };
  }

  return { fetchVerified, async save(input) {
    packageInput(input, true);
    if (input.destinationFile !== undefined && (typeof input.destinationFile !== 'string' || !path.isAbsolute(input.destinationFile) || !input.destinationFile.endsWith('.zip'))) throw badParams('請提供 ZIP 的完整儲存路徑');
    const { bytes, sha256: actual } = await fetchVerified(input);
    const filePath = input.destinationFile || path.join(downloadDirectory, `${input.packageKey}-${input.version}.zip`);
    const temporary = path.join(path.dirname(filePath), `.tmp-dl-${randomUUID()}.zip`);
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, filePath);
    } catch { throw new RcError(ErrorCode.saveFailed, '無法儲存 ZIP，請確認儲存位置與權限後重試'); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return { filePath, sha256: actual, fileSize: bytes.length };
  } };
}
