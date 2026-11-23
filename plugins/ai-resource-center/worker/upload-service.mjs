import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { inspectSourceFolder, buildPackageZip, MAX_PACKAGE_ZIP_BYTES } from './pack/index.mjs';
import { RcError, ErrorCode, badParams } from './contract.mjs';

async function folderInput(input) {
  if (typeof input?.folder !== 'string' || input.folder.length > 4096 || input.folder.includes('\0') || !path.isAbsolute(input.folder)) throw badParams('請指定存在的絕對資料夾路徑');
  try { if ((await fs.stat(input.folder)).isDirectory()) return input.folder; } catch { /* 統一輸入錯誤 */ }
  throw badParams('來源資料夾不存在或無法讀取');
}

export function createUploadService({ session, developer, temporaryRoot = tmpdir() }) {
  const jobs = new Map();
  let generation = 0;
  function find(input) {
    if (typeof input?.jobId !== 'string' || !jobs.has(input.jobId)) throw badParams('找不到上傳工作');
    return jobs.get(input.jobId);
  }
  const status = job => ({ ...job.status, ...(job.status.error ? { error: { ...job.status.error } } : {}) });
  async function inspect(input) {
    const folder = await folderInput(input);
    if (!['upload', 'install'].includes(input.mode)) throw badParams('預檢模式必須為 upload 或 install');
    const { files, ...result } = await inspectSourceFolder(folder, { mode: input.mode });
    return result;
  }
  function run(job, prepare) {
    job.controller = new AbortController();
    const signal = job.controller.signal;
    const check = () => signal.throwIfAborted();
    job.done = (async () => {
      try {
        if (prepare) {
          job.directory = await fs.mkdtemp(path.join(temporaryRoot, 'rc-upload-'));
          check();
          job.zip = await buildPackageZip(job.folder, job.inspection, { outputDirectory: job.directory });
          if (job.zip.bytes > MAX_PACKAGE_ZIP_BYTES) throw new RcError(ErrorCode.invalidPackage, '資源包 ZIP 不可超過 100 MB');
        }
        check();
        job.status.state = 'uploading';
        const request = (route, options = {}) => {
          check();
          return developer.request(route, { ...options, signal }, false, job.client);
        };
        const route = `packages/${encodeURIComponent(job.status.packageKey)}`;
        try { await request(route); }
        catch (error) {
          if (error.status !== 404) throw error;
          let context;
          try { context = await request(`${route}/publish-context`); }
          catch (error) { if (error.status !== 404) throw error; }
          if (!context) {
            const m = job.inspection.manifest;
            try {
              await request('packages', { method: 'POST', json: { packageKey: m.key, name: m.name, type: m.type,
                description: m.description ?? null, category: m.category ?? null, tags: m.tags?.length ? m.tags.join(',') : null } });
              job.status.createdPackage = true;
            } catch (error) { if (error.status !== 409) throw error; }
          }
        }
        check();
        const zip = await fs.readFile(job.zip.zipPath);
        check();
        const boundary = `rc-${randomUUID()}`;
        const filename = `${job.status.packageKey}-${job.status.version}.zip`;
        const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`), zip, Buffer.from(`\r\n--${boundary}--\r\n`)]);
        const result = await request(`${route}/versions`, { method: 'POST', body,
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, timeoutMs: 10 * 60 * 1000 });
        check();
        if (!Number.isSafeInteger(result?.id) || result.id <= 0) throw new RcError(ErrorCode.marketError, '市集上傳回應格式錯誤，請重新整理版本清單');
        job.status.versionId = result.id;
        job.status.state = 'uploaded';
      } catch (error) {
        if (signal.aborted) job.status.state = 'cancelled';
        else {
          job.status.state = 'failed';
          job.status.error = error instanceof RcError ? { code: error.code, message: error.message }
            : { code: ErrorCode.internal, message: '打包或上傳失敗，請稍後再試' };
        }
      }
    })();
  }
  function cancel(job) {
    if (['preparing', 'uploading'].includes(job.status.state)) {
      job.controller.abort();
      job.status.state = 'cancelled';
    }
  }
  async function dispose(job) {
    cancel(job);
    await job.done;
    if (job.directory) await fs.rm(job.directory, { recursive: true, force: true });
  }
  return {
    inspect,
    async start(input) {
      const current = generation;
      const client = await session.requireClient();
      const folder = await folderInput(input);
      const inspection = await inspectSourceFolder(folder, { mode: 'upload' });
      if (!inspection.ok) throw new RcError(ErrorCode.invalidPackage, '來源資料夾未通過上傳預檢', { blocking: inspection.blocking });
      if (current !== generation) throw new RcError(ErrorCode.sessionExpired, '登入狀態已變更，請重新開始上傳');
      const m = inspection.manifest;
      const jobId = randomUUID();
      const job = { folder, inspection, client, status: { state: 'preparing', packageKey: m.key, version: m.version, name: m.name, createdPackage: false } };
      jobs.set(jobId, job);
      run(job, true);
      return { jobId };
    },
    status: input => status(find(input)),
    cancel(input) { cancel(find(input)); return { ok: true }; },
    retry(input) {
      const job = find(input);
      if (job.status.state !== 'failed' || !job.zip) throw badParams('只有已完成打包的失敗工作可以重試');
      job.status.state = 'uploading';
      delete job.status.error;
      run(job, false);
      return { jobId: input.jobId };
    },
    async dispose(input) {
      const job = find(input);
      jobs.delete(input.jobId);
      await dispose(job);
      return { ok: true };
    },
    clear() {
      generation++;
      const pending = [...jobs.values()];
      jobs.clear();
      return Promise.all(pending.map(dispose));
    }
  };
}
