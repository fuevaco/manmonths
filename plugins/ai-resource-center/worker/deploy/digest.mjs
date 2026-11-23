// 穩定 SHA-256 計算（對照 Deployment/ResourceDrivers.cs 的 Digest）。
import { createHash } from 'node:crypto';

/** bytes 的小寫十六進位 SHA-256。 */
export const ofBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** UTF-8 文字的 SHA-256。 */
export const ofText = (text) => ofBytes(Buffer.from(text, 'utf8'));

/** ordinal（UTF-16 code unit）比較，對應 .NET StringComparer.Ordinal。 */
export const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 目錄樹的 SHA-256：固定排序的相對路徑 + 內容 hash。 */
export function ofTree(files) {
  const sorted = [...files].sort((a, b) => ordinal(a.relativePath, b.relativePath));
  let text = '';
  for (const f of sorted) text += `${f.relativePath.replaceAll('\\', '/')}:${ofBytes(f.content)}\n`;
  return ofText(text);
}
