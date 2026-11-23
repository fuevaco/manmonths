// 對照 SessionManagerTests：single-flight 續期、結果分類、立即重試、退避、排程、補續與停止。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager, REFRESH_INTERVAL_MS, IMMEDIATE_RETRY_DELAY_MS, TRANSIENT_BACKOFF_MS } from '../worker/session-manager.mjs';
import { HttpError } from '../worker/http.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-20T00:00:00Z');
const REFRESH = 'lcrt_refresh-secret';
const ACCESS = 'access-secret';

function fixture({ session: overrides = {}, marketUrl = 'https://market.example/base' } = {}) {
  let nowMs = T0;
  const requests = [];
  const script = [];
  const saved = [];
  const delays = [];
  let saveError = null;

  const transport = (req) => {
    requests.push(req);
    const next = script.shift();
    if (!next) return new Promise(() => {}); // 沒安排回應：一直等（可被取消）
    return next(req);
  };
  const respond = (status, body) => script.push(() => Promise.resolve({ status, headers: {}, text: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body) }));
  const fail = (err) => script.push(() => Promise.reject(err));
  const pending = () => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    script.push((req) => new Promise((res, rej) => {
      req.signal?.addEventListener('abort', () => rej(new HttpError('cancelled', '已取消')), { once: true });
      p.then(res);
    }));
    return (status, body) => resolve({ status, headers: {}, text: JSON.stringify(body) });
  };
  // 受控的等待：測試呼叫 release() 時才讓時間前進並結束等待
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    const entry = { ms, release: () => { nowMs += ms; resolve(); } };
    delays.push(entry);
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

  const session = {
    marketUrl,
    account: 'alice',
    token: ACCESS,
    expiresAt: new Date(T0 + HOUR).toISOString(),
    refreshToken: REFRESH,
    refreshExpiresAt: new Date(T0 + 7 * 24 * HOUR).toISOString(),
    lastRefreshedAt: new Date(T0 - HOUR).toISOString(),
    ...overrides
  };
  const store = { save: async (s) => { if (saveError) throw saveError; saved.push(structuredClone(s)); } };
  const manager = createSessionManager({ session, store, transport, now: () => nowMs, delay });
  return {
    manager, requests, saved, delays, respond, fail, pending,
    advance: (ms) => { nowMs += ms; },
    now: () => nowMs,
    failSaves: (e) => { saveError = e; }
  };
}

const rotated = (n = 2) => ({
  token: `access-${n}`,
  expiresAt: new Date(T0 + 2 * HOUR).toISOString(),
  refreshToken: `lcrt_rotated-${n}`,
  refreshExpiresAt: new Date(T0 + 8 * 24 * HOUR).toISOString()
});

const settle = () => new Promise((r) => setImmediate(r));
async function until(cond, label) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await settle();
  }
  assert.fail(`等待逾時：${label}`);
}

test('並行續期共用同一個請求與同一個結果', async () => {
  const f = fixture();
  const finish = f.pending();
  const a = f.manager.refresh();
  const b = f.manager.refresh();
  finish(200, rotated());
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.outcome, 'refreshed');
  assert.deepEqual(ra, rb);
  assert.equal(f.requests.length, 1);
});

test('成功時儲存輪替後的工作階段、更新目前值，之後才發出事件', async () => {
  const f = fixture();
  const seen = [];
  f.manager.onRefreshed((e) => seen.push({ e, saved: f.saved.length, token: f.manager.currentAccessToken }));
  f.respond(200, rotated());
  const r = await f.manager.refresh();
  assert.equal(r.outcome, 'refreshed');
  assert.equal(f.manager.current.account, 'alice', '保留帳號');
  assert.equal(f.manager.current.marketUrl, 'https://market.example/base', '保留綁定的市集');
  assert.equal(f.manager.currentAccessToken, 'access-2');
  assert.equal(f.manager.current.refreshToken, 'lcrt_rotated-2');
  assert.equal(f.manager.current.lastRefreshedAt, new Date(T0).toISOString());
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].token, 'access-2');
  assert.deepEqual(seen, [{ e: { account: 'alice', expiresAt: rotated().expiresAt }, saved: 1, token: 'access-2' }]);
  assert.equal(f.manager.state, 'healthy');
  assert.equal(f.manager.nextRefreshAt, T0 + REFRESH_INTERVAL_MS);
});

test('續期請求只送 refresh token、不帶 Authorization，並保留市集子路徑', async () => {
  const f = fixture();
  f.respond(200, rotated());
  await f.manager.refresh();
  const [req] = f.requests;
  assert.equal(req.method, 'POST');
  assert.equal(String(req.url), 'https://market.example/base/api/auth/refresh');
  assert.deepEqual(req.json, { refreshToken: REFRESH });
  assert.equal(req.headers?.Authorization, undefined);
});

test('存檔失敗仍視為續期成功，記憶體已更新', async () => {
  const f = fixture();
  f.failSaves(new Error('disk full'));
  f.respond(200, rotated());
  assert.equal((await f.manager.refresh()).outcome, 'refreshed');
  assert.equal(f.manager.currentAccessToken, 'access-2');
});

test('事件訂閱者擲錯不影響續期', async () => {
  const f = fixture();
  f.manager.onRefreshed(() => { throw new Error('boom'); });
  f.respond(200, rotated());
  assert.equal((await f.manager.refresh()).outcome, 'refreshed');
  assert.equal(f.manager.state, 'healthy');
});

for (const [label, status, body, reason] of [
  ['401 帳號無法使用', 401, { code: 'auth.account-unavailable' }, 'account_unavailable'],
  ['401 工作階段失效', 401, { code: 'auth.session-invalid' }, 'session_expired'],
  ['401 未知代碼', 401, { code: 'x' }, 'session_expired'],
  ['401 無內容', 401, undefined, 'session_expired'],
  ['400', 400, {}, 'session_expired'],
  ['422', 422, {}, 'session_expired']
]) {
  test(`明確拒絕（${label}）只發一次事件並進入終態`, async () => {
    const f = fixture();
    const rejected = [];
    f.manager.onRejected((e) => rejected.push(e.reason));
    f.respond(status, body);
    const r = await f.manager.refresh();
    assert.deepEqual(r, { outcome: 'rejected', reason });
    assert.deepEqual(await f.manager.refresh(), r, '終態直接回快取結果');
    assert.equal(f.requests.length, 1, '終態不再送請求');
    assert.deepEqual(rejected, [reason]);
    assert.equal(f.manager.state, 'rejected');
    assert.equal(f.manager.canRefresh, false);
    assert.equal(f.manager.nextRefreshAt, null);
    assert.equal(f.saved.length, 0, '拒絕時不動儲存');
  });
}

test('404（舊伺服器）為不支援續期的終態，不發事件', async () => {
  const f = fixture();
  const events = [];
  f.manager.onRejected((e) => events.push(e));
  f.respond(404, {});
  assert.deepEqual(await f.manager.refresh(), { outcome: 'unsupported' });
  assert.equal(f.manager.state, 'unsupported');
  assert.equal(events.length, 0);
});

test('沒有 refresh token 的工作階段從不排程也不送請求', async () => {
  const f = fixture({ session: { refreshToken: undefined, refreshExpiresAt: undefined } });
  assert.equal(f.manager.state, 'unsupported');
  assert.equal(f.manager.nextRefreshAt, null);
  f.manager.start();
  await f.manager.schedulerDone;
  assert.deepEqual(await f.manager.refresh(), { outcome: 'unsupported' });
  assert.equal(f.requests.length, 0);
});

for (const [label, arrange, expectedRequests] of [
  ['5xx（可能已送達，立即重試一次）', (f) => { f.respond(500); f.respond(503); }, 2],
  ['逾時（可能已送達）', (f) => { f.fail(new HttpError('timeout', 't')); f.fail(new HttpError('timeout', 't')); }, 2],
  ['連線中斷（可能已送達）', (f) => { f.fail(new HttpError('network', 'n')); f.fail(new HttpError('network', 'n')); }, 2],
  ['2xx 但內容不完整', (f) => { f.respond(200, { token: 'x' }); f.respond(200, 'not json'); }, 2],
  ['無法連線（確定未送出）', (f) => f.fail(new HttpError('not_sent', 'refused', { notSent: true })), 1],
  ['429', (f) => f.respond(429, {}), 1],
  ['403', (f) => f.respond(403, {}), 1],
  ['408', (f) => f.respond(408, {}), 1]
]) {
  test(`暫時性失敗不打擾使用者並退避一分鐘：${label}`, async () => {
    const f = fixture();
    const events = [];
    f.manager.onRejected((e) => events.push(e));
    arrange(f);
    const p = f.manager.refresh();
    if (expectedRequests === 2) {
      await until(() => f.delays.length === 1, '立即重試的等待');
      assert.equal(f.delays[0].ms, IMMEDIATE_RETRY_DELAY_MS);
      f.delays[0].release();
    }
    assert.deepEqual(await p, { outcome: 'transient' });
    assert.equal(f.requests.length, expectedRequests);
    if (expectedRequests === 2) assert.deepEqual(f.requests[1].json, f.requests[0].json, '以同一個 refresh token 重送');
    assert.equal(f.manager.state, 'transient_failure');
    assert.equal(f.manager.nextRefreshAt, f.now() + MIN);
    assert.equal(events.length, 0);
  });
}

test('立即重試的結果照一般規則分類', async () => {
  const f = fixture();
  f.respond(502);
  f.respond(401, { code: 'auth.session-invalid' });
  const p = f.manager.refresh();
  await until(() => f.delays.length === 1, '重試等待');
  f.delays[0].release();
  assert.deepEqual(await p, { outcome: 'rejected', reason: 'session_expired' });
});

test('連續暫時性失敗依 1、5、15、60 分鐘退避，之後固定 60 分鐘；成功後歸零', async () => {
  assert.deepEqual(TRANSIENT_BACKOFF_MS, [MIN, 5 * MIN, 15 * MIN, 60 * MIN]);
  const f = fixture();
  const expected = [1, 5, 15, 60, 60];
  for (const minutes of expected) {
    f.fail(new HttpError('not_sent', 'x', { notSent: true }));
    await f.manager.refresh();
    assert.equal(f.manager.nextRefreshAt, f.now() + minutes * MIN);
  }
  f.respond(200, rotated());
  await f.manager.refresh();
  assert.equal(f.manager.nextRefreshAt, f.now() + REFRESH_INTERVAL_MS);
  f.fail(new HttpError('not_sent', 'x', { notSent: true }));
  await f.manager.refresh();
  assert.equal(f.manager.nextRefreshAt, f.now() + MIN, '成功後退避歸零');
});

for (const hoursAgo of [null, 24, 30]) {
  test(`啟動時從未續期或距上次已滿 24 小時立即續期（${hoursAgo ?? '從未'}）`, async () => {
    const f = fixture({ session: { lastRefreshedAt: hoursAgo === null ? undefined : new Date(T0 - hoursAgo * HOUR).toISOString() } });
    assert.equal(f.manager.nextRefreshAt, T0);
    f.respond(200, rotated());
    f.manager.start();
    await until(() => f.requests.length === 1, '立即續期');
    await until(() => f.manager.state === 'healthy' && f.manager.currentAccessToken === 'access-2', '續期完成');
    f.manager.stop();
  });
}

test('啟動時距上次續期未滿 24 小時，等到期才續期（每次最多等 1 分鐘）', async () => {
  const f = fixture({ session: { lastRefreshedAt: new Date(T0 - 23 * HOUR - 58 * MIN).toISOString() } });
  assert.equal(f.manager.nextRefreshAt, T0 + 2 * MIN);
  f.respond(200, rotated());
  f.manager.start();
  await until(() => f.delays.length === 1, '第一次等待');
  assert.equal(f.delays[0].ms, MIN);
  assert.equal(f.requests.length, 0);
  f.delays[0].release();
  await until(() => f.delays.length === 2, '第二次等待');
  f.delays[1].release();
  await until(() => f.requests.length === 1, '到期續期');
  f.manager.stop();
});

test('睡眠後時鐘跳躍，下一次檢查即觸發續期', async () => {
  const f = fixture({ session: { lastRefreshedAt: new Date(T0 - HOUR).toISOString() } });
  f.respond(200, rotated());
  f.manager.start();
  await until(() => f.delays.length === 1, '等待中');
  f.advance(30 * HOUR); // 電腦睡眠
  f.delays[0].release();
  await until(() => f.requests.length === 1, '醒來後續期');
  f.manager.stop();
});

test('時鐘被調回時，下一次續期不會延後超過 24 小時', async () => {
  const f = fixture({ session: { lastRefreshedAt: new Date(T0 + 48 * HOUR).toISOString() } });
  assert.equal(f.manager.nextRefreshAt, T0 + REFRESH_INTERVAL_MS);
});

test('暫時性失敗期間任一請求成功時立即補續一次，且不阻塞呼叫者', async () => {
  const f = fixture();
  f.fail(new HttpError('not_sent', 'x', { notSent: true }));
  await f.manager.refresh();
  f.respond(200, rotated());
  f.manager.notifyRequestSucceeded();
  assert.equal(f.manager.isRefreshing, true);
  await until(() => f.manager.state === 'healthy', '補續完成');
  assert.equal(f.requests.length, 2);
});

test('健康狀態下請求成功不觸發續期', async () => {
  const f = fixture();
  f.manager.notifyRequestSucceeded();
  await settle();
  assert.equal(f.requests.length, 0);
});

test('補續只由非補續觸發的暫時性失敗重新上膛', async () => {
  const f = fixture();
  f.fail(new HttpError('not_sent', 'x', { notSent: true }));
  await f.manager.refresh();
  f.fail(new HttpError('not_sent', 'x', { notSent: true }));
  f.manager.notifyRequestSucceeded();
  await until(() => !f.manager.isRefreshing && f.requests.length === 2, '補續失敗');
  f.manager.notifyRequestSucceeded();
  await settle();
  assert.equal(f.requests.length, 2, '補續失敗後不再上膛');
  f.fail(new HttpError('not_sent', 'x', { notSent: true }));
  await f.manager.refresh();
  f.respond(200, rotated());
  f.manager.notifyRequestSucceeded();
  await until(() => f.manager.state === 'healthy', '重新上膛後補續');
  assert.equal(f.requests.length, 4);
});

test('停止後不再送請求、不發事件，續期呼叫失敗', async () => {
  const f = fixture();
  const events = [];
  f.manager.onRefreshed((e) => events.push(e));
  const finish = f.pending();
  const p = f.manager.refresh();
  f.manager.stop();
  finish(200, rotated());
  await assert.rejects(p);
  assert.equal(events.length, 0);
  assert.equal(f.saved.length, 0, '登出後不得把工作階段寫回');
  assert.equal(f.manager.state, 'stopped');
  await assert.rejects(f.manager.refresh(), { code: 'stopped' });
  assert.equal(f.requests.length, 1);
});

test('停止時取消立即重試的等待，不送出重試', async () => {
  const f = fixture();
  f.respond(500);
  const p = f.manager.refresh();
  await until(() => f.delays.length === 1, '重試等待');
  f.manager.stop();
  await assert.rejects(p);
  assert.equal(f.requests.length, 1);
});

test('結果、事件與錯誤都不含 refresh token', async () => {
  const f = fixture();
  const texts = [];
  f.manager.onRejected((e) => texts.push(JSON.stringify(e)));
  f.fail(new HttpError('network', 'n'));
  f.respond(401, { code: 'auth.session-invalid', refreshToken: REFRESH });
  const p = f.manager.refresh();
  await until(() => f.delays.length === 1, '重試等待');
  f.delays[0].release();
  texts.push(JSON.stringify(await p));
  f.manager.stop();
  try { await f.manager.refresh(); } catch (e) { texts.push(e.message, String(e.stack)); }
  assert.equal(texts.join('\n').includes(REFRESH), false);
  assert.equal(texts.join('\n').includes(ACCESS), false);
});
