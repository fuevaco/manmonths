// 對照 AuthenticatingHandlerTests：帶 token、401 續期後重送一次、同源限制、補續通知、相容模式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketClient, SESSION_TEMPORARILY_UNAVAILABLE } from '../worker/market-client.mjs';

const MARKET = 'https://market.example/base';

function fakeManager() {
  const m = {
    token: 't1',
    notifyCalls: 0,
    refreshCalls: 0,
    onRefresh: async () => ({ outcome: 'refreshed' }),
    get currentAccessToken() { return m.token; },
    refresh() { m.refreshCalls += 1; return m.onRefresh(); },
    notifyRequestSucceeded() { m.notifyCalls += 1; },
    refreshTo(token) { m.onRefresh = async () => { m.token = token; return { outcome: 'refreshed' }; }; }
  };
  return m;
}

function fakeTransport(...statuses) {
  const sent = [];
  const t = async (req) => {
    sent.push(req);
    const s = statuses.shift();
    if (typeof s === 'function') return s(req);
    return { status: s ?? 200, headers: {}, text: '{}' };
  };
  t.sent = sent;
  return t;
}

const auth = (req) => req.headers?.Authorization;

test('每個請求都帶目前的 access token，並覆寫既有的 Authorization', async () => {
  const manager = fakeManager();
  const transport = fakeTransport(200, 200);
  const c = createMarketClient({ manager, marketUrl: MARKET, transport });
  await c.request({ path: 'api/market/categories' });
  manager.token = 't2';
  await c.request({ path: 'api/market/categories', headers: { Authorization: 'Bearer stale' } });
  assert.equal(String(transport.sent[0].url), 'https://market.example/base/api/market/categories');
  assert.deepEqual(transport.sent.map(auth), ['Bearer t1', 'Bearer t2']);
});

test('非 401 錯誤不觸發續期', async () => {
  const manager = fakeManager();
  const c = createMarketClient({ manager, marketUrl: MARKET, transport: fakeTransport(403, 500) });
  assert.equal((await c.request({ path: 'a' })).status, 403);
  assert.equal((await c.request({ path: 'a' })).status, 500);
  assert.equal(manager.refreshCalls, 0);
});

test('401 時續期並以新 token 重送一次（含 JSON 本文）', async () => {
  const manager = fakeManager();
  manager.refreshTo('t2');
  const transport = fakeTransport(401, 200);
  const c = createMarketClient({ manager, marketUrl: MARKET, transport });
  const res = await c.request({ method: 'POST', path: 'api/x', json: { a: 1 } });
  assert.equal(res.status, 200);
  assert.equal(manager.refreshCalls, 1);
  assert.deepEqual(transport.sent.map(auth), ['Bearer t1', 'Bearer t2']);
  assert.deepEqual(transport.sent[1].json, { a: 1 });
  assert.equal(manager.notifyCalls, 1);
});

test('重送後仍 401 直接回傳，不再續期', async () => {
  const manager = fakeManager();
  manager.refreshTo('t2');
  const transport = fakeTransport(401, 401);
  const c = createMarketClient({ manager, marketUrl: MARKET, transport });
  assert.equal((await c.request({ path: 'a' })).status, 401);
  assert.equal(manager.refreshCalls, 1);
  assert.equal(transport.sent.length, 2);
});

test('等待期間 token 已被其他請求換新：不續期，直接以目前 token 重送', async () => {
  const manager = fakeManager();
  const transport = fakeTransport(() => { manager.token = 't2'; return { status: 401, headers: {}, text: '' }; }, 200);
  const c = createMarketClient({ manager, marketUrl: MARKET, transport });
  assert.equal((await c.request({ path: 'a' })).status, 200);
  assert.equal(manager.refreshCalls, 0);
  assert.deepEqual(transport.sent.map(auth), ['Bearer t1', 'Bearer t2']);
});

test('續期為暫時性失敗時擲出固定訊息，不含任何 token', async () => {
  const manager = fakeManager();
  manager.onRefresh = async () => ({ outcome: 'transient' });
  const c = createMarketClient({ manager, marketUrl: MARKET, transport: fakeTransport(401) });
  await assert.rejects(c.request({ path: 'a' }), (e) => e.code === 'session_unavailable' && e.message === SESSION_TEMPORARILY_UNAVAILABLE && !e.message.includes('t1'));
});

for (const reason of ['session_expired', 'account_unavailable']) {
  test(`續期被拒絕（${reason}）回原 401，不重送也不另外通知`, async () => {
    const manager = fakeManager();
    manager.onRefresh = async () => ({ outcome: 'rejected', reason });
    let notified = 0;
    const transport = fakeTransport(401);
    const c = createMarketClient({ manager, marketUrl: MARKET, transport, onUnauthorizedWithoutRefresh: () => notified++ });
    assert.equal((await c.request({ path: 'a' })).status, 401);
    assert.equal(transport.sent.length, 1);
    assert.equal(notified, 0);
  });
}

test('相容模式（無法續期）收到 401：回原 401，並只通知一次工作階段過期', async () => {
  const manager = fakeManager();
  manager.onRefresh = async () => ({ outcome: 'unsupported' });
  const seen = [];
  const c = createMarketClient({ manager, marketUrl: MARKET, transport: fakeTransport(401, 401), onUnauthorizedWithoutRefresh: (e) => seen.push(e.reason) });
  assert.equal((await c.request({ path: 'a' })).status, 401);
  assert.equal((await c.request({ path: 'a' })).status, 401);
  assert.deepEqual(seen, ['session_expired']);
});

test('相容模式的通知訂閱者擲錯不影響回應', async () => {
  const manager = fakeManager();
  manager.onRefresh = async () => ({ outcome: 'unsupported' });
  const c = createMarketClient({ manager, marketUrl: MARKET, transport: fakeTransport(401), onUnauthorizedWithoutRefresh: () => { throw new Error('boom'); } });
  assert.equal((await c.request({ path: 'a' })).status, 401);
});

test('只有 2xx 的最終回應通知補續', async () => {
  for (const [status, expected] of [[200, 1], [204, 1], [404, 0], [500, 0]]) {
    const manager = fakeManager();
    const c = createMarketClient({ manager, marketUrl: MARKET, transport: fakeTransport(status) });
    await c.request({ path: 'a' });
    assert.equal(manager.notifyCalls, expected, `HTTP ${status}`);
  }
});

test('傳輸失敗原樣擲出且不通知', async () => {
  const manager = fakeManager();
  const boom = new Error('offline');
  const c = createMarketClient({ manager, marketUrl: MARKET, transport: async () => { throw boom; } });
  await assert.rejects(c.request({ path: 'a' }), (e) => e === boom);
  assert.equal(manager.notifyCalls, 0);
});

test('續期因工作階段已停止（登出中）而失敗：回原 401，不重送', async () => {
  const manager = fakeManager();
  manager.onRefresh = async () => { throw Object.assign(new Error('stopped'), { code: 'stopped' }); };
  const transport = fakeTransport(401);
  const c = createMarketClient({ manager, marketUrl: MARKET, transport });
  assert.equal((await c.request({ path: 'a' })).status, 401);
  assert.equal(transport.sent.length, 1);
});

for (const url of ['https://market.example:8443/base/x', 'http://market.example/base/x', 'https://cdn.example/x']) {
  test(`不同來源的請求不帶 token，401 也不續期：${url}`, async () => {
    const manager = fakeManager();
    const transport = fakeTransport(401);
    const c = createMarketClient({ manager, marketUrl: MARKET, transport });
    assert.equal((await c.request({ url, headers: { Authorization: 'Bearer x' } })).status, 401);
    assert.equal(auth(transport.sent[0]), undefined);
    assert.equal(manager.refreshCalls, 0);
  });
}

test('同源但不同路徑的請求仍帶 token', async () => {
  const manager = fakeManager();
  const transport = fakeTransport(200);
  const c = createMarketClient({ manager, marketUrl: MARKET, transport });
  await c.request({ url: 'https://MARKET.example/other/path' });
  assert.equal(auth(transport.sent[0]), 'Bearer t1');
});
