// 工項 09～12 面板端（ADR-0003）：卡片與明細的一鍵安裝／更新／補裝按鈕、例外確認層、結果短提示、
// 失敗清單與只重試失敗、明細的設定參數區塊。worker 以替身回應，驗證面板送出的 rc.install.* 請求與畫面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, textOf, detailsOf, findByData, findAllByData, panelSource } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const dep = (extra = {}) => ({ id: 'codex|codex-cli|global|/home/a/.codex', hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', rootPath: '/home/a/.codex',
  version: '1.0.0', channel: 'release', status: 'current', updateVersion: null, label: 'Codex', backupPaths: [], ...extra });
const toolsOf = (codex = false, claude = false) => [{ hostId: 'codex', label: 'Codex', deployed: codex }, { hostId: 'claude-code', label: 'Claude Code', deployed: claude }];
const claudeTarget = { targetId: 'claude-code|claude-code-cli|global|/home/a/.claude', hostId: 'claude-code', label: 'Claude Code', rootPath: '/home/a/.claude' };
const pkg = (key, extra = {}) => ({ packageKey: key, name: `資源 ${key}`, type: 'skill', latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [],
  tools: toolsOf(), pendingTargets: { count: 0, targets: [] }, lastFailure: null, ...extra });
const installed = (key, extra = {}) => pkg(key, { installationStatus: 'current', deployments: [dep({ version: '1.2.0' })], tools: toolsOf(true), ...extra });
const ok = (n, extra = {}) => ({ ok: true, succeeded: Array.from({ length: n }, (_, i) => ({ ...claudeTarget, targetId: `t${i}` })), failed: [], backups: [], ...extra });
const confirmation = (reasons, plan, extra = {}) => ({ needsConfirmation: true, reasons, allBlocked: false, planId: 'p1',
  plan: { deployableCount: 1, blockedTargets: [], setupCommands: [], missingParameters: [], ...plan }, ...extra });
const command = { commandId: 'init', name: '準備環境', runner: 'powershell', script: 'setup/init.ps1', arguments: ['-Mode', 'short'], timeoutMinutes: 5, runOnUpdate: false,
  eligibility: 'Eligible', willExecute: true, reason: 'FirstRun' };

async function start({ items = [pkg('demo')], detail, run = async () => ok(1), saveSetup = async () => ({ parameters: [] }), handler } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input, options) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)), options });
    const custom = handler && await handler(method, input);
    if (custom !== undefined) return custom;
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false };
    if (method === 'rc.catalog.list') return { data: typeof items === 'function' ? items() : items };
    if (method === 'rc.package.getDetails') {
      const list = typeof items === 'function' ? items() : items;
      const base = list.find(p => p.packageKey === input.packageKey);
      return { readme: '', selectedVersion: '1.2.0', recommendedVersion: '1.2.0', versions: [{ version: '1.2.0', channel: 'release', hosts: ['codex'] }], parameters: [],
        ...base, ...(typeof detail === 'function' ? detail(input) : detail) };
    }
    if (method === 'rc.install.run') return run(input);
    if (method === 'rc.install.saveSetup') return saveSetup(input);
    return {};
  });
  const card = (key = 'demo') => findByData(panel.get('catalog-list'), 'package-key', key);
  const action = (root, name) => findByData(root, 'action', name);
  const open = async (key = 'demo') => { await card(key).fire('click'); await settle(); };
  const runs = () => calls.filter(c => c.method === 'rc.install.run').map(c => c.input);
  return { panel, calls, card, action, open, runs };
}
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : null;
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');
const mainActions = (node) => findAllByData(node, 'action').map(n => n.getAttribute('data-action')).filter(a => ['install', 'update', 'fill-pending'].includes(a));
const status = (node) => text(findByData(node, 'role', 'status-text'));
const param = (panel, id) => findByData(panel.get('confirm-body'), 'param', id);

test('卡片主要按鈕：未安裝「安裝」、可更新「更新」、有待補裝目標「補裝」；已是最新、較新、已下架不顯示', async () => {
  const pending = { count: 2, targets: [claudeTarget, { ...claudeTarget, targetId: 'work', rootPath: '/home/a/.claude-work' }] };
  const { card, action } = await start({ items: [
    pkg('none'),
    pkg('upd', { installationStatus: 'updateAvailable', deployments: [dep({ status: 'updateAvailable', updateVersion: '1.2.0' })], tools: toolsOf(true), pendingTargets: { count: 1, targets: [claudeTarget] } }),
    installed('pend', { pendingTargets: pending }),
    installed('cur'),
    pkg('new', { installationStatus: 'newer', deployments: [dep({ version: '2.0.0', status: 'newer' })], tools: toolsOf(true) }),
    pkg('gone', { installationStatus: 'unavailable', latestVisibleVersion: null, deployments: [dep({ status: 'unavailable' })], tools: toolsOf(true) })
  ] });
  assert.deepEqual(['none', 'upd', 'pend', 'cur', 'new', 'gone'].map(k => mainActions(card(k))), [['install'], ['update'], ['fill-pending'], [], [], []]);
  assert.deepEqual(['none', 'upd', 'pend'].map(k => text(action(card(k), k === 'none' ? 'install' : k === 'upd' ? 'update' : 'fill-pending'))), ['安裝', '更新', '補裝']);
  assert.equal(status(card('upd')), '可更新 1.0.0 → 1.2.0', '同時有待補裝目標時仍顯示可更新');
  assert.equal(status(card('pend')), '已安裝 1.2.0 · 2 個新位置');
  assert.equal(findByData(card('pend'), 'tool', 'claude-code').getAttribute('data-deployed'), 'false', '待補裝工具的圖示維持灰色');
  assert.ok(findByData(findByData(card('none'), 'slot', 'card-actions'), 'action', 'install'), '按鈕放在狀態列右側預留的位置');
});

test('按「安裝」不進入明細；執行中停用並顯示「安裝中…」且不能重複觸發；成功後短提示並就地更新狀態', async () => {
  let release, done = false;
  const { panel, calls, card, action, runs } = await start({ items: () => [done ? installed('demo') : pkg('demo')], run: () => new Promise(resolve => { release = resolve; }) });
  const clicking = action(card(), 'install').dispatch('click'); // 冒泡到卡片也不會進入明細
  await settle();
  assert.deepEqual(runs(), [{ packageKey: 'demo', action: 'install' }]);
  assert.equal(hidden(panel, 'view-details'), true);
  assert.equal(calls.some(c => c.method === 'rc.package.getDetails'), false);
  const busy = action(card(), 'install');
  assert.equal(busy.disabled, true);
  assert.equal(text(busy), '安裝中…');
  await busy.fire('click');
  assert.equal(runs().length, 1, '同一資源包執行中不重複送出');

  panel.get('view-main').scrollTop = 180;
  const lists = calls.filter(c => c.method === 'rc.catalog.list').length;
  done = true;
  release(ok(2));
  await clicking; await settle();
  assert.equal(hidden(panel, 'toast'), false);
  assert.equal(text(panel.get('toast')), '已安裝到 2 個位置');
  assert.equal(calls.filter(c => c.method === 'rc.catalog.list').length, lists + 1, '重新讀取狀態');
  assert.equal(panel.get('view-main').scrollTop, 180, '清單不跳回頂端');
  assert.equal(status(card()), '已安裝 1.2.0');
  assert.deepEqual(mainActions(card()), []);
  await panel.timeouts.fireAll();
  assert.equal(hidden(panel, 'toast'), true, '幾秒後短提示消失');
});

test('「更新」與「補裝」送出對應的一鍵動作與成功提示', async () => {
  const items = [pkg('upd', { installationStatus: 'updateAvailable', deployments: [dep({ status: 'updateAvailable', updateVersion: '1.2.0' })], tools: toolsOf(true) }),
    installed('pend', { pendingTargets: { count: 2, targets: [claudeTarget, claudeTarget] } })];
  const { panel, card, action, runs } = await start({ items, run: (input) => ok(input.action === 'update' ? 1 : 2) });
  await action(card('upd'), 'update').fire('click'); await settle();
  assert.deepEqual(runs().at(-1), { packageKey: 'upd', action: 'update' });
  assert.equal(text(panel.get('toast')), '已更新 1 個位置');
  await action(card('pend'), 'fill-pending').fire('click'); await settle();
  assert.deepEqual(runs().at(-1), { packageKey: 'pend', action: 'fillPending' });
  assert.equal(text(panel.get('toast')), '已補裝到 2 個位置');
});

test('受阻目標：確認層列出友善名稱、根目錄與原因及其餘部署目標數；取消不套用，確認後帶 confirmedPlanId', async () => {
  const blocked = { ...claudeTarget, reason: '目的地已由資源包 other 管理' };
  const { panel, card, action, runs } = await start({ run: (input) => input.confirmedPlanId ? ok(1) : confirmation(['blockedTargets'], { blockedTargets: [blocked] }) });
  await action(card(), 'install').fire('click'); await settle();
  assert.equal(hidden(panel, 'confirm-layer'), false);
  const body = panel.get('confirm-body');
  assert.ok(findByData(body, 'section', 'blockedTargets'));
  assert.equal(findByData(body, 'section', 'missingParameters'), null);
  assert.equal(findByData(body, 'section', 'setupCommands'), null);
  const row = findByData(body, 'role', 'blocked-target');
  assert.match(text(row), /Claude Code/);
  assert.match(text(row), /\/home\/a\/\.claude/);
  assert.match(text(row), /目的地已由資源包 other 管理/);
  assert.equal(findByData(row, 'tool').getAttribute('data-tool'), 'claude-code');
  assert.match(text(body), /其餘 1 個位置仍會安裝/);
  assert.equal(text(panel.get('confirm-primary')), '安裝到其餘 1 個位置');
  assert.equal(text(panel.get('confirm-cancel')), '取消');
  assert.match(text(panel.get('confirm-title')), /資源 demo/);
  await action(card(), 'install').fire('click');
  assert.equal(runs().length, 1, '確認層開啟時不重複觸發');

  await panel.get('confirm-cancel').fire('click');
  assert.equal(hidden(panel, 'confirm-layer'), true);
  assert.equal(runs().length, 1);

  await action(card(), 'install').fire('click'); await settle();
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(runs().at(-1), { packageKey: 'demo', action: 'install', confirmedPlanId: 'p1' });
  assert.equal(hidden(panel, 'confirm-layer'), true);
  assert.equal(text(panel.get('toast')), '已安裝到 1 個位置');
});

test('全部受阻：只顯示原因與「關閉」，沒有主要按鈕', async () => {
  const reasons = [{ ...claudeTarget, reason: '原因一' }, { ...claudeTarget, targetId: 'x', hostId: 'codex', label: 'Codex', rootPath: '/home/a/.codex', reason: '原因二' }];
  const { panel, card, action, runs } = await start({ run: () => ({ needsConfirmation: false, allBlocked: true, planId: null, reasons: ['blockedTargets'],
    plan: { deployableCount: 0, blockedTargets: reasons, setupCommands: [], missingParameters: [] } }) });
  await action(card(), 'install').fire('click'); await settle();
  assert.equal(hidden(panel, 'confirm-layer'), false);
  assert.match(text(panel.get('confirm-title')), /無法安裝/);
  assert.match(text(panel.get('confirm-body')), /原因一.*原因二/);
  assert.doesNotMatch(text(panel.get('confirm-body')), /仍會安裝/);
  assert.equal(hidden(panel, 'confirm-primary'), true);
  assert.equal(text(panel.get('confirm-cancel')), '關閉');
  await panel.get('confirm-cancel').fire('click');
  assert.equal(hidden(panel, 'confirm-layer'), true);
  assert.equal(runs().length, 1);
  assert.equal(text(action(card(), 'install')), '安裝');
  assert.equal(action(card(), 'install').disabled, false);
});

test('設定命令：列出用途與命令；確認時本機狀態改變則更新確認層內容，再次確認才套用', async () => {
  const replanned = confirmation(['setupCommands', 'blockedTargets'], { setupCommands: [command], blockedTargets: [{ ...claudeTarget, reason: '受管內容被移除' }] }, { planId: 'p2' });
  const { panel, calls, card, action, runs } = await start({ run: (input) => input.confirmedPlanId === 'p2' ? ok(1)
    : input.confirmedPlanId === 'p1' ? replanned : confirmation(['setupCommands'], { setupCommands: [command, { ...command, commandId: 'skip', name: '略過的命令', willExecute: false, reason: 'SkippedAlreadySucceeded' }] }) });
  await action(card(), 'install').fire('click'); await settle();
  const body = panel.get('confirm-body');
  const commands = findAllByData(body, 'role', 'setup-command');
  assert.match(text(commands[0]), /準備環境/);
  assert.match(text(commands[0]), /powershell setup\/init\.ps1 -Mode short/);
  assert.match(text(body), /略過的命令/);
  assert.equal(findByData(body, 'section', 'blockedTargets'), null);

  await panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(runs().at(-1), { packageKey: 'demo', action: 'install', confirmedPlanId: 'p1' });
  assert.ok(calls.filter(c => c.method === 'rc.install.run').at(-1).options.timeoutMs >= 5 * 60000, '請求逾時涵蓋設定命令時間');
  assert.equal(hidden(panel, 'confirm-layer'), false, '重新規劃後仍有例外：留在確認層');
  assert.match(text(panel.get('confirm-body')), /本機狀態已改變/);
  assert.ok(findByData(panel.get('confirm-body'), 'section', 'blockedTargets'));
  assert.match(text(panel.get('confirm-body')), /受管內容被移除/);
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(runs().at(-1), { packageKey: 'demo', action: 'install', confirmedPlanId: 'p2' });
  assert.equal(hidden(panel, 'confirm-layer'), true);
});

test('缺少參數：表單沿用設定參數輸入元件，秘密用 password；必填驗證，儲存後確認；同一批命令不再重複詢問', async () => {
  const missing = [
    { parameterId: 'endpoint', label: '服務網址', type: 'string', required: true, visible: true, isSecret: false, needsInput: true, value: null, options: [], source: 'Unset' },
    { parameterId: 'region', label: '區域', type: 'choice', required: true, visible: true, isSecret: false, needsInput: true, value: null, options: [{ value: 'north', label: 'North' }, { value: 'south', label: 'South' }] },
    { parameterId: 'token', label: 'API 金鑰', type: 'secret', required: true, visible: true, isSecret: true, isSet: false, needsInput: true, options: [] }];
  const { panel, calls, card, action, runs } = await start({ run: (input) => input.confirmedPlanId === 'p2' ? ok(1)
    : input.confirmedPlanId === 'p1' ? confirmation(['setupCommands'], { setupCommands: [{ ...command, arguments: ['-Mode', 'edited'] }] }, { planId: 'p2' })
      : confirmation(['missingParameters', 'setupCommands'], { missingParameters: missing, setupCommands: [command] }) });
  await action(card(), 'install').fire('click'); await settle();
  assert.ok(findByData(panel.get('confirm-body'), 'section', 'missingParameters'));
  assert.equal(param(panel, 'token').type, 'password');
  assert.equal(param(panel, 'token').value, '');
  assert.deepEqual(param(panel, 'region').children.map(o => [o.value, o.textContent]), [['', '請選擇'], ['north', 'North'], ['south', 'South']]);
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.match(text(panel.get('confirm-error')), /請填寫「服務網址」/);
  assert.equal(calls.some(c => c.method === 'rc.install.saveSetup'), false);

  param(panel, 'endpoint').value = ' https://synthetic.example ';
  param(panel, 'region').value = 'south';
  param(panel, 'token').value = 'canary-panel-token';
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(calls.find(c => c.method === 'rc.install.saveSetup').input, { packageKey: 'demo', values: { endpoint: 'https://synthetic.example', region: 'south' }, secrets: { token: 'canary-panel-token' } });
  assert.deepEqual(runs().map(r => r.confirmedPlanId), [undefined, 'p1', 'p2'], '儲存參數造成的重新規劃沿用已確認的命令');
  assert.equal(param(panel, 'token')?.value ?? '', '');
  assert.equal(hidden(panel, 'confirm-layer'), true);
  assert.doesNotMatch(text(panel.get('view-main')), /canary-panel-token/);
});

test('選填的 PAT 可以留空、儲存或移除，而且安裝時不回顯', async () => {
  const field = { parameterId: 'tfs-pat', label: 'PAT', type: 'secret', isSecret: true,
    required: false, visible: true, secretUsage: 'setup-and-runtime' };
  for (const mode of ['ad', 'pat', 'clear']) {
    const { panel, calls, card, action } = await start({ run: input => input.confirmedPlanId ? ok(1)
      : confirmation(['setupCommands'], { setupCommands: [command], optionalParameters: [{ ...field, isSet: mode === 'clear' }] }) });
    await action(card(), 'install').fire('click'); await settle();
    assert.equal(param(panel, 'tfs-pat').type, 'password');
    if (mode === 'pat') param(panel, 'tfs-pat').value = 'synthetic-token';
    if (mode === 'clear') {
      const clear = findByData(panel.get('confirm-body'), 'param-row', 'tfs-pat').children
        .flatMap(child => child.children).find(child => child.type === 'checkbox');
      assert.ok(clear);
      clear.checked = true;
    }
    await panel.get('confirm-primary').fire('click'); await settle();
    const saved = calls.find(c => c.method === 'rc.install.saveSetup');
    assert.deepEqual(saved?.input.secrets, mode === 'ad' ? undefined : { 'tfs-pat': mode === 'pat' ? 'synthetic-token' : null });
    assert.equal(hidden(panel, 'confirm-layer'), true);
  }
});

test('有失敗：卡片顯示紅色「N 個位置失敗」，點開精簡清單（工具、名稱、根目錄、原因、備份），只重試失敗項目', async () => {
  let fixed = false;
  const failure = { count: 1, targets: [{ ...claudeTarget, reason: '寫入失敗，已完整還原', backupPaths: ['/home/a/.claude/skills/hello.bak-lcaipack-1'] }] };
  const { panel, card, action, runs } = await start({ items: () => [installed('demo', { lastFailure: fixed ? null : failure })],
    run: () => { fixed = true; return ok(1); } });
  const badge = findByData(card(), 'role', 'failure');
  assert.equal(text(badge), '1 個位置失敗');
  assert.ok(badge.classList.contains('failure-badge'));
  assert.equal(findByData(card(), 'role', 'failure-list'), null, '預設收合');
  await badge.fire('click');
  const list = findByData(card(), 'role', 'failure-list');
  const row = findByData(list, 'role', 'failure-target');
  assert.equal(findByData(row, 'tool').getAttribute('data-tool'), 'claude-code');
  assert.match(text(row), /Claude Code.*\/home\/a\/\.claude.*寫入失敗，已完整還原/);
  const backups = detailsOf(list).find(d => /備份位置/.test(d.summary));
  assert.match(backups.body, /hello\.bak-lcaipack-1/);
  await action(list, 'retry').fire('click'); await settle();
  assert.deepEqual(runs().at(-1), { packageKey: 'demo', action: 'retry', targetIds: [claudeTarget.targetId] });
  assert.equal(text(panel.get('toast')), '已重新安裝到 1 個位置');
  assert.equal(findByData(card(), 'role', 'failure'), null, '全部成功後不再顯示失敗');
});

test('失敗清單：有原始部署問題時提供預設收合的「詳細紀錄」（原因文字會請使用者展開查看）', async () => {
  const detail = [{ code: 'deployment.apply-failed', severity: 'Blocking', summary: 'Target apply failed', explanation: "EPERM: operation not permitted, mkdir 'C:\home\.claude\skills\demo'" }];
  const failure = { count: 2, targets: [
    { ...claudeTarget, reason: '這個位置安裝失敗，已還原本次變更，請展開詳細紀錄查看原因', detail },
    { ...claudeTarget, targetId: 'other', reason: '原部署目標已消失' }] };
  const { card } = await start({ items: () => [installed('demo', { lastFailure: failure })] });
  await findByData(card(), 'role', 'failure').fire('click');
  const rows = findAllByData(findByData(card(), 'role', 'failure-list'), 'role', 'failure-target');
  const fold = findByData(rows[0], 'role', 'failure-detail');
  assert.ok(fold, '有 detail 時提供詳細紀錄');
  assert.notEqual(fold.open, true, '預設收合');
  const [entry] = detailsOf(rows[0]).filter(d => /詳細紀錄/.test(d.summary));
  assert.match(entry.body, /Target apply failed/);
  assert.match(entry.body, /EPERM: operation not permitted/);
  assert.equal(findByData(rows[1], 'role', 'failure-detail'), null, '沒有 detail 時不顯示');
});

test('套用後有失敗：提示失敗數量並自動展開該資源包的失敗清單', async () => {
  let failed = false;
  const failure = { count: 1, targets: [{ ...claudeTarget, reason: "設定命令 '準備環境' 未成功" }] };
  const { panel, card } = await start({ items: () => [failed ? installed('demo', { lastFailure: failure }) : pkg('demo')],
    run: () => { failed = true; return { ok: false, succeeded: [{ ...claudeTarget, targetId: 'a' }], failed: failure.targets, backups: [] }; } });
  await findByData(card(), 'action', 'install').fire('click'); await settle();
  assert.match(text(panel.get('toast')), /已安裝到 1 個位置，1 個位置失敗/);
  assert.ok(panel.get('toast').classList.contains('error'));
  assert.match(text(findByData(card(), 'role', 'failure-list')), /設定命令 '準備環境' 未成功/);
});

test('明細頁：狀態列同樣有主要按鈕與失敗提示；更新後留在明細並重新讀取狀態', async () => {
  let updated = false;
  const failure = { count: 1, targets: [{ ...claudeTarget, reason: '寫入失敗' }] };
  const item = () => updated ? installed('demo') : pkg('demo', { installationStatus: 'updateAvailable', deployments: [dep({ status: 'updateAvailable', updateVersion: '1.2.0' })], tools: toolsOf(true), lastFailure: failure });
  const { panel, calls, open, runs } = await start({ items: () => [item()], run: () => { updated = true; return ok(1); } });
  await open();
  const row = panel.get('details-status-row');
  assert.equal(text(findByData(row, 'role', 'failure')), '1 個位置失敗');
  await findByData(row, 'role', 'failure').fire('click');
  assert.match(text(findByData(row, 'role', 'failure-list')), /寫入失敗/);
  const details = calls.filter(c => c.method === 'rc.package.getDetails').length;
  await findByData(row, 'action', 'update').fire('click'); await settle();
  assert.deepEqual(runs().at(-1), { packageKey: 'demo', action: 'update' });
  assert.equal(hidden(panel, 'view-details'), false);
  assert.equal(calls.filter(c => c.method === 'rc.package.getDetails').length, details + 1);
  assert.equal(status(panel.get('details-status-row')), '已安裝 1.2.0');
  assert.equal(findByData(panel.get('details-status-row'), 'role', 'failure'), null);
  assert.equal(text(panel.get('toast')), '已更新 1 個位置');
});

const parameters = [
  { parameterId: 'endpoint', label: '服務網址', type: 'string', required: true, visible: true, isSecret: false, needsInput: false, value: 'https://old.example', source: 'Global', options: [] },
  { parameterId: 'verbose', label: '詳細紀錄', type: 'boolean', required: false, visible: true, isSecret: false, needsInput: false, value: 'false', source: 'ManifestDefault', options: [] },
  { parameterId: 'token', label: 'API 金鑰', type: 'secret', required: true, visible: true, isSecret: true, isSet: true, needsInput: false, options: [] },
  { parameterId: 'hidden', label: '隱藏參數', type: 'string', required: false, visible: false, isSecret: false, needsInput: false, value: 'x', options: [] }];

test('設定參數區塊：預設收合列出目前值，秘密只顯示「已設定」；儲存並重新套用', async () => {
  const { panel, calls, open, runs } = await start({ items: [installed('demo')], detail: { parameters }, run: () => ok(2) });
  await open();
  const section = findByData(panel.get('details-setup'), 'role', 'setup');
  assert.equal(section.tagName, 'details');
  assert.notEqual(section.open, true, '預設收合');
  assert.equal(detailsOf(panel.get('details-setup'))[0].summary, '設定參數');
  const field = (id) => findByData(section, 'param', id);
  assert.equal(field('endpoint').value, 'https://old.example');
  assert.equal(field('verbose').checked, false);
  assert.equal(field('token').type, 'password');
  assert.equal(field('token').value, '');
  assert.match(text(findByData(section, 'param-row', 'token')), /已設定/);
  assert.equal(field('hidden'), null);
  assert.doesNotMatch(text(section), /隱藏參數/);

  field('endpoint').value = 'https://new.example';
  field('verbose').checked = true;
  await findByData(section, 'action', 'save-setup').fire('click'); await settle();
  assert.deepEqual(calls.find(c => c.method === 'rc.install.saveSetup').input, { packageKey: 'demo', values: { endpoint: 'https://new.example', verbose: true }, secrets: {} }, '秘密空白表示不變');
  assert.deepEqual(runs().at(-1), { packageKey: 'demo', action: 'reapply' });
  assert.equal(text(panel.get('toast')), '已重新套用到 2 個位置');

  const again = findByData(panel.get('details-setup'), 'role', 'setup');
  findByData(again, 'param', 'token').value = 'canary-new-secret';
  await findByData(again, 'action', 'save-setup').fire('click'); await settle();
  assert.deepEqual(calls.filter(c => c.method === 'rc.install.saveSetup').at(-1).input.secrets, { token: 'canary-new-secret' });
  assert.equal(findByData(findByData(panel.get('details-setup'), 'role', 'setup'), 'param', 'token').value, '');
  assert.doesNotMatch(text(panel.get('view-details')), /canary-new-secret/);
});

test('設定參數：必填空白不儲存；重新套用遇到例外顯示確認層；沒有參數時不顯示區塊，讀取失敗時說明原因', async () => {
  const { panel, calls, open, runs } = await start({ items: [installed('demo')], detail: { parameters },
    run: (input) => input.confirmedPlanId ? ok(1) : confirmation(['setupCommands'], { setupCommands: [command] }) });
  await open();
  const section = findByData(panel.get('details-setup'), 'role', 'setup');
  findByData(section, 'param', 'endpoint').value = '  ';
  await findByData(section, 'action', 'save-setup').fire('click'); await settle();
  assert.match(text(findByData(section, 'role', 'setup-error')), /請填寫「服務網址」/);
  assert.equal(calls.some(c => c.method === 'rc.install.saveSetup'), false);
  findByData(section, 'param', 'endpoint').value = 'https://new.example';
  await findByData(section, 'action', 'save-setup').fire('click'); await settle();
  assert.equal(hidden(panel, 'confirm-layer'), false);
  assert.equal(text(panel.get('confirm-primary')), '重新套用');
  await panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(runs().at(-1), { packageKey: 'demo', action: 'reapply', confirmedPlanId: 'p1' });

  const none = await start({ items: [installed('demo')] });
  await none.open();
  assert.equal(findByData(none.panel.get('details-setup'), 'role', 'setup'), null);
  const broken = await start({ items: [installed('demo')], detail: { parameters: [], parametersError: { code: 'invalid_package', message: '資源包格式錯誤' } } });
  await broken.open();
  assert.match(text(broken.panel.get('details-setup')), /設定參數無法讀取：資源包格式錯誤/);
});

test('舊安裝區已移除：沒有範圍、專案路徑、目標勾選、更新所選目標與部署摘要，也不呼叫 rc.deploy.*', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const js = await panelSource();
  for (const gone of ['install-scope', 'install-project', 'install-detect', 'install-target', 'details-update', 'install-plan', 'install-summary', 'install-confirm',
    'install-result', 'install-retry', 'install-done', '產生部署摘要', '更新所選目標', '本機專案', '讀取專案目標', '勾選部署目標']) {
    assert.ok(!html.includes(gone) && !js.includes(gone), `不應再有 ${gone}`);
  }
  assert.doesNotMatch(js, /rc\.deploy\./);
  const { calls, card, action, open } = await start();
  await action(card(), 'install').fire('click'); await settle();
  await open();
  assert.equal(calls.some(c => c.method.startsWith('rc.deploy.')), false);
});
