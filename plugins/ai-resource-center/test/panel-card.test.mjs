// 工項 05：清單卡片資訊（作者、安裝次數、日期、描述、類型與分類）、ⓘ 進明細、一行式安裝狀態與卡片外觀。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, textOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const uploaded = new Date(2026, 10, 20, 9, 30).toISOString(); // 本地時間 2026-11-20，與測試機時區無關
const deployment = (extra = {}) => ({ id: 'codex|global|/demo/.codex', hostId: 'codex', scope: 'global', rootPath: '/demo/.codex', version: '1.0.0', channel: 'release', status: 'current', updateVersion: null, ...extra });
const base = {
  packageKey: 'demo', name: 'Demo 資源包', type: 'skill', description: '示範用的描述', category: '軟體工作流程', owner: 'Alice', installCount: 15, lastUploadedAt: uploaded,
  hasFullGuide: false, hosts: ['codex', 'claude-code'], latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [],
  tools: [{ hostId: 'codex', label: 'Codex', deployed: false }, { hostId: 'claude-code', label: 'Claude Code', deployed: false }]
};

async function start(...items) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false };
    if (method === 'rc.catalog.list') return { data: items };
    if (method === 'rc.package.getDetails') return { ...items[0], selectedVersion: '1.2.0', versions: [{ version: '1.2.0', hosts: [] }], readme: '' };
    return {};
  });
  return { panel, calls, card: (key = items[0].packageKey) => findByData(panel.get('catalog-list'), 'package-key', key) };
}
const role = (card, name) => findByData(card, 'role', name);
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : null;
const classes = (node) => String(node.className).split(/\s+/);

test('卡片顯示名稱、作者、安裝次數、本地日期；圖示為 inline SVG', async () => {
  const { card } = await start(base);
  const c = card();
  assert.equal(text(role(c, 'title')), 'Demo 資源包');
  const meta = role(c, 'meta');
  assert.equal(text(findByData(meta, 'meta', 'owner')), 'Alice');
  assert.equal(text(findByData(meta, 'meta', 'installs')), '15 次');
  assert.equal(text(findByData(meta, 'meta', 'date')), '2026-11-20');
  assert.equal(text(meta), 'Alice · 15 次 · 2026-11-20');
  assert.equal(findAllByData(meta, 'meta').filter(n => n.children.some(k => k.tagName === 'svg')).length, 2, '作者與安裝次數各有 SVG 圖示');
});

test('資訊列缺值的項目整項省略；全部缺值時不留空列', async () => {
  const { card } = await start({ ...base, owner: null, installCount: null }, { ...base, packageKey: 'only-owner', owner: 'bob', installCount: null, lastUploadedAt: null }, { ...base, packageKey: 'none', owner: '  ', installCount: null, lastUploadedAt: null });
  assert.equal(text(role(card('demo'), 'meta')), '2026-11-20');
  assert.equal(findByData(card('demo'), 'meta', 'owner'), null);
  assert.equal(findByData(card('demo'), 'meta', 'installs'), null);
  assert.equal(text(role(card('only-owner'), 'meta')), 'bob');
  assert.equal(role(card('none'), 'meta'), null);
});

test('安裝次數為 0 仍顯示「0 次」', async () => {
  const { card } = await start({ ...base, installCount: 0 });
  assert.equal(text(findByData(role(card(), 'meta'), 'meta', 'installs')), '0 次');
});

test('描述以兩行截斷顯示（CSS line-clamp），沒有描述時省略', async () => {
  const { card } = await start(base, { ...base, packageKey: 'nodesc', description: '' });
  assert.equal(text(role(card('demo'), 'description')), '示範用的描述');
  assert.equal(role(card('nodesc'), 'description'), null);
  const css = await readFile(new URL('../panel/panel.css', import.meta.url), 'utf8');
  assert.match(css.match(/\.card-desc \{[^}]*\}/)[0], /-webkit-line-clamp: 2/);
});

test('類型與分類以「Skills · 軟體工作流程」呈現，沒有分類只顯示類型，不顯示標籤', async () => {
  const { card } = await start(base, { ...base, packageKey: 'nocat', type: 'bundle', category: null, tags: ['alpha', 'beta'] });
  assert.equal(text(role(card('demo'), 'type')), 'Skills · 軟體工作流程');
  assert.equal(text(role(card('nocat'), 'type')), '組合包');
  assert.doesNotMatch(text(card('nocat')), /alpha|#/);
});

test('卡片沒有 ⓘ（data-action="details"）或「查看詳情」按鈕；整張卡片可點，進入明細（細節見 panel-card-click.test.mjs）', async () => {
  const { panel, card, calls } = await start(base);
  assert.equal(findAllByData(card(), 'action', 'details').length, 0);
  assert.doesNotMatch(textOf(card()), /查看詳情/);
  await card().fire('click');
  assert.equal(panel.get('view-details').classList.contains('hidden'), false);
  assert.ok(calls.some(c => c.method === 'rc.package.getDetails' && c.input.packageKey === 'demo'));
});

test('🌐 完整說明按鈕：只有 hasFullGuide 為 true 的卡片才有，且顯示（點選行為見 panel-full-guide.test.mjs）', async () => {
  const { card } = await start({ ...base, hasFullGuide: true }, { ...base, packageKey: 'no-guide', hasFullGuide: false });
  const guide = findByData(card('demo'), 'action', 'full-guide');
  assert.ok(guide);
  assert.equal(guide.getAttribute('aria-label'), '開啟完整說明頁');
  assert.ok(!classes(guide).includes('hidden'));
  assert.equal(findByData(card('no-guide'), 'action', 'full-guide'), null);
});

test('五種安裝狀態的文字', async () => {
  const items = [
    { ...base, packageKey: 'not', installationStatus: 'notInstalled' },
    { ...base, packageKey: 'cur', installationStatus: 'current', latestVisibleVersion: '1.2.0', deployments: [deployment({ version: '1.2.0' })] },
    { ...base, packageKey: 'new', installationStatus: 'newer', latestVisibleVersion: '1.0.0', deployments: [deployment({ version: '2.0.0' })] },
    { ...base, packageKey: 'upd', installationStatus: 'updateAvailable', latestVisibleVersion: '1.2.0', deployments: [deployment({ version: '1.0.0', status: 'updateAvailable', updateVersion: '1.2.0' })] },
    { ...base, packageKey: 'gone', installationStatus: 'unavailable', latestVisibleVersion: null, deployments: [deployment({ version: '1.0.0', status: 'unavailable' })] }
  ];
  const { card } = await start(...items);
  const status = key => text(role(card(key), 'status-text'));
  assert.equal(status('not'), '未安裝');
  assert.equal(status('cur'), '已安裝 1.2.0');
  assert.equal(status('new'), '已安裝 2.0.0');
  assert.equal(status('upd'), '可更新 1.0.0 → 1.2.0');
  assert.equal(status('gone'), '已下架');
});

test('多個根目錄版本不一致時，只要有一個較舊就顯示可更新（以最舊版本為 x）', async () => {
  const { card } = await start({ ...base, installationStatus: 'updateAvailable', latestVisibleVersion: '1.2.0', deployments: [
    deployment({ id: 'a', version: '1.1.0', status: 'updateAvailable', updateVersion: '1.2.0' }),
    deployment({ id: 'b', version: '1.2.0', status: 'current' }),
    deployment({ id: 'c', version: '0.9.0', status: 'updateAvailable', updateVersion: '1.2.0' })] });
  assert.equal(text(role(card(), 'status-text')), '可更新 0.9.0 → 1.2.0');
});

test('工具圖示只列 tools 內的工具；已部署與未部署以 data-deployed、class 與名稱區分', async () => {
  const tools = [{ hostId: 'codex', label: 'Codex', deployed: true }, { hostId: 'claude-code', label: 'Claude Code', deployed: false }, { hostId: 'claude-desktop', label: 'Claude Desktop', deployed: true }];
  const { card } = await start({ ...base, tools, installationStatus: 'current', deployments: [deployment({ version: '1.2.0' })] }, { ...base, packageKey: 'only-codex', tools: [base.tools[0]] });
  const icons = findAllByData(card('demo'), 'tool');
  assert.deepEqual(icons.map(n => n.getAttribute('data-tool')), ['codex', 'claude-code', 'claude-desktop']);
  assert.deepEqual(icons.map(n => n.getAttribute('data-deployed')), ['true', 'false', 'true']);
  assert.deepEqual(icons.map(n => classes(n).includes('deployed')), [true, false, true]);
  assert.deepEqual(icons.map(n => classes(n).includes('not-deployed')), [false, true, false]);
  assert.deepEqual(icons.map(n => n.getAttribute('aria-label')), ['Codex：已安裝', 'Claude Code：未安裝', 'Claude Desktop：已安裝']);
  assert.deepEqual(icons.map(n => n.getAttribute('title')), ['Codex：已安裝', 'Claude Code：未安裝', 'Claude Desktop：已安裝']);
  for (const icon of icons) {
    const svg = icon.children.find(k => k.tagName === 'svg');
    assert.ok(svg, '品牌圖示為 inline SVG');
    assert.equal(svg.getAttribute('fill'), 'currentColor');
    assert.match(svg.children[0].getAttribute('d'), /^[Mm]/);
  }
  const [codex, claude, desktop] = icons.map(n => n.children.find(k => k.tagName === 'svg').children[0].getAttribute('d'));
  assert.notEqual(codex, claude, 'Codex 與 Claude 圖示不同');
  assert.equal(claude, desktop, 'Claude Code 與 Desktop 共用 Claude 圖示');
  assert.match(text(icons[2]), /Desktop/, 'Desktop 以小字區分');
  assert.equal(findAllByData(card('only-codex'), 'tool').length, 1);
});

test('沒有 tools 時只顯示狀態文字，不出錯', async () => {
  const { card } = await start({ ...base, tools: undefined, hosts: null });
  assert.deepEqual(findAllByData(card(), 'tool'), []);
  assert.equal(text(role(card(), 'status-text')), '未安裝');
});

test('卡片外觀 class：已安裝為綠邊、可更新為橘邊並有徽章、未安裝維持原樣', async () => {
  const items = [
    { ...base, packageKey: 'not' },
    { ...base, packageKey: 'cur', installationStatus: 'current', deployments: [deployment({ version: '1.2.0' })] },
    { ...base, packageKey: 'new', installationStatus: 'newer', deployments: [deployment({ version: '2.0.0' })] },
    { ...base, packageKey: 'upd', installationStatus: 'updateAvailable', deployments: [deployment({ status: 'updateAvailable', updateVersion: '1.2.0' })] },
    { ...base, packageKey: 'gone', installationStatus: 'unavailable', latestVisibleVersion: null, deployments: [deployment({ status: 'unavailable' })] },
    { ...base, packageKey: 'gone-nodeploy', installationStatus: 'unavailable', latestVisibleVersion: null, deployments: [] }
  ];
  const { card } = await start(...items);
  const has = (key, cls) => classes(card(key)).includes(cls);
  assert.deepEqual(['not', 'cur', 'new', 'upd', 'gone', 'gone-nodeploy'].map(k => has(k, 'is-installed')), [false, true, true, false, true, false]);
  assert.deepEqual(['not', 'cur', 'new', 'upd', 'gone'].map(k => has(k, 'has-update')), [false, false, false, true, false]);
  assert.equal(has('upd', 'is-installed'), false, '可更新用橘邊，不同時套用綠邊');
  assert.equal(text(role(card('upd'), 'update-badge')), '可更新');
  assert.equal(role(card('cur'), 'update-badge'), null);
  assert.equal(role(card('not'), 'update-badge'), null);
  assert.equal(card('cur').getAttribute('data-install-status'), 'current');
  const css = await readFile(new URL('../panel/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.catalog-card\.is-installed \{[^}]*border-left-color: var\(--ok\)/);
  assert.match(css, /\.catalog-card\.has-update \{[^}]*border-left-color: var\(--update\)/);
});

test('卡片不顯示部署路徑、原始識別碼或舊版「類型 · 版本」文字', async () => {
  const { card } = await start({ ...base, installationStatus: 'current', latestVisibleVersion: '1.2.0',
    deployments: [deployment({ version: '1.2.0', rootPath: 'D:\\demo\\.codex' }), deployment({ id: 'b', version: '1.2.0', rootPath: '/demo/.claude' })] });
  const all = text(card());
  assert.doesNotMatch(all, /\.codex|\.claude|D:\\|\/demo|global|claude-code|codex global/);
  assert.doesNotMatch(all, /Skills · 1\.2\.0/);
  assert.deepEqual(findAllByData(card(), 'action').map(n => n.getAttribute('data-action')), ['uninstall'], '已是最新且沒有 🌐 時卡片只有解除安裝按鈕，整張卡片其餘處可點進入明細');
});

test('狀態列預留：狀態文字容器與右側按鈕空間，後續狀態可往同一列附加', async () => {
  const { card } = await start(base);
  const row = role(card(), 'status-row');
  assert.ok(row);
  assert.ok(role(row, 'status-text'));
  assert.ok(findByData(row, 'slot', 'card-actions'), '右側預留按鈕空間');
  const css = await readFile(new URL('../panel/panel.css', import.meta.url), 'utf8');
  assert.match(css.match(/\.card-status \{[^}]*\}/)[0], /flex-wrap: wrap/);
});

test('市集內容一律當純文字，不被解讀為 HTML', async () => {
  const { card } = await start({ ...base, name: '<img src=x onerror=alert(1)>', owner: '<b>x</b>', description: '<script>y</script>', category: '<i>c</i>' });
  assert.match(text(role(card(), 'title')), /<img src=x onerror=alert\(1\)>/);
  assert.match(text(card()), /<script>y<\/script>/);
});

test('舊資料缺 installationStatus 時視為未安裝', async () => {
  const { card } = await start({ packageKey: 'legacy', name: 'Legacy', type: 'skill', latestVisibleVersion: '1.0.0' });
  assert.equal(text(role(card('legacy'), 'status-text')), '未安裝');
  assert.equal(classes(card('legacy')).includes('is-installed'), false);
});
