import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './pack-fixture.mjs';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { send } from '../worker/http.mjs';

const pack = extra => ({ packageKey: 'example.test', name: '合成資源包', versions: [], ...extra });
async function setup(t, options = {}, deps = {}) {
  const source = await fixture(t);
  const temporaryRoot = path.join(source.root, 'uploads');
  await fs.mkdir(temporaryRoot);
  const market = await startFakeMarket({ users: { alice: { password: 'pw-alice', permissions: ['market:read', 'market:write'] } }, ...options });
  const worker = startWorker({ deps: { uploadTemporaryRoot: temporaryRoot, ...deps } });
  t.after(async () => { worker.dispose(); await market.close(); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const call = (action, input) => worker.call(`rc.dev.${action}`, input);
  const start = () => call('upload.start', { folder: source.folder });
  const status = job => call('upload.status', job);
  async function until(predicate) {
    for (let n = 0; n < 300; n++) { const result = await predicate(); if (result) return result; await delay(10); }
    assert.fail('背景工作未在期限內完成');
  }
  const finish = job => until(async () => { const s = await status(job); return ['uploaded', 'failed', 'cancelled'].includes(s.state) && s; });
  const uploadFiles = async () => (await fs.readdir(temporaryRoot, { recursive: true })).filter(p => p.endsWith('.zip'));
  return { source, temporaryRoot, market, worker, call, start, status, finish, until, uploadFiles };
}

test('預檢驗證資料夾與模式，保留檔案數，不揭露完整清單', async t => {
  const e = await setup(t);
  for (const input of [{ folder: 'relative', mode: 'upload' }, { folder: e.source.root + '-missing', mode: 'upload' }, { folder: e.source.folder, mode: 'other' }, { folder: path.join(e.source.folder, 'lcpack.json'), mode: 'upload' }]) {
    await assert.rejects(e.call('inspect', input), { code: 'invalid_params' });
  }
  for (const mode of ['upload', 'install']) {
    const result = await e.call('inspect', { folder: e.source.folder, mode });
    assert.equal(result.ok, true); assert.equal(result.summary.fileCount, 3); assert.equal(result.files, undefined);
  }
  e.source.manifest.version = '1.2.3-preview'; await e.source.save();
  assert.equal((await e.call('inspect', { folder: e.source.folder, mode: 'install' })).ok, true);
  await assert.rejects(e.start(), { code: 'invalid_package' });
  assert.deepEqual(await fs.readdir(e.temporaryRoot), []);
});

test('新識別碼依序建主檔、multipart 上傳、依版本字串送審與 dispose', async t => {
  const e = await setup(t);
  e.source.manifest.tags = ['one', 'two']; await e.source.save();
  const job = await e.start();
  const result = await e.finish(job);
  assert.deepEqual(result, { state: 'uploaded', packageKey: 'example.test', version: '1.2.3', name: '測試資源包', createdPackage: true, versionId: 1 });
  const requests = e.market.requests.filter(r => r.route.startsWith('/api/market/packages'));
  assert.deepEqual(requests.map(r => [r.method, r.route]), [
    ['GET', '/api/market/packages/example.test'], ['GET', '/api/market/packages/example.test/publish-context'],
    ['POST', '/api/market/packages'], ['POST', '/api/market/packages/example.test/versions']
  ]);
  assert.deepEqual(requests[2].body, { packageKey: 'example.test', name: '測試資源包', type: 'bundle', description: '合成測試資料', category: null, tags: 'one,two' });
  assert.equal(requests[3].file.filename, 'example.test-1.2.3.zip');
  assert.equal(requests[3].file.bytes.readUInt32LE(), 0x04034b50);
  assert.deepEqual(await e.call('submitReviewByVersion', { packageKey: 'example.test', version: '1.2.3', comment: ' 請審核 ' }), { ok: true });
  assert.deepEqual(e.market.requests.at(-1).body, { comment: '請審核' });
  assert.equal((await e.call('listMyPackages')).packages[0].versions[0].status, 'pending_review');
  assert.equal((await e.uploadFiles()).length, 1);
  await e.call('upload.dispose', job);
  assert.deepEqual(await fs.readdir(e.temporaryRoot), []);
  await assert.rejects(e.status(job), { code: 'invalid_params' });
});

for (const hidden of [false, true]) test(`既有識別碼不重建主檔（publish-context：${hidden}）`, async t => {
  const e = await setup(t, { myPackages: [pack({ hidden })] });
  assert.equal((await e.finish(await e.start())).createdPackage, false);
  assert.equal(e.market.requests.some(r => r.method === 'POST' && r.route === '/api/market/packages'), false);
  assert.equal(e.market.requests.some(r => r.route.endsWith('/publish-context')), hidden);
});

test('建主檔競態 409 吞掉後繼續上傳', async t => {
  const e = await setup(t, { myPackages: [pack({ hidden: true })] });
  e.market.override('GET /api/market/packages/example.test/publish-context', () => ({ status: 404 }));
  const result = await e.finish(await e.start());
  assert.equal(result.state, 'uploaded'); assert.equal(result.createdPackage, false);
});

test('版本已存在保留 RFC 9457 detail 與 conflict 狀態至 dispose', async t => {
  const e = await setup(t, { myPackages: [pack({ versions: [{ id: 1, version: '1.2.3' }] })] });
  const job = await e.start(); const result = await e.finish(job);
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.error, { code: 'conflict', message: '版本 1.2.3 已存在，請改用新的版本號' });
  assert.deepEqual(await e.status(job), result);
  await e.call('upload.dispose', job); assert.deepEqual(await e.uploadFiles(), []);
});

test('非擁有者 403 顯示伺服器 detail', async t => {
  const e = await setup(t, { myPackages: [pack({ hidden: true, owner: 'example-owner' })] });
  const result = await e.finish(await e.start());
  assert.deepEqual(result.error, { code: 'forbidden', message: '此識別碼屬於 example-owner，請改用其他識別碼' });
  assert.equal(e.market.requests.some(r => r.method === 'POST' && r.route.endsWith('/versions')), false);
});

test('上傳在背景等待，可取消中止且保留狀態直到 dispose', async t => {
  const e = await setup(t);
  e.market.override('POST /api/market/packages/example.test/versions', () => ({ hold: true }));
  const job = await e.start();
  await e.until(() => e.market.requests.some(r => r.file));
  assert.equal((await e.status(job)).state, 'uploading');
  await assert.rejects(e.call('upload.retry', job), { code: 'invalid_params' });
  await e.call('upload.cancel', job);
  assert.equal((await e.finish(job)).state, 'cancelled');
  await e.call('upload.dispose', job);
  assert.deepEqual(await fs.readdir(e.temporaryRoot), []);
});

test('失敗重試使用同一份 ZIP，不重新讀來源；上傳經過 token 續期', async t => {
  const e = await setup(t);
  e.market.override('POST /api/market/packages/example.test/versions', () => ({ status: 503, body: { detail: '請稍後再試' } }));
  const job = await e.start(); assert.equal((await e.finish(job)).state, 'failed');
  const first = e.market.requests.find(r => r.file).file.bytes;
  await e.source.write('README.md', 'changed');
  await fs.rm(e.source.folder, { recursive: true });
  e.market.clearOverrides(); e.market.expireAccessTokens();
  assert.deepEqual(await e.call('upload.retry', job), job);
  assert.equal((await e.finish(job)).state, 'uploaded');
  assert.deepEqual(e.market.requests.filter(r => r.file).at(-1).file.bytes, first);
  assert.ok(e.market.requests.some(r => r.route === '/api/auth/refresh'));
});

for (const action of ['logout', 'dispose']) test(`${action} 會中止進行中的上傳並清理全部工作`, async t => {
  const e = await setup(t);
  e.market.override('POST /api/market/packages/example.test/versions', () => ({ hold: true }));
  const job = await e.start(); await e.until(() => e.market.requests.some(r => r.file));
  if (action === 'logout') await e.worker.call('rc.session.signOut');
  else await e.call('upload.dispose', job);
  await e.until(async () => (await fs.readdir(e.temporaryRoot)).length === 0);
  await assert.rejects(e.status(job), { code: 'invalid_params' });
});

test('送審驗證版本與附註、缺版與失敗可重試', async t => {
  const e = await setup(t); await e.finish(await e.start());
  for (const input of [{ packageKey: '../bad', version: '1.2.3' }, { packageKey: 'example.test', version: null }, { packageKey: 'example.test', version: '1.2.3', comment: 1 }]) {
    await assert.rejects(e.call('submitReviewByVersion', input), { code: 'invalid_params' });
  }
  await assert.rejects(e.call('submitReviewByVersion', { packageKey: 'example.test', version: '9.0.0' }), { code: 'version_unavailable' });
  e.market.override('POST /api/market/versions/1/submit-review', () => ({ status: 503, body: { detail: '暫時無法送審' } }));
  const input = { packageKey: 'example.test', version: '1.2.3', comment: '附註' };
  await assert.rejects(e.call('submitReviewByVersion', input), { message: '暫時無法送審' });
  e.market.clearOverrides(); assert.deepEqual(await e.call('submitReviewByVersion', input), { ok: true });
});

test('上次打包上傳的資料夾儲存在外掛偏好並驗證型別與長度（從資料夾安裝另由 rc.dev.install.lastFolder 記錄）', async t => {
  const e = await setup(t);
  const values = { lastUploadFolder: e.source.folder };
  await e.worker.call('rc.preferences.set', values);
  const second = startWorker({ state: e.worker.state }); t.after(() => second.dispose());
  const result = await second.call('rc.preferences.get');
  for (const [key, value] of Object.entries(values)) {
    assert.equal(result[key], value);
    for (const bad of [null, 42, {}, 'x'.repeat(4097), 'bad\0path']) await assert.rejects(e.worker.call('rc.preferences.set', { [key]: bad }), { code: 'invalid_params' });
  }
});

test('multipart 的 401 續期重送完整二進位本文，使用十分鐘逾時', async t => {
  const sent = [];
  const e = await setup(t, {}, { transport: req => {
    if (req.body) sent.push(req);
    return send(req);
  } });
  let first = true;
  e.market.override('POST /api/market/packages/example.test/versions', () => {
    if (first) { first = false; return { status: 401 }; }
  });
  assert.equal((await e.finish(await e.start())).state, 'uploaded');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].timeoutMs, 600000);
  assert.deepEqual(sent[0].body, sent[1].body);
  assert.notEqual(sent[0].headers.Authorization, sent[1].headers.Authorization);
  assert.equal(e.market.requests.filter(r => r.route === '/api/auth/refresh').length, 1);
});

test('登出清理已完成與失敗工作的全部 ZIP', async t => {
  const e = await setup(t);
  const success = await e.start(); assert.equal((await e.finish(success)).state, 'uploaded');
  const failure = await e.start(); assert.equal((await e.finish(failure)).state, 'failed');
  assert.equal((await e.uploadFiles()).length, 2);
  await e.worker.call('rc.session.signOut');
  await e.until(async () => (await fs.readdir(e.temporaryRoot)).length === 0);
  for (const job of [success, failure]) await assert.rejects(e.status(job), { code: 'invalid_params' });
  await assert.rejects(e.start(), { code: 'signed_out' });
});
