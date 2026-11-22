// 清單卡片整張可點進入明細：卡片內的互動元素（安裝／更新／補裝、取消、🌐、失敗徽章與失敗清單）不會進入明細，
// 鍵盤 Enter／空白鍵可進入（焦點在內部按鈕時不觸發），有文字選取時不進入；🌐 為強調藍色（CSS）。
// 以 Element.dispatch 模擬真實點擊（事件會冒泡到卡片），因此卡片層的委派判斷才是唯一把關。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const target = { targetId: 'claude-code|claude-code-cli|global|/home/a/.claude', hostId: 'claude-code', label: 'Claude Code', rootPath: '/home/a/.claude' };
const dep = (extra = {}) => ({ id: 'codex|codex-cli|global|/home/a/.codex', hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', rootPath: '/home/a/.codex', version: '1.0.0', channel: 'release', status: 'current', updateVersion: null, label: 'Codex', backupPaths: [], ...extra });
const tools = (codex = false) => [{ hostId: 'codex', label: 'Codex', deployed: codex }, { hostId: 'claude-code', label: 'Claude Code', deployed: false }];
const pkg = (key, extra = {}) => ({ packageKey: key, name: `資源 ${key}`, type: 'skill', description: `${key} 的描述`, hasFullGuide: false, latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled',
  deployments: [], tools: tools(), pendingTargets: { count: 0, targets: [] }, lastFailure: null, ...extra });
const failure = { targets: [{ ...target, reason: '寫入失敗，已完整還原', backupPaths: ['/home/a/.claude/skills/hello.bak-1'], detail: [{ summary: '寫入失敗', explanation: 'EACCES' }] }] };
const items = () => [
  pkg('demo', { hasFullGuide: true }),
  pkg('upd', { installationStatus: 'updateAvailable', deployments: [dep({ status: 'updateAvailable', updateVersion: '1.2.0' })], tools: tools(true) }),
  pkg('pend', { installationStatus: 'current', deployments: [dep({ version: '1.2.0' })], tools: tools(true), pendingTargets: { count: 1, targets: [target] } }),
  pkg('bad', { installationStatus: 'current', deployments: [dep({ version: '1.2.0' })], tools: tools(true), lastFailure: failure })
];

async function start({ run = async () => ({ ok: true, succeeded: [target], failed: [], backups: [] }), prepare = async () => ({ url: 'http://127.0.0.1:51234/index.html' }) } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false };
    if (method === 'rc.catalog.list') return { data: items() };
    if (method === 'rc.package.getDetails') return { ...items().find(p => p.packageKey === input.packageKey), selectedVersion: '1.2.0', readme: '', versions: [{ version: '1.2.0', channel: 'release', hosts: ['codex'] }], parameters: [] };
    if (method === 'rc.install.run') return run(input);
    if (method === 'rc.guide.prepare') return prepare(input);
    return {};
  });
  const card = (key = 'demo') => findByData(panel.get('catalog-list'), 'package-key', key);
  const action = (root, name) => findByData(root, 'action', name);
  const inDetails = () => !panel.get('view-details').classList.contains('hidden');
  const detailCalls = () => calls.filter(c => c.method === 'rc.package.getDetails');
  return { panel, calls, card, action, inDetails, detailCalls };
}

test('卡片沒有 data-action="details"；有 tabindex、role 與含資源包名稱的 aria-label', async () => {
  const { panel, card } = await start();
  assert.equal(findAllByData(panel.get('catalog-list'), 'action', 'details').length, 0);
  for (const key of ['demo', 'upd', 'pend', 'bad']) {
    assert.equal(card(key).getAttribute('tabindex'), '0');
    assert.equal(card(key).getAttribute('role'), 'link');
    assert.match(card(key).getAttribute('aria-label'), new RegExp(`資源 ${key}`));
  }
});

test('點卡片空白區（卡片本身、標題、描述、狀態文字）進入明細', async () => {
  for (const pick of [c => c, c => findByData(c, 'role', 'title'), c => findByData(c, 'role', 'description'), c => findByData(c, 'role', 'status-text'), c => findByData(c, 'role', 'type')]) {
    const { card, inDetails, detailCalls } = await start();
    await pick(card('demo')).dispatch('click'); await settle();
    assert.equal(inDetails(), true);
    assert.deepEqual(detailCalls().map(c => c.input.packageKey), ['demo']);
  }
});

test('點安裝：執行安裝，不進入明細', async () => {
  const { calls, card, action, inDetails, detailCalls } = await start();
  await action(card('demo'), 'install').dispatch('click'); await settle();
  assert.deepEqual(calls.filter(c => c.method === 'rc.install.run').map(c => c.input), [{ packageKey: 'demo', action: 'install' }]);
  assert.equal(inDetails(), false);
  assert.equal(detailCalls().length, 0);
});

test('點更新、補裝：各自執行，不進入明細', async () => {
  const { calls, card, action, inDetails, detailCalls } = await start();
  await action(card('upd'), 'update').dispatch('click'); await settle();
  await action(card('pend'), 'fill-pending').dispatch('click'); await settle();
  assert.deepEqual(calls.filter(c => c.method === 'rc.install.run').map(c => `${c.input.packageKey}:${c.input.action}`), ['upd:update', 'pend:fillPending']);
  assert.equal(inDetails(), false);
  assert.equal(detailCalls().length, 0);
});

test('點取消：送出取消，不進入明細', async () => {
  let release;
  const { calls, card, action, inDetails, detailCalls } = await start({ run: () => new Promise(resolve => { release = resolve; }) });
  const running = action(card('demo'), 'install').dispatch('click'); await settle();
  const cancel = action(card('demo'), 'cancel-install');
  assert.ok(cancel);
  await cancel.dispatch('click'); await settle();
  assert.equal(calls.filter(c => c.method === 'rc.install.cancel').length, 1);
  assert.equal(inDetails(), false);
  assert.equal(detailCalls().length, 0);
  release({ ok: true, succeeded: [], failed: [], backups: [] }); await running; await settle();
});

test('點 🌐：開啟完整說明頁，不進入明細', async () => {
  const { panel, calls, card, action, inDetails, detailCalls } = await start();
  await action(card('demo'), 'full-guide').dispatch('click'); await settle();
  assert.equal(calls.filter(c => c.method === 'rc.guide.prepare').length, 1);
  assert.equal(panel.externalUrls.length, 1);
  assert.equal(inDetails(), false);
  assert.equal(detailCalls().length, 0);
});

test('點失敗徽章展開／收合失敗清單，不進入明細；失敗清單內任何位置（原因、路徑、詳細紀錄、備份位置、重試）都不進入明細', async () => {
  const { calls, card, action, inDetails, detailCalls } = await start();
  await findByData(card('bad'), 'role', 'failure').dispatch('click'); await settle();
  const list = findByData(card('bad'), 'role', 'failure-list');
  assert.ok(list, '點徽章後展開失敗清單');
  assert.equal(inDetails(), false);

  const row = findByData(list, 'role', 'failure-target');
  const fold = findByData(row, 'role', 'failure-detail');
  const backups = findByData(row, 'role', 'backups');
  const inner = [list, row, findByData(row, 'role', 'failure-detail'), fold.children.find(n => n.tagName === 'summary'), fold.children.at(-1),
    backups, backups.children.find(n => n.tagName === 'summary'), backups.children.at(-1) ].filter(Boolean);
  inner.push(...findAllByData(row, 'role').filter(n => n.className.includes('failure-reason')));
  for (const node of inner) await node.dispatch('click');
  await settle();
  assert.equal(inDetails(), false);

  await action(list, 'retry').dispatch('click'); await settle();
  assert.deepEqual(calls.filter(c => c.method === 'rc.install.run').map(c => c.input), [{ packageKey: 'bad', action: 'retry', targetIds: [target.targetId] }]);
  assert.equal(inDetails(), false);
  assert.equal(detailCalls().length, 0);

  await findByData(card('bad'), 'role', 'failure').dispatch('click'); await settle();
  assert.equal(findByData(card('bad'), 'role', 'failure-list') !== null, true, '再點一次徽章會切換（此處因重試已完成重新載入，狀態只要不進入明細即可）');
  assert.equal(inDetails(), false);
});

test('鍵盤：焦點在卡片上按 Enter 或空白鍵進入明細；其他按鍵不進入', async () => {
  for (const key of ['Enter', ' ']) {
    const { card, inDetails, detailCalls } = await start();
    let prevented = 0;
    await card('demo').fire('keydown', { key: 'Tab', preventDefault: () => { prevented += 1; } });
    await card('demo').fire('keydown', { key: 'a' });
    assert.equal(inDetails(), false);
    await card('demo').fire('keydown', { key, preventDefault: () => { prevented += 1; } }); await settle();
    assert.equal(inDetails(), true);
    assert.equal(prevented, 1, '空白鍵不捲動頁面');
    assert.deepEqual(detailCalls().map(c => c.input.packageKey), ['demo']);
  }
});

test('鍵盤：焦點在內部按鈕（安裝、🌐、徽章）時按 Enter／空白鍵不觸發進入明細', async () => {
  const { card, action, inDetails, detailCalls } = await start();
  for (const node of [action(card('demo'), 'install'), action(card('demo'), 'full-guide'), findByData(card('bad'), 'role', 'failure')]) {
    for (const key of ['Enter', ' ']) await node.dispatch('keydown', { key });
  }
  await settle();
  assert.equal(inDetails(), false);
  assert.equal(detailCalls().length, 0);
});

test('有文字選取時（拖曳選取後放開）點卡片不進入明細；選取清除後才進入', async () => {
  const { panel, card, inDetails, detailCalls } = await start();
  let selected = '被選取的描述文字';
  panel.window.getSelection = () => ({ toString: () => selected });
  await findByData(card('demo'), 'role', 'description').dispatch('click'); await settle();
  assert.equal(inDetails(), false);
  assert.equal(detailCalls().length, 0);
  selected = '';
  await findByData(card('demo'), 'role', 'description').dispatch('click'); await settle();
  assert.equal(inDetails(), true);
});

test('就地重繪（例如展開失敗清單）後的新卡片仍可點進入明細', async () => {
  const { card, inDetails } = await start();
  await findByData(card('bad'), 'role', 'failure').dispatch('click'); await settle();
  await card('bad').dispatch('click'); await settle();
  assert.equal(inDetails(), true);
});

test('CSS：卡片 cursor: pointer、hover／focus 樣式；🌐 使用強調藍色（卡片與明細共用），失敗清單不顯示手型', async () => {
  const css = await readFile(new URL('../panel/panel.css', import.meta.url), 'utf8');
  const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.[\]()"=:*]/g, '\\$&')} \\{[^}]*\\}`))?.[0] ?? '';
  assert.match(rule('.catalog-card'), /cursor: pointer/);
  assert.match(rule('.catalog-card:hover'), /background: var\(--hover-bg\)/);
  assert.match(rule('.catalog-card:focus-visible'), /outline: [^;]*var\(--accent\)/);
  assert.match(rule('.catalog-card .failure-list'), /cursor: auto/);
  assert.match(rule('.btn-card-icon[data-action="full-guide"]'), /color: var\(--accent\)/);
  assert.match(rule('.btn-card-icon[data-action="full-guide"]:hover, .catalog-card .btn-card-icon[data-action="full-guide"]:hover'), /color: var\(--accent\)/, 'hover 時不變回前景色');
  assert.match(rule('.btn-card-icon'), /color: var\(--muted\)/, '⤢ 放大閱讀維持灰色，不跟著變藍');
  assert.match(rule('.btn-card-icon.is-ready'), /border-color: var\(--accent\)/, '已準備好狀態仍有框線與圓點');
  assert.match(rule('.btn-card-icon.is-ready::after'), /content/);
});
