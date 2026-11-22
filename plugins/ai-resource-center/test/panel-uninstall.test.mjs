// 解除安裝（ADR-0003 補充）面板端：卡片與明細的紅色按鈕、一律確認、執行中、結果提示、備份、失敗清單與重試。
// worker 以替身回應，驗證面板送出的 rc.install.run（action: 'uninstall'）請求與畫面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, detailsOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const dep = (extra = {}) => ({ id: 'codex|codex-cli|global|/home/a/.codex', hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', rootPath: '/home/a/.codex',
  version: '1.0.0', channel: 'release', status: 'current', updateVersion: null, label: 'Codex', backupPaths: [], ...extra });
const claudeDep = (extra = {}) => dep({ id: 'claude-code|claude-code-cli|global|/home/a/.claude', hostId: 'claude-code', surfaceId: 'claude-code-cli', rootPath: '/home/a/.claude', label: 'Claude Code', ...extra });
const toolsOf = (codex = false, claude = false) => [{ hostId: 'codex', label: 'Codex', deployed: codex }, { hostId: 'claude-code', label: 'Claude Code', deployed: claude }];
const claudeTarget = { targetId: 'claude-code|claude-code-cli|global|/home/a/.claude', hostId: 'claude-code', label: 'Claude Code', rootPath: '/home/a/.claude' };
const codexTarget = { targetId: 'codex|codex-cli|global|/home/a/.codex', hostId: 'codex', label: 'Codex', rootPath: '/home/a/.codex' };
const pkg = (key, extra = {}) => ({ packageKey: key, name: `資源 ${key}`, type: 'skill', latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [],
  tools: toolsOf(), pendingTargets: { count: 0, targets: [] }, lastFailure: null, ...extra });
const installed = (key, extra = {}) => pkg(key, { installationStatus: 'current', deployments: [dep({ version: '1.2.0' }), claudeDep({ version: '1.2.0' })], tools: toolsOf(true, true), ...extra });
const done = (targets = [codexTarget, claudeTarget], extra = {}) => ({ ok: true, succeeded: targets, failed: [], backups: [], ...extra });

async function start({ items = [installed('demo')], detail, run = async () => done(), handler } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input, options) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)), options });
    const custom = handler && await handler(method, input);
    if (custom !== undefined) return custom;
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false };
    if (method === 'rc.catalog.list') return { data: typeof items === 'function' ? items(input) : items };
    if (method === 'rc.package.getDetails') {
      const list = typeof items === 'function' ? items({}) : items;
      const base = list.find(p => p.packageKey === input.packageKey);
      return { readme: '', selectedVersion: '1.2.0', recommendedVersion: '1.2.0', versions: [{ version: '1.2.0', channel: 'release', hosts: ['codex'] }], parameters: [],
        ...base, ...(typeof detail === 'function' ? detail(input) : detail) };
    }
    if (method === 'rc.install.run') return run(input);
    if (method === 'rc.updates.checkNow') return { count: 0 };
    return {};
  });
  const card = (key = 'demo') => findByData(panel.get('catalog-list'), 'package-key', key);
  const action = (root, name) => findByData(root, 'action', name);
  const open = async (key = 'demo') => { await card(key).fire('click'); await settle(); };
  const runs = () => calls.filter(c => c.method === 'rc.install.run').map(c => c.input);
  const count = (method) => calls.filter(c => c.method === method).length;
  return { panel, calls, card, action, open, runs, count };
}
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : null;
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');
const buttons = (node) => findAllByData(findByData(node, 'slot', 'card-actions'), 'action').map(n => n.getAttribute('data-action'));
const uninstallOf = (node) => findByData(node, 'action', 'uninstall');
const status = (node) => text(findByData(node, 'role', 'status-text'));

test('解除安裝按鈕：已安裝（最新、較新、可更新、已下架、待補裝）才顯示；未安裝不顯示；與更新／補裝並存時排在其右邊', async () => {
  const pending = { count: 1, targets: [claudeTarget] };
  const { card } = await start({ items: [
    pkg('none'),
    installed('cur'),
    pkg('new', { installationStatus: 'newer', deployments: [dep({ version: '2.0.0', status: 'newer' })], tools: toolsOf(true) }),
    pkg('gone', { installationStatus: 'unavailable', latestVisibleVersion: null, deployments: [dep({ status: 'unavailable' })], tools: toolsOf(true) }),
    pkg('upd', { installationStatus: 'updateAvailable', deployments: [dep({ status: 'updateAvailable', updateVersion: '1.2.0' })], tools: toolsOf(true) }),
    pkg('pend', { installationStatus: 'current', deployments: [dep({ version: '1.2.0' })], tools: toolsOf(true), pendingTargets: pending }),
    pkg('err', { installationStatus: 'current', deployments: [dep()], tools: toolsOf(true), installedError: { message: '讀不到' } })
  ] });
  assert.deepEqual(['none', 'cur', 'new', 'gone', 'upd', 'pend', 'err'].map(k => buttons(card(k))), [
    ['install'], ['uninstall'], ['uninstall'], ['uninstall'], ['update', 'uninstall'], ['fill-pending', 'uninstall'], []]);
  const button = uninstallOf(card('cur'));
  assert.equal(text(button), '解除安裝');
  assert.equal(button.tagName, 'button');
  assert.ok(button.classList.contains('btn-danger-outline'), '紅色次要樣式');
  assert.ok(!button.classList.contains('btn-primary'));
  assert.ok(findByData(findByData(card('cur'), 'slot', 'card-actions'), 'action', 'uninstall'), '放在原本主要按鈕的位置');
});

test('只裝在專案範圍的資源包是未安裝，不顯示解除安裝', async () => {
  const { card } = await start({ items: [pkg('proj', { installationStatus: 'notInstalled', deployments: [dep({ scope: 'project' })] })] });
  assert.deepEqual(buttons(card('proj')), ['install']);
});

test('點解除安裝不進入明細，只開確認層；按鈕與失敗徽章同樣不會觸發進入明細', async () => {
  const { panel, calls, card } = await start();
  await uninstallOf(card()).dispatch('click');
  await settle();
  assert.equal(hidden(panel, 'view-details'), true);
  assert.equal(calls.some(c => c.method === 'rc.package.getDetails'), false);
  assert.equal(hidden(panel, 'confirm-layer'), false);
});

test('確認層：標題、將從 N 個位置移除、每個位置的工具圖示與名稱與根目錄、備份與保留說明；紅色主要按鈕「解除安裝」與「取消」', async () => {
  const { panel, card, runs } = await start();
  await uninstallOf(card()).fire('click'); await settle();
  assert.equal(hidden(panel, 'confirm-layer'), false);
  assert.equal(text(panel.get('confirm-title')), '解除安裝 資源 demo？');
  const body = panel.get('confirm-body');
  const section = findByData(body, 'section', 'uninstallTargets');
  assert.match(text(findByData(section, 'role', 'confirm-heading') ?? section), /將從 2 個位置移除/);
  const rows = findAllByData(body, 'role', 'removal-target');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => findByData(r, 'tool').getAttribute('data-tool')), ['codex', 'claude-code']);
  assert.match(text(rows[0]), /Codex.*\/home\/a\/\.codex/);
  assert.match(text(rows[1]), /Claude Code.*\/home\/a\/\.claude/);
  assert.match(text(body), /你在安裝後修改過的檔案會先備份再移除。設定參數會保留，重新安裝可直接沿用。/);
  assert.equal(text(panel.get('confirm-primary')), '解除安裝');
  assert.ok(panel.get('confirm-primary').classList.contains('btn-danger'));
  assert.ok(!panel.get('confirm-primary').classList.contains('btn-primary'));
  assert.equal(text(panel.get('confirm-cancel')), '取消');
  assert.equal(runs().length, 0, '開啟確認層不呼叫 worker');
  assert.equal(findByData(body, 'section', 'blockedTargets'), null);
});

test('確認層位置清單只列全域部署，Claude Desktop 以友善名稱呈現', async () => {
  const desktop = dep({ id: 'claude-code|claude-desktop|global|/d', hostId: 'claude-code', surfaceId: 'claude-desktop', rootPath: '/d', label: 'Claude Desktop' });
  const { panel, card } = await start({ items: [installed('demo', { deployments: [dep(), desktop, dep({ id: 'proj', scope: 'project', rootPath: '/proj' })] })] });
  await uninstallOf(card()).fire('click'); await settle();
  const rows = findAllByData(panel.get('confirm-body'), 'role', 'removal-target');
  assert.equal(rows.length, 2);
  assert.match(text(panel.get('confirm-body')), /將從 2 個位置移除/);
  assert.match(text(rows[1]), /Claude Desktop/);
  assert.doesNotMatch(text(panel.get('confirm-body')), /\/proj/);
});

test('取消不呼叫 worker，確認層關閉，按鈕可再次使用；再開一次不重複送出', async () => {
  const { panel, card, runs } = await start();
  await uninstallOf(card()).fire('click'); await settle();
  await panel.get('confirm-cancel').fire('click'); await settle();
  assert.equal(hidden(panel, 'confirm-layer'), true);
  assert.equal(runs().length, 0);
  assert.equal(uninstallOf(card()).disabled, false);
  assert.equal(text(uninstallOf(card())), '解除安裝');
});

test('確認後只呼叫一次 rc.install.run（action uninstall，不帶 targetIds 或 confirmedPlanId）；執行中停用並顯示「解除安裝中…」且沒有取消鈕', async () => {
  let release;
  const { panel, card, runs } = await start({ run: () => new Promise(resolve => { release = resolve; }) });
  await uninstallOf(card()).fire('click'); await settle();
  const confirming = panel.get('confirm-primary').fire('click');
  await settle();
  assert.deepEqual(runs(), [{ packageKey: 'demo', action: 'uninstall' }]);
  assert.equal(hidden(panel, 'confirm-layer'), true);
  const busy = uninstallOf(card());
  assert.equal(busy.disabled, true);
  assert.equal(text(busy), '解除安裝中…');
  assert.equal(findByData(card(), 'action', 'cancel-install'), null, '不提供取消');
  await busy.fire('click');
  assert.equal(runs().length, 1, '同一資源包不能重複觸發');
  release(done());
  await confirming; await settle();
  assert.equal(runs().length, 1);
});

test('全部成功：提示「已從 N 個位置解除安裝」，卡片就地變為未安裝、清單不跳回頂端，並向市集重新同步可更新數量', async () => {
  let removed = false;
  const { panel, calls, card, action, count } = await start({ items: () => [removed ? pkg('demo') : installed('demo')], run: () => { removed = true; return done(); } });
  panel.get('view-main').scrollTop = 160;
  const lists = count('rc.catalog.list');
  await uninstallOf(card()).fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '已從 2 個位置解除安裝');
  assert.equal(panel.get('toast').classList.contains('error'), false);
  assert.equal(count('rc.catalog.list'), lists + 1, '重新讀取狀態');
  assert.equal(panel.get('view-main').scrollTop, 160);
  assert.equal(status(card()), '未安裝');
  assert.equal(uninstallOf(card()), null);
  assert.ok(action(card(), 'install'));
  assert.ok(calls.some(c => c.method === 'rc.updates.checkNow'), '解除安裝後更新可更新數量');
  assert.equal(hidden(panel, 'confirm-layer'), true);
  await panel.timeouts.fireAll();
  assert.equal(hidden(panel, 'toast'), true);
});

test('目前篩選是「已安裝」時，解除安裝成功後該卡片從清單移除，其他卡片保留', async () => {
  let removed = false;
  const { panel, card } = await start({
    items: (input) => [removed ? null : installed('demo'), installed('other')].filter(Boolean).filter(p => input?.installation !== 'installed' || p.installationStatus !== 'notInstalled'),
    run: () => { removed = true; return done(); } });
  panel.get('catalog-installation').value = 'installed';
  await panel.get('catalog-installation').fire('change'); await settle();
  assert.ok(card('demo'));
  await uninstallOf(card()).fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(card('demo'), null);
  assert.ok(card('other'));
});

test('有備份：提示附「已備份 M 個修改過的檔案」', async () => {
  const backup = (n) => ({ ...claudeTarget, backupPath: `/home/a/.claude/skills/demo/a${n}.md.bak-lcaipack-1` });
  const { panel, card } = await start({ run: () => done(undefined, { backups: [backup(1), backup(2), backup(3)] }) });
  await uninstallOf(card()).fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '已從 2 個位置解除安裝，已備份 3 個修改過的檔案');
  assert.equal(panel.get('toast').classList.contains('error'), false);
});

test('部分失敗：提示成功與失敗數量，卡片顯示「N 個位置失敗」並展開失敗清單（含備份位置）；「重試失敗項目」送 retry，成功提示仍是解除安裝', async () => {
  let phase = 'before';
  const failedTarget = { ...claudeTarget, reason: '檔案被其他程式占用', backupPaths: ['/home/a/.claude/skills/demo/a.md.bak-lcaipack-1'] };
  const failure = { count: 1, action: 'uninstall', targets: [failedTarget] };
  const view = () => phase === 'before' ? installed('demo')
    : phase === 'partial' ? installed('demo', { deployments: [claudeDep({ version: '1.2.0' })], tools: toolsOf(false, true), lastFailure: failure })
      : pkg('demo');
  const { panel, card, action, runs } = await start({ items: () => [view()],
    run: (input) => {
      if (input.action === 'uninstall') { phase = 'partial'; return { ok: false, succeeded: [codexTarget], failed: [failedTarget], backups: [] }; }
      phase = 'after'; return done([claudeTarget]);
    } });
  await uninstallOf(card()).fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '已從 1 個位置解除安裝，1 個位置失敗');
  assert.ok(panel.get('toast').classList.contains('error'));
  assert.equal(text(findByData(card(), 'role', 'failure')), '1 個位置失敗');
  const list = findByData(card(), 'role', 'failure-list');
  assert.match(text(list), /Claude Code.*檔案被其他程式占用/);
  assert.match(detailsOf(list).find(d => /備份位置/.test(d.summary)).body, /a\.md\.bak-lcaipack-1/);
  assert.deepEqual(buttons(card()).filter(a => a !== 'retry'), ['uninstall'], '仍有部署時保留解除安裝');

  await action(list, 'retry').fire('click'); await settle();
  assert.deepEqual(runs().at(-1), { packageKey: 'demo', action: 'retry', targetIds: [claudeTarget.targetId] });
  assert.equal(text(panel.get('toast')), '已從 1 個位置解除安裝');
  assert.equal(findByData(card(), 'role', 'failure'), null);
  assert.equal(status(card()), '未安裝');
});

test('全部失敗：只提示失敗數量並展開失敗清單；卡片維持已安裝', async () => {
  const failedTarget = { ...codexTarget, reason: '權限不足' };
  const { panel, card } = await start({ items: () => [installed('demo', { lastFailure: { count: 1, action: 'uninstall', targets: [failedTarget] } })],
    run: () => ({ ok: false, succeeded: [], failed: [failedTarget], backups: [] }) });
  await uninstallOf(card()).fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '1 個位置失敗');
  assert.match(text(findByData(card(), 'role', 'failure-list')), /權限不足/);
  assert.equal(status(card()), '已安裝 1.2.0');
});

test('找不到安裝紀錄：顯示該訊息並重新整理狀態；解除安裝鈕恢復', async () => {
  let gone = false;
  const { panel, card, count } = await start({ items: () => [gone ? pkg('demo') : installed('demo')],
    run: () => { gone = true; throw Object.assign(new Error('找不到這個資源包的安裝紀錄'), { code: 'not_installed' }); } });
  const lists = count('rc.catalog.list');
  await uninstallOf(card()).fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '找不到這個資源包的安裝紀錄');
  assert.ok(panel.get('toast').classList.contains('error'));
  assert.equal(count('rc.catalog.list'), lists + 1, '重新整理狀態');
  assert.equal(status(card()), '未安裝');
  assert.equal(hidden(panel, 'confirm-layer'), true);
});

test('明細頁：狀態列同樣有紅色解除安裝（與更新並存時在其右邊）；確認、執行中、成功後就地更新為未安裝', async () => {
  let removed = false;
  let release;
  const item = () => removed ? pkg('demo') : installed('demo', { installationStatus: 'updateAvailable', deployments: [dep({ status: 'updateAvailable', updateVersion: '1.2.0' }), claudeDep({ version: '1.2.0' })] });
  const { panel, calls, open, runs, count } = await start({ items: () => [item()], run: () => new Promise(resolve => { release = () => { removed = true; resolve(done([codexTarget, claudeTarget], { backups: [{ ...codexTarget, backupPath: '/x/a.bak-lcaipack-1' }] })); }; }) });
  await open();
  const row = panel.get('details-status-row');
  assert.deepEqual(findAllByData(row, 'action').map(n => n.getAttribute('data-action')), ['update', 'uninstall']);
  assert.equal(text(findByData(row, 'action', 'uninstall')), '解除安裝');
  await findByData(row, 'action', 'uninstall').fire('click'); await settle();
  assert.equal(text(panel.get('confirm-title')), '解除安裝 資源 demo？');
  assert.match(text(panel.get('confirm-body')), /將從 2 個位置移除/);
  const confirming = panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(runs(), [{ packageKey: 'demo', action: 'uninstall' }]);
  const busy = findByData(panel.get('details-status-row'), 'action', 'uninstall');
  assert.equal(busy.disabled, true);
  assert.equal(text(busy), '解除安裝中…');
  const details = count('rc.package.getDetails');
  release(); await confirming; await settle();
  assert.equal(hidden(panel, 'view-details'), false, '留在明細頁');
  assert.equal(count('rc.package.getDetails'), details + 1);
  assert.equal(text(panel.get('toast')), '已從 2 個位置解除安裝，已備份 1 個修改過的檔案');
  assert.equal(status(panel.get('details-status-row')), '未安裝');
  assert.equal(findByData(panel.get('details-status-row'), 'action', 'uninstall'), null);
  assert.equal(findByData(panel.get('details-installed'), 'role', 'locations'), null, '安裝位置清單消失');
  assert.ok(calls.some(c => c.method === 'rc.updates.checkNow'));
});

test('明細頁：取消不呼叫 worker；已是最新時解除安裝在主要按鈕的位置', async () => {
  const { panel, open, runs } = await start();
  await open();
  const row = panel.get('details-status-row');
  assert.deepEqual(findAllByData(row, 'action').map(n => n.getAttribute('data-action')), ['uninstall']);
  await findByData(row, 'action', 'uninstall').fire('click'); await settle();
  await panel.get('confirm-cancel').fire('click'); await settle();
  assert.equal(hidden(panel, 'confirm-layer'), true);
  assert.equal(runs().length, 0);
});

test('確認層文字不使用「保存」', async () => {
  const { panel, card } = await start();
  await uninstallOf(card()).fire('click'); await settle();
  assert.doesNotMatch(text(panel.get('confirm-layer')), /保存/);
});
