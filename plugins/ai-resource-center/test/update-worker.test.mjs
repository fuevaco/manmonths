import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const notifications = worker => worker.state.hostCalls.filter(c => c.method === 'notifications.show');
const status = worker => worker.state.hostCalls.filter(c => c.method === 'statusBar.update').at(-1)?.input;
function scheduler() {
  let seq = 0;
  const tasks = new Map();
  return { tasks, setTimeout(fn, ms) { const id = ++seq; tasks.set(id, { fn, ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    async tick() { const [id, task] = [...tasks][0]; tasks.delete(id); await task.fn(); } };
}
async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-updates-'));
  const home = path.join(dir, 'shared'); await mkdir(home);
  const catalog = [{ packageKey: 'demo', name: '測試資源', type: 'skill', latestReleaseVersion: '1.1.0' }];
  const market = await startFakeMarket({ packages: catalog });
  const timers = scheduler();
  const deps = { userHome: dir, lcaipackHome: home, dataDirectory: path.join(dir, 'plugin'), env: {}, updateScheduler: timers };
  const worker = startWorker({ deps, ...options });
  const receipt = (extra = {}) => ({ packageKey: 'demo', packageVersion: '1.0.0', packageSha256: 'a'.repeat(64), channel: 'release',
    contentId: 'hello', kind: 'skill', hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', canonicalRoot: path.join(dir, '.codex'), ...extra });
  const save = receipts => writeFile(path.join(home, 'receipts.json'), JSON.stringify({ receiptFormatVersion: 1, receipts }));
  const signIn = async () => { await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' }); await settle(); };
  t.after(async () => { worker.dispose(); await market.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, home, deps, worker, market, catalog, timers, receipt, save, signIn };
}

test('檢查完成在狀態列顯示更新數與定案版本提示，歸零時隱藏', async t => {
  const e = await setup(t); await e.signIn();
  e.catalog.push({ packageKey: 'other', name: '其他', type: 'skill', latestReleaseVersion: '2.0.0' });
  await e.save([e.receipt(), e.receipt({ packageKey: 'other' })]);
  await e.worker.call('rc.updates.checkNow');
  assert.deepEqual(status(e.worker), { id: 'update-reminder', text: '2', tone: 'warning', visible: true,
    tooltip: '資源中心：2 個資源包可更新、・測試資源 1.0.0 → 1.1.0、・其他 1.0.0 → 2.0.0、請到側欄「資源中心」分頁更新' });
  await e.save([]);
  await e.worker.call('rc.updates.checkNow');
  assert.equal(status(e.worker).visible, false);
});

test('未登入先隱藏；關閉間隔、重新啟用、登出與登入立即重算狀態列', async t => {
  const e = await setup(t); await settle();
  assert.deepEqual(status(e.worker), { id: 'update-reminder', visible: false });
  await e.signIn(); await e.save([e.receipt()]);
  await e.worker.call('rc.updates.checkNow');
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 0 }); await settle();
  assert.equal(status(e.worker).visible, false);
  await e.worker.call('rc.updates.checkNow');
  assert.equal(status(e.worker).visible, false, '關閉時手動檢查也不顯示數字');
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 60 }); await settle();
  assert.equal(status(e.worker).text, '1'); assert.equal(status(e.worker).visible, true);
  await e.worker.call('rc.session.signOut');
  assert.equal(status(e.worker).visible, false);
  await e.signIn();
  assert.equal(status(e.worker).visible, false, '新工作階段不沿用登出前摘要');
});

test('工作階段遭拒時儲存所屬市集，需登入優先於更新數且面板提示不變', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
  await e.worker.call('rc.updates.checkNow');
  assert.equal(status(e.worker).text, '1');
  e.market.revokeAllSessions();
  await assert.rejects(e.worker.call('rc.updates.checkNow'), { code: 'session_expired' });
  await settle();
  assert.deepEqual(status(e.worker), { id: 'update-reminder', text: '需登入', tone: 'danger', visible: true,
    tooltip: '資源中心登入已過期，無法檢查更新。請到側欄「資源中心」分頁重新登入。' });
  assert.deepEqual(e.worker.state.storage.get('resource-center.session-expired'), { marketUrl: e.market.url });
  assert.deepEqual(await e.worker.call('rc.session.getState'), { marketUrl: e.market.url, signedIn: false, notice: '登入已過期，請重新登入' });
  assert.equal(e.timers.tasks.size, 0);
});

test('關閉檢查仍顯示需登入，共用 host state 重開後恢復提醒且不改面板提示', async t => {
  const e = await setup(t); await e.signIn();
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 0 }); await settle();
  e.market.revokeAllSessions();
  await assert.rejects(e.worker.call('rc.updates.checkNow'), { code: 'session_expired' });
  await settle();
  const previous = status(e.worker);
  assert.equal(previous.text, '需登入'); assert.equal(previous.visible, true);
  e.worker.dispose();
  const before = e.market.requests.length;
  const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.call('rc.session.getState'), { marketUrl: e.market.url, signedIn: false });
  await settle();
  assert.deepEqual(status(restarted), previous);
  assert.deepEqual(restarted.state.storage.get('resource-center.session-expired'), { marketUrl: e.market.url });
  assert.equal(e.timers.tasks.size, 0);
  assert.equal(e.market.requests.length, before);
});

test('登入失敗保留過期提醒；重新登入成功清除旗標並恢復更新數顯示', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
  e.market.revokeAllSessions();
  await assert.rejects(e.worker.call('rc.updates.checkNow'), { code: 'session_expired' }); await settle();
  await assert.rejects(e.worker.call('rc.session.signIn', { marketUrl: e.market.url, username: 'alice', password: 'wrong' }));
  assert.equal(status(e.worker).text, '需登入');
  assert.deepEqual(e.worker.state.storage.get('resource-center.session-expired'), { marketUrl: e.market.url });
  await e.signIn();
  assert.equal(e.worker.state.storage.has('resource-center.session-expired'), false);
  assert.equal(status(e.worker).visible, false);
  await e.worker.call('rc.updates.checkNow');
  assert.equal(status(e.worker).text, '1'); assert.equal(status(e.worker).tone, 'warning');
  assert.equal(status(e.worker).visible, true);
});

test('過期後主動登出立即清除旗標並隱藏，重開也不再提醒', async t => {
  const e = await setup(t); await e.signIn();
  e.market.revokeAllSessions();
  await assert.rejects(e.worker.call('rc.updates.checkNow'), { code: 'session_expired' }); await settle();
  assert.equal(status(e.worker).text, '需登入');
  assert.deepEqual(await e.worker.call('rc.session.signOut'), { marketUrl: e.market.url, signedIn: false });
  assert.equal(e.worker.state.storage.has('resource-center.session-expired'), false);
  assert.deepEqual(status(e.worker), { id: 'update-reminder', visible: false });
  e.worker.dispose();
  const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
  await restarted.call('rc.session.getState'); await settle();
  assert.deepEqual(status(restarted), { id: 'update-reminder', visible: false });
});

test('啟動時過期旗標所屬市集不同即刪除並隱藏，不改登入畫面', async t => {
  const e = await setup(t); await e.signIn();
  e.market.revokeAllSessions();
  await assert.rejects(e.worker.call('rc.updates.checkNow'), { code: 'session_expired' }); await settle();
  e.worker.dispose();
  e.worker.state.settings.set('marketUrl', 'https://other.example');
  const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.call('rc.session.getState'), { marketUrl: 'https://other.example', signedIn: false }); await settle();
  assert.equal(restarted.state.storage.has('resource-center.session-expired'), false);
  assert.deepEqual(status(restarted), { id: 'update-reminder', visible: false });
});

test('啟動發現舊工作階段綁定其他市集時，同時清除過期旗標並隱藏', async t => {
  const e = await setup(t); await e.signIn();
  const previousSession = e.worker.state.secrets.get('session.v1');
  e.worker.dispose();
  e.worker.state.settings.set('marketUrl', 'https://other.example');
  e.worker.state.secrets.set('session.v1', previousSession);
  e.worker.state.storage.set('resource-center.session-expired', { marketUrl: 'https://other.example' });
  const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.call('rc.session.getState'), { marketUrl: 'https://other.example', signedIn: false }); await settle();
  assert.equal(restarted.state.storage.has('resource-center.session-expired'), false);
  assert.equal(restarted.state.secrets.has('session.v1'), false);
  assert.deepEqual(status(restarted), { id: 'update-reminder', visible: false });
});

test('目錄的相容模式 401 與帳號停用拒絕也保留需登入提醒，面板沿用各自原因', async t => {
  for (const legacy of [true, false]) {
    const e = await setup(t);
    if (legacy) e.market.override('POST /api/auth/login', () => ({ status: 200,
      body: { token: 'legacy-access', expiresAt: new Date(Date.now() + 3600000).toISOString() } }));
    else e.market.override('POST /api/auth/refresh', () => ({ status: 401, body: { code: 'auth.account-unavailable' } }));
    await e.signIn();
    e.market.expireAccessTokens();
    await assert.rejects(e.worker.call('rc.catalog.list'), { code: 'session_expired' }); await settle();
    assert.equal(status(e.worker).text, '需登入'); assert.equal(status(e.worker).tone, 'danger');
    assert.deepEqual(e.worker.state.storage.get('resource-center.session-expired'), { marketUrl: e.market.url });
    assert.equal((await e.worker.call('rc.session.getState')).notice,
      legacy ? '登入已過期，請重新登入' : '帳號目前無法使用，請聯絡管理員');
  }
});

test('執行中變更市集網址會清除原工作階段或過期旗標並隱藏提醒', async t => {
  for (const expired of [false, true]) {
    const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
    await e.worker.call('rc.updates.checkNow');
    if (expired) {
      e.market.revokeAllSessions();
      await assert.rejects(e.worker.call('rc.updates.checkNow'), { code: 'session_expired' }); await settle();
    }
    e.worker.state.settings.set('marketUrl', 'https://other.example');
    assert.deepEqual(await e.worker.call('rc.session.getState'), { marketUrl: 'https://other.example', signedIn: false });
    assert.equal(e.worker.state.storage.has('resource-center.session-expired'), false);
    assert.equal(e.worker.state.secrets.has('session.v1'), false);
    assert.deepEqual(status(e.worker), { id: 'update-reminder', visible: false });
    assert.equal(e.timers.tasks.size, 0);
  }
});

test('旗標寫入尚未完成也立即顯示需登入並停止排程，隨後登出不留下舊旗標', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
  await e.worker.call('rc.updates.checkNow');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const set = e.worker.orca.storage.set;
  e.worker.orca.storage.set = async (key, value) => {
    if (key === 'resource-center.session-expired') { entered(); await gate; }
    return set(key, value);
  };
  e.market.revokeAllSessions();
  const check = e.worker.call('rc.updates.checkNow').catch(error => error);
  await started;
  let logout;
  try {
    assert.equal(status(e.worker).text, '需登入');
    assert.equal(e.timers.tasks.size, 0);
    logout = e.worker.call('rc.session.signOut');
  } finally { release(); await check; await logout; }
  assert.equal(e.worker.state.storage.has('resource-center.session-expired'), false);
  assert.deepEqual(status(e.worker), { id: 'update-reminder', visible: false });
});

test('tooltip 依序保留完整版本列與更新指引，超長以剩餘數結尾且不超過 256 字', async t => {
  const e = await setup(t); await e.signIn();
  e.catalog.splice(0, e.catalog.length, ...Array.from({ length: 10 }, (_, i) => ({
    packageKey: `pack-${i}`, name: `資源包${i}${'長'.repeat(30)}`, type: 'skill', latestReleaseVersion: '2.0.0'
  })));
  await e.save(e.catalog.map(p => e.receipt({ packageKey: p.packageKey })));
  await e.worker.call('rc.updates.checkNow');
  const tooltip = status(e.worker).tooltip;
  assert.ok(tooltip.length <= 256);
  assert.equal(tooltip, ['資源中心：10 個資源包可更新',
    ...[0, 1, 2, 3].map(i => `・資源包${i}${'長'.repeat(30)} 1.0.0 → 2.0.0`),
    '請到側欄「資源中心」分頁更新', '…另外 6 個'].join('、'));
  e.catalog[0].name = '長'.repeat(300);
  await e.worker.call('rc.updates.checkNow');
  assert.equal(status(e.worker).tooltip, '資源中心：10 個資源包可更新、請到側欄「資源中心」分頁更新、…另外 10 個');
});

test('共用 host state 重開後恢復摘要與狀態列，啟動時仍依收據重核且不連線', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
  await e.worker.call('rc.updates.checkNow');
  const previous = status(e.worker);
  e.worker.dispose();
  const before = e.market.requests.length;
  const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
  await restarted.call('rc.session.getState'); await settle();
  assert.deepEqual(status(restarted), previous);
  assert.equal((await restarted.call('rc.updates.summary')).count, 1);
  assert.equal(e.market.requests.length, before);
  restarted.dispose(); await e.save([]);
  const removed = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => removed.dispose());
  await removed.call('rc.session.getState'); await settle();
  assert.equal(status(removed).visible, false);
  assert.equal((await removed.call('rc.updates.summary')).count, 0);
});

test('收據重核後 tooltip 與摘要使用仍可更新目標的最舊版本', async t => {
  const e = await setup(t); await e.signIn();
  await e.save([e.receipt({ packageVersion: '0.1.0' }), e.receipt({ packageVersion: '0.5.0', canonicalRoot: path.join(e.dir, '.codex-other') })]);
  await e.worker.call('rc.updates.checkNow');
  await e.save([e.receipt({ packageVersion: '0.5.0', canonicalRoot: path.join(e.dir, '.codex-other') })]);
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 60 }); await settle();
  assert.match(status(e.worker).tooltip, /0\.5\.0 → 1\.1\.0/);
  assert.equal((await e.worker.call('rc.updates.summary')).packages[0].installedVersion, '0.5.0');
});

for (const action of ['signOut', 'changeMarket']) {
  test(`${action} 後重開不恢復原工作階段的更新數`, async t => {
    const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
    await e.worker.call('rc.updates.checkNow');
    if (action === 'signOut') await e.worker.call('rc.session.signOut');
    else e.worker.state.settings.set('marketUrl', 'https://market.example');
    e.worker.dispose();
    const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
    await restarted.call('rc.session.getState'); await settle();
    assert.equal(status(restarted).visible, false);
    assert.equal((await restarted.call('rc.updates.summary')).count, 0);
  });
}

test('市集暫時失敗保留上次狀態列與摘要，恢復後再顯示新版', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
  const first = await e.worker.call('rc.updates.checkNow');
  const previous = status(e.worker);
  e.market.override('GET /api/market/packages', () => ({ status: 503, body: {} }));
  await assert.rejects(e.worker.call('rc.updates.checkNow'));
  assert.deepEqual(status(e.worker), previous);
  assert.deepEqual(await e.worker.call('rc.updates.summary'), first);
  await e.timers.tick();
  assert.deepEqual(status(e.worker), previous);
  e.market.override('GET /api/market/packages', () => ({ status: 200, body: { data: [
    { ...e.catalog[0], latestReleaseVersion: '2.0.0' }
  ], meta: { total: 1 } } }));
  await e.timers.tick();
  assert.match(status(e.worker).tooltip, /1\.0\.0 → 2\.0\.0/);
});

test('狀態列主機呼叫失敗每次只記錄一行安全 log，通知與摘要照常', async t => {
  const e = await setup(t, { hostCall: async method => {
    if (method === 'statusBar.update') throw new Error('alice https://market.example/ token=secret\nunsafe');
  } });
  await e.signIn(); await e.save([e.receipt()]);
  const before = e.worker.state.logs.length;
  const calls = e.worker.state.hostCalls.filter(c => c.method === 'statusBar.update').length;
  const summary = await e.worker.call('rc.updates.checkNow');
  assert.equal(summary.count, 1);
  assert.deepEqual(await e.worker.call('rc.updates.summary'), summary);
  assert.equal(notifications(e.worker).length, 1);
  const failures = e.worker.state.hostCalls.filter(c => c.method === 'statusBar.update').length - calls;
  assert.deepEqual(e.worker.state.logs.slice(before), Array(failures).fill('[updates] 無法更新資源中心狀態列'));
});

test('只比對全域舊目標；合併通知、去重、摘要持續存在，更新版本才再次通知', async t => {
  const e = await setup(t); await e.signIn();
  e.catalog.push({ packageKey: 'other', name: '其他', type: 'skill', latestReleaseVersion: '2.0.0' });
  await e.save([e.receipt(), e.receipt({ packageKey: 'other' })]);
  const before = await readFile(path.join(e.home, 'receipts.json'), 'utf8');
  const first = await e.worker.call('rc.updates.checkNow');
  assert.equal(first.count, 2); assert.ok(Date.parse(first.checkedAt));
  assert.deepEqual(first.packages[0], { packageKey: 'demo', name: '測試資源', installedVersion: '1.0.0', updateVersion: '1.1.0' });
  assert.deepEqual(notifications(e.worker), [{ method: 'notifications.show', input: { title: '資源中心', body: '有 2 個資源包可更新' } }]);
  assert.deepEqual(await e.worker.call('rc.updates.summary'), first);
  await e.worker.call('rc.updates.checkNow');
  assert.equal(notifications(e.worker).length, 1);
  e.catalog[0].latestReleaseVersion = '1.2.0';
  await e.worker.call('rc.updates.checkNow');
  assert.equal(notifications(e.worker).length, 2);
  assert.match(notifications(e.worker)[1].input.body, /測試資源.*1\.2\.0/);
  assert.equal(await readFile(path.join(e.home, 'receipts.json'), 'utf8'), before, '檢查與通知不套用新版、不改收據');
  await e.save([e.receipt({ packageVersion: '1.2.0' }), e.receipt({ packageKey: 'other', packageVersion: '2.0.0' })]);
  assert.equal((await e.worker.call('rc.updates.checkNow')).count, 0);
  assert.deepEqual(e.worker.state.storage.get('resource-center.update-notifications').pairs, []);
});

test('重開 worker 沿用外掛通知清單；本機來源、新版已安裝、下架與待補裝均不通知', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
  await e.worker.call('rc.updates.checkNow');
  e.worker.dispose();
  const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
  await restarted.call('rc.updates.checkNow');
  assert.equal(notifications(e.worker).length, 1);
  for (const receipts of [[], [e.receipt({ source: 'local' })], [e.receipt({ packageVersion: '3.0.0' })],
    [e.receipt({ packageKey: 'removed' })], [e.receipt({ packageVersion: '1.1.0' })]]) {
    await e.save(receipts);
    assert.equal((await restarted.call('rc.updates.checkNow')).count, 0);
  }
  assert.equal(notifications(e.worker).length, 1);
});

test('登入後 30 秒先檢查，之後採預設 15 分鐘；所有間隔可重排，關閉與登出停止', async t => {
  const e = await setup(t); await settle();
  assert.equal(e.timers.tasks.size, 0);
  assert.deepEqual(await e.worker.call('rc.updates.checkNow'), { count: 0, packages: [], checkedAt: null });
  assert.equal(e.market.requests.length, 0);
  await e.signIn(); await e.save([e.receipt()]);
  assert.equal([...e.timers.tasks.values()][0].ms, 30000);
  assert.equal(e.market.requests.filter(r => r.route === '/api/market/packages').length, 0);
  await e.timers.tick();
  assert.equal((await e.worker.call('rc.updates.summary')).count, 1);
  assert.equal(e.timers.tasks.size, 1);
  assert.equal([...e.timers.tasks.values()][0].ms, 15 * 60000);
  for (const minutes of [60, 240, 1440, 15]) {
    await e.worker.call('rc.preferences.set', { checkIntervalMinutes: minutes }); await settle();
    assert.equal(e.timers.tasks.size, 1);
    assert.equal([...e.timers.tasks.values()][0].ms, minutes * 60000);
  }
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 0 }); await settle();
  assert.equal(e.timers.tasks.size, 0);
  assert.equal((await e.worker.call('rc.updates.checkNow')).count, 1);
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 15 }); await settle();
  await e.worker.call('rc.session.signOut');
  assert.equal(e.timers.tasks.size, 0);
  assert.equal((await e.worker.call('rc.updates.summary')).count, 0);
});

test('排程與同時手動檢查共用一次目錄請求，通知失敗只記錄且摘要可用', async t => {
  const e = await setup(t, { hostCall: async () => { throw new Error('synthetic notification failure'); } });
  await e.signIn(); await e.save([e.receipt()]);
  const before = e.market.requests.filter(r => r.route === '/api/market/packages').length;
  const results = await Promise.all([e.worker.call('rc.updates.checkNow'), e.worker.call('rc.updates.checkNow'), e.timers.tick()]);
  assert.equal(results[0].count, 1); assert.deepEqual(results[0], results[1]);
  assert.equal(e.market.requests.filter(r => r.route === '/api/market/packages').length - before, 1);
  assert.equal(notifications(e.worker).length, 1);
  assert.ok(e.worker.state.logs.some(l => l.includes('無法顯示資源包更新通知')));
});

test('已登入時重開 worker，長間隔也在 30 秒後先檢查，完成後才等完整間隔', async t => {
  for (const minutes of [15, 240, 1440]) {
    const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
    await e.worker.call('rc.preferences.set', { checkIntervalMinutes: minutes }); await settle();
    e.worker.dispose();
    const worker = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => worker.dispose());
    await settle(); await settle();
    assert.equal(e.timers.tasks.size, 1);
    assert.equal([...e.timers.tasks.values()][0].ms, 30000);
    assert.equal(e.market.requests.filter(r => r.route === '/api/market/packages').length, 0);
    await e.timers.tick();
    assert.equal((await worker.call('rc.updates.summary')).count, 1);
    assert.equal(e.timers.tasks.size, 1);
    assert.equal([...e.timers.tasks.values()][0].ms, minutes * 60000);
  }
});

test('關閉後重新啟用在 30 秒後先檢查；關閉時登入與未登入時啟用都不背景檢查', async t => {
  const e = await setup(t); await settle();
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 0 }); await settle();
  await e.signIn(); await e.save([e.receipt()]);
  assert.equal(e.timers.tasks.size, 0);
  assert.equal(e.market.requests.filter(r => r.route === '/api/market/packages').length, 0);
  for (const minutes of [15, 60, 240, 1440]) {
    await e.worker.call('rc.preferences.set', { checkIntervalMinutes: minutes }); await settle();
    assert.equal(e.timers.tasks.size, 1);
    assert.equal([...e.timers.tasks.values()][0].ms, 30000);
    await e.timers.tick();
    assert.equal((await e.worker.call('rc.updates.summary')).count, 1);
    assert.equal([...e.timers.tasks.values()][0].ms, minutes * 60000);
    await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 0 }); await settle();
    assert.equal(e.timers.tasks.size, 0);
  }
  await e.worker.call('rc.session.signOut');
  const before = e.market.requests.filter(r => r.route === '/api/market/packages').length;
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 240 }); await settle();
  assert.equal(e.timers.tasks.size, 0);
  assert.equal(e.market.requests.filter(r => r.route === '/api/market/packages').length, before);
  await e.signIn();
  assert.equal([...e.timers.tasks.values()][0].ms, 30000);
  await e.timers.tick();
  assert.equal([...e.timers.tasks.values()][0].ms, 240 * 60000);
});

test('首次檢查前讀取登入狀態仍保留 30 秒檢查；切換非關閉間隔則沿用完整間隔重排', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
  assert.equal((await e.worker.call('rc.session.getState')).signedIn, true); await settle();
  assert.equal(e.timers.tasks.size, 1);
  assert.equal([...e.timers.tasks.values()][0].ms, 30000);
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 240 }); await settle();
  assert.equal(e.timers.tasks.size, 1);
  assert.equal([...e.timers.tasks.values()][0].ms, 240 * 60000);
  await e.timers.tick();
  assert.equal((await e.worker.call('rc.updates.summary')).count, 1);
  assert.equal([...e.timers.tasks.values()][0].ms, 240 * 60000);
});

test('Preview 開關沿用 Release 優先規則；專案獨有收據完全忽略', async t => {
  const e = await setup(t); await e.signIn();
  e.catalog[0].latestReleaseVersion = null; e.catalog[0].latestPreviewVersion = '2.0.0';
  await e.save([e.receipt()]);
  assert.equal((await e.worker.call('rc.updates.checkNow')).count, 0);
  await e.worker.call('rc.preferences.set', { showPreview: true });
  assert.equal((await e.worker.call('rc.updates.checkNow')).packages[0].updateVersion, '2.0.0');
  const project = path.join(e.dir, 'project'); await mkdir(path.join(project, '.lcaipack'), { recursive: true });
  await writeFile(path.join(project, '.lcaipack', 'receipts.json'), JSON.stringify({ receiptFormatVersion: 1, receipts: [e.receipt({ scope: 'project' })] }));
  await writeFile(path.join(e.home, 'config.json'), JSON.stringify({ registeredProjects: [project] }));
  await e.save([]);
  assert.equal((await e.worker.call('rc.updates.checkNow')).count, 0);
});

test('更新檢查走完全部目錄分頁；收據損壞保留上次摘要並回報錯誤', async t => {
  const e = await setup(t); await e.signIn();
  e.catalog.unshift(...Array.from({ length: 55 }, (_, i) => ({ packageKey: `aaa${i}`, name: 'Other', type: 'skill', latestReleaseVersion: '9.0.0' })));
  await e.save([e.receipt()]);
  const first = await e.worker.call('rc.updates.checkNow'); assert.equal(first.count, 1);
  assert.equal(e.market.requests.filter(r => r.route === '/api/market/packages').length, 2);
  await writeFile(path.join(e.home, 'receipts.json'), '{bad');
  await assert.rejects(e.worker.call('rc.updates.checkNow'), { code: 'receipt_invalid' });
  assert.deepEqual(await e.worker.call('rc.updates.summary'), first);
});

test('檢查期間登出後，不顯示過時通知也不重新啟動排程', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const original = e.worker.orca.storage.get;
  e.worker.orca.storage.get = async key => {
    if (key === 'resource-center.update-notifications') { entered(); await gate; }
    return original(key);
  };
  const check = e.worker.call('rc.updates.checkNow');
  await started;
  await e.worker.call('rc.session.signOut');
  release(); await check;
  assert.equal(notifications(e.worker).length, 0);
  assert.equal(e.timers.tasks.size, 0);
  assert.equal((await e.worker.call('rc.updates.summary')).count, 0);
});

test('工作階段遭拒立即停止排程；背景暫時失敗仍排下一輪', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]);
  e.market.override('GET /api/market/packages', () => ({ status: 503, body: {} }));
  await e.timers.tick();
  assert.equal(e.timers.tasks.size, 1);
  assert.equal([...e.timers.tasks.values()][0].ms, 15 * 60000);
  assert.ok(e.worker.state.logs.some(l => l.includes('無法檢查資源包更新')));
  e.market.revokeAllSessions();
  e.market.override('GET /api/market/packages', () => ({ status: 401, body: {} }));
  await assert.rejects(e.worker.call('rc.updates.checkNow'));
  assert.equal(e.timers.tasks.size, 0);
});

test('重開沿用關閉排程偏好；摘要取各已部署舊目標最舊版本', async t => {
  const e = await setup(t); await e.signIn();
  await e.save([e.receipt({ packageVersion: '0.5.0' }), e.receipt({ packageVersion: '0.1.0', canonicalRoot: path.join(e.dir, '.codex-other') })]);
  assert.equal((await e.worker.call('rc.updates.checkNow')).packages[0].installedVersion, '0.1.0');
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 0 }); await settle();
  e.worker.dispose();
  const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
  await restarted.call('rc.session.getState'); await settle();
  assert.equal(e.timers.tasks.size, 0);
  assert.equal((await restarted.call('rc.updates.checkNow')).count, 1);
});

test('啟動時偏好儲存暫時未就緒，記錄安全原因並自動重試恢復定期檢查', async t => {
  const e = await setup(t); await e.signIn(); await e.save([e.receipt()]); e.worker.dispose();
  const get = e.worker.state.storage.get.bind(e.worker.state.storage);
  let failures = 2;
  e.worker.state.storage.get = key => {
    if (key === 'resource-center.preferences' && failures-- > 0) throw Object.assign(new Error('token=synthetic-secret password=synthetic-password https://market.example/?token=query-secret'), { code: 'STORAGE_NOT_READY' });
    return get(key);
  };
  const worker = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => worker.dispose());
  await settle(); await settle();
  assert.equal(e.timers.tasks.size, 1, '啟動失敗後仍安排重試');
  assert.ok([...e.timers.tasks.values()][0].ms <= 60000);
  assert.match(e.worker.state.logs.join('\n'), /無法排程更新檢查.*STORAGE_NOT_READY/);
  assert.doesNotMatch(e.worker.state.logs.join('\n'), /synthetic-secret|synthetic-password|query-secret/);
  await e.timers.tick(); await settle();
  assert.equal([...e.timers.tasks.values()][0].ms, 2000);
  await e.timers.tick(); await settle();
  assert.equal(e.timers.tasks.size, 1);
  assert.equal([...e.timers.tasks.values()][0].ms, 30000);
  await e.timers.tick(); assert.equal((await worker.call('rc.updates.summary')).count, 1);
  assert.equal([...e.timers.tasks.values()][0].ms, 15 * 60000);
});

test('啟動讀取工作階段 API 暫時失敗後可重新載入登入並恢復排程', async t => {
  const e = await setup(t); await e.signIn(); e.worker.dispose();
  const get = e.worker.state.settings.get.bind(e.worker.state.settings);
  let fail = true;
  e.worker.state.settings.get = key => {
    if (key === 'marketUrl' && fail) { fail = false; throw Object.assign(new Error('synthetic API unavailable'), { code: 'API_NOT_READY' }); }
    return get(key);
  };
  const worker = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => worker.dispose());
  await settle(); await settle();
  assert.equal(e.timers.tasks.size, 1);
  await e.timers.tick(); await settle();
  assert.equal([...e.timers.tasks.values()][0].ms, 30000);
  await e.timers.tick();
  assert.equal([...e.timers.tasks.values()][0].ms, 15 * 60000);
  assert.equal((await worker.call('rc.session.getState')).signedIn, true);
  assert.match(e.worker.state.logs.join('\n'), /code=API_NOT_READY reason=工作階段讀取/);
});

test('秘密儲存暫時失敗可重載；排程計時器暫時拋錯也會重試', async t => {
  const e = await setup(t); await e.signIn(); e.worker.dispose();
  const get = e.worker.state.secrets.get.bind(e.worker.state.secrets);
  let failRead = true, failTimer = true;
  e.worker.state.secrets.get = key => {
    if (key === 'session.v1' && failRead) { failRead = false; throw Object.assign(new Error('synthetic secret store unavailable'), { code: 'EBUSY' }); }
    return get(key);
  };
  const set = e.timers.setTimeout;
  e.timers.setTimeout = (fn, ms) => {
    if (ms === 30000 && failTimer) { failTimer = false; throw Object.assign(new Error('synthetic API failure'), { code: 'API_NOT_READY' }); }
    return set(fn, ms);
  };
  const worker = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => worker.dispose());
  await settle(); await settle();
  await e.timers.tick(); await settle();
  assert.ok([...e.timers.tasks.values()][0].ms <= 60000);
  await e.timers.tick(); await settle();
  assert.equal([...e.timers.tasks.values()][0].ms, 30000);
  await e.timers.tick();
  assert.equal([...e.timers.tasks.values()][0].ms, 15 * 60000);
  assert.match(e.worker.state.logs.join('\n'), /code=EBUSY reason=工作階段讀取/);
  assert.match(e.worker.state.logs.join('\n'), /code=API_NOT_READY reason=計時器建立/);
});

test('排程重試等待期間關閉、登出或 dispose 不重建計時器', async t => {
  for (const action of ['disable', 'logout', 'dispose']) {
    const e = await setup(t); await e.signIn();
    const get = e.worker.orca.storage.get;
    let fail = true;
    e.worker.orca.storage.get = async key => {
      if (key === 'resource-center.preferences' && fail) { fail = false; throw Object.assign(new Error('synthetic'), { code: 'STORAGE_NOT_READY' }); }
      return get(key);
    };
    // 背景回呼會重新讀取排程設定，暫時失敗後只保留重試。
    await e.timers.tick(); await settle();
    const stale = [...e.timers.tasks.values()][0].fn;
    if (action === 'disable') await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 0 });
    if (action === 'logout') await e.worker.call('rc.session.signOut');
    if (action === 'dispose') e.worker.dispose();
    await settle(); assert.equal(e.timers.tasks.size, 0);
    await stale(); await settle(); assert.equal(e.timers.tasks.size, 0);
  }
});

test('較舊的偏好讀取失敗不覆蓋較新的關閉排程設定', async t => {
  const e = await setup(t); await e.signIn();
  let entered, reject;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise((_, fail) => { reject = fail; });
  const get = e.worker.orca.storage.get;
  let first = true;
  e.worker.orca.storage.get = async key => {
    if (key === 'resource-center.preferences' && first) { first = false; entered(); return gate; }
    return get(key);
  };
  const background = e.timers.tick(); await started;
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 0 }); await settle();
  reject(Object.assign(new Error('stale failure'), { code: 'STORAGE_NOT_READY' })); await background; await settle();
  assert.equal(e.timers.tasks.size, 0);
});

test('已取消但排入事件佇列的舊回呼不執行檢查或遺失新計時器', async t => {
  const e = await setup(t); await e.signIn();
  const stale = [...e.timers.tasks.values()][0].fn;
  await e.worker.call('rc.preferences.set', { checkIntervalMinutes: 60 }); await settle();
  const before = e.market.requests.length;
  await stale(); await settle();
  assert.equal(e.market.requests.length, before);
  assert.equal(e.timers.tasks.size, 1);
  await e.worker.call('rc.session.signOut'); assert.equal(e.timers.tasks.size, 0);
});
