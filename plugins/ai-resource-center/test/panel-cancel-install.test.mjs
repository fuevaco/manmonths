// 一鍵操作進行中的「取消」：按鈕出現在卡片與明細、點擊送出 rc.install.cancel（只一次）、結果以中性提示與失敗清單呈現。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const CANCELLED = '已取消設定，尚未完成安裝';
const claudeTarget = { targetId: 'claude-code|claude-code-cli|global|/home/a/.claude', hostId: 'claude-code', label: 'Claude Code', rootPath: '/home/a/.claude' };
const pkg = (key, extra = {}) => ({ packageKey: key, name: `資源 ${key}`, type: 'skill', latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [],
  tools: [{ hostId: 'claude-code', label: 'Claude Code', deployed: false }], pendingTargets: { count: 0, targets: [] }, lastFailure: null, ...extra });
const cancelledResult = (extra = {}) => ({ ok: false, succeeded: [], failed: [{ ...claudeTarget, reason: CANCELLED, backupPaths: [] }], backups: [], ...extra });
const command = { commandId: 'init', name: '準備環境', runner: 'powershell', script: 'setup/init.ps1', arguments: [], timeoutMinutes: 5, runOnUpdate: false,
  eligibility: 'Eligible', willExecute: true, reason: 'FirstRun' };
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : null;

async function start({ items = () => [pkg('demo')], run, cancel = async () => ({ cancelled: true }) } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input, options) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)), options });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false };
    if (method === 'rc.catalog.list') return { data: items() };
    if (method === 'rc.package.getDetails') {
      const base = items().find(p => p.packageKey === input.packageKey);
      return { readme: '', selectedVersion: '1.2.0', recommendedVersion: '1.2.0', versions: [{ version: '1.2.0', channel: 'release', hosts: ['codex'] }], parameters: [], ...base };
    }
    if (method === 'rc.install.run') return run(input);
    if (method === 'rc.install.cancel') return cancel(input);
    return {};
  });
  const card = () => findByData(panel.get('catalog-list'), 'package-key', 'demo');
  const cancelButton = (root) => findByData(root, 'action', 'cancel-install');
  const cancels = () => calls.filter(c => c.method === 'rc.install.cancel').map(c => c.input);
  return { panel, calls, card, cancelButton, cancels };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('一鍵操作進行中卡片顯示「取消」，點擊只呼叫一次 rc.install.cancel 並停用；完成後按鈕消失', async () => {
  const gate = deferred();
  const { panel, card, cancelButton, cancels } = await start({ run: () => gate.promise });
  assert.equal(cancelButton(card()), null, '未執行時沒有取消按鈕');
  const clicking = findByData(card(), 'action', 'install').fire('click');
  await settle();
  const cancel = cancelButton(card());
  assert.ok(cancel, '進行中顯示取消');
  assert.equal(text(cancel), '取消');
  assert.equal(cancel.disabled, false);
  assert.equal(text(findByData(card(), 'action', 'install')), '安裝中…');
  assert.ok(findByData(findByData(card(), 'slot', 'card-actions'), 'action', 'cancel-install'), '取消放在進行中按鈕旁');

  await cancel.fire('click'); await settle();
  assert.deepEqual(cancels(), [{ packageKey: 'demo' }]);
  assert.equal(cancelButton(card()).disabled, true, '送出後停用避免重複點擊');
  await cancelButton(card()).fire('click'); await settle();
  assert.equal(cancels().length, 1, '停用後再點不會重複送出');

  gate.resolve(cancelledResult());
  await clicking; await settle();
  assert.equal(cancelButton(card()), null, '完成後取消按鈕消失');
  assert.equal(findAllByData(panel.get('catalog-list'), 'action', 'cancel-install').length, 0);
});

test('取消後全部目標都是取消狀態：中性訊息「已取消安裝」而非失敗，失敗清單保留原因並可重試失敗項目', async () => {
  const gate = deferred();
  let state = pkg('demo');
  const { panel, card, cancelButton } = await start({ items: () => [state], run: (input) => input.action === 'retry' ? ({ ok: true, succeeded: [claudeTarget], failed: [], backups: [] }) : gate.promise });
  const clicking = findByData(card(), 'action', 'install').fire('click'); await settle();
  await cancelButton(card()).fire('click'); await settle();
  state = pkg('demo', { lastFailure: { targets: [{ ...claudeTarget, reason: CANCELLED }] } });
  gate.resolve(cancelledResult());
  await clicking; await settle();
  assert.equal(text(panel.get('toast')), '已取消安裝');
  assert.equal(panel.get('toast').classList.contains('error'), false, '不是紅色錯誤');
  assert.ok(panel.get('toast').classList.contains('info'));
  const list = findByData(card(), 'role', 'failure-list');
  assert.ok(list, '失敗清單仍展開');
  assert.match(text(findByData(list, 'role', 'failure-target')), new RegExp(CANCELLED));
  assert.ok(findByData(list, 'action', 'retry'), '可重試失敗項目');
});

test('部分成功、部分取消時沿用失敗呈現', async () => {
  const { panel, card } = await start({ run: () => cancelledResult({ succeeded: [{ ...claudeTarget, targetId: 'other' }] }) });
  await findByData(card(), 'action', 'install').fire('click'); await settle();
  assert.ok(panel.get('toast').classList.contains('error'));
  assert.match(text(panel.get('toast')), /1 個位置失敗/);
});

test('明細的狀態列也顯示取消並共用同一個請求', async () => {
  const gate = deferred();
  const { panel, card, cancelButton, cancels } = await start({ run: () => gate.promise });
  await card().fire('click'); await settle();
  const row = () => panel.get('details-status-row');
  const clicking = findByData(row(), 'action', 'install').fire('click'); await settle();
  assert.equal(text(findByData(row(), 'action', 'running') ?? findByData(row(), 'action', 'install')), '安裝中…');
  const cancel = cancelButton(row());
  assert.ok(cancel);
  await cancel.fire('click'); await settle();
  assert.deepEqual(cancels(), [{ packageKey: 'demo' }]);
  assert.equal(cancelButton(row()).disabled, true);
  gate.resolve(cancelledResult());
  await clicking; await settle();
  assert.equal(cancelButton(row()), null);
});

test('取消請求失敗：顯示錯誤並可再按；回報沒有可取消的操作時也允許再試', async () => {
  const gate = deferred();
  let reply = () => { throw Object.assign(new Error('暫時無法取消'), { code: 'internal_error' }); };
  const { panel, card, cancelButton, cancels } = await start({ run: () => gate.promise, cancel: () => reply() });
  const clicking = findByData(card(), 'action', 'install').fire('click'); await settle();
  await cancelButton(card()).fire('click'); await settle();
  assert.ok(panel.get('toast').classList.contains('error'));
  assert.equal(cancelButton(card()).disabled, false);
  reply = async () => ({ cancelled: false });
  await cancelButton(card()).fire('click'); await settle();
  assert.equal(cancelButton(card()).disabled, false, 'cancelled:false 表示目前沒有可取消的設定命令，保留按鈕');
  assert.equal(cancels().length, 2);
  gate.resolve({ ok: true, succeeded: [claudeTarget], failed: [], backups: [] });
  await clicking; await settle();
  assert.equal(cancelButton(card()), null);
});

test('確認層確認後執行中：「取消」按鈕改為可取消安裝，送出 rc.install.cancel', async () => {
  const gate = deferred();
  const confirmation = { needsConfirmation: true, reasons: ['setupCommands'], allBlocked: false, planId: 'p1', plan: { deployableCount: 1, blockedTargets: [], setupCommands: [command], missingParameters: [] } };
  const { panel, card, cancels } = await start({ run: (input) => input.confirmedPlanId ? gate.promise : confirmation });
  await findByData(card(), 'action', 'install').fire('click'); await settle();
  assert.equal(text(panel.get('confirm-cancel')), '取消');
  const confirming = panel.get('confirm-primary').fire('click'); await settle();
  assert.equal(panel.get('confirm-primary').disabled, true);
  assert.equal(text(panel.get('confirm-cancel')), '取消安裝');
  assert.equal(panel.get('confirm-cancel').disabled, false);
  await panel.get('confirm-cancel').fire('click'); await settle();
  assert.deepEqual(cancels(), [{ packageKey: 'demo' }]);
  assert.equal(panel.get('confirm-cancel').disabled, true);
  assert.equal(panel.get('confirm-layer').classList.contains('hidden'), false, '結果回來前確認層不關閉');
  gate.resolve(cancelledResult());
  await confirming; await settle();
  assert.equal(panel.get('confirm-layer').classList.contains('hidden'), true);
  assert.equal(text(panel.get('toast')), '已取消安裝');
});
