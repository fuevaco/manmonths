import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf } from './panel-harness.mjs';
const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const item = { packageKey: 'demo', name: '<script>合成包</script>', type: 'skill', latestVisibleVersion: '1.0.0' };

test('面板登入後讀取並以純文字呈現單欄資源清單', async () => {
  const panel = await startPanel(async (method) => method === 'rc.session.getState' ? signedIn : { data: [item] });
  assert.match(textOf(panel.get('catalog-list')), /<script>合成包<\/script>/);
  assert.match(textOf(panel.get('catalog-list')), /Skills/);
  assert.match(textOf(panel.get('catalog-list')), /1\.0\.0/);
});

test('目錄讀取失敗提供重試，工作階段失效回登入畫面', async () => {
  let fail = 'service_unavailable';
  const panel = await startPanel(async (method) => {
    if (method === 'rc.session.getState') return fail === 'session_expired' ? { signedIn: false, notice: '請重新登入' } : signedIn;
    if (fail) throw Object.assign(new Error('目錄暫時無法讀取'), { code: fail });
    return { data: [item] };
  });
  assert.equal(panel.get('catalog-retry').classList.contains('hidden'), false);
  fail = '';
  await panel.get('catalog-retry').fire('click');
  assert.match(textOf(panel.get('catalog-list')), /合成包/);
  fail = 'session_expired';
  await panel.get('catalog-retry').fire('click');
  await settle();
  assert.equal(panel.get('view-main').classList.contains('hidden'), true);
  assert.match(textOf(panel.get('login-notice')), /重新登入/);
});

test('較晚抵達的舊清單及舊錯誤不覆蓋新篩選結果', async () => {
  let resolveOld, rejectOld;
  let next = 'success';
  const panel = await startPanel(async (method, input) => {
    if (method === 'rc.session.getState') return signedIn;
    if (input.type === 'agent') return new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    return { data: [item] };
  });
  for (next of ['success', 'failure']) {
    panel.get('catalog-type').value = 'agent';
    const old = panel.get('catalog-type').fire('change');
    panel.get('catalog-type').value = 'skill';
    await panel.get('catalog-type').fire('change');
    if (next === 'success') resolveOld({ data: [{ ...item, name: '舊 Agent' }] });
    else rejectOld(new Error('舊錯誤'));
    await old;
    assert.match(textOf(panel.get('catalog-list')), /合成包/);
    assert.doesNotMatch(textOf(panel.get('catalog-list')), /舊 Agent/);
    assert.doesNotMatch(textOf(panel.get('catalog-status')), /舊錯誤/);
  }
});

test('面板送出搜尋、類型與 Preview 條件並可清除搜尋重試空結果', async () => {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input });
    return method === 'rc.session.getState' ? signedIn : { data: [] };
  });
  panel.get('catalog-search').value = 'demo';
  panel.get('catalog-type').value = 'mcp';
  panel.get('catalog-preview').checked = true;
  await panel.get('catalog-form').fire('submit');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { method: 'rc.catalog.list', input: { search: 'demo', type: 'mcp', previewMode: true } });
  assert.match(textOf(panel.get('catalog-status')), /沒有符合/);
  await panel.get('catalog-clear').fire('click');
  assert.equal(calls.at(-1).input.search, '');
  assert.equal(calls.at(-1).input.type, '');
});

test('從清單開啟詳情、切換版本、下載失敗後重試並顯示儲存位置', async () => {
  const calls = []; let fail = true;
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.download.save') {
      if (fail) throw new Error('下載中斷，請重試');
      return { filePath: '/downloads/demo-0.9.0.zip' };
    }
    return { ...item, description: '資源說明', selectedVersion: input.version || '1.0.0', readme: '<script>使用說明</script>',
      versions: ['1.0.0', '0.9.0'].map(version => ({ version, hosts: ['codex'], changelog: `更新 ${version}` })) };
  });
  await panel.get('catalog-list').children[0].children.at(-1).fire('click');
  assert.equal(panel.get('view-details').classList.contains('hidden'), false);
  assert.match(textOf(panel.get('details-readme')), /<script>使用說明<\/script>/);
  assert.match(textOf(panel.get('details-hosts')), /codex/);
  panel.get('details-version').value = '0.9.0';
  await panel.get('details-version').fire('change');
  assert.equal(calls.filter(c => c.method === 'rc.package.getDetails').at(-1).input.version, '0.9.0');
  await panel.get('details-download').fire('click');
  assert.match(textOf(panel.get('details-status')), /下載中斷/);
  fail = false;
  await panel.get('details-download').fire('click');
  assert.equal(calls.at(-1).input.version, '0.9.0');
  assert.match(textOf(panel.get('details-status')), /downloads\/demo-0.9.0.zip/);
  await panel.get('details-back').fire('click');
  assert.equal(panel.get('view-main').classList.contains('hidden'), false);
});

test('返回或登出後，較晚抵達的詳情不覆蓋目前畫面與版本', async () => {
  let resolveDetail;
  const panel = await startPanel(async method => {
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.session.signOut') return { signedIn: false };
    if (method === 'rc.catalog.list') return { data: [item] };
    return new Promise(resolve => { resolveDetail = resolve; });
  });
  const open = panel.get('catalog-list').children[0].children.at(-1).fire('click');
  await panel.get('details-back').fire('click');
  await panel.get('btn-logout').fire('click');
  resolveDetail({ name: '舊詳情', selectedVersion: '1.0.0', versions: [{ version: '1.0.0', hosts: [] }], readme: 'old' });
  await open;
  assert.equal(panel.get('view-login').classList.contains('hidden'), false);
  assert.doesNotMatch(textOf(panel.get('details-title')), /舊詳情/);
});
