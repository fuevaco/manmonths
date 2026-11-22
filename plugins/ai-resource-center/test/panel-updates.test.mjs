// 工項 13（面板端）：檢查更新頻率、可更新數量、提示列、↻ 與切回面板時的同步。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, textOf, findByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const item = { packageKey: 'demo', name: 'Demo 資源包', type: 'skill', description: '清單描述', hasFullGuide: false, latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [], tools: [] };
const summaryOf = (count) => ({ count, packages: Array.from({ length: count }, (_, i) => ({ packageKey: `p${i}`, name: `P${i}`, installedVersion: '1.0.0', updateVersion: '2.0.0' })), checkedAt: '2026-11-21T00:00:00.000Z' });

async function start({ preferences = {}, summary = summaryOf(0), checkNow, handler } = {}) {
  const calls = [];
  const state = { summary, checkNow: checkNow ?? (() => state.summary) };
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    const custom = handler && await handler(method, input, calls);
    if (custom !== undefined) return custom;
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false, checkIntervalMinutes: 15, ...preferences };
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.updates.summary') return state.summary;
    if (method === 'rc.updates.checkNow') return state.checkNow();
    if (method === 'rc.package.getDetails') return { ...item, selectedVersion: '1.2.0', readme: '', versions: [{ version: '1.2.0', hosts: [] }] };
    return {};
  });
  const count = (method) => calls.filter(c => c.method === method).length;
  return { panel, calls, state, count };
}
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');
const text = (panel, id) => textOf(panel.get(id)).replace(/\s+/g, ' ').trim();
const optionText = (panel) => text(panel, 'catalog-installation-updates');

test('齒輪選單設定區：預覽開關與「檢查更新」下拉（15 分鐘、1 小時、4 小時、1 天、關閉）', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const menu = html.slice(html.indexOf('id="menu-settings"'), html.indexOf('id="btn-logout"'));
  assert.match(menu, /id="catalog-preview"/);
  const select = menu.match(/<select[^>]*id="check-interval"[^>]*>[\s\S]*?<\/select>/)[0];
  assert.match(select, /aria-label="檢查更新"/);
  const options = [...select.matchAll(/<option value="(\d+)"[^>]*>([^<]*)<\/option>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(options, [['15', '15 分鐘'], ['60', '1 小時'], ['240', '4 小時'], ['1440', '1 天'], ['0', '關閉']]);
  assert.match(menu, /<label[^>]*for="check-interval"[^>]*>檢查更新<\/label>/);
});

test('檢查更新：預設 15 分鐘；讀取已儲存的偏好；偏好沒有或無效時退回 15', async () => {
  let { panel } = await start();
  assert.equal(panel.get('check-interval').value, '15');
  ({ panel } = await start({ preferences: { checkIntervalMinutes: 240 } }));
  assert.equal(panel.get('check-interval').value, '240');
  ({ panel } = await start({ preferences: { checkIntervalMinutes: 0 } }));
  assert.equal(panel.get('check-interval').value, '0', '關閉也是有效值');
  ({ panel } = await start({ preferences: { checkIntervalMinutes: 7 } }));
  assert.equal(panel.get('check-interval').value, '15');
});

test('變更檢查更新：以平面物件寫入 rc.preferences.set，不重新查詢清單', async () => {
  const { panel, calls, count } = await start();
  const lists = count('rc.catalog.list');
  for (const [value, minutes] of [['60', 60], ['1440', 1440], ['0', 0], ['15', 15]]) {
    panel.get('check-interval').value = value;
    await panel.get('check-interval').fire('change');
    await settle();
    assert.deepEqual(calls.filter(c => c.method === 'rc.preferences.set').at(-1).input, { checkIntervalMinutes: minutes });
  }
  assert.equal(count('rc.catalog.list'), lists);
});

test('儲存失敗：還原下拉選項並顯示提示；無效值不送出', async () => {
  const { panel, count } = await start({ preferences: { checkIntervalMinutes: 60 }, handler: async (method) => {
    if (method === 'rc.preferences.set') throw Object.assign(new Error('寫入失敗'), { code: 'storage_failed' });
  } });
  panel.get('check-interval').value = '240';
  await panel.get('check-interval').fire('change');
  await settle();
  assert.equal(panel.get('check-interval').value, '60');
  assert.match(textOf(panel.get('toast')), /檢查更新/);
  assert.equal(count('rc.preferences.set'), 1);
  panel.get('check-interval').value = '7';
  await panel.get('check-interval').fire('change');
  await settle();
  assert.equal(count('rc.preferences.set'), 1);
  assert.equal(panel.get('check-interval').value, '60');
});

test('可更新數量：狀態下拉顯示「可更新 (N)」，0 時只顯示「可更新」', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  assert.match(html, /<option id="catalog-installation-updates" value="updates">可更新<\/option>/);
  let { panel } = await start({ summary: summaryOf(3) });
  assert.equal(optionText(panel), '可更新 (3)');
  ({ panel } = await start({ summary: summaryOf(0) }));
  assert.equal(optionText(panel), '可更新');
});

test('提示列：N > 0 時顯示「N 個資源包可更新」；0 時隱藏；點選後切到可更新篩選並查詢', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const banner = html.match(/<button[^>]*id="update-banner"[^>]*>/)[0];
  assert.match(banner, /data-role="update-banner"/);
  assert.match(banner, /class="[^"]*hidden/);
  const query = html.indexOf('id="catalog-form"'), status = html.indexOf('id="catalog-status"');
  assert.ok(html.indexOf('id="update-banner"') > query && html.indexOf('id="update-banner"') < status, '提示列在查詢列與「共 N 個」之間');

  const zero = await start({ summary: summaryOf(0) });
  assert.equal(hidden(zero.panel, 'update-banner'), true);

  const { panel, calls } = await start({ summary: summaryOf(2) });
  assert.equal(hidden(panel, 'update-banner'), false);
  assert.equal(text(panel, 'update-banner'), '2 個資源包可更新');
  assert.equal(panel.get('catalog-installation').value, '');
  await panel.get('update-banner').fire('click');
  await settle();
  assert.equal(panel.get('catalog-installation').value, 'updates');
  assert.equal(calls.filter(c => c.method === 'rc.catalog.list').at(-1).input.installation, 'updates');
});

test('開啟面板時讀取摘要並立即同步一次（checkNow）；同步結果更新數量，同步失敗保留舊數量', async () => {
  const { panel, calls, state, count } = await start({ summary: summaryOf(1), checkNow: () => summaryOf(4) });
  assert.equal(count('rc.updates.summary') >= 1, true);
  assert.equal(count('rc.updates.checkNow'), 1);
  assert.ok(calls.findIndex(c => c.method === 'rc.updates.summary') < calls.findIndex(c => c.method === 'rc.updates.checkNow'), '先顯示最近的摘要，再同步');
  assert.equal(optionText(panel), '可更新 (4)');
  assert.equal(text(panel, 'update-banner'), '4 個資源包可更新');

  state.summary = summaryOf(4); // worker 的摘要保留最近一次成功檢查的結果
  state.checkNow = () => { throw new Error('市集暫時無法連線'); };
  await panel.get('btn-refresh').fire('click');
  await settle();
  assert.equal(optionText(panel), '可更新 (4)', '失敗時保留上次的數量');
  assert.equal(hidden(panel, 'update-banner'), false);
  assert.equal(panel.get('view-main').classList.contains('hidden'), false);
});

test('↻：清單頁與明細頁都除了重新整理，也呼叫 rc.updates.checkNow 並更新數量', async () => {
  const { panel, state, count } = await start({ summary: summaryOf(0) });
  const before = count('rc.updates.checkNow');
  state.checkNow = () => summaryOf(2);
  await panel.get('btn-refresh').fire('click');
  await settle();
  assert.equal(count('rc.updates.checkNow'), before + 1);
  assert.equal(optionText(panel), '可更新 (2)');
  await findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click');
  await settle();
  state.checkNow = () => summaryOf(0);
  const detailsBefore = count('rc.package.getDetails');
  const checksBefore = count('rc.updates.checkNow');
  await panel.get('btn-refresh').fire('click');
  await settle();
  assert.equal(count('rc.package.getDetails'), detailsBefore + 1);
  assert.equal(count('rc.updates.checkNow'), checksBefore + 1);
  assert.equal(optionText(panel), '可更新');
  assert.equal(hidden(panel, 'update-banner'), true);
});

test('切回面板（visibilitychange 變為可見）：重新整理清單與安裝狀態並更新數量；隱藏時不做任何事', async () => {
  const { panel, state, count } = await start({ summary: summaryOf(0) });
  const lists = count('rc.catalog.list'), checks = count('rc.updates.checkNow');
  await panel.setVisibility('hidden');
  assert.equal(count('rc.catalog.list'), lists);
  assert.equal(count('rc.updates.checkNow'), checks);
  state.checkNow = () => summaryOf(5);
  await panel.setVisibility('visible');
  assert.equal(count('rc.catalog.list'), lists + 1);
  assert.equal(count('rc.updates.checkNow'), checks + 1);
  assert.equal(optionText(panel), '可更新 (5)');
});

test('切回面板時，清單使用上次查詢的條件（輸入框內尚未送出的字不會被套用）並保留捲動位置', async () => {
  const { panel, calls } = await start();
  panel.get('catalog-search').value = '還沒按 Enter';
  panel.get('view-main').scrollTop = 120;
  await panel.setVisibility('visible');
  assert.equal(calls.filter(c => c.method === 'rc.catalog.list').at(-1).input.search, '');
  assert.equal(panel.get('view-main').scrollTop, 120);
});

test('切回面板時在明細頁：重新讀取該資源包的安裝狀態；登入畫面不做任何事', async () => {
  const { panel, count } = await start();
  await findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click');
  await settle();
  const details = count('rc.package.getDetails');
  await panel.setVisibility('visible');
  assert.equal(count('rc.package.getDetails'), details + 1);
  assert.equal(panel.get('view-details').classList.contains('hidden'), false);

  const login = await start({ handler: async (method) => method === 'rc.session.getState' ? { signedIn: false, marketUrl: 'https://market.example.com' } : undefined });
  const lists = login.count('rc.catalog.list'), checks = login.count('rc.updates.checkNow');
  await login.panel.setVisibility('visible');
  assert.equal(login.count('rc.catalog.list'), lists);
  assert.equal(login.count('rc.updates.checkNow'), checks);
});

test('切回面板時不與進行中的查詢或同步重疊', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { panel, count } = await start({ handler: async (method) => {
    if (method === 'rc.catalog.list') { await gate; return { data: [item] }; }
    if (method === 'rc.updates.checkNow') { await gate; return summaryOf(1); }
  } });
  assert.equal(count('rc.catalog.list'), 1);
  assert.equal(count('rc.updates.checkNow'), 1);
  await panel.setVisibility('visible');
  await panel.setVisibility('visible');
  assert.equal(count('rc.catalog.list'), 1, '清單查詢尚未完成時不再重複查詢');
  assert.equal(count('rc.updates.checkNow'), 1, '同步尚未完成時不再重複同步');
  release();
  await settle(); await settle();
  assert.equal(optionText(panel), '可更新 (1)');
});

test('登出後清空可更新數量；一鍵安裝完成後重新同步數量（不自動更新任何資源包）', async () => {
  const { panel, state, count, calls } = await start({ summary: summaryOf(2), handler: async (method, input) => {
    if (method === 'rc.install.run') return { ok: true, succeeded: [{ targetId: 't', hostId: 'codex', label: 'Codex', rootPath: '/x' }], failed: [], backups: [] };
    if (method === 'rc.session.signOut') return { signedIn: false, marketUrl: 'https://market.example.com' };
  } });
  assert.equal(optionText(panel), '可更新 (2)');
  const checks = count('rc.updates.checkNow');
  state.checkNow = () => summaryOf(1);
  await findByData(findByData(panel.get('catalog-list'), 'package-key', 'demo'), 'action', 'install').fire('click');
  await settle(); await settle();
  assert.equal(count('rc.updates.checkNow'), checks + 1);
  assert.equal(optionText(panel), '可更新 (1)');
  assert.deepEqual(calls.filter(c => c.method === 'rc.install.run').map(c => c.input.action), ['install'], '只執行使用者按下的動作');
  await panel.get('btn-logout').fire('click');
  await settle();
  assert.equal(optionText(panel), '可更新');
  assert.equal(hidden(panel, 'update-banner'), true);
});
