// 安裝與完整說明頁共用的外掛專用 ZIP 快取；每次讀取均重新驗證，不信任磁碟內容。
import { readFile, mkdir, lstat, writeFile, rename, rm, readdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { packageInput } from './package-service.mjs';
import { validatePackage } from './package-validator.mjs';
import { RcError, ErrorCode } from './contract.mjs';

export async function rejectLinks(target) {
  for (let current = path.resolve(target);; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new RcError(ErrorCode.unsafePath, '外掛快取路徑不得包含符號連結'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (path.dirname(current) === current) break;
  }
}

export async function atomicCacheWrite(file, bytes) {
  await rejectLinks(file);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

// 同一進程內重啟 worker 也共用檔案鎖；清理不能與正在讀取／重建的 ZIP 交錯。
const filesInUse = new Map();
function withFile(file, action) {
  const next = (filesInUse.get(file) ?? Promise.resolve()).catch(() => {}).then(action);
  filesInUse.set(file, next);
  return next.finally(() => { if (filesInUse.get(file) === next) filesInUse.delete(file); });
}

export function createManagedDownloads({ downloads, session, packages, dataDirectory, log, now = Date.now }) {
  const root = path.resolve(dataDirectory, 'cache');
  async function entries(dir) {
    try { return await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  const ready = (async () => {
    try {
      await rejectLinks(root);
      for (const pkg of await entries(root)) {
        if (!pkg.isDirectory() || pkg.isSymbolicLink()) continue;
        const pkgDir = path.join(root, pkg.name);
        for (const version of await entries(pkgDir)) {
          if (!version.isDirectory() || version.isSymbolicLink()) continue;
          const dir = path.join(pkgDir, version.name);
          for (const entry of await entries(dir)) {
            if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.zip$/.test(entry.name)) continue;
            const file = path.join(dir, entry.name);
            await withFile(file, async () => {
              await rejectLinks(file);
              const stat = await lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
              if (stat?.isFile() && Math.max(stat.atimeMs, stat.mtimeMs) < Number(now()) - 30 * 86400000) await rm(file, { force: true });
            });
          }
        }
      }
    } catch { log('[download-cache-cleanup] 無法清理 ZIP 快取'); }
  })();
  const touch = file => { const time = new Date(Number(now())); return utimes(file, time, time); };
  return { ...downloads, dataDirectory, ready, async fetchVerified(input, limits = {}) {
    packageInput(input, true);
    await ready;
    const client = await session.requireClient();
    const detail = await packages.details(client, input);
    const version = detail.versions.find(v => v.version === input.version);
    const sha = version.sha256?.toLowerCase();
    // 缺少可信 SHA 的舊市集仍走既有下載驗證，不把它放入持久快取。
    if (!/^[a-f0-9]{64}$/.test(sha ?? '')) return downloads.fetchVerified(input, limits);
    const file = path.join(root, input.packageKey, input.version, `${sha}.zip`);
    return withFile(file, async () => {
      await rejectLinks(file);
      try {
        const bytes = await readFile(file);
        const verified = validatePackage(bytes, { ...input, sha256: sha }, limits);
        await touch(file);
        return { bytes, ...verified, detail, version };
      } catch (e) {
        if (e.code === ErrorCode.guideTooLarge) throw e;
        if (e.code !== 'ENOENT') log('[download-cache] 快取無法驗證，重新下載');
      }
      const result = await downloads.fetchVerified(input, limits);
      try { await atomicCacheWrite(file, result.bytes); await touch(file); }
      catch { log('[download-cache] 無法儲存快取'); }
      return result;
    });
  } };
}
