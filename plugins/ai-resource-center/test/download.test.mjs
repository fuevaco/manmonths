import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker } from './harness.mjs';
import { createSessionService } from '../worker/session-service.mjs';
import { createPackageService } from '../worker/package-service.mjs';
import { createDownloadService } from '../worker/download-service.mjs';
import { zip, manifest } from './zip-fixture.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-download-'));
  const market = await startFakeMarket();
  const worker = startWorker({ deps: { userHome: dir, env: {} } });
  const session = createSessionService({ orca: worker.orca });
  const downloads = createDownloadService({ session, packages: createPackageService(session) });
  t.after(async () => { session.dispose(); worker.dispose(); await market.close(); await rm(dir, { recursive: true, force: true }); });
  const bytes = zip();
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo',
    recommendedVersion: '2.0.0', versions: ['1.0.0', '2.0.0'].map(version => ({ version, isEnabled: true, channel: 'release', sha256: sha(bytes) })) } }));
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes,
    headers: { 'X-Checksum-Sha256': sha(bytes) }, contentType: 'application/zip' }));
  await session.signIn({ marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { dir, market, worker, downloads, bytes };
}

test('worker 不再註冊單獨下載請求，內部服務不提供存檔方法', async t => {
  const { worker, downloads } = await setup(t);
  assert.equal(worker.handlers.has('rc.download.save'), false);
  await assert.rejects(worker.call('rc.download.save', { packageKey: 'demo', version: '1.0.0' }), /沒有註冊的請求/);
  assert.equal(downloads.save, undefined);
});

test('內部下載取得所選確切版本 ZIP，不寫入檔案或部署收據', async t => {
  const { downloads, worker, dir, bytes, market } = await setup(t);
  const result = await downloads.fetchVerified({ packageKey: 'demo', version: '1.0.0' });
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.version.version, '1.0.0');
  assert.equal(result.sha256, sha(bytes));
  assert.deepEqual(await readdir(dir), []);
  assert.equal(worker.state.storage.size, 0);
  assert.equal(market.requests.filter(r => r.path.endsWith('/download')).length, 1);
});

test('拒絕無效 ZIP 與 canonical 格式，不留下檔案，修復後可安全重試', async t => {
  const { downloads, dir, market, bytes } = await setup(t);
  for (const invalid of [Buffer.from('not a zip'), zip({ 'lcpack.json': JSON.stringify({ ...manifest, packageFormatVersion: 2 }), 'README.md': 'x' })]) {
    market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: sha(invalid) }] } }));
    market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: invalid, headers: { 'X-Checksum-Sha256': sha(invalid) } }));
    await assert.rejects(downloads.fetchVerified({ packageKey: 'demo', version: '1.0.0' }), { code: 'invalid_package' });
    assert.deepEqual(await readdir(dir), []);
  }
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: sha(bytes) }] } }));
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes, headers: { 'X-Checksum-Sha256': sha(bytes) } }));
  assert.equal((await downloads.fetchVerified({ packageKey: 'demo', version: '1.0.0' })).sha256, sha(bytes));
});

for (const entry of ['../escaped.txt', 'assets/../../escaped.txt', '/escaped.txt', 'C:/escaped.txt', '..\\escaped.txt', 'a:stream', 'a./file', 'resources/tool.EXE', 'node_modules/a.js']) {
  test(`下載拒絕不安全或禁止的封裝路徑 ${entry}`, async t => {
    const { downloads, dir, market } = await setup(t);
    const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': 'x', [entry]: 'x' });
    market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: sha(bytes) }] } }));
    market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes }));
    await assert.rejects(downloads.fetchVerified({ packageKey: 'demo', version: '1.0.0' }), e => ['unsafe_path', 'invalid_package'].includes(e.code));
    assert.deepEqual(await readdir(dir), []);
  });
}

test('內部下載 SHA-256 比對 metadata 及下載標頭；錯誤後可重試', async t => {
  const { downloads, dir, market, bytes } = await setup(t);
  const input = { packageKey: 'demo', version: '1.0.0' };
  assert.deepEqual((await downloads.fetchVerified(input)).bytes, bytes);
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes, headers: { 'X-Checksum-Sha256': '0'.repeat(64) } }));
  await assert.rejects(downloads.fetchVerified(input), { code: 'checksum_mismatch' });
  assert.deepEqual(await readdir(dir), []);
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: Buffer.from('corrupt') }));
  await assert.rejects(downloads.fetchVerified(input), { code: 'checksum_mismatch' });
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes }));
  assert.deepEqual((await downloads.fetchVerified(input)).bytes, bytes);
  assert.deepEqual(await readdir(dir), []);
});

test('下載中斷不留下檔案，再次下載可成功，401 續期也沿用同版本', async t => {
  const { downloads, worker, dir, market, bytes } = await setup(t);
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ disconnect: true }));
  await assert.rejects(downloads.fetchVerified({ packageKey: 'demo', version: '1.0.0' }), { code: 'unreachable' });
  assert.deepEqual(await readdir(dir), []);
  const firstToken = `Bearer ${JSON.parse(worker.state.secrets.get('session.v1')).token}`;
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', req => req.headers.authorization === firstToken
    ? { status: 401, body: {} } : { status: 200, raw: bytes });
  const result = await downloads.fetchVerified({ packageKey: 'demo', version: '1.0.0' });
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.version.version, '1.0.0');
});

test('ZIP 下載不套用 JSON 回應的 8 MB 上限', async t => {
  const { downloads, market } = await setup(t);
  const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': 'x', 'resources/data.txt': randomBytes(9 * 1024 * 1024).toString('base64') });
  assert.ok(bytes.length > 8 * 1024 * 1024);
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: sha(bytes) }] } }));
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes }));
  assert.equal((await downloads.fetchVerified({ packageKey: 'demo', version: '1.0.0' })).bytes.length, bytes.length);
});
