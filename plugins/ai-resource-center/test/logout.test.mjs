// 對照 LC-AI-Pack SessionRevokerTests 與 LogoutFlowTests。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRevoker, clearSession } from '../worker/logout.mjs';
import { send } from '../worker/http.mjs';
import { startFakeMarket } from './fake-market.mjs';

const ACCESS = 'access-jwt-secret';
const REFRESH = 'lcrt_refresh-secret';
const NOW = Date.parse('2026-11-20T00:00:00Z');

const session = (accessLifetimeMs, refresh = REFRESH) => ({
  account: 'alice',
  token: ACCESS,
  expiresAt: new Date(NOW + accessLifetimeMs).toISOString(),
  refreshToken: refresh
});

function recording(respond = async () => ({ status: 200, headers: {}, text: '' })) {
  const sent = [];
  const t = async (req) => { sent.push(req); return respond(req); };
  t.sent = sent;
  return t;
}

test('撤銷：以登入當時的市集網址送出 POST logout，帶 Bearer 與 refresh token', async () => {
  const transport = recording();
  await createRevoker({ transport, now: () => NOW })('https://old.example/base', session(5 * 60000));
  assert.equal(transport.sent.length, 1);
  const [req] = transport.sent;
  assert.equal(req.method, 'POST');
  assert.equal(String(req.url), 'https://old.example/base/api/auth/logout');
  assert.equal(req.headers.Authorization, `Bearer ${ACCESS}`);
  assert.deepEqual(req.json, { refreshToken: REFRESH });
});

test('撤銷：access token 已過期或沒有 refresh token 時不送出', async () => {
  const transport = recording();
  const revoke = createRevoker({ transport, now: () => NOW });
  await revoke('https://old.example', session(-60000));
  await revoke('https://old.example', session(5 * 60000, null));
  assert.equal(transport.sent.length, 0);
});

test('撤銷：離線、伺服器錯誤、逾時都不擲例外，也不洩漏 token', async () => {
  const revokeOffline = createRevoker({ transport: recording(async () => { throw new Error(`fail ${ACCESS} ${REFRESH}`); }), now: () => NOW });
  await assert.doesNotReject(revokeOffline('https://old.example', session(60000)));
  const revoke500 = createRevoker({ transport: recording(async () => ({ status: 500, headers: {}, text: '' })), now: () => NOW });
  await assert.doesNotReject(revoke500('https://old.example', session(60000)));

  const m = await startFakeMarket();
  m.override('POST /api/auth/logout', () => undefined);
  const hang = await import('node:http').then(({ default: http }) => {
    const s = http.createServer(() => {}); // 永不回應
    return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
  });
  try {
    const started = Date.now();
    const revokeSlow = createRevoker({ transport: send, now: () => NOW, timeoutMs: 100 });
    await revokeSlow(`http://127.0.0.1:${hang.address().port}`, session(60000));
    assert.ok(Date.now() - started < 5000, '逾時後很快返回');
  } finally {
    hang.closeAllConnections?.();
    hang.close();
    await m.close();
  }
});

function countingStore() {
  const calls = [];
  return { calls, clear: async () => { calls.push('clear'); } };
}

test('登出：撤銷永遠不會完成，本機仍立即清除', async () => {
  const store = countingStore();
  await clearSession({ notice: null, current: session(60000), marketUrl: 'https://old.example', revoke: () => new Promise(() => {}), stopSession: () => {}, store });
  assert.deepEqual(store.calls, ['clear']);
});

test('登出：撤銷同步擲錯仍清除且不擲例外', async () => {
  const store = countingStore();
  await assert.doesNotReject(clearSession({ notice: null, current: session(60000), marketUrl: 'https://old.example', revoke: () => { throw new Error('boom'); }, stopSession: () => {}, store }));
  assert.deepEqual(store.calls, ['clear']);
});

test('登出：工作階段被拒絕（帶提示）時不撤銷，但仍清除', async () => {
  const store = countingStore();
  let revoked = 0;
  await clearSession({ notice: '登入已過期，請重新登入', current: session(60000), marketUrl: 'https://old.example', revoke: async () => { revoked++; }, stopSession: () => {}, store });
  assert.equal(revoked, 0);
  assert.deepEqual(store.calls, ['clear']);
});

test('登出：使用指定的舊網址與工作階段，並依「撤銷 → 停止 → 清除」順序', async () => {
  const store = countingStore();
  const order = [];
  const s = session(60000);
  let seen;
  await clearSession({
    notice: null,
    current: s,
    marketUrl: 'https://old.example',
    revoke: async (u, cur) => { order.push('revoke'); seen = [u, cur]; },
    stopSession: () => order.push('stop'),
    store: { clear: async () => order.push('clear') }
  });
  assert.deepEqual(order, ['revoke', 'stop', 'clear']);
  assert.equal(seen[0], 'https://old.example');
  assert.equal(seen[1], s);
});
