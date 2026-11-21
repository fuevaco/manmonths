// 受阻目標在例外確認畫面同意略過後，不再是紅色失敗（面板端）：
// 結果提示用中性樣式、卡片與明細的灰色「略過 N 個位置」徽章與精簡清單（沒有重試）、與失敗並存時失敗在前。
// worker 以替身回應（新契約：rc.install.run 的 skipped、清單與明細的 lastSkipped）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const dep = (extra = {}) => ({ id: 'codex|codex-cli|global|/home/a/.codex', hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', rootPath: '/home/a/.codex',
  version: '1.2.0', channel: 'release', status: 'current', updateVersion: null, label: 'Codex', backupPaths: [], ...extra });
const toolsOf = (codex = false, claude = false) => [{ hostId: 'codex', label: 'Codex', deployed: codex }, { hostId: 'claude-code', label: 'Claude Code', deployed: claude }];
const claudeTarget = { targetId: 'claude-code|claude-code-cli|global|/home/a/.claude', hostId: 'claude-code', label: 'Claude Code', rootPath: '/home/a/.claude' };
const codexTarget = { targetId: 'codex|codex-cli|global|/home/a/.codex', hostId: 'codex', label: 'Codex', rootPath: '/home/a/.codex' };
const skippedTarget = { ...claudeTarget, reason: '目的地已由資源包 other 管理', detail: [{ summary: '目的地衝突', explanation: 'managed by other' }] };
const skipped = { count: 1, targets: [skippedTarget] };
const failure = { count: 1, targets: [{ ...codexTarget, reason: '寫入失敗，已完整還原' }] };
const pkg = (key, extra = {}) => ({ packageKey: key, name: `資源 ${key}`, type: 'skill', latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [],
  tools: toolsOf(), pendingTargets: { count: 0, targets: [] }, lastFailure: null, lastSkipped: null, ...extra });
const installed = (key, extra = {}) => pkg(key, { installationStatus: 'current', deployments: [dep()], tools: toolsOf(true), ...extra });
const ok = (n, extra = {}) => ({ ok: true, succeeded: Array.from({ length: n }, (_, i) => ({ ...claudeTarget, targetId: `t${i}` })), failed: [], skipped: [], backups: [], ...extra });
const confirmation = (blocked) => ({ needsConfirmation: true, reasons: ['blockedTargets'], allBlocked: false, planId: 'p1',
  plan: { deployableCount: 3, blockedTargets: blocked, setupCommands: [], missingParameters: [] } });

async function start({ items = [pkg('demo')], run = async () => ok(1) } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false };
    if (method === 'rc.catalog.list') return { data: typeof items === 'function' ? items() : items };
    if (method === 'rc.package.getDetails') {
      const base = (typeof items === 'function' ? items() : items).find(p => p.packageKey === input.packageKey);
      return { readme: '', selectedVersion: '1.2.0', recommendedVersion: '1.2.0', versions: [{ version: '1.2.0', channel: 'release', hosts: ['codex'] }], parameters: [], ...base };
    }
    if (method === 'rc.install.run') return run(input);
    return {};
  });
  const card = (key = 'demo') => findByData(panel.get('catalog-list'), 'package-key', key);
  const inDetails = () => !panel.get('view-details').classList.contains('hidden');
  return { panel, calls, card, inDetails, runs: () => calls.filter(c => c.method === 'rc.install.run').map(c => c.input) };
}
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : null;
const role = (root, name) => findByData(root, 'role', name);

test('部分受阻並確認後：提示「已安裝到 3 個位置，略過 1 個位置」用中性樣式，不是紅色', async () => {
  const { panel, card } = await start({ run: (input) => input.confirmedPlanId ? ok(3, { skipped: [skippedTarget] }) : confirmation([skippedTarget]) });
  await findByData(card(), 'action', 'install').fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '已安裝到 3 個位置，略過 1 個位置');
  assert.ok(panel.get('toast').classList.contains('info'));
  assert.equal(panel.get('toast').classList.contains('error'), false);
});

test('只有略過、沒有成功：提示「略過 N 個位置」且為中性樣式', async () => {
  const { panel, card } = await start({ run: () => ok(0, { skipped: [skippedTarget, { ...codexTarget, reason: '另一個原因' }] }) });
  await findByData(card(), 'action', 'install').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '略過 2 個位置');
  assert.ok(panel.get('toast').classList.contains('info'));
});

test('更新的提示沿用說法並附上略過數', async () => {
  const { panel, card } = await start({
    items: [pkg('upd', { installationStatus: 'updateAvailable', deployments: [dep({ status: 'updateAvailable', updateVersion: '1.2.0' })], tools: toolsOf(true) })],
    run: () => ok(2, { skipped: [skippedTarget] }) });
  await findByData(card('upd'), 'action', 'update').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '已更新 2 個位置，略過 1 個位置');
});

test('同時有真正失敗：用紅色並優先描述失敗，略過接在後面', async () => {
  const { panel, card } = await start({ run: () => ok(2, { ok: false, failed: failure.targets, skipped: [skippedTarget] }) });
  await findByData(card(), 'action', 'install').fire('click'); await settle();
  const toast = text(panel.get('toast'));
  assert.match(toast, /^已安裝到 2 個位置，1 個位置失敗/);
  assert.ok(toast.indexOf('失敗') < toast.indexOf('略過'));
  assert.match(toast, /略過 1 個位置/);
  assert.ok(panel.get('toast').classList.contains('error'));
});

test('沒有略過也沒有失敗：提示維持原樣，不是中性也不是紅色', async () => {
  const { panel, card } = await start({ run: () => ok(1) });
  await findByData(card(), 'action', 'install').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '已安裝到 1 個位置');
  assert.equal(panel.get('toast').classList.contains('info'), false);
  assert.equal(panel.get('toast').classList.contains('error'), false);
});

test('卡片：lastSkipped 有內容時在狀態文字旁顯示灰色「略過 N 個位置」徽章；預設收合', async () => {
  const { card } = await start({ items: [installed('demo', { lastSkipped: skipped })] });
  const badge = role(card(), 'skipped');
  assert.equal(text(badge), '略過 1 個位置');
  assert.ok(badge.classList.contains('skipped-badge'));
  assert.equal(badge.classList.contains('failure-badge'), false, '不是紅色失敗徽章');
  assert.equal(badge.getAttribute('aria-expanded'), 'false');
  assert.equal(role(card(), 'skipped-list'), null);
  assert.equal(role(card(), 'failure'), null);
  assert.equal(text(role(card(), 'status-text')), '已安裝 1.2.0');
});

test('點徽章展開精簡清單：工具圖示、友善名稱、根目錄、原因、可展開的詳細紀錄、說明句，沒有重試；再點收合', async () => {
  const { card, inDetails, runs } = await start({ items: [installed('demo', { lastSkipped: skipped })] });
  await role(card(), 'skipped').dispatch('click'); await settle();
  assert.equal(inDetails(), false, '點徽章不進入明細');
  const list = role(card(), 'skipped-list');
  assert.ok(list);
  const row = role(list, 'skipped-target');
  assert.equal(findByData(row, 'tool').getAttribute('data-tool'), 'claude-code');
  assert.match(text(row), /Claude Code/);
  assert.match(text(row), /\/home\/a\/\.claude/);
  assert.match(text(row), /目的地已由資源包 other 管理/);
  const fold = role(row, 'failure-detail');
  assert.ok(fold, 'detail 可展開');
  assert.match(text(fold), /目的地衝突/);
  assert.equal(text(role(list, 'skipped-note')), '排除原因後，下次安裝、更新或補裝時會再嘗試。');
  assert.equal(findAllByData(list, 'action').length, 0, '沒有任何按鈕（沒有重試）');
  assert.doesNotMatch(text(list), /重試/);
  assert.equal(runs().length, 0);
  await role(card(), 'skipped').dispatch('click'); await settle();
  assert.equal(role(card(), 'skipped-list'), null);
  assert.equal(inDetails(), false);
});

test('清單內任何位置（列、原因、路徑、詳細紀錄、說明句）與徽章被點擊或按鍵都不進入明細', async () => {
  const { card, inDetails } = await start({ items: [installed('demo', { lastSkipped: skipped })] });
  await role(card(), 'skipped').dispatch('keydown', { key: 'Enter' });
  await role(card(), 'skipped').dispatch('click'); await settle();
  const list = role(card(), 'skipped-list');
  const row = role(list, 'skipped-target');
  const fold = role(row, 'failure-detail');
  const inner = [list, row, fold, fold.children.find(n => n.tagName === 'summary'), fold.children.at(-1), role(list, 'skipped-note'),
    ...findAllByData(row, 'role').filter(n => n.className.includes('failure-reason'))].filter(Boolean);
  for (const node of inner) await node.dispatch('click');
  await settle();
  assert.equal(inDetails(), false);
});

test('重新載入後仍顯示：結果提示後重新讀取即出現徽章，再次載入清單仍在', async () => {
  let current = pkg('demo');
  const { panel, card } = await start({ items: () => [current], run: () => { current = installed('demo', { lastSkipped: skipped }); return ok(1, { skipped: [skippedTarget] }); } });
  assert.equal(role(card(), 'skipped'), null);
  await findByData(card(), 'action', 'install').fire('click'); await settle();
  assert.equal(text(role(card(), 'skipped')), '略過 1 個位置');
  await panel.get('catalog-search').fire('keydown', { key: 'Enter' }); await settle();
  assert.equal(text(role(card(), 'skipped')), '略過 1 個位置', '重新載入清單後仍在');
});

test('明細狀態列同樣顯示灰色徽章與清單；點徽章不離開明細，清單沒有重試', async () => {
  const { panel, card, inDetails } = await start({ items: [installed('demo', { lastSkipped: skipped })] });
  await card().fire('click'); await settle();
  assert.equal(inDetails(), true);
  const row = panel.get('details-status-row');
  const badge = role(row, 'skipped');
  assert.equal(text(badge), '略過 1 個位置');
  await badge.dispatch('click'); await settle();
  const list = role(row, 'skipped-list');
  assert.ok(list);
  assert.match(text(list), /目的地已由資源包 other 管理/);
  assert.equal(findAllByData(list, 'action').length, 0);
  assert.equal(inDetails(), true);
});

test('失敗與略過並存：兩個徽章並列、失敗在前；清單失敗在前，失敗清單有重試、略過清單沒有', async () => {
  const { card } = await start({ items: [installed('demo', { lastFailure: failure, lastSkipped: skipped })] });
  const nodes = role(card(), 'status-row').children;
  const failureIndex = nodes.findIndex(n => n.getAttribute('data-role') === 'failure');
  const skippedIndex = nodes.findIndex(n => n.getAttribute('data-role') === 'skipped');
  assert.ok(failureIndex >= 0 && skippedIndex > failureIndex, '失敗徽章在前');
  assert.equal(text(role(card(), 'failure')), '1 個位置失敗');
  assert.equal(text(role(card(), 'skipped')), '略過 1 個位置');
  await role(card(), 'skipped').dispatch('click'); await settle();
  await role(card(), 'failure').dispatch('click'); await settle();
  const failureList = role(card(), 'failure-list'), skippedList = role(card(), 'skipped-list');
  assert.ok(failureList && skippedList);
  assert.ok(findByData(failureList, 'action', 'retry'));
  assert.equal(findAllByData(skippedList, 'action').length, 0);
  const order = card().children.filter(n => ['status-row', 'failure-list', 'skipped-list'].includes(n.getAttribute?.('data-role')))
    .map(n => n.getAttribute('data-role'));
  assert.deepEqual(order, ['status-row', 'failure-list', 'skipped-list'], '失敗清單在略過清單之前');
});

test('沒有略過時不顯示：lastSkipped 為 null、空清單或缺欄位', async () => {
  const { card } = await start({ items: [installed('a', { lastSkipped: null }), installed('b', { lastSkipped: { count: 0, targets: [] } }), installed('c', { lastSkipped: undefined })] });
  for (const key of ['a', 'b', 'c']) assert.equal(role(card(key), 'skipped'), null, key);
});

test('略過的位置不會讓失敗徽章或「重試失敗項目」出現：失敗徽章只依 lastFailure', async () => {
  const { card } = await start({ items: [installed('demo', { lastSkipped: skipped })] });
  assert.equal(role(card(), 'failure'), null);
  await role(card(), 'skipped').dispatch('click'); await settle();
  assert.equal(findAllByData(card(), 'action', 'retry').length, 0);
  assert.equal(role(card(), 'failure'), null);
});

test('CSS：略過徽章與清單用灰色中性樣式，不使用紅色；卡片上清單不顯示手型', async () => {
  const css = await readFile(new URL('../panel/panel.css', import.meta.url), 'utf8');
  const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.[\]()"=:*]/g, '\\$&')} \\{[^}]*\\}`))?.[0] ?? '';
  for (const selector of ['.skipped-badge', '.skipped-list']) {
    assert.ok(rule(selector), `${selector} 有樣式`);
    assert.doesNotMatch(rule(selector), /--bad/, `${selector} 不是紅色`);
  }
  assert.match(rule('.skipped-badge'), /color: var\(--muted\)/);
  assert.match(rule('.catalog-card .skipped-list'), /cursor: auto/);
});
