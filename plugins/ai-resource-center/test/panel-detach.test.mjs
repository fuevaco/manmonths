// 停止管理此位置（保留檔案）與已下架說明（statusHint）面板端：
// worker 以替身回應，驗證面板送出的 rc.install.run（action: 'detach'）請求與畫面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

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
const failed = (targets, action = 'uninstall') => ({ count: targets.length, action, targets: targets.map(t => ({ ...t, reason: '檔案被其他程式占用' })) });
const kept = (target, paths) => ({ targetId: target.targetId, label: target.label, rootPath: target.rootPath, keptPaths: paths });
const HINT = '已自市集下架或你已無權限查看；本機仍可繼續使用與解除安裝';

async function start({ items = [installed('demo')], detail, run = async () => ({ ok: true, succeeded: [], failed: [], detached: [] }) } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input, options) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)), options });
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
  const open = async (key = 'demo') => { await card(key).fire('click'); await settle(); };
  const runs = () => calls.filter(c => c.method === 'rc.install.run').map(c => c.input);
  return { panel, calls, card, open, runs };
}
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : null;
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');
const detachButtons = (node) => findAllByData(node, 'action', 'detach');
const withFailure = (targets, action = 'uninstall', extra = {}) => installed('demo', { lastFailure: failed(targets, action), ...extra });
const expand = async (node) => { await findByData(node, 'role', 'failure').fire('click'); await settle(); };

test('停止管理按鈕：只在上一次解除安裝失敗時出現；安裝或更新失敗、沒有失敗都不顯示', async () => {
  const { card } = await start({ items: [
    installed('un', { lastFailure: failed([claudeTarget], 'uninstall') }),
    installed('ins', { lastFailure: failed([claudeTarget], 'install') }),
    installed('upd', { lastFailure: failed([claudeTarget], 'update') }),
    installed('none')
  ] });
  for (const key of ['un', 'ins', 'upd']) await expand(card(key));
  assert.equal(detachButtons(card('un')).length, 1);
  assert.equal(text(detachButtons(card('un'))[0]), '停止管理此位置（保留檔案）');
  assert.equal(detachButtons(card('ins')).length, 0);
  assert.equal(detachButtons(card('upd')).length, 0);
  assert.equal(detachButtons(card('none')).length, 0);
  assert.ok(findByData(card('ins'), 'action', 'retry'), '其他失敗仍有重試');
});

test('失敗清單收合時不顯示停止管理按鈕；按鈕是次要按鈕，與重試失敗項目並存', async () => {
  const { card } = await start({ items: [withFailure([claudeTarget])] });
  assert.equal(detachButtons(card()).length, 0);
  await expand(card());
  const button = detachButtons(card())[0];
  assert.equal(button.tagName, 'button');
  assert.ok(!button.classList.contains('btn-primary'));
  assert.ok(findByData(card(), 'action', 'retry'));
});

test('多個失敗位置：每列各一顆，按下只針對該列位置', async () => {
  const { panel, card, runs } = await start({ items: [withFailure([codexTarget, claudeTarget])] });
  await expand(card());
  const rows = findAllByData(card(), 'role', 'failure-target');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => detachButtons(r).length), [1, 1]);
  assert.deepEqual(rows.map(r => detachButtons(r)[0].getAttribute('data-target-id')), [codexTarget.targetId, claudeTarget.targetId]);
  await detachButtons(rows[1])[0].dispatch('click'); await settle();
  const rowsInLayer = findAllByData(panel.get('confirm-body'), 'role', 'detach-target');
  assert.equal(rowsInLayer.length, 1);
  assert.match(text(rowsInLayer[0]), /Claude Code.*\/home\/a\/\.claude/);
  assert.doesNotMatch(text(panel.get('confirm-body')), /\.codex/);
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(runs(), [{ packageKey: 'demo', action: 'detach', targetIds: [claudeTarget.targetId] }]);
});

test('點停止管理不進入明細，只開確認層', async () => {
  const { panel, calls, card } = await start({ items: [withFailure([claudeTarget])] });
  await expand(card());
  await detachButtons(card())[0].dispatch('click'); await settle();
  assert.equal(hidden(panel, 'view-details'), true);
  assert.equal(calls.some(c => c.method === 'rc.package.getDetails'), false);
  assert.equal(hidden(panel, 'confirm-layer'), false);
});

test('確認層：標題、位置（工具圖示、名稱、根目錄）、不刪檔說明；按鈕「停止管理」與「取消」；開啟時不呼叫 worker', async () => {
  const { panel, card, runs } = await start({ items: [withFailure([claudeTarget])] });
  await expand(card());
  await detachButtons(card())[0].fire('click'); await settle();
  assert.equal(text(panel.get('confirm-title')), '停止管理這個位置？');
  const body = panel.get('confirm-body');
  const rows = findAllByData(body, 'role', 'detach-target');
  assert.equal(rows.length, 1);
  assert.equal(findByData(rows[0], 'tool').getAttribute('data-tool'), 'claude-code');
  assert.match(text(rows[0]), /Claude Code.*\/home\/a\/\.claude/);
  assert.match(text(body), /資源中心會刪除這個位置的安裝紀錄，但不會刪除任何檔案或設定。留在原處的內容需要你自行刪除：/);
  assert.equal(text(panel.get('confirm-primary')), '停止管理');
  assert.equal(text(panel.get('confirm-cancel')), '取消');
  assert.equal(panel.get('confirm-primary').classList.contains('hidden'), false);
  assert.doesNotMatch(text(panel.get('confirm-layer')), /保存/);
  assert.equal(runs().length, 0);
});

test('取消不呼叫 worker，確認層關閉，失敗清單與按鈕仍在', async () => {
  const { panel, card, runs } = await start({ items: [withFailure([claudeTarget])] });
  await expand(card());
  await detachButtons(card())[0].fire('click'); await settle();
  await panel.get('confirm-cancel').fire('click'); await settle();
  assert.equal(hidden(panel, 'confirm-layer'), true);
  assert.equal(runs().length, 0);
  assert.equal(detachButtons(card())[0].disabled, false);
});

test('確認後只呼叫一次 detach（帶正確 targetIds）；執行中停用並顯示處理中', async () => {
  let release;
  const { panel, card, runs } = await start({ items: [withFailure([codexTarget, claudeTarget])], run: () => new Promise(resolve => { release = resolve; }) });
  await expand(card());
  await detachButtons(card())[0].fire('click'); await settle();
  const confirming = panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(runs(), [{ packageKey: 'demo', action: 'detach', targetIds: [codexTarget.targetId] }]);
  assert.equal(hidden(panel, 'confirm-layer'), true);
  assert.ok(detachButtons(card()).every(b => b.disabled), '執行中全部停用');
  assert.ok(findByData(card(), 'action', 'retry').disabled);
  await detachButtons(card())[0].fire('click');
  assert.equal(runs().length, 1);
  release({ ok: true, succeeded: [], failed: [], detached: [kept(codexTarget, [])] });
  await confirming; await settle();
  assert.equal(runs().length, 1);
});

test('完成：提示「已停止管理 N 個位置，檔案保留在原處」，列出 keptPaths，卡片依重新讀取的資料更新（未安裝）', async () => {
  let done = false;
  const paths = ['/home/a/.claude/skills/demo', '/home/a/.claude/.mcp.json'];
  const { panel, card } = await start({ items: () => [done ? pkg('demo') : withFailure([claudeTarget], 'uninstall', { deployments: [claudeDep({ version: '1.2.0' })], tools: toolsOf(false, true) })],
    run: () => { done = true; return { ok: true, succeeded: [], failed: [], detached: [kept(claudeTarget, paths)] }; } });
  await expand(card());
  await detachButtons(card())[0].fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '已停止管理 1 個位置，檔案保留在原處');
  assert.equal(panel.get('toast').classList.contains('error'), false);
  const note = findByData(card(), 'role', 'detached-note');
  assert.ok(note, '留下需手動處理的路徑');
  assert.match(text(note), /Claude Code/);
  assert.match(text(note), /\/home\/a\/\.claude\/skills\/demo/);
  assert.match(text(note), /\/home\/a\/\.claude\/\.mcp\.json/);
  assert.equal(findByData(card(), 'role', 'status-text').textContent, '未安裝');
  assert.equal(findByData(card(), 'role', 'failure'), null);
  assert.equal(detachButtons(card()).length, 0);
  assert.equal(hidden(panel, 'confirm-layer'), true);
  // 收到「知道了」後說明消失
  await findByData(note, 'action', 'dismiss-detached').fire('click'); await settle();
  assert.equal(findByData(card(), 'role', 'detached-note'), null);
});

test('完成後仍有其他失敗位置：維持已安裝並保留另一位置的停止管理按鈕；點說明區不進明細', async () => {
  let phase = 0;
  const view = () => phase === 0 ? withFailure([codexTarget, claudeTarget]) : installed('demo', { deployments: [claudeDep({ version: '1.2.0' })], tools: toolsOf(false, true), lastFailure: failed([claudeTarget]) });
  const { panel, calls, card } = await start({ items: () => [view()],
    run: () => { phase = 1; return { ok: true, succeeded: [], failed: [], detached: [kept(codexTarget, ['/home/a/.codex/skills/demo'])] }; } });
  await expand(card());
  await detachButtons(card())[0].fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(findByData(card(), 'role', 'status-text').textContent, '已安裝 1.2.0');
  assert.deepEqual(detachButtons(card()).map(b => b.getAttribute('data-target-id')), [claudeTarget.targetId]);
  await findByData(card(), 'role', 'detached-note').dispatch('click'); await settle();
  assert.equal(hidden(panel, 'view-details'), true);
  assert.equal(calls.some(c => c.method === 'rc.package.getDetails'), false);
});

test('沒有 keptPaths 時不顯示說明區，仍顯示完成提示', async () => {
  const { panel, card } = await start({ items: [withFailure([claudeTarget])], run: () => ({ ok: true, succeeded: [], failed: [], detached: [kept(claudeTarget, [])] }) });
  await expand(card());
  await detachButtons(card())[0].fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '已停止管理 1 個位置，檔案保留在原處');
  assert.equal(findByData(card(), 'role', 'detached-note'), null);
});

test('worker 拒絕時顯示原因並重新整理狀態', async () => {
  const { panel, card, calls } = await start({ items: [withFailure([claudeTarget])], run: () => { throw Object.assign(new Error('這個位置不能停止管理'), { code: 'detach_not_allowed' }); } });
  await expand(card());
  await detachButtons(card())[0].fire('click'); await settle();
  const lists = calls.filter(c => c.method === 'rc.catalog.list').length;
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(text(panel.get('toast')), '這個位置不能停止管理');
  assert.ok(panel.get('toast').classList.contains('error'));
  assert.equal(calls.filter(c => c.method === 'rc.catalog.list').length, lists + 1);
  assert.equal(findByData(card(), 'role', 'detached-note'), null);
});

test('明細頁：失敗清單同樣有停止管理按鈕，確認後就地更新並顯示保留路徑', async () => {
  let done = false;
  const { panel, open, runs } = await start({
    items: () => [done ? pkg('demo') : withFailure([claudeTarget], 'uninstall', { deployments: [claudeDep({ version: '1.2.0' })], tools: toolsOf(false, true) })],
    run: () => { done = true; return { ok: true, succeeded: [], failed: [], detached: [kept(claudeTarget, ['/home/a/.claude/skills/demo'])] }; } });
  await open();
  const row = panel.get('details-status-row');
  await expand(row);
  const button = detachButtons(panel.get('details-status-row'))[0];
  assert.equal(text(button), '停止管理此位置（保留檔案）');
  await button.fire('click'); await settle();
  assert.equal(text(panel.get('confirm-title')), '停止管理這個位置？');
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(runs(), [{ packageKey: 'demo', action: 'detach', targetIds: [claudeTarget.targetId] }]);
  assert.equal(hidden(panel, 'view-details'), false);
  assert.equal(text(panel.get('toast')), '已停止管理 1 個位置，檔案保留在原處');
  assert.match(text(findByData(panel.get('details-status-row'), 'role', 'detached-note')), /\/home\/a\/\.claude\/skills\/demo/);
  assert.equal(findByData(panel.get('details-status-row'), 'role', 'status-text').textContent, '未安裝');
});

// ---------- 已下架說明 ----------
const gone = (key, extra = {}) => pkg(key, { installationStatus: 'unavailable', latestVisibleVersion: null, deployments: [dep({ status: 'unavailable' })], tools: toolsOf(true), ...extra });

test('已下架：卡片與明細在狀態文字旁顯示 statusHint；沒有 statusHint 時不顯示', async () => {
  const { panel, card, open } = await start({ items: [gone('withHint', { statusHint: HINT }), gone('noHint'), installed('cur', { statusHint: HINT })] });
  assert.equal(text(findByData(card('withHint'), 'role', 'status-text')), '已下架');
  assert.equal(text(findByData(card('withHint'), 'role', 'status-hint')), HINT);
  assert.equal(findByData(card('withHint'), 'role', 'status-text').getAttribute('title'), HINT);
  assert.equal(findByData(card('noHint'), 'role', 'status-hint'), null);
  assert.equal(findByData(card('noHint'), 'role', 'status-text').getAttribute('title'), null);
  assert.equal(findByData(card('cur'), 'role', 'status-hint'), null, '只有已下架才顯示');
  await open('withHint');
  assert.equal(text(findByData(panel.get('details-status-row'), 'role', 'status-hint')), HINT);
  assert.equal(text(findByData(panel.get('details-status-row'), 'role', 'status-text')), '已下架');
});

test('點 statusHint 不影響卡片進入明細的互動（點卡片其他處仍進入）', async () => {
  const { panel, card } = await start({ items: [gone('g', { statusHint: HINT })] });
  await card('g').dispatch('click'); await settle();
  assert.equal(hidden(panel, 'view-details'), false);
});
