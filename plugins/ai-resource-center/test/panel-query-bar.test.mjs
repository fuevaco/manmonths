// 工項 04：精簡查詢列（搜尋框、類型、安裝狀態、排序欄位與方向）、Preview 開關移到齒輪選單、排序偏好還原與儲存。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const item = (n) => ({ packageKey: `demo-${n}`, name: `資源包 ${n}`, type: 'skill', latestVisibleVersion: '1.0.0', installationStatus: 'notInstalled', deployments: [], tools: [] });
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 啟動面板；預設偏好為 worker 的預設值，可注入偏好、清單與其他請求的行為。 */
async function start({ prefs = { sortField: 'installCount', sortDirection: 'desc', showPreview: false, checkIntervalMinutes: 15 }, items = [item(1), item(2)], extra = {} } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: plain(input ?? null) });
    if (extra[method]) return extra[method](input);
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return prefs;
    if (method === 'rc.preferences.set') return { ...prefs, ...input };
    if (method === 'rc.catalog.list') return { data: items };
    if (method === 'rc.client.getVersions') return { orca: { version: '1.0.0', source: 'plugin' } };
    return {};
  });
  const lists = () => calls.filter(c => c.method === 'rc.catalog.list');
  const sets = () => calls.filter(c => c.method === 'rc.preferences.set');
  return { panel, calls, lists, sets };
}
const readPanelFile = (name) => readFile(new URL(`../panel/${name}`, import.meta.url), 'utf8');
const mainSection = (html) => html.slice(html.indexOf('id="view-main"'), html.indexOf('id="view-details"'));

test('查詢區沒有「全部資源包」標題、「搜尋」與「清除篩選」按鈕；搜尋框有放大鏡 SVG 與 placeholder', async () => {
  const html = await readPanelFile('index.html');
  const main = mainSection(html);
  assert.doesNotMatch(main, /全部資源包/);
  assert.doesNotMatch(main, /id="catalog-clear"/);
  assert.doesNotMatch(main, /type="submit"/);
  assert.doesNotMatch(main, /<button[^>]*>\s*搜尋\s*<\/button>/);
  const search = main.slice(main.indexOf('class="search-field"'), main.indexOf('id="catalog-search"') + 200);
  assert.match(search, /<svg[^>]*class="search-icon"/);
  assert.match(main.match(/<input[^>]*id="catalog-search"[^>]*>/)[0], /placeholder="搜尋名稱、識別碼或說明"/);
  for (const id of ['catalog-type', 'catalog-installation', 'catalog-sort-field', 'catalog-sort-direction']) assert.ok(main.includes(`id="${id}"`), `${id} 存在`);
  assert.ok(main.indexOf('id="catalog-search"') < main.indexOf('id="catalog-type"'), '搜尋框在第一行，下拉在第二行');
  assert.ok(main.indexOf('id="catalog-sort-direction"') < main.indexOf('id="catalog-status"'), '「共 N 個」在查詢列下方');
});

test('排序欄位下拉為安裝次數、名稱、擁有者、上傳日期；方向鈕為按鈕且有名稱', async () => {
  const html = await readPanelFile('index.html');
  const select = html.match(/<select[^>]*id="catalog-sort-field"[\s\S]*?<\/select>/)[0];
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(m => [m[1], m[2]]),
    [['installCount', '安裝次數'], ['name', '名稱'], ['owner', '擁有者'], ['uploadedAt', '上傳日期']]);
  assert.match(html.match(/<button[^>]*id="catalog-sort-direction"[^>]*>/)[0], /type="button"/);
  assert.match(html.match(/<select[^>]*id="catalog-installation"[\s\S]*?<\/select>/)[0], /全部狀態/);
});

test('「顯示 Preview 版本」位於齒輪選單的設定區，不在查詢列', async () => {
  const html = await readPanelFile('index.html');
  const menu = html.slice(html.indexOf('id="settings-menu"'), html.indexOf('<div id="banner"'));
  const settings = menu.slice(menu.indexOf('data-section="settings"'), menu.indexOf('id="btn-logout"'));
  assert.match(settings, /id="catalog-preview"/);
  assert.match(settings, /顯示 Preview 版本/);
  assert.doesNotMatch(mainSection(html), /Preview/);
});

test('只在按 Enter 時查詢；輸入文字與輸入法組字中的 Enter 不查詢', async () => {
  const { panel, lists } = await start();
  const before = lists().length;
  const search = panel.get('catalog-search');
  search.value = 'demo';
  await search.fire('input');
  assert.equal(lists().length, before, '逐字輸入不查詢');
  await search.fire('keydown', { key: 'Enter', isComposing: true });
  assert.equal(lists().length, before, '輸入法組字中的 Enter 不查詢');
  await search.fire('keydown', { key: 'a' });
  assert.equal(lists().length, before);
  await search.fire('keydown', { key: 'Enter' });
  assert.equal(lists().length, before + 1);
  assert.equal(lists().at(-1).input.search, 'demo');
  await panel.get('catalog-form').fire('submit');
  assert.equal(lists().length, before + 1, '表單送出只阻止預設行為，不重複查詢');
});

test('清空搜尋框（含按 ×）時自動重新查詢；本來就沒有查詢字串時不重查', async () => {
  const { panel, lists } = await start();
  const search = panel.get('catalog-search');
  await search.fire('input');
  assert.equal(lists().length, 1, '空白且無已查詢字串：不重查');
  search.value = 'demo';
  await search.fire('keydown', { key: 'Enter' });
  assert.equal(lists().at(-1).input.search, 'demo');
  const count = lists().length;
  search.value = '';
  await search.fire('input');
  assert.equal(lists().length, count + 1);
  assert.equal(lists().at(-1).input.search, '');
  await search.fire('input');
  assert.equal(lists().length, count + 1, '已清空後再觸發不重查');
});

test('類型、安裝狀態、排序欄位、排序方向一變動就立即查詢', async () => {
  const { panel, lists } = await start();
  let n = lists().length;
  panel.get('catalog-type').value = 'mcp';
  await panel.get('catalog-type').fire('change');
  assert.equal(lists().length, ++n);
  assert.equal(lists().at(-1).input.type, 'mcp');
  panel.get('catalog-installation').value = 'installed';
  await panel.get('catalog-installation').fire('change');
  assert.equal(lists().length, ++n);
  assert.equal(lists().at(-1).input.installation, 'installed');
  panel.get('catalog-sort-field').value = 'name';
  await panel.get('catalog-sort-field').fire('change');
  assert.equal(lists().length, ++n);
  assert.deepEqual(lists().at(-1).input.sortField, 'name');
  await panel.get('catalog-sort-direction').fire('click');
  assert.equal(lists().length, ++n);
  assert.equal(lists().at(-1).input.sortDirection, 'desc');
});

test('預設排序為安裝次數多→少，查詢帶上排序欄位與方向', async () => {
  const { panel, lists } = await start();
  assert.equal(panel.get('catalog-sort-field').value, 'installCount');
  assert.equal(textOf(panel.get('catalog-sort-direction')).trim(), '↓ 多→少');
  assert.equal(lists().at(-1).input.sortField, 'installCount');
  assert.equal(lists().at(-1).input.sortDirection, 'desc');
});

test('切換排序欄位時方向重設為該欄位預設，方向鈕文字依欄位，並儲存偏好', async () => {
  const { panel, lists, sets } = await start();
  const dir = () => textOf(panel.get('catalog-sort-direction')).trim();
  const choose = async (field) => { panel.get('catalog-sort-field').value = field; await panel.get('catalog-sort-field').fire('change'); };
  await choose('name');
  assert.equal(dir(), '↑ A→Z');
  assert.deepEqual(sets().at(-1).input, { sortField: 'name', sortDirection: 'asc' });
  assert.deepEqual([lists().at(-1).input.sortField, lists().at(-1).input.sortDirection], ['name', 'asc']);
  await panel.get('catalog-sort-direction').fire('click');
  assert.equal(dir(), '↓ Z→A');
  assert.deepEqual(sets().at(-1).input, { sortField: 'name', sortDirection: 'desc' });
  await choose('owner');
  assert.equal(dir(), '↑ A→Z', '名稱改為擁有者：方向重設為 A→Z，而不是沿用 Z→A');
  assert.deepEqual(sets().at(-1).input, { sortField: 'owner', sortDirection: 'asc' });
  await choose('uploadedAt');
  assert.equal(dir(), '↓ 新→舊');
  assert.deepEqual(sets().at(-1).input, { sortField: 'uploadedAt', sortDirection: 'desc' });
  await panel.get('catalog-sort-direction').fire('click');
  assert.equal(dir(), '↑ 舊→新');
  await choose('installCount');
  assert.equal(dir(), '↓ 多→少');
  await panel.get('catalog-sort-direction').fire('click');
  assert.equal(dir(), '↑ 少→多');
  assert.match(panel.get('catalog-sort-direction').getAttribute('aria-label'), /少→多/);
});

test('啟動時以 rc.preferences.get 還原排序與 Preview，且先於第一次清單查詢', async () => {
  const { panel, calls, lists } = await start({ prefs: { sortField: 'owner', sortDirection: 'desc', showPreview: true, checkIntervalMinutes: 60 } });
  assert.ok(calls.findIndex(c => c.method === 'rc.preferences.get') < calls.findIndex(c => c.method === 'rc.catalog.list'));
  assert.equal(panel.get('catalog-sort-field').value, 'owner');
  assert.equal(textOf(panel.get('catalog-sort-direction')).trim(), '↓ Z→A');
  assert.equal(panel.get('catalog-preview').checked, true);
  assert.equal(lists().length, 1, '還原偏好不造成多餘的查詢');
  assert.deepEqual(lists()[0].input, { search: '', type: '', previewMode: true, sortField: 'owner', sortDirection: 'desc' });
});

test('偏好讀取失敗或內容無效時回到預設（安裝次數多→少、不顯示 Preview），仍可瀏覽清單', async () => {
  const failing = await start({ extra: { 'rc.preferences.get': () => { throw new Error('讀取失敗'); } } });
  assert.equal(failing.panel.get('catalog-sort-field').value, 'installCount');
  assert.equal(failing.lists().at(-1).input.sortDirection, 'desc');
  assert.match(textOf(failing.panel.get('catalog-list')), /資源包 1/);
  const invalid = await start({ prefs: { sortField: 'bogus', sortDirection: 'sideways', showPreview: 'yes' } });
  assert.equal(invalid.panel.get('catalog-sort-field').value, 'installCount');
  assert.equal(textOf(invalid.panel.get('catalog-sort-direction')).trim(), '↓ 多→少');
  assert.equal(invalid.panel.get('catalog-preview').checked, false);
});

test('在齒輪選單切換 Preview：儲存 showPreview 偏好並重新查詢，與原本相同以 previewMode 送出', async () => {
  const { panel, lists, sets } = await start();
  const before = lists().length;
  panel.get('catalog-preview').checked = true;
  await panel.get('catalog-preview').fire('change');
  assert.deepEqual(sets().at(-1).input, { showPreview: true });
  assert.equal(lists().length, before + 1);
  assert.equal(lists().at(-1).input.previewMode, true);
  panel.get('catalog-preview').checked = false;
  await panel.get('catalog-preview').fire('change');
  assert.deepEqual(sets().at(-1).input, { showPreview: false });
  assert.equal(lists().at(-1).input.previewMode, false);
});

test('偏好儲存失敗不影響查詢與畫面', async () => {
  const { panel, lists } = await start({ extra: { 'rc.preferences.set': () => { throw new Error('寫入失敗'); } } });
  panel.get('catalog-sort-field').value = 'name';
  await panel.get('catalog-sort-field').fire('change');
  assert.equal(lists().at(-1).input.sortField, 'name');
  assert.match(textOf(panel.get('catalog-list')), /資源包 1/);
});

test('「共 N 個」顯示在查詢列下方；空結果顯示沒有符合條件', async () => {
  const { panel } = await start({ items: [item(1), item(2), item(3)] });
  assert.equal(textOf(panel.get('catalog-status')).trim(), '共 3 個');
  const empty = await start({ items: [] });
  assert.match(textOf(empty.panel.get('catalog-status')), /沒有符合條件/);
});

test('查詢列 CSS：第二行可換行、各欄位可收縮，窄寬度不溢出', async () => {
  const css = await readPanelFile('panel.css');
  assert.match(css.match(/\.query-filters \{[^}]*\}/)[0], /flex-wrap: wrap/);
  assert.match(css.match(/\.query-filters select \{[^}]*\}/)[0], /min-width: 0/);
  assert.match(css.match(/\.search-field \{[^}]*\}/)[0], /position: relative/);
});

test('清單依序呈現 worker 回傳的資源包（排序在 worker 完成，面板不重排）', async () => {
  const { panel } = await start({ items: [item(3), item(1), item(2)] });
  assert.deepEqual(findAllByData(panel.get('catalog-list'), 'package-key').map(n => n.getAttribute('data-package-key')), ['demo-3', 'demo-1', 'demo-2']);
  assert.equal(findByData(panel.get('catalog-list'), 'action', 'details'), null, '卡片本身可點，不再有 ⓘ 按鈕');
  await settle();
});
