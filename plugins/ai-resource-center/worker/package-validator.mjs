// 公開接縫：下載與後續部署都以同一份 ZIP 位元組驗證，不解壓到部署目標。
import { inflateRawSync, crc32 } from 'node:zlib';
import { ErrorCode, RcError } from './contract.mjs';
import { ofBytes } from './deploy/digest.mjs';
import { parseManifest, validateManifest } from './manifest-validator.mjs';

const invalid = message => { throw new RcError(ErrorCode.invalidPackage, `資源包格式錯誤：${message}`); };

const MB = 1024 * 1024;
/**
 * 資源包大小上限。原本只限制壓縮後大小（市集 Market:MaxPackageSizeMB，預設 100），沒有項目數或解壓上限；
 * 這裡在記憶體中解壓，所以多加項目數、單檔與總解壓上限，避免 zip bomb 耗盡記憶體。
 */
export const PackageLimits = Object.freeze({ maxDownloadBytes: 100 * MB, maxEntries: 5000, maxEntryBytes: 100 * MB, maxTotalBytes: 500 * MB });
const deniedExtensions = /\.(exe|dll|msi|bat|cmd|com|scr|ps1xml|zip|7z|rar)$/i;
function safeEntry(name) {
  const segments = name.replace(/\/$/, '').split('/');
  if (name.includes('\\') || segments.some(s => !s.trim() || s === '.' || s === '..' || /[. ]$|[:<>"|?*\x00-\x1f\x7f]/.test(s))) {
    throw new RcError(ErrorCode.unsafePath, '資源包包含不安全的封裝路徑');
  }
  if (segments.some(s => ['.git', 'node_modules'].includes(s.toLowerCase())) || deniedExtensions.test(name)) invalid('封裝含禁止的檔案或目錄');
}
export function readPackageZip(bytes, limits = {}) {
  const { maxEntries, maxEntryBytes, maxTotalBytes } = { ...PackageLimits, ...limits };
  try {
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) invalid('ZIP 目錄損壞');
    let count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), directorySize = bytes.readUInt32LE(end + 12), directoryEnd = end;
    const uint64 = offset => {
      const value = bytes.readBigUInt64LE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid('ZIP 大小超出可讀取範圍');
      return Number(value);
    };
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) invalid('ZIP 目錄損壞或為分卷封裝');
    if (count === 65535 || start === 0xffffffff || directorySize === 0xffffffff) {
      const locator = end - 20;
      if (bytes.readUInt32LE(locator) !== 0x07064b50 || bytes.readUInt32LE(locator + 4) || bytes.readUInt32LE(locator + 16) !== 1) invalid('ZIP64 目錄損壞');
      directoryEnd = uint64(locator + 8);
      if (bytes.readUInt32LE(directoryEnd) !== 0x06064b50 || directoryEnd + 12 + uint64(directoryEnd + 4) !== locator || bytes.readUInt32LE(directoryEnd + 16) || bytes.readUInt32LE(directoryEnd + 20)) invalid('ZIP64 目錄損壞');
      count = uint64(directoryEnd + 32); start = uint64(directoryEnd + 48); directorySize = uint64(directoryEnd + 40);
      if (uint64(directoryEnd + 24) !== count) invalid('ZIP64 分卷封裝不支援');
    }
    if (start + directorySize !== directoryEnd) invalid('ZIP 目錄損壞');
    if (count > maxEntries) invalid(`項目數超過上限（${maxEntries}）`);
    const files = new Map(); let offset = start, total = 0;
    for (let i = 0; i < count; i++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) invalid('ZIP 項目損壞');
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
      let size = bytes.readUInt32LE(offset + 24), compressed = bytes.readUInt32LE(offset + 20);
      const crc = bytes.readUInt32LE(offset + 16);
      const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength), name = nameBytes.toString('utf8');
      safeEntry(name);
      const attributes = bytes.readUInt32LE(offset + 38);
      if (((attributes >>> 16) & 0xf000) === 0xa000 || (attributes & 0x400)) invalid('封裝不得包含符號連結');
      let local = bytes.readUInt32LE(offset + 42);
      if ([size, compressed, local].includes(0xffffffff)) {
        let position = offset + 46 + nameLength;
        const extraEnd = position + extra;
        while (position + 4 <= extraEnd && bytes.readUInt16LE(position) !== 1) position += 4 + bytes.readUInt16LE(position + 2);
        if (position + 4 > extraEnd) invalid('ZIP64 項目缺少大小資訊');
        const fieldEnd = position + 4 + bytes.readUInt16LE(position + 2); position += 4;
        const next = () => { if (position + 8 > fieldEnd || fieldEnd > extraEnd) invalid('ZIP64 項目損壞'); const value = uint64(position); position += 8; return value; };
        if (size === 0xffffffff) size = next();
        if (compressed === 0xffffffff) compressed = next();
        if (local === 0xffffffff) local = next();
      }
      if (flags & 1 || ![0, 8].includes(method) || bytes.readUInt32LE(local) !== 0x04034b50) invalid('ZIP 壓縮方式不支援或已加密');
      const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (dataStart + compressed > start || !bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).equals(nameBytes)) invalid('ZIP 項目損壞');
      // 先以宣告大小擋下，再把解壓輸出長度限制在宣告大小；標頭謊報時 inflate 在超出處就中止，不會先展開整個炸彈。
      limits.checkEntry?.(name, size);
      if (size > maxEntryBytes) invalid(`單一檔案解壓後超過上限（${maxEntryBytes / MB} MB）`);
      total += size;
      if (total > maxTotalBytes) invalid(`解壓後總大小超過上限（${maxTotalBytes / MB} MB）`);
      const data = method === 0 ? bytes.subarray(dataStart, dataStart + compressed) : inflateRawSync(bytes.subarray(dataStart, dataStart + compressed), { maxOutputLength: Math.max(1, size) });
      if (data.length !== size || crc32(data) !== crc) invalid('ZIP 項目完整性驗證失敗');
      if (files.has(name)) invalid('ZIP 包含重複路徑');
      files.set(name, data);
      offset += 46 + nameLength + extra + comment;
    }
    if (offset !== directoryEnd) invalid('ZIP 目錄損壞');
    return files;
  } catch (e) { if (e instanceof RcError) throw e; invalid('ZIP 無法讀取'); }
}

export function validatePackage(bytes, identity, limits = {}) {
  const sha256 = ofBytes(bytes);
  for (const expected of [identity.sha256, identity.downloadSha256]) {
    if (expected && (typeof expected !== 'string' || expected.toLowerCase() !== sha256)) throw new RcError(ErrorCode.checksumMismatch, '資源包 SHA-256 驗證失敗，請重新下載');
  }
  const files = readPackageZip(bytes, limits);
  if (!files.has('lcpack.json') || !files.has('README.md')) invalid('根目錄需要 lcpack.json 與 README.md');
  let manifest;
  try { manifest = parseManifest(files.get('lcpack.json').toString('utf8')); } catch { invalid('lcpack.json 不是合法 JSONC'); }
  validateManifest(manifest);
  if (manifest.key !== identity.packageKey || manifest.version !== identity.version) invalid('資源包識別碼或版本與所選版本不符');
  return { manifest, files, sha256 };
}
