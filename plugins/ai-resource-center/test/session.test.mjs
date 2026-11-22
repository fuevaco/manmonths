import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostState, startWorker, leakedSecrets } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { HttpError } from '../worker/http.mjs';
import { resolveLcAiPackHome } from '../worker/paths.mjs';

const cleanup = [];
after(async () => { for (const c of cleanup.reverse()) await c(); });

async function market(opts) {
  const m = await startFakeMarket(opts);
  cleanup.push(() => m.close());
  return m;
}

test('首次開啟時市集網址為空，且尚未登入', async () => {
  const w = startWorker();
  const s = await w.call('rc.session.getState');
  assert.equal(s.marketUrl, '');
  assert.equal(s.signedIn, false);
});

test('登入：以 client "gui" 呼叫登入契約，取得 Orca 專用工作階段並存入外掛秘密儲存（綁定市集來源）', async () => {
  const m = await market({ prefix: '/market' });
  const w = startWorker();

  const s = await w.call('rc.session.signIn', { marketUrl: `  ${m.url}/ `, username: 'alice', password: 'pw-alice' });

  assert.equal(s.signedIn, true);
  assert.equal(s.account, 'alice');
  assert.equal(s.marketUrl, m.url, '網址去頭尾空白與結尾斜線後儲存');
  assert.equal(w.state.settings.get('marketUrl'), m.url);

  const login = m.requests.find((r) => r.route === '/api/auth/login');
  assert.deepEqual(login.body, { username: 'alice', password: 'pw-alice', client: 'gui' });

  const stored = JSON.parse(w.state.secrets.get('session.v1'));
  assert.equal(stored.marketUrl, m.url);
  assert.equal(stored.account, 'alice');
  assert.match(stored.token, /^fake-access-/);
  assert.match(stored.refreshToken, /^fake-refresh-/);
  assert.ok(stored.lastRefreshedAt, '新伺服器回應帶 refresh 欄位時記錄續期時間');
  assert.equal(JSON.stringify(s).includes('fake-'), false, '面板結果不含憑證');
});

test('登入失敗各自顯示可辨識的原因，修正後可重試', async () => {
  const m = await market({
    users: {
      alice: { password: 'pw-alice', permissions: ['market:read'] },
      bob: { password: 'pw-bob', permissions: [] }
    }
  });
  const gone = await startFakeMarket();
  const goneUrl = gone.url;
  await gone.close();
  const w = startWorker();
  const signIn = (marketUrl, username, password) => w.call('rc.session.signIn', { marketUrl, username, password });

  await assert.rejects(signIn('', 'alice', 'pw-alice'), { code: 'invalid_params', message: '請填寫市集網址、帳號與密碼' });
  await assert.rejects(signIn('market.example', 'alice', 'pw-alice'), { code: 'invalid_url', message: /網址格式不正確/ });
  await assert.rejects(signIn('ftp://market.example', 'alice', 'pw-alice'), { code: 'invalid_url' });
  await assert.rejects(signIn(`${m.url}/not-a-market`, 'alice', 'pw-alice'), { code: 'invalid_url', message: /找不到市集服務/ });
  await assert.rejects(signIn(goneUrl, 'alice', 'pw-alice'), { code: 'unreachable', message: /無法連線到 http:\/\/127\.0\.0\.1:\d+/ });
  await assert.rejects(signIn(m.url, 'alice', 'wrong'), { code: 'invalid_credentials', message: '帳號或密碼錯誤' });

  assert.equal(w.state.secrets.size, 0, '失敗時不儲存任何工作階段');
  assert.equal(w.state.settings.get('marketUrl'), '', '失敗時不改動已儲存的網址');
  assert.equal((await w.call('rc.session.getState')).signedIn, false);

  const ok = await signIn(m.url, 'alice', 'pw-alice');
  assert.equal(ok.signedIn, true);
});

test('登入成功即保留，不做權限探測；沒有權限時在讀取目錄才顯示，且不登出', async () => {
  const m = await market({
    users: {
      bob: { password: 'pw-bob', permissions: [] }
    }
  });
  const w = startWorker();
  const s = await w.call('rc.session.signIn', { marketUrl: m.url, username: 'bob', password: 'pw-bob' });

  assert.equal(s.signedIn, true);
  assert.equal(s.account, 'bob');
  assert.equal(w.state.secrets.has('session.v1'), true, '登入成功就保留工作階段');
  assert.equal(m.requests.some((r) => r.route === '/api/market/categories'), false, '登入後不送權限探測');
  assert.equal(m.requests.some((r) => r.route === '/api/auth/logout'), false);

  await assert.rejects(w.call('rc.catalog.list'), { code: 'forbidden', message: '沒有權限：權限不足' });
  assert.ok(w.state.logs.some(line => line.includes('403') && line.includes('權限不足')));

  const after = await w.call('rc.session.getState');
  assert.equal(after.signedIn, true, '沒有權限不會登出');
  assert.equal(after.notice, undefined);
  assert.equal(w.state.secrets.has('session.v1'), true);
  assert.equal(m.requests.some((r) => r.route === '/api/auth/logout'), false, '沒有權限不撤銷工作階段');
  assert.equal(m.requests.some((r) => r.route === '/api/market/categories'), false, 'getState 也不送權限探測');
});

test('伺服器暫時無法驗證（503）與非市集回應各自分類', async () => {
  const m = await market();
  const w = startWorker();
  m.override('POST /api/auth/login', () => ({ status: 503, body: { title: '驗證服務暫時無法使用', status: 503 } }));
  await assert.rejects(
    w.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'pw-alice' }),
    { code: 'service_unavailable', message: '驗證服務暫時無法使用' }
  );
  m.override('POST /api/auth/login', () => ({ status: 200, raw: '<html>portal</html>' }));
  await assert.rejects(
    w.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'pw-alice' }),
    { code: 'invalid_url', message: /沒有回應市集的登入資料/ }
  );
});

const HOUR = 60 * 60 * 1000;

/** 測試共用時鐘：worker 與假市集看同一個時間。 */
function clock(start = Date.parse('2026-11-20T00:00:00Z')) {
  let t = start;
  return { now: () => t, date: () => new Date(t), advance: (ms) => { t += ms; } };
}

/** worker 測試相依：共用時鐘、等待立即結束、排程不自動跑（避免背景請求干擾斷言）。 */
const deps = (c, extra = {}) => ({ now: c.now, delay: () => new Promise(() => {}), ...extra });

async function signedIn({ users, prefix } = {}) {
  const c = clock();
  const m = await market({ users, prefix, now: c.date });
  const state = createHostState();
  const w = startWorker({ state, deps: deps(c) });
  cleanup.push(() => w.dispose());
  await w.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'pw-alice' });
  return { c, m, state, w };
}

function restart(state, c, extra) {
  const w = startWorker({ state, deps: deps(c, extra) });
  cleanup.push(() => w.dispose());
  return w;
}

test('重開 Orca 後續用工作階段，不需重新登入', async () => {
  const { c, m, state, w } = await signedIn();
  w.dispose();
  const logins = m.requests.filter((r) => r.route === '/api/auth/login').length;
  const before = m.requests.length;

  const w2 = restart(state, c);
  const s = await w2.call('rc.session.getState');

  assert.equal(s.signedIn, true);
  assert.equal(s.account, 'alice');
  assert.equal(m.requests.filter((r) => r.route === '/api/auth/login').length, logins, '沒有再次登入');
  assert.equal(m.requests.length, before, 'getState 不送任何市集請求');
  await w2.call('rc.catalog.list');
  const call = m.requests.at(-1);
  assert.equal(call.route, '/api/market/packages');
  assert.match(call.authorization, /^Bearer fake-access-/);
});

test('重開時 access token 已過期但 refresh token 有效：自動續期並儲存輪替後的憑證', async () => {
  const { c, m, state, w } = await signedIn();
  w.dispose();
  const before = JSON.parse(state.secrets.get('session.v1'));
  c.advance(2 * HOUR);
  m.expireAccessTokens();

  const w2 = restart(state, c);
  await w2.call('rc.catalog.list');
  const s = await w2.call('rc.session.getState');

  assert.equal(s.signedIn, true);
  const after = JSON.parse(state.secrets.get('session.v1'));
  assert.notEqual(after.token, before.token);
  assert.notEqual(after.refreshToken, before.refreshToken);
  assert.equal(m.isRefreshRevoked(before.refreshToken), true, '舊 refresh token 已輪替');
});

test('工作階段失效時，面板提示重新登入並清除儲存的憑證', async () => {
  const { c, m, state, w } = await signedIn();
  w.dispose();
  m.revokeAllSessions();

  const w2 = restart(state, c);
  await assert.rejects(w2.call('rc.catalog.list'), { code: 'session_expired' });
  const s = await w2.call('rc.session.getState');

  assert.equal(s.signedIn, false);
  assert.equal(s.notice, '登入已過期，請重新登入');
  assert.equal(s.marketUrl, m.url, '保留市集網址方便重新登入');
  assert.equal(state.secrets.has('session.v1'), false);
  assert.equal(m.requests.some((r) => r.route === '/api/auth/logout'), false, '被拒絕的工作階段不再撤銷');

  const again = await w2.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'pw-alice' });
  assert.equal(again.signedIn, true);
  assert.equal(again.notice, undefined, '登入後清除提示');
});

test('帳號無法使用時顯示對應提示', async () => {
  const { c, m, state, w } = await signedIn();
  w.dispose();
  m.expireAccessTokens();
  m.override('POST /api/auth/refresh', () => ({ status: 401, body: { title: '帳號目前無法使用，請聯絡管理員', status: 401, code: 'auth.account-unavailable' } }));

  const w2 = restart(state, c);
  await assert.rejects(w2.call('rc.catalog.list'), { code: 'session_expired' });
  const s = await w2.call('rc.session.getState');
  assert.equal(s.signedIn, false);
  assert.equal(s.notice, '帳號目前無法使用，請聯絡管理員');
});

test('舊伺服器（沒有 refresh token）的工作階段收到 401 時提示重新登入', async () => {
  const c = clock();
  const m = await market({ now: c.date });
  m.override('POST /api/auth/login', (req, body) => {
    if (body?.password !== 'pw-alice') return undefined;
    return { status: 200, body: { token: 'legacy-token', expiresAt: new Date(c.now() + 30 * 24 * HOUR).toISOString() } };
  });
  m.override('GET /api/market/packages', (req) =>
    req.headers.authorization === 'Bearer legacy-token' && !m.legacyRevoked ? { status: 200, body: { data: [], meta: { total: 0 } } } : { status: 401, body: {} });
  const state = createHostState();
  const w = restart(state, c);
  const s = await w.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'pw-alice' });
  assert.equal(s.signedIn, true);
  assert.equal(JSON.parse(state.secrets.get('session.v1')).refreshToken, undefined);
  w.dispose();

  m.legacyRevoked = true;
  const w2 = restart(state, c);
  await assert.rejects(w2.call('rc.catalog.list'), { code: 'session_expired' });
  const after = await w2.call('rc.session.getState');
  assert.equal(after.signedIn, false);
  assert.equal(after.notice, '登入已過期，請重新登入');
  assert.equal(m.requests.some((r) => r.route === '/api/auth/refresh'), false, '沒有 refresh token 不送續期');
});

test('續期暫時失敗時保持登入，並說明將自動重試', async () => {
  const { c, m, state, w } = await signedIn();
  w.dispose();
  m.expireAccessTokens();
  m.override('POST /api/auth/refresh', () => ({ status: 429, body: {} }));

  const w2 = restart(state, c);
  await assert.rejects(w2.call('rc.catalog.list'), { code: 'session_unavailable', message: '暫時無法向伺服器驗證，將自動重試' });
  const s = await w2.call('rc.session.getState');
  assert.equal(s.signedIn, true);
  assert.equal(state.secrets.has('session.v1'), true, '暫時性失敗不登出');
});

test('已登入但市集暫時連不上：保持登入並顯示無法連線', async () => {
  const { c, m, state, w } = await signedIn();
  w.dispose();
  await m.close();
  const w2 = restart(state, c);
  await assert.rejects(w2.call('rc.catalog.list'), { code: 'unreachable' });
  const s = await w2.call('rc.session.getState');
  assert.equal(s.signedIn, true);
  assert.equal(state.secrets.has('session.v1'), true);
});

test('改用其他市集網址時不沿用原本的憑證，並撤銷舊市集的工作階段', async () => {
  const { c, m, state, w } = await signedIn();
  const other = await market({ now: c.date });
  w.dispose();
  const old = JSON.parse(state.secrets.get('session.v1'));
  state.settings.set('marketUrl', other.url); // 使用者在 Orca 設定中改了網址

  const s = await restart(state, c).call('rc.session.getState');

  assert.equal(s.signedIn, false);
  assert.equal(s.marketUrl, other.url);
  assert.equal(s.notice, undefined);
  assert.equal(state.secrets.has('session.v1'), false);
  assert.equal(other.requests.length, 0, '舊憑證不會送到新市集');
  await until(() => m.isRefreshRevoked(old.refreshToken));
  const logout = m.requests.find((r) => r.route === '/api/auth/logout');
  assert.equal(logout.authorization, `Bearer ${old.token}`);
});

test('在已登入狀態以另一個網址登入：先登出舊市集，新憑證綁定新網址', async () => {
  const { c, m, state, w } = await signedIn();
  const other = await market({ now: c.date });
  const old = JSON.parse(state.secrets.get('session.v1'));

  const s = await w.call('rc.session.signIn', { marketUrl: other.url, username: 'alice', password: 'pw-alice' });

  assert.equal(s.signedIn, true);
  assert.equal(JSON.parse(state.secrets.get('session.v1')).marketUrl, other.url);
  await until(() => m.isRefreshRevoked(old.refreshToken));
  assert.equal(other.requests.some((r) => r.authorization === `Bearer ${old.token}`), false);
});

test('登出：撤銷後端工作階段、清除外掛儲存的憑證，之後重開也不會自動登入', async () => {
  const { c, m, state, w } = await signedIn();
  const stored = JSON.parse(state.secrets.get('session.v1'));

  const s = await w.call('rc.session.signOut');

  assert.equal(s.signedIn, false);
  assert.equal(s.marketUrl, m.url);
  assert.equal(s.notice, undefined);
  assert.equal(state.secrets.has('session.v1'), false);
  await until(() => m.isRefreshRevoked(stored.refreshToken));
  assert.equal((await restart(state, c).call('rc.session.getState')).signedIn, false);
});

test('市集離線時登出仍立即清除本機工作階段', async () => {
  const { m, state, w } = await signedIn();
  await m.close();
  const s = await w.call('rc.session.signOut');
  assert.equal(s.signedIn, false);
  assert.equal(state.secrets.has('session.v1'), false);
});

test('登出只清除 Orca 的工作階段，不影響 LC-AI-Pack 的登入狀態', async () => {
  const lcHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-lcaipack-'));
  cleanup.push(() => fs.rm(lcHome, { recursive: true, force: true }));
  const env = { LCAIPACK_HOME: lcHome };
  const home = resolveLcAiPackHome({ env, platform: process.platform, homedir: os.homedir() });
  assert.equal(home, lcHome);
  const files = { 'gui-session.json': '{"account":"desktop-user","token":"desktop-token"}', 'credentials.json': '{"pat":"desktop-pat"}', 'config.json': '{"registryUrl":"https://desktop.example"}' };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(home, name), text);

  const c = clock();
  const m = await market({ now: c.date });
  const state = createHostState();
  const w = restart(state, c, { env });
  await w.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'pw-alice' });
  await w.call('rc.session.signOut');

  assert.deepEqual((await fs.readdir(home)).sort(), Object.keys(files).sort());
  for (const [name, text] of Object.entries(files)) assert.equal(await fs.readFile(path.join(home, name), 'utf8'), text);
  assert.equal(m.requests.some((r) => r.authorization === 'Bearer desktop-token'), false);
});

test('整個流程中，面板結果與日誌都不出現憑證、密碼或秘密值', async () => {
  const { c, m, state, w } = await signedIn();
  const first = JSON.parse(state.secrets.get('session.v1'));
  await w.call('rc.session.getState');
  c.advance(2 * HOUR);
  m.expireAccessTokens();
  await w.call('rc.session.getState');
  const second = JSON.parse(state.secrets.get('session.v1'));
  await assert.rejects(w.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'wrong-secret-pw' }));
  await w.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'pw-alice' });
  await w.call('rc.session.signOut');

  const secrets = [first.token, first.refreshToken, second.token, second.refreshToken, 'pw-alice', 'wrong-secret-pw'];
  assert.deepEqual(leakedSecrets([...state.transcript, ...state.logs], secrets), []);
  assert.ok(state.transcript.length >= 5);
});

async function until(cond) {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('等待逾時');
}

test('登入失敗訊息保留伺服器說明，但絕不包含 refresh token', async () => {
  const m = await market();
  m.override('POST /api/auth/login', () => ({ status: 401, body: { detail: '帳號或密碼錯誤', refreshToken: 'lcrt_leak' } }));
  const w = startWorker();
  await assert.rejects(
    w.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'pw-alice' }),
    (e) => e.message === '帳號或密碼錯誤' && !JSON.stringify({ ...e, m: e.message, s: e.stack }).includes('lcrt_')
  );
});

for (const [status, expected] of [[401, '帳號或密碼錯誤'], [403, '沒有權限：權限不足'], [404, '這個網址找不到市集服務，請確認網址是否正確'], [405, '這個網址找不到市集服務，請確認網址是否正確'], [400, '登入資料格式不正確，請重新輸入'], [422, '登入資料格式不正確，請重新輸入'], [429, '登入失敗，請稍後再試'], [503, '市集服務暫時無法使用，請稍後再試']]) {
  test(`登入 ${status} 的原始診斷只進紀錄，面向使用者維持繁中`, async () => {
    const m = await market();
    const technical = 'Synthetic authentication service HTTP ' + status;
    m.override('POST /api/auth/login', () => ({ status, body: { detail: technical, refreshToken: 'synthetic-secret-token' } }));
    const w = startWorker(); cleanup.push(() => w.dispose());
    await assert.rejects(w.call('rc.session.signIn', { marketUrl: m.url, username: 'alice', password: 'pw-alice' }), { message: expected });
    assert.ok(w.state.logs.some(line => line.includes(String(status)) && line.includes(technical)));
    assert.deepEqual(leakedSecrets([...w.state.transcript, ...w.state.logs], ['pw-alice', 'synthetic-secret-token']), []);
  });
}

for (const error of [new HttpError('not_sent', 'synthetic TLS certificate', { tls: true }), new HttpError('timeout', 'synthetic timeout'), new Error('synthetic network detail')]) {
  test(`登入連線錯誤僅顯示繁中提示：${error.message}`, async () => {
    const w = startWorker({ deps: { transport: async () => { throw error; } } }); cleanup.push(() => w.dispose());
    await assert.rejects(w.call('rc.session.signIn', { marketUrl: 'https://market.example.com', username: 'alice', password: 'secret-password' }), e => {
      assert.equal(e.code, 'unreachable');
      assert.doesNotMatch(e.message.replace('https://market.example.com', ''), /[a-z]/i);
      return true;
    });
    assert.ok(w.state.logs.some(line => line.includes(error.message)));
  });
}
