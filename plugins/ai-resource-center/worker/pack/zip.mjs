// 標準 ZIP（UTF-8 entry、deflate、CRC32）；預檢與寫檔共用相同編碼，大小包含目錄標頭。
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { isUnsafeRelativePath } from '../path-safety.mjs';

export async function* zipChunks(folder, files) {
  const directory = [];
  let offset = 0;
  for (const relative of files) {
    if (typeof relative !== 'string' || isUnsafeRelativePath(relative)) throw new Error('封裝路徑不可為絕對路徑或含 ..');
    const name = Buffer.from(relative, 'utf8');
    const bytes = await fs.readFile(path.join(folder, relative));
    const compressed = deflateRawSync(bytes);
    if (bytes.length >= 0xffffffff || name.length > 65535) throw new Error('ZIP 大小超出支援範圍');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x21, 12); // 固定 1980-01-01，讓同一份內容可重現。
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const extra = offset >= 0xffffffff ? Buffer.alloc(12) : Buffer.alloc(0);
    if (extra.length) { extra.writeUInt16LE(1); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(offset), 4); }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    header.copy(central, 8, 6, 30);
    central.writeUInt16LE(extra.length, 30);
    if (extra.length) central.writeUInt16LE(45, 6);
    central.writeUInt32LE(Math.min(offset, 0xffffffff), 42);
    directory.push(central, name, extra);
    yield header; yield name; yield compressed;
    offset += header.length + name.length + compressed.length;
  }
  const size = directory.reduce((n, b) => n + b.length, 0);
  const zip64 = files.length >= 65535 || offset >= 0xffffffff || size >= 0xffffffff;
  for (const chunk of directory) yield chunk;
  if (zip64) {
    const record = Buffer.alloc(56), locator = Buffer.alloc(20);
    record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(files.length), 24); record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(size), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + size), 8); locator.writeUInt32LE(1, 16);
    yield record; yield locator;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Math.min(files.length, 65535), 8); end.writeUInt16LE(Math.min(files.length, 65535), 10);
  end.writeUInt32LE(Math.min(size, 0xffffffff), 12); end.writeUInt32LE(Math.min(offset, 0xffffffff), 16);
  yield end;
}

/** inspection 必須為成功的預檢結果；不改寫來源或 manifest。 */
export async function buildPackageZip(folder, inspection, { outputDirectory } = {}) {
  if (!inspection?.ok || !inspection.manifest || !Array.isArray(inspection.files)) throw new Error('資源包尚未通過預檢');
  if (!outputDirectory) throw new TypeError('必須指定 outputDirectory');
  const { key, version } = inspection.manifest;
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(key) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) throw new Error('資源包識別碼或版本格式錯誤');
  const zipPath = path.resolve(outputDirectory, `${key}-${version}.zip`);
  if (inspection.files.some(p => path.resolve(folder, p).toLowerCase() === zipPath.toLowerCase())) throw new Error('輸出 ZIP 不可覆寫來源檔案');
  await fs.mkdir(outputDirectory, { recursive: true });
  const temporary = `${zipPath}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  const hash = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of zipChunks(folder, inspection.files)) {
      let written = 0;
      while (written < chunk.length) written += (await handle.write(chunk, written, chunk.length - written)).bytesWritten;
      hash.update(chunk); bytes += chunk.length;
    }
    await handle.close();
    await fs.rename(temporary, zipPath);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { zipPath, sha256: hash.digest('hex'), bytes };
}
