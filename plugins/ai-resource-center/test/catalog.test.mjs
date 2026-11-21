import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';

const summary = (extra = {}) => ({ packageKey: 'demo-skill', name: '示範 Skill', type: 'skill',
  description: '合成資料', category: 'Demo', latestReleaseVersion: '1.0.0', latestPreviewVersion: '2.0.0', ...extra });
async function setup(t, opts) {
  const market = await startFakeMarket(opts);
  const worker = startWorker();
  t.after(async () => { worker.dispose(); await market.close(); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { market, worker };
}

test('目錄透過工作階段讀取摘要，顯示名稱、類型與正式版本，不混用下載與安裝次數', async (t) => {
  const { market, worker } = await setup(t);
  market.override('GET /api/market/packages', () => ({ status: 200,
    body: { data: [summary({ installCount: 34, downloadCount: 12, token: '不應回傳' })], meta: { total: 1, page: 1, pageSize: 50 } } }));
  const result = await worker.call('rc.catalog.list');
  assert.equal(result.data[0].name, '示範 Skill');
  assert.equal(result.data[0].type, 'skill');
  assert.equal(result.data[0].latestVisibleVersion, '1.0.0');
  assert.equal(result.data[0].installCount, 34);
  assert.equal(result.data[0].downloadCount, 12);
  assert.equal(result.data[0].token, undefined);
});

test('目錄空白、伺服器失敗與錯誤格式可區分，失敗後可重新讀取', async (t) => {
  const { worker, market } = await setup(t);
  assert.deepEqual((await worker.call('rc.catalog.list')).data, []);
  for (const body of [{}, { data: [], meta: { total: 'bad' } }, { data: [null], meta: { total: 1 } }]) {
    market.override('GET /api/market/packages', () => ({ status: 200, body }));
    await assert.rejects(worker.call('rc.catalog.list'), { code: 'market_error' });
  }
  market.override('GET /api/market/packages', () => ({ status: 503, body: { title: '維護中' } }));
  await assert.rejects(worker.call('rc.catalog.list'), { code: 'service_unavailable' });
  market.clearOverrides();
  assert.deepEqual((await worker.call('rc.catalog.list')).data, []);
});

test('查詢輸入型別與類型值錯誤時拒絕，不會當成全部資源包', async (t) => {
  const { worker } = await setup(t);
  for (const input of [{ search: [] }, { type: 'unknown' }, { category: 4 }, { previewMode: 'true' }, []]) {
    await assert.rejects(worker.call('rc.catalog.list', input), { code: 'invalid_params' });
  }
});

test('目錄 401 續期重送，工作階段被撤銷時回報需重新登入', async (t) => {
  const { worker, market } = await setup(t);
  market.expireAccessTokens();
  assert.deepEqual((await worker.call('rc.catalog.list')).data, []);
  market.revokeAllSessions();
  await assert.rejects(worker.call('rc.catalog.list'), { code: 'session_expired' });
  assert.equal((await worker.call('rc.session.getState')).signedIn, false);
});

test('頁界移動不重複列出資源包', async (t) => {
  const { worker, market } = await setup(t);
  market.override('GET /api/market/packages', (req) => ({ status: 200, body: {
    data: new URL(req.url, market.url).searchParams.get('page') === '1' ? [summary()] : [summary(), summary({ packageKey: 'second' })],
    meta: { total: 51 }
  } }));
  const result = await worker.call('rc.catalog.list');
  assert.deepEqual(result.data.map((p) => p.packageKey), ['demo-skill', 'second']);
});

test('搜尋會去除前後空白並與類型、分類相交，特殊字元不會變成查詢參數', async (t) => {
  const { worker } = await setup(t, { packages: [
    summary({ name: 'A & B', category: '' }),
    summary({ packageKey: 'demo-agent', name: 'A & B', type: 'agent', category: '' }),
    summary({ packageKey: 'demo-other', name: 'Other', category: '' }),
    summary({ packageKey: 'demo-category', name: 'A & B' })
  ] });
  const result = await worker.call('rc.catalog.list', { search: '  a & b  ', type: 'skill', category: '未分類' });
  assert.deepEqual(result.data.map((p) => p.packageKey), ['demo-skill']);
});

test('目錄讀完超過 50 筆的分頁，每頁維持相同條件，重新整理取得新資料', async (t) => {
  const packages = Array.from({ length: 51 }, (_, i) => summary({ packageKey: `demo-${String(i).padStart(2, '0')}` }));
  const { worker } = await setup(t, { packages });
  const input = { search: 'demo', type: 'skill', category: 'Demo' };
  const first = await worker.call('rc.catalog.list', input);
  assert.equal(first.data.length, 51);
  packages[50].latestReleaseVersion = '1.1.0';
  const second = await worker.call('rc.catalog.list', input);
  assert.equal(second.data[50].latestVisibleVersion, '1.1.0');
});

test('Preview 模式傳遞通道，正式版優先，僅 Preview 的包在開啟時才顯示版本', async (t) => {
  const { worker, market } = await setup(t);
  market.override('GET /api/market/packages', (req) => ({ status: 200, body: {
    data: [summary(), summary({ packageKey: 'preview-only', latestReleaseVersion: null })], meta: { total: 2 }
  } }));
  assert.equal((await worker.call('rc.catalog.list')).data[1].latestVisibleVersion, null);
  const result = await worker.call('rc.catalog.list', { previewMode: true });
  assert.equal(result.data[0].latestVisibleVersion, '1.0.0');
  assert.equal(result.data[1].latestVisibleVersion, '2.0.0');
  market.override('GET /api/market/packages', (req) => {
    assert.equal(new URL(req.url, market.url).searchParams.get('channel'), 'preview');
    return { status: 200, body: { data: [], meta: { total: 0 } } };
  });
  await worker.call('rc.catalog.list', { previewMode: true });
});
