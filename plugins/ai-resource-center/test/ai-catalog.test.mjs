import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';

const summary = (extra = {}) => ({ packageKey: 'demo', name: '示範資源包', type: 'skill',
  description: '整理會議紀錄', category: '文件', tags: ['會議'], latestReleaseVersion: '1.0.0', latestPreviewVersion: '2.0.0', ...extra });
const readmePath = (key = 'demo', version = '1.0.0') => `/api/market/packages/${key}/versions/${version}/readme`;
async function setup(t, rows = [summary()]) {
  const market = await startFakeMarket({ packages: rows });
  const worker = startWorker();
  t.after(async () => { worker.dispose(); await market.close(); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { market, worker };
}

test('AI 資源清單包含可見版本與推薦卡片需要的摘要，依偏好設定讀取 Preview', async t => {
  const { market, worker } = await setup(t, [summary(), summary({ packageKey: 'preview-only', latestReleaseVersion: null })]);
  const first = await worker.call('rc.ai.catalog.get');
  assert.deepEqual(first.packages, [{ packageKey: 'demo', name: '示範資源包', description: '整理會議紀錄', category: '文件', tags: ['會議'], version: '1.0.0' }]);
  assert.equal(market.requests.filter(r => r.path.endsWith('/readme')).length, 0);
  assert.equal(first.packageCount, 1);
  assert.deepEqual(first.packageKeys, ['demo']);
  await worker.call('rc.preferences.set', { showPreview: true });
  let channel;
  market.override('GET /api/market/packages', req => { channel = new URL(req.url, market.url).searchParams.get('channel'); });
  const preview = await worker.call('rc.ai.catalog.get');
  assert.deepEqual(preview.packages.map(p => p.version), ['2.0.0', '2.0.0']);
  assert.equal(preview.packageCount, 2);
  assert.deepEqual(preview.packageKeys, ['demo', 'preview-only']);
  assert.equal(channel, 'preview');
});

test('README 截斷到 6000 字並依識別碼與版本快取，重新整理只抓新版本', async t => {
  const rows = [summary()];
  const { market, worker } = await setup(t, rows);
  market.override(`GET ${readmePath()}`, () => ({ status: 200, body: { readme: '會'.repeat(6001) } }));
  market.override(`GET ${readmePath('demo', '1.1.0')}`, () => ({ status: 200, body: { readme: '新說明' } }));
  const first = await worker.call('rc.ai.catalog.get', { keys: ['demo'] });
  assert.equal(first.packages[0].readme, '會'.repeat(6000));
  first.packages[0].readme = '呼叫端改動';
  assert.equal((await worker.call('rc.ai.catalog.get', { keys: ['demo'] })).packages[0].readme, '會'.repeat(6000));
  rows[0].latestReleaseVersion = '1.1.0';
  assert.equal((await worker.call('rc.ai.catalog.get', { keys: ['demo'] })).packages[0].readme, '新說明');
  assert.deepEqual(market.requests.filter(r => r.path.endsWith('/readme')).map(r => r.path), [readmePath(), readmePath('demo', '1.1.0')]);
});

test('README 失敗或空白只省略該份說明，其他資源包照常，失敗後可重試', async t => {
  const { market, worker } = await setup(t, ['ok', 'empty', 'failed', 'invalid'].map(packageKey => summary({ packageKey })));
  market.override(`GET ${readmePath('ok')}`, () => ({ status: 200, body: { readme: '可用說明' } }));
  market.override(`GET ${readmePath('empty')}`, () => ({ status: 200, body: { readme: '   ' } }));
  market.override(`GET ${readmePath('failed')}`, () => ({ status: 503, body: {} }));
  market.override(`GET ${readmePath('invalid')}`, () => ({ status: 200, body: { readme: 123 } }));
  const first = await worker.call('rc.ai.catalog.get', { keys: ['ok', 'empty', 'failed', 'invalid'] });
  assert.equal(first.packageCount, 4);
  assert.deepEqual(first.packages.filter(p => p.readme).map(p => p.packageKey), ['ok']);
  market.override(`GET ${readmePath('failed')}`, () => ({ status: 200, body: { readme: '已恢復' } }));
  assert.equal((await worker.call('rc.ai.catalog.get', { keys: ['ok', 'empty', 'failed', 'invalid'] })).packages.find(p => p.packageKey === 'failed').readme, '已恢復');
});

test('目錄不預讀 README，僅讀取指定候選且不因總字數退回摘要', async t => {
  const rows = Array.from({ length: 61 }, (_, i) => summary({ packageKey: `demo-${i}` }));
  const { market, worker } = await setup(t, rows);
  for (const p of rows) market.override(`GET ${readmePath(p.packageKey)}`, () => ({ status: 200, body: { readme: '會'.repeat(6000) } }));
  const list = await worker.call('rc.ai.catalog.get');
  assert.equal(list.packageCount, 61);
  assert.equal(market.requests.filter(r => r.path.endsWith('/readme')).length, 0);
  const result = await worker.call('rc.ai.catalog.get', { keys: rows.map(p => p.packageKey) });
  assert.ok(result.packages.every(p => p.readme.length === 6000));
});

test('同時組成清單仍只並行讀取最多 4 份 README，同版本不重複請求', async t => {
  const rows = Array.from({ length: 9 }, (_, i) => summary({ packageKey: `demo-${i}` }));
  const { market, worker } = await setup(t, rows);
  let active = 0, peak = 0;
  for (const p of rows) market.override(`GET ${readmePath(p.packageKey)}`, async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    return { status: 200, body: { readme: '說明' } };
  });
  const results = await Promise.all([worker.call('rc.ai.catalog.get', { keys: rows.map(p => p.packageKey) }), worker.call('rc.ai.catalog.get', { keys: rows.map(p => p.packageKey) })]);
  assert.equal(peak, 4);
  assert.ok(results.every(r => r.packages.every(p => p.readme === '說明')));
  assert.equal(market.requests.filter(r => r.path.endsWith('/readme')).length, 9);
});

test('登出清空記憶體快取，重新登入與重開 worker 都重新讀取 README', async t => {
  const { market, worker } = await setup(t);
  let readme = '第一次';
  market.override(`GET ${readmePath()}`, () => ({ status: 200, body: { readme } }));
  assert.equal((await worker.call('rc.ai.catalog.get', { keys: ['demo'] })).packages[0].readme, '第一次');
  await worker.call('rc.session.signOut');
  await assert.rejects(worker.call('rc.ai.catalog.get', { keys: ['demo'] }), { code: 'signed_out' });
  readme = '重新登入';
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  assert.equal((await worker.call('rc.ai.catalog.get', { keys: ['demo'] })).packages[0].readme, '重新登入');
  const reopened = startWorker({ state: worker.state });
  t.after(() => reopened.dispose());
  readme = '重新啟動';
  assert.equal((await reopened.call('rc.ai.catalog.get', { keys: ['demo'] })).packages[0].readme, '重新啟動');
  assert.ok(!JSON.stringify([...worker.state.storage]).includes('重新登入'));
});

test('登出時尚未完成的清單不可回傳舊工作階段資料，也不污染重新登入的快取', async t => {
  const { market, worker } = await setup(t);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  market.override(`GET ${readmePath()}`, async () => {
    started();
    await held;
    return { status: 200, body: { readme: '舊工作階段' } };
  });
  const pending = worker.call('rc.ai.catalog.get', { keys: ['demo'] });
  const rejected = assert.rejects(pending, { code: 'signed_out' });
  await entered;
  await worker.call('rc.session.signOut');
  release();
  await rejected;
  market.override(`GET ${readmePath()}`, () => ({ status: 200, body: { readme: '新工作階段' } }));
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  assert.equal((await worker.call('rc.ai.catalog.get', { keys: ['demo'] })).packages[0].readme, '新工作階段');
});

test('README 讀取遇到工作階段撤銷時要求重新登入，不能偽裝成部分說明失敗', async t => {
  const { market, worker } = await setup(t);
  market.override(`GET ${readmePath()}`, () => { market.revokeAllSessions(); return { status: 401, body: {} }; });
  await assert.rejects(worker.call('rc.ai.catalog.get', { keys: ['demo'] }), { code: 'session_expired' });
  assert.equal((await worker.call('rc.session.getState')).signedIn, false);
});

const detailPath = (key = 'demo') => `/api/market/packages/${key}`;
const detailBody = (contents, version = '1.0.0') => ({ packageKey: 'demo', name: '示範資源包', versions: [
  { version, channel: 'release', isEnabled: true, contents },
  { version: '0.9.0', channel: 'release', isEnabled: true, contents: [{ id: 'old-skill', kind: 'skill', description: '舊版內容' }] }] });

test('資源清單附上該版本內容清單的識別碼與說明，供第一階段挑選；依識別碼與版本快取', async t => {
  const { market, worker } = await setup(t);
  market.override(`GET ${detailPath()}`, () => ({ status: 200, body: detailBody([
    { id: 'meeting-processor', kind: 'skill', name: 'meeting-processor', description: '整理逐字稿、錄音與白板圖片，依範本產出會議紀錄' },
    { id: 'usecase-spec-composer', kind: 'skill', name: null, description: null },
    { id: 'long', kind: 'skill', description: '長'.repeat(300) }]) }));
  const first = await worker.call('rc.ai.catalog.get');
  assert.deepEqual(first.packages[0].contents.slice(0, 2), ['meeting-processor：整理逐字稿、錄音與白板圖片，依範本產出會議紀錄', 'usecase-spec-composer']);
  assert.equal(first.packages[0].contents[2], `long：${'長'.repeat(120)}`, '說明截斷到 120 字');
  await worker.call('rc.ai.catalog.get');
  assert.equal(market.requests.filter(r => r.path === detailPath()).length, 1, '同版本不重抓明細');
});

test('明細讀取失敗或沒有內容清單時省略 contents，清單照常', async t => {
  const { market, worker } = await setup(t);
  market.override(`GET ${detailPath()}`, () => ({ status: 500, body: {} }));
  const failed = await worker.call('rc.ai.catalog.get');
  assert.equal(failed.packageCount, 1);
  assert.equal('contents' in failed.packages[0], false);
  market.override(`GET ${detailPath()}`, () => ({ status: 200, body: detailBody([]) }));
  const empty = await worker.call('rc.ai.catalog.get');
  assert.equal('contents' in empty.packages[0], false);
});
