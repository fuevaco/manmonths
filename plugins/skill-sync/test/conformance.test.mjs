import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/mock-server.mjs';
import { verifyApi } from '../worker/conformance.mjs';
import { createClient, ApiError } from '../worker/api-client.mjs';

const skillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'skills');
const servers = [];
const boot = async (opts) => {
  const s = await startServer({ skillsDir, token: 'secret', prefix: '/api/v1', ...opts });
  servers.push(s);
  return s;
};
after(() => Promise.all(servers.map((s) => s.close())));

const statusOf = (report, id) => report.checks.find((c) => c.id === id)?.status;

test('參考實作通過全部檢查', async () => {
  const s = await boot();
  const r = await verifyApi({ baseUrl: s.url, token: 'secret' });
  assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => c.status === 'fail')));
  assert.equal(r.summary.fail, 0);
  assert.equal(r.summary.warn, 0);
  assert.equal(r.checks.filter((c) => c.id.startsWith('skill:')).length, 2);
});

test('Token 錯誤：索引直接 401，驗證失敗並說明原因', async () => {
  const s = await boot();
  const r = await verifyApi({ baseUrl: s.url, token: 'wrong' });
  assert.equal(r.ok, false);
  assert.equal(statusOf(r, 'index.reachable'), 'fail');
  assert.match(r.checks[0].detail, /401/);
});

test('伺服器沒有真的檢查 Token（接受任何 Token）會被判定不合標準', async () => {
  const s = await boot({ acceptAnyToken: true });
  const r = await verifyApi({ baseUrl: s.url, token: 'secret' });
  assert.equal(r.ok, false);
  assert.equal(statusOf(r, 'auth.bad-token'), 'fail');
});

test('公開 API：預設只警告；加 requireAuth 才算失敗', async () => {
  const s = await boot({ publicApi: true });
  const loose = await verifyApi({ baseUrl: s.url, token: 'whatever' });
  assert.ok(loose.ok);
  assert.equal(statusOf(loose, 'auth.no-token'), 'warn');
  const strict = await verifyApi({ baseUrl: s.url, token: 'whatever' }, { requireAuth: true });
  assert.equal(strict.ok, false);
});

test('檔案被竄改（內容與清單雜湊不符）會被抓到', async () => {
  const s = await boot({ tamper: 'hello-skill' });
  const r = await verifyApi({ baseUrl: s.url, token: 'secret' });
  assert.equal(r.ok, false);
  assert.equal(statusOf(r, 'skill:hello-skill'), 'fail');
  assert.equal(statusOf(r, 'skill:commit-helper'), 'pass');
});

test('網址錯誤、連不上都有明確失敗訊息', async () => {
  assert.equal((await verifyApi({ baseUrl: '' })).ok, false);
  const r = await verifyApi({ baseUrl: 'http://127.0.0.1:1/api/', timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(statusOf(r, 'index.reachable'), 'fail');
});

test('Token 不會透過未加密 HTTP 傳給非本機主機', async () => {
  const c = createClient({ baseUrl: 'http://skills.example.com/api/', token: 'secret' });
  await assert.rejects(c.getIndex(), (e) => e instanceof ApiError && e.code === 'insecure_transport');
});

test('用戶端：etag 命中時回 notModified；清單 digest 與索引不符則拒絕', async () => {
  const s = await boot();
  const c = createClient({ baseUrl: s.url, token: 'secret' });
  const first = await c.getIndex();
  assert.ok(first.etag);
  const again = await c.getIndex({ etag: first.etag });
  assert.equal(again.notModified, true);
  const forged = { ...first.index.skills[0], digest: `sha256:${'1'.repeat(64)}` };
  await assert.rejects(c.getManifest(forged), (e) => e.code === 'invalid_manifest');
});

test('用戶端：下載的檔案被竄改 → 拒絕，不回傳任何檔案', async () => {
  // append：檔案變大，在大小上限就被擋；flip：大小不變，只有雜湊檢查能抓到
  for (const [tamperMode, code] of [['append', 'too_large'], ['flip', 'integrity']]) {
    const s = await boot({ tamper: 'commit-helper', tamperMode });
    const c = createClient({ baseUrl: s.url, token: 'secret' });
    const { index } = await c.getIndex();
    const entry = index.skills.find((x) => x.name === 'commit-helper');
    const { manifest, manifestUrl } = await c.getManifest(entry);
    await assert.rejects(c.downloadSkill(manifest, manifestUrl), (e) => e.code === code, tamperMode);
  }
});

test('Token 只送往 API 同一來源：轉址到他站時不帶 Authorization', async () => {
  const http = await import('node:http');
  let leaked = '';
  const other = http.createServer((req, res) => { leaked = req.headers.authorization || ''; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const redirector = http.createServer((req, res) => { res.writeHead(302, { Location: `http://localhost:${other.address().port}/x` }); res.end(); });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const { httpGet } = await import('../worker/http.mjs');
  const res = await httpGet(`http://127.0.0.1:${redirector.address().port}/`, { token: 'secret' });
  assert.equal(res.status, 200);
  assert.equal(leaked, '', 'Token 不該被送到另一個來源');
  other.close(); redirector.close();
});
