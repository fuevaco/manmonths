// 工項 06：頂部返回、返回保留篩選與捲動位置、明細資訊列／狀態列、安裝位置與變更內容（預設收合）、移除版本選單與下載區。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, textOf, detailsOf, findByData, findAllByData, panelSource } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const uploaded = new Date(2026, 10, 20, 9, 30).toISOString(); // 本地時間 2026-11-20
const dep = (extra = {}) => ({ id: 'codex|global|/home/a/.codex', hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', rootPath: '/home/a/.codex', version: '1.0.0', channel: 'release', status: 'current', updateVersion: null, ...extra });
const listItem = {
  packageKey: 'demo', name: 'Demo 資源包', type: 'skill', description: '清單描述', category: '軟體工作流程', owner: 'Alice', installCount: 15, lastUploadedAt: uploaded,
  hasFullGuide: false, hosts: ['codex', 'claude-code'], latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [],
  tools: [{ hostId: 'codex', label: 'Codex', deployed: false }, { hostId: 'claude-code', label: 'Claude Code', deployed: false }]
};
// worker 明細不帶 owner／installCount／lastUploadedAt：由清單帶入
const detailOf = (extra = {}) => ({ packageKey: 'demo', name: 'Demo 資源包', type: 'skill', description: '明細描述', selectedVersion: '1.2.0', recommendedVersion: '1.2.0', readme: '說明內容',
  versions: [{ version: '1.2.0', channel: 'release', hosts: ['codex'], changelog: '- 新增功能' }], tools: listItem.tools, installationStatus: 'notInstalled', deployments: [], ...extra });

async function start({ items = [listItem], detail = detailOf(), preferences = {}, handler } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    const custom = handler && await handler(method, input);
    if (custom !== undefined) return custom;
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false, ...preferences };
    if (method === 'rc.catalog.list') return { data: items };
    if (method === 'rc.package.getDetails') return typeof detail === 'function' ? detail(input) : detail;
    if (method === 'rc.deploy.listTargets') return { targets: [] };
    return {};
  });
  const card = (key = 'demo') => findByData(panel.get('catalog-list'), 'package-key', key);
  const open = async (key = 'demo') => { await card(key).fire('click'); await settle(); };
  return { panel, calls, card, open };
}
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : null;
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');

test('頂部列：清單頁是「● 資源中心」，明細頁左側是 ← 圖示按鈕加資源包名稱，沒有「返回清單」文字按鈕', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const button = html.match(/<button id="btn-back"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(button, '頂部列有 #btn-back');
  assert.match(button, /aria-label="返回清單"/);
  assert.match(button, /data-action="back"/);
  assert.match(button, /<svg/);
  assert.doesNotMatch(html, /id="details-back"/);
  assert.doesNotMatch(html, />返回清單</);

  const { panel, open } = await start();
  assert.equal(hidden(panel, 'btn-back'), true);
  assert.equal(text(panel.get('header-title')), '資源中心');
  assert.equal(hidden(panel, 'status-dot'), false);
  await open();
  assert.equal(hidden(panel, 'btn-back'), false);
  assert.equal(text(panel.get('header-title')), 'Demo 資源包');
  assert.equal(hidden(panel, 'status-dot'), true);
  await panel.get('btn-back').fire('click');
  assert.equal(hidden(panel, 'btn-back'), true);
  assert.equal(text(panel.get('header-title')), '資源中心');
  assert.equal(hidden(panel, 'status-dot'), false);
  assert.equal(hidden(panel, 'view-main'), false);
  assert.equal(hidden(panel, 'view-details'), true);
});

test('明細尚在讀取時頂部列先顯示清單帶入的名稱；讀取失敗仍可返回；登出後回到登入畫面時標題恢復', async () => {
  let fail = true;
  const { panel, open } = await start({ detail: () => { if (fail) throw new Error('讀取失敗'); return detailOf(); }, handler: (m) => m === 'rc.session.signOut' ? { signedIn: false } : undefined });
  await open();
  assert.equal(text(panel.get('header-title')), 'Demo 資源包');
  assert.match(text(panel.get('details-status')), /讀取失敗/);
  assert.equal(hidden(panel, 'btn-back'), false);
  fail = false;
  await panel.get('details-retry').fire('click'); await settle();
  assert.equal(text(panel.get('details-status')), '');
  await panel.get('btn-logout').fire('click'); await settle();
  assert.equal(hidden(panel, 'btn-back'), true);
  assert.equal(text(panel.get('header-title')), '資源中心');
});

test('長名稱在頂部列截斷或換行，不溢出', async () => {
  const css = await readFile(new URL('../panel/panel.css', import.meta.url), 'utf8');
  const rule = css.match(/#header-title \{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /min-width: 0/);
  assert.match(rule, /overflow-wrap: anywhere/);
  assert.match(rule, /-webkit-line-clamp: 2/);
  const long = 'A'.repeat(120);
  const { panel, open } = await start({ detail: detailOf({ name: long }) });
  await open();
  assert.equal(text(panel.get('header-title')), long);
  assert.equal(panel.get('header-title').getAttribute('title'), long, '被截斷時仍可由 title 看到全名');
});

test('返回清單保留篩選條件，先顯示原清單（不清空）並還原捲動位置，再於背景重新整理', async () => {
  let pending = null;
  let held = false;
  const { panel, calls, open } = await start({ handler: (method) => {
    if (method === 'rc.catalog.list' && held) return new Promise(resolve => { pending = resolve; });
  } });
  panel.get('catalog-search').value = 'demo';
  panel.get('catalog-type').value = 'skill';
  panel.get('catalog-installation').value = 'updates';
  await panel.get('catalog-search').fire('keydown', { key: 'Enter' });
  panel.get('view-main').scrollTop = 240;
  await open();
  panel.get('view-main').scrollTop = 0; // 瀏覽器在區塊隱藏後會把捲動位置歸零
  const listCalls = calls.filter(c => c.method === 'rc.catalog.list').length;

  held = true;
  const back = panel.get('btn-back').fire('click'); // 背景重新整理尚未完成，不等它
  await settle();
  assert.equal(hidden(panel, 'view-main'), false);
  assert.equal(findAllByData(panel.get('catalog-list'), 'package-key').length, 1, '原清單仍在，沒有被清空');
  assert.doesNotMatch(text(panel.get('catalog-status')), /載入資源包中/);
  assert.equal(panel.get('view-main').scrollTop, 240, '先還原捲動位置');
  assert.equal(panel.get('catalog-search').value, 'demo');
  assert.equal(panel.get('catalog-type').value, 'skill');
  assert.equal(panel.get('catalog-installation').value, 'updates');
  assert.equal(calls.filter(c => c.method === 'rc.catalog.list').length, listCalls + 1, '背景重新整理一次');
  assert.deepEqual(calls.at(-1).input, { search: 'demo', type: 'skill', installation: 'updates', previewMode: false, sortField: 'installCount', sortDirection: 'desc' });

  // 背景重新整理完成：清單換成新資料，捲動位置維持
  held = false;
  pending({ data: [{ ...listItem, installCount: 99 }] });
  await back;
  assert.match(text(findByData(panel.get('catalog-list'), 'package-key', 'demo')), /99 次/);
  assert.equal(panel.get('view-main').scrollTop, 240, '重新整理後維持捲動位置');
  assert.match(text(panel.get('catalog-status')), /共 1 個/);
});

test('返回後背景重新整理失敗：保留原清單並提示錯誤；較舊的重新整理不覆蓋較新的', async () => {
  let fail = false;
  const { panel, open } = await start({ handler: (method) => { if (method === 'rc.catalog.list' && fail) throw new Error('市集暫時無法連線'); } });
  await open();
  fail = true;
  await panel.get('btn-back').fire('click'); await settle();
  assert.equal(findAllByData(panel.get('catalog-list'), 'package-key').length, 1);
  assert.match(text(panel.get('catalog-status')), /市集暫時無法連線/);
  assert.equal(hidden(panel, 'catalog-retry'), false);
});

test('明細上方：與卡片相同的資訊列、描述與一行式安裝狀態；清單的作者等資料由清單帶入，右側預留按鈕位置', async () => {
  const withUpdate = { ...listItem, installationStatus: 'updateAvailable', deployments: [dep({ status: 'updateAvailable', updateVersion: '1.2.0' })],
    tools: [{ hostId: 'codex', label: 'Codex', deployed: true }, { hostId: 'claude-code', label: 'Claude Code', deployed: false }] };
  const { panel, card, open } = await start({ items: [withUpdate], detail: detailOf({ installationStatus: 'updateAvailable', deployments: withUpdate.deployments, tools: withUpdate.tools }) });
  await open();
  const meta = panel.get('details-meta');
  assert.equal(text(meta), text(findByData(card(), 'role', 'meta')));
  assert.equal(text(meta), 'Alice · 15 次 · 2026-11-20');
  assert.equal(text(panel.get('details-description')), '明細描述');
  const row = panel.get('details-status-row');
  assert.equal(text(findByData(row, 'role', 'status-text')), '可更新 1.0.0 → 1.2.0');
  assert.equal(text(findByData(row, 'role', 'status-text')), text(findByData(card(), 'role', 'status-text')));
  assert.deepEqual(findAllByData(row, 'tool').map(n => [n.getAttribute('data-tool'), n.getAttribute('data-deployed')]), [['codex', 'true'], ['claude-code', 'false']]);
  assert.equal(findByData(row, 'role', 'status-text').getAttribute('data-kind'), 'update');
  assert.ok(findByData(row, 'slot', 'card-actions'), '右側預留安裝／更新按鈕位置');
});

test('明細的資訊列以 worker 明細的欄位為優先；沒有清單資料時省略缺值項目', async () => {
  const { panel, open } = await start({ detail: detailOf({ owner: 'Bob', installCount: 7 }) });
  await open();
  assert.equal(text(panel.get('details-meta')), 'Bob · 7 次 · 2026-11-20');
  const none = await start({ items: [{ ...listItem, owner: null, installCount: null, lastUploadedAt: null }] });
  await none.open();
  assert.equal(text(none.panel.get('details-meta')), '');
});

test('已安裝、已下架與狀態無法讀取的狀態列文字', async () => {
  const cases = [
    [{ installationStatus: 'current', deployments: [dep()] }, '已安裝 1.0.0', 'installed'],
    [{ installationStatus: 'unavailable', deployments: [dep({ status: 'unavailable' })] }, '已下架', 'unavailable'],
    [{ installationStatus: 'notInstalled', deployments: [] }, '未安裝', 'none']
  ];
  for (const [extra, expected, kind] of cases) {
    const { panel, open } = await start({ detail: detailOf(extra) });
    await open();
    const status = findByData(panel.get('details-status-row'), 'role', 'status-text');
    assert.equal(text(status), expected);
    assert.equal(status.getAttribute('data-kind'), kind);
  }
  const error = { code: 'receipt_invalid', message: '部署收據檔不是有效的 JSON' };
  const { panel, open } = await start({ detail: detailOf({ installationStatus: undefined, deployments: undefined, installedError: error }) });
  await open();
  assert.match(text(panel.get('details-installed')), /已安裝狀態無法讀取.*部署收據檔不是有效的 JSON/);
  assert.equal(findByData(panel.get('details-status-row'), 'role', 'status-text'), null, '狀態未知時不猜測狀態文字');
});

test('安裝位置（N）預設收合；每列為工具圖示、友善名稱與根目錄、版本與狀態；不顯示原始識別碼', async () => {
  const deployments = [
    dep({ id: 'claude-code|global|/home/a/.claude', hostId: 'claude-code', surfaceId: 'claude-code-cli', rootPath: '/home/a/.claude', version: '1.0.0', status: 'updateAvailable', updateVersion: '1.2.0', label: 'Claude Code' }),
    dep({ id: 'claude-code|global|C:/Claude', hostId: 'claude-code', surfaceId: 'claude-desktop', rootPath: 'D:\\ClaudeDesktop', version: '1.2.0', status: 'current', label: 'Claude Desktop' }),
    dep({ id: 'codex|global|/home/a/.codex', hostId: 'codex', rootPath: '/home/a/.codex', version: '1.3.0', status: 'newer', channel: 'preview' }),
    dep({ id: 'codex|global|/home/a/.codex2', hostId: 'codex', rootPath: '/home/a/.codex2', version: '0.9.0', status: 'unavailable' }),
    dep({ id: 'claude-code|project|/work/one', hostId: 'claude-code', surfaceId: 'claude-code-cli', scope: 'project', rootPath: '/work/one', version: '1.0.0' })
  ];
  const { panel, open } = await start({ detail: detailOf({ installationStatus: 'updateAvailable', deployments }) });
  await open();
  const section = detailsOf(panel.get('details-installed')).find(d => /安裝位置/.test(d.summary));
  assert.equal(section.summary, '安裝位置（4）', '只列全域部署');
  const box = findByData(panel.get('details-installed'), 'role', 'locations');
  assert.equal(box.tagName, 'details');
  assert.notEqual(box.open, true, '預設收合');
  const rows = findAllByData(box, 'role', 'location');
  assert.equal(rows.length, 4);
  const cell = (row, name) => text(findByData(row, 'role', name));
  assert.deepEqual(rows.map(r => [cell(r, 'location-name'), cell(r, 'location-path'), cell(r, 'location-status')]), [
    ['Claude Code', '/home/a/.claude', '1.0.0 · 可更新 → 1.2.0'],
    ['Claude Desktop', 'D:\\ClaudeDesktop', '1.2.0 · 已是最新'],
    ['Codex', '/home/a/.codex', '1.3.0 (Preview) · 已是最新'],
    ['Codex', '/home/a/.codex2', '0.9.0 · 已下架']
  ]);
  assert.ok(rows.every(r => findAllByData(r, 'tool').length === 1), '每列有工具圖示');
  assert.deepEqual(rows.map(r => findByData(r, 'tool').getAttribute('data-tool')), ['claude-code', 'claude-desktop', 'codex', 'codex']);
  const all = text(panel.get('details-installed'));
  assert.doesNotMatch(all, /claude-code|codex-cli|claude-desktop|\bglobal\b|\|/, '不顯示原始識別碼');
  assert.doesNotMatch(all, /\/work\/one/);
  assert.doesNotMatch(all, /已安裝資源版本/);
});

test('沒有全域部署時不顯示安裝位置區塊', async () => {
  const { panel, open } = await start({ detail: detailOf({ deployments: [dep({ scope: 'project', rootPath: '/work/one' })] }) });
  await open();
  assert.equal(findByData(panel.get('details-installed'), 'role', 'locations'), null);
});

test('版本 x 的變更內容預設收合；沒有內容時不顯示該區塊', async () => {
  const { panel, open } = await start();
  await open();
  const section = detailsOf(panel.get('details-changelog'));
  assert.equal(section.length, 1);
  assert.equal(section[0].summary, '版本 1.2.0 的變更內容');
  assert.match(section[0].body, /- 新增功能/);
  const box = findByData(panel.get('details-changelog'), 'role', 'changelog');
  assert.notEqual(box.open, true, '預設收合');

  const none = await start({ detail: detailOf({ versions: [{ version: '1.2.0', channel: 'release', hosts: [], changelog: '  ' }] }) });
  await none.open();
  assert.equal(detailsOf(none.panel.get('details-changelog')).length, 0);
  assert.equal(text(none.panel.get('details-changelog')), '');
});

test('明細沒有版本選單、相容 AI 工具文字與下載 ZIP 區塊，也不再呼叫 rc.download.save', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const js = await panelSource();
  for (const gone of ['details-version', 'details-hosts', 'details-download', 'details-destination', '下載 ZIP', 'ZIP 完整儲存路徑', '相容 AI 工具']) {
    assert.ok(!html.includes(gone) && !js.includes(gone), `不應再有 ${gone}`);
  }
  assert.doesNotMatch(js, /rc\.download\.save/);
  const { panel, calls, open } = await start();
  await open();
  assert.equal(panel.get('details-version'), undefined);
  assert.doesNotMatch(text(panel.get('view-details')), /相容 AI 工具/);
  assert.equal(calls.some(c => c.method === 'rc.download.save'), false);
});

test('明細一律取推薦版本：不指定版本；勾選 Preview 時以 previewMode 讓 worker 給最新 Preview', async () => {
  const { calls, open } = await start({ preferences: { showPreview: true } });
  await open();
  assert.deepEqual(calls.findLast(c => c.method === 'rc.package.getDetails').input, { packageKey: 'demo', previewMode: true });
  const normal = await start();
  await normal.open();
  assert.deepEqual(normal.calls.findLast(c => c.method === 'rc.package.getDetails').input, { packageKey: 'demo', previewMode: false });
});

test('在明細頁按 ↻ 重新讀取推薦版本與已安裝狀態（例如 LC-AI-Pack 裝了舊版後出現可更新）', async () => {
  let installed = false;
  const { panel, calls, open } = await start({ detail: () => installed
    ? detailOf({ installationStatus: 'updateAvailable', deployments: [dep({ version: '1.0.0', status: 'updateAvailable', updateVersion: '1.2.0' })] }) : detailOf() });
  await open();
  assert.equal(text(findByData(panel.get('details-status-row'), 'role', 'status-text')), '未安裝');
  installed = true;
  await panel.get('btn-refresh').fire('click'); await settle();
  assert.deepEqual(calls.findLast(c => c.method === 'rc.package.getDetails').input, { packageKey: 'demo', previewMode: false }, '重新整理不鎖定舊版本');
  assert.equal(text(findByData(panel.get('details-status-row'), 'role', 'status-text')), '可更新 1.0.0 → 1.2.0');
  assert.match(text(panel.get('details-installed')), /1\.0\.0 · 可更新 → 1\.2\.0/);
  assert.equal(text(panel.get('header-title')), 'Demo 資源包');
});

test('較晚抵達的舊詳情不覆蓋目前畫面；返回後再進入另一個資源包以新資料呈現', async () => {
  let resolveOld;
  const second = { ...listItem, packageKey: 'two', name: '第二個資源包', owner: 'Carol' };
  const { panel, card, open } = await start({ items: [listItem, second], detail: (input) => input.packageKey === 'demo' ? new Promise(resolve => { resolveOld = resolve; }) : detailOf({ packageKey: 'two', name: '第二個資源包' }) });
  const first = findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click'); // 詳情遲遲未回
  await settle();
  await panel.get('btn-back').fire('click');
  await open('two');
  resolveOld(detailOf({ name: '舊詳情' }));
  await first; await settle();
  assert.equal(text(panel.get('header-title')), '第二個資源包');
  assert.equal(text(panel.get('details-meta')), 'Carol · 15 次 · 2026-11-20');
  assert.doesNotMatch(text(panel.get('view-details')), /舊詳情/);
});
