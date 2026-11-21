import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker } from './harness.mjs';
import { zip, manifest } from './zip-fixture.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-download-'));
  const market = await startFakeMarket();
  const worker = startWorker({ deps: { downloadDirectory: dir } });
  t.after(async () => { worker.dispose(); await market.close(); await rm(dir, { recursive: true, force: true }); });
  const bytes = zip();
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo',
    recommendedVersion: '2.0.0', versions: ['1.0.0', '2.0.0'].map(version => ({ version, isEnabled: true, channel: 'release', sha256: sha(bytes) })) } }));
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes,
    headers: { 'X-Checksum-Sha256': sha(bytes) }, contentType: 'application/zip' }));
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { dir, market, worker, bytes };
}

test('單獨下載取得所選確切版本 ZIP，只產生該檔案且沒有部署收據', async t => {
  const { worker, dir, bytes, market } = await setup(t);
  const result = await worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0' });
  assert.equal(result.filePath, path.join(dir, 'demo-1.0.0.zip'));
  assert.deepEqual(await readFile(result.filePath), bytes);
  assert.deepEqual(await readdir(dir), ['demo-1.0.0.zip']);
  assert.equal(worker.state.storage.size, 0);
  assert.equal(market.requests.filter(r => r.path.endsWith('/download')).length, 1);
});

test('拒絕無效 ZIP 與 canonical 格式，不留下檔案，修復後可安全重試', async t => {
  const { worker, dir, market, bytes } = await setup(t);
  for (const invalid of [Buffer.from('not a zip'), zip({ 'lcpack.json': JSON.stringify({ ...manifest, packageFormatVersion: 2 }), 'README.md': 'x' })]) {
    market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: sha(invalid) }] } }));
    market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: invalid, headers: { 'X-Checksum-Sha256': sha(invalid) } }));
    await assert.rejects(worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0' }), { code: 'invalid_package' });
    assert.deepEqual(await readdir(dir), []);
  }
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: sha(bytes) }] } }));
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes, headers: { 'X-Checksum-Sha256': sha(bytes) } }));
  assert.equal((await worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0' })).sha256, sha(bytes));
});

for (const entry of ['../escaped.txt', 'assets/../../escaped.txt', '/escaped.txt', 'C:/escaped.txt', '..\\escaped.txt', 'a:stream', 'a./file', 'resources/tool.EXE', 'node_modules/a.js']) {
  test(`下載拒絕不安全或禁止的封裝路徑 ${entry}`, async t => {
    const { worker, dir, market } = await setup(t);
    const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': 'x', [entry]: 'x' });
    market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: sha(bytes) }] } }));
    market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes }));
    await assert.rejects(worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0' }), e => ['unsafe_path', 'invalid_package'].includes(e.code));
    assert.deepEqual(await readdir(dir), []);
  });
}

test('SHA-256 比對 metadata 及下載標頭；錯誤不改寫既有下載，可重試', async t => {
  const { worker, dir, market, bytes } = await setup(t);
  const input = { packageKey: 'demo', version: '1.0.0' };
  const saved = await worker.call('rc.download.save', input);
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes, headers: { 'X-Checksum-Sha256': '0'.repeat(64) } }));
  await assert.rejects(worker.call('rc.download.save', input), { code: 'checksum_mismatch' });
  assert.deepEqual(await readFile(saved.filePath), bytes);
  assert.deepEqual(await readdir(dir), ['demo-1.0.0.zip']);
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: Buffer.from('corrupt') }));
  await assert.rejects(worker.call('rc.download.save', input), { code: 'checksum_mismatch' });
});

test('下載中斷不留下檔案，再次下載可成功，401 續期也沿用同版本', async t => {
  const { worker, dir, market, bytes } = await setup(t);
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ disconnect: true }));
  await assert.rejects(worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0' }), { code: 'unreachable' });
  assert.deepEqual(await readdir(dir), []);
  const firstToken = `Bearer ${JSON.parse(worker.state.secrets.get('session.v1')).token}`;
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', req => req.headers.authorization === firstToken
    ? { status: 401, body: {} } : { status: 200, raw: bytes });
  const result = await worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0' });
  assert.deepEqual(await readFile(result.filePath), bytes);
});

test('ZIP 下載不套用 JSON 回應的 8 MB 上限', async t => {
  const { worker, market } = await setup(t);
  const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': 'x', 'resources/data.txt': randomBytes(9 * 1024 * 1024).toString('base64') });
  assert.ok(bytes.length > 8 * 1024 * 1024);
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: sha(bytes) }] } }));
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes }));
  assert.equal((await worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0' })).fileSize, bytes.length);
});

test('儲存位置無法建立時回報可重試的原因且保留原檔案', async t => {
  const { worker, dir } = await setup(t);
  const saved = await worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0' });
  await assert.rejects(worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0', destinationFile: path.join(saved.filePath, 'another.zip') }), { code: 'save_failed' });
  assert.deepEqual(await readdir(dir), ['demo-1.0.0.zip']);
});
