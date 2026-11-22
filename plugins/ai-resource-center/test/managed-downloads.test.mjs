import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedDownloads } from '../worker/managed-downloads.mjs';
import { zip } from './zip-fixture.mjs';

async function environment(t, fetchVerified) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'rc-zip-cache-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const bytes = zip(), sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = path.join(dataDirectory, 'cache', 'demo', '1.0.0', `${sha256}.zip`);
  const now = () => Date.UTC(2026, 10, 21);
  const options = { dataDirectory, now, log() {}, session: { requireClient: async () => ({}) },
    packages: { details: async () => ({ versions: [{ version: '1.0.0', sha256 }] }) },
    downloads: { fetchVerified: async () => { await fetchVerified?.(); return { bytes, sha256 }; } } };
  return { options, file, bytes, now, input: { packageKey: 'demo', version: '1.0.0' } };
}

test('啟動清理等待使用中的 ZIP 重建完成，再檢查最新使用時間', async t => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const e = await environment(t, async () => { started(); await gate; });
  const downloads = createManagedDownloads(e.options);
  await downloads.ready;
  await mkdir(path.dirname(e.file), { recursive: true });
  await writeFile(e.file, 'corrupt');
  const old = new Date(e.now() - 31 * 86400000);
  await utimes(e.file, old, old);
  const fetching = downloads.fetchVerified(e.input);
  await entered;
  const cleaner = createManagedDownloads(e.options);
  try {
    assert.equal(await Promise.race([cleaner.ready.then(() => 'cleaned'), delay(100).then(() => 'in-use')]), 'in-use');
    assert.ok((await stat(e.file)).isFile(), '正在重建的 ZIP 不得刪除');
  } finally { release(); await fetching; await cleaner.ready; }
  assert.deepEqual(await readFile(e.file), e.bytes);
  assert.equal((await stat(e.file)).mtimeMs, e.now());
});

test('ZIP 清理不跟隨快取根目錄符號連結，取用也拒絕該路徑', async t => {
  const e = await environment(t);
  const outside = path.join(e.options.dataDirectory, 'outside');
  const outsideFile = path.join(outside, 'demo', '1.0.0', path.basename(e.file));
  await mkdir(path.dirname(outsideFile), { recursive: true });
  await writeFile(outsideFile, e.bytes);
  const old = new Date(e.now() - 31 * 86400000);
  await utimes(outsideFile, old, old);
  await symlink(outside, path.join(e.options.dataDirectory, 'cache'), process.platform === 'win32' ? 'junction' : 'dir');
  const downloads = createManagedDownloads(e.options);
  await downloads.ready;
  assert.ok((await stat(outsideFile)).isFile());
  await assert.rejects(downloads.fetchVerified(e.input), { code: 'unsafe_path' });
});
