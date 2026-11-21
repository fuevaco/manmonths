// 資源包大小防護（zip bomb）。LC-AI-Pack 只限制壓縮後 100 MB（市集 Market:MaxPackageSizeMB），沒有解壓上限；
// 資源中心在記憶體解壓，因此另外限制項目數、單檔與總解壓大小，且解壓前先看宣告大小並限制輸出長度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { validatePackage, PackageLimits } from '../worker/package-validator.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker } from './harness.mjs';
import { createSessionService } from '../worker/session-service.mjs';
import { createPackageService } from '../worker/package-service.mjs';
import { createDownloadService } from '../worker/download-service.mjs';
import { zip, manifest } from './zip-fixture.mjs';

const identity = { packageKey: 'demo', version: '1.0.0' };
const sha = b => createHash('sha256').update(b).digest('hex');
const withManifest = extra => ({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo', 'resources/hello/SKILL.md': 'hello', ...extra });

test('預設上限：下載 100 MB（同市集），項目數與解壓大小有明確數字', () => {
  assert.equal(PackageLimits.maxDownloadBytes, 100 * 1024 * 1024);
  for (const key of ['maxEntries', 'maxEntryBytes', 'maxTotalBytes']) assert.ok(Number.isSafeInteger(PackageLimits[key]) && PackageLimits[key] > 0);
  assert.ok(PackageLimits.maxEntryBytes <= PackageLimits.maxTotalBytes);
});

test('項目數超過上限時拒絕', () => {
  const entries = withManifest({ 'resources/hello/a.md': 'a', 'resources/hello/b.md': 'b' });
  assert.throws(() => validatePackage(zip(entries), identity, { maxEntries: 4 }), { code: 'invalid_package', message: /項目數/ });
  assert.doesNotThrow(() => validatePackage(zip(entries), identity, { maxEntries: 5 }));
});

test('單檔解壓大小超過上限時拒絕', () => {
  const bomb = zip(withManifest({ 'resources/hello/big.bin': Buffer.alloc(2 * 1024 * 1024) }));
  assert.throws(() => validatePackage(bomb, identity, { maxEntryBytes: 1024 * 1024 }), { code: 'invalid_package', message: /單一檔案/ });
});

test('總解壓大小超過上限時拒絕', () => {
  const entries = withManifest({ 'resources/hello/a.bin': Buffer.alloc(600 * 1024), 'resources/hello/b.bin': Buffer.alloc(600 * 1024) });
  assert.throws(() => validatePackage(zip(entries), identity, { maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 }), { code: 'invalid_package', message: /解壓後總大小/ });
});

test('標頭謊報大小：實際解壓內容超出宣告值時拒絕', () => {
  const bytes = zip(withManifest({ 'resources/hello/lie.bin': Buffer.alloc(1024 * 1024) }));
  const name = Buffer.from('resources/hello/lie.bin');
  let offset = bytes.readUInt32LE(bytes.length - 6), patched = false;
  for (let i = 0; i < 10 && !patched; i++) {
    const len = bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 46, offset + 46 + len).equals(name)) { bytes.writeUInt32LE(10, offset + 24); patched = true; }
    offset += 46 + len + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  assert.ok(patched);
  assert.throws(() => validatePackage(bytes, identity), { code: 'invalid_package' });
});

test('下載超過大小上限時拒絕：不寫入檔案、回報資源包過大', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-download-cap-'));
  const market = await startFakeMarket();
  const worker = startWorker({ deps: { userHome: dir, env: {} } });
  const session = createSessionService({ orca: worker.orca });
  const downloads = createDownloadService({ session, packages: createPackageService(session), maxDownloadBytes: 1024 });
  t.after(async () => { session.dispose(); worker.dispose(); await market.close(); await rm(dir, { recursive: true, force: true }); });
  const big = zip(withManifest({ 'resources/hello/SKILL.md': randomBytes(4096).toString('hex') }));
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: sha(big) }] } }));
  market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: big, headers: { 'X-Checksum-Sha256': sha(big) } }));
  await session.signIn({ marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  await assert.rejects(downloads.fetchVerified({ packageKey: 'demo', version: '1.0.0' }), { code: 'invalid_package', message: /大小上限/ });
  assert.deepEqual(await readdir(dir), []);
});
