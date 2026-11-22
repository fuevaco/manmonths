import { packageInput } from './package-service.mjs';
import { validatePackage, PackageLimits } from './package-validator.mjs';

export function createDownloadService({ session, packages, maxDownloadBytes = PackageLimits.maxDownloadBytes }) {
  /**
   * 依 package key＋version 取得確切 ZIP 並驗證（SHA-256、ZIP 與 canonical 格式）。安裝與完整說明頁共用。
   * @returns {Promise<{bytes: Buffer, sha256: string, manifest: object, detail: object, version: object}>}
   */
  async function fetchVerified(input, limits = {}) {
    packageInput(input, true);
    const client = await session.requireClient();
    const detail = await packages.details(client, input);
    const selected = detail.versions.find(v => v.version === input.version);
    const suffix = input.previewMode ? '?channel=preview' : '';
    const response = await packages.request(client, `api/market/packages/${encodeURIComponent(input.packageKey)}/versions/${encodeURIComponent(input.version)}/download${suffix}`, { maxBytes: maxDownloadBytes, responseType: 'bytes' });
    const bytes = response.bytes;
    const { sha256, manifest } = validatePackage(bytes, { ...input, sha256: selected.sha256, downloadSha256: response.headers['x-checksum-sha256'] }, limits);
    return { bytes, sha256, manifest, detail, version: selected };
  }

  return { fetchVerified };
}
