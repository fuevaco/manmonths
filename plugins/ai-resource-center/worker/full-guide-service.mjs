import { lstat, readdir, rm, utimes, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { packageInput } from './package-service.mjs';
import { RcError, ErrorCode, badParams } from './contract.mjs';
import { readPackageZip } from './package-validator.mjs';
import { atomicCacheWrite, rejectLinks } from './managed-downloads.mjs';
import { createGuideHttpServer } from './guide-http-server.mjs';

const maxGuideBytes = 20 * 1024 * 1024;
const tooLarge = () => new RcError(ErrorCode.guideTooLarge, '完整說明頁 index.html 解壓後不得超過 20 MB');
const limits = { checkEntry(name, size) { if (name === 'index.html' && size > maxGuideBytes) throw tooLarge(); } };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function createFullGuideService({ downloads, packages, session, preferences, now = Date.now, log, scheduler, makeServer }) {
  const http = createGuideHttpServer({ scheduler, makeServer });
  let generation = 0;
  let disposed = false;
  const root = path.join(downloads.dataDirectory, 'full-guides');
  let pending = Promise.resolve();
  const serial = fn => { const next = pending.then(fn); pending = next.catch(() => {}); return next; };
  async function children(parent) {
    try { return (await readdir(parent, { withFileTypes: true })).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => path.join(parent, e.name)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  const ready = serial(async () => {
    await downloads.ready;
    try {
      await rejectLinks(root);
      for (const pkg of await children(root)) for (const version of await children(pkg)) for (const dir of await children(version)) {
        if (!/^[a-f0-9]{16}$/.test(path.basename(dir))) continue;
        const file = path.join(dir, 'index.html');
        try {
          const stat = await lstat(file);
          if (stat.isFile() && !stat.isSymbolicLink() && Math.max(stat.atimeMs, stat.mtimeMs) < Number(now()) - 30 * 86400000) {
            await rejectLinks(dir);
            await rm(dir, { recursive: true, force: true });
          }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    } catch { log('[full-guide-cleanup] 無法清理完整說明頁快取'); }
  });

  async function prepare(input) {
    const started = generation;
    packageInput(input);
    if (Object.keys(input).some(k => k !== 'packageKey')) throw badParams('完整說明頁只接受資源包識別碼');
    return serial(async () => {
      const previewMode = (await preferences.get()).showPreview;
      const client = await session.requireClient();
      const detail = await packages.details(client, { packageKey: input.packageKey, previewMode });
      const selected = detail.versions.find(v => v.version === detail.recommendedVersion);
      if (!selected?.hasFullGuide) throw new RcError(ErrorCode.guideUnavailable, '此資源版本未提供完整說明頁');
      packageInput({ packageKey: input.packageKey, version: selected.version }, true);
      if (selected.version.endsWith('.')) throw badParams('資源版本包含不安全的路徑片段');
      if (!/^[a-f0-9]{64}$/i.test(selected.sha256 ?? '')) throw new RcError(ErrorCode.checksumMismatch, '完整說明頁 ZIP 的 SHA-256 格式不正確，無法驗證');
      const file = path.join(root, input.packageKey, selected.version, selected.sha256.toLowerCase().slice(0, 16), 'index.html');
      const marker = path.join(path.dirname(file), '.complete.json');
      await rejectLinks(file);
      await rejectLinks(marker);
      let complete = false;
      try {
        const saved = JSON.parse(await readFile(marker, 'utf8'));
        if ((await lstat(file)).size > maxGuideBytes) throw tooLarge();
        const bytes = await readFile(file);
        complete = bytes.length <= maxGuideBytes && saved.zipSha256 === selected.sha256.toLowerCase() && saved.htmlSha256 === digest(bytes);
      } catch { /* 不完整或被變更時，從已驗證 ZIP 重建。 */ }
      if (!complete) {
        const result = await downloads.fetchVerified({ packageKey: input.packageKey, version: selected.version, previewMode }, limits);
        if (result.sha256 !== selected.sha256.toLowerCase()) throw new RcError(ErrorCode.checksumMismatch, '完整說明頁 ZIP 的 SHA-256 驗證失敗，請重試');
        const bytes = readPackageZip(result.bytes, limits).get('index.html');
        if (!bytes) throw new RcError(ErrorCode.guideIndexMissing, '資源版本缺少根目錄 index.html，無法開啟完整說明頁');
        if (bytes.length > maxGuideBytes) throw tooLarge();
        try {
          await atomicCacheWrite(file, bytes);
          await atomicCacheWrite(marker, JSON.stringify({ zipSha256: result.sha256, htmlSha256: digest(bytes) }));
        } catch (e) {
          if (e instanceof RcError) throw e;
          throw new RcError(ErrorCode.saveFailed, '無法儲存完整說明頁，請確認外掛資料目錄權限後重試');
        }
      }
      const time = new Date(Number(now()));
      await utimes(file, time, time);
      if (disposed || started !== generation) throw new RcError(ErrorCode.saveFailed, '完整說明頁準備已停止，請重新開啟');
      return { url: await http.register(input.packageKey, selected.version, file), path: file };
    });
  }

  async function prepareLocal({ key, version, zipPath, sha256 }) {
    const started = generation;
    packageInput({ packageKey: key, version }, true);
    if (version.endsWith('.')) throw badParams('資源版本包含不安全的路徑片段');
    return serial(async () => {
      const stat = await lstat(zipPath).catch(error => {
        if (error.code === 'ENOENT') throw new RcError(ErrorCode.planStale, '確認已失效，請重新執行預檢');
        throw error;
      });
      if (!stat.isFile()) throw new RcError(ErrorCode.unsafePath, '本機打包內容無法安全讀取');
      const zip = await readFile(zipPath);
      if (digest(zip) !== sha256) throw new RcError(ErrorCode.checksumMismatch, '本機打包內容已變更，請重新預檢');
      const bytes = readPackageZip(zip, limits).get('index.html');
      if (!bytes) throw new RcError(ErrorCode.guideIndexMissing, '來源資料夾缺少根目錄 index.html');
      if (bytes.length > maxGuideBytes) throw tooLarge();
      const revision = sha256.slice(0, 16);
      const file = path.join(root, key, version, revision, 'index.html');
      await atomicCacheWrite(file, bytes);
      if (disposed || started !== generation) throw new RcError(ErrorCode.saveFailed, '完整說明頁準備已停止，請重新開啟');
      return { url: await http.register(key, version, file, revision) };
    });
  }

  function stop() { generation++; http.stop(); }
  return { prepare, prepareLocal, ready, stop, dispose() { disposed = true; stop(); } };
}
