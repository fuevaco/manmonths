// 工項 15：只重試失敗的部署目標（對照 LC-AI-Pack BrowseViewModel.RetryFailedTargetsAsync 與 HasFailedTargets）。
// 失敗＝failed／rolledBack／rollbackIncomplete／stale；全部成功或全部受阻（skipped）不顯示按鈕。
// 重試只把失敗的目標重新規劃，回到部署摘要，需再確認一次才套用；已成功的目標不再送出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startPanel, settle, textOf } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const item = { packageKey: 'demo', name: '合成包', type: 'skill', latestVisibleVersion: '1.0.0' };
const mk = (host, surface, root) => ({ id: `${host}|${surface}|project|${root}`, label: `${host} 本機專案`, rootPath: root, projectRoot: root, canonicalRoot: root, scope: 'project' });
const codex = mk('codex', 'codex-cli', '/work/one'), claude = mk('claude-code', 'claude-code-cli', '/work/one');
const planFor = (digest, ids) => ({ planDigest: digest, canApply: true, package: { packageKey: 'demo', name: '合成包', version: '1.0.0', channel: 'release' },
  deployableCount: ids.length, blockedCount: 0, targets: ids.map(id => ({ id, label: id, rootPath: id, canApply: true, changes: [], problems: [] })), problems: [] });
const res = (t, status, problems = []) => ({ id: t.id, label: t.label, status, writtenPaths: [], backupPaths: [], problems });

async function open(applies) {
  const calls = [];
  const queue = [...applies];
  let planNo = 0;
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.package.getDetails') return { ...item, selectedVersion: '1.0.0', readme: '', versions: [{ version: '1.0.0', channel: 'release', hosts: ['codex'] }], deployments: [] };
    if (method === 'rc.deploy.listTargets') return { targets: [codex, claude] };
    if (method === 'rc.deploy.plan') return planFor(`d${++planNo}`, input.targets);
    if (method === 'rc.deploy.apply') return queue.shift();
  });
  await panel.get('catalog-list').children[0].children.at(-1).fire('click');
  await settle();
  panel.get('install-scope').value = 'project'; await panel.get('install-scope').fire('change'); await settle();
  for (const label of panel.get('install-target').children) { label.children[0].checked = true; await label.children[0].fire('change'); }
  return { panel, calls };
}
const shown = (panel) => !panel.get('install-retry').classList.contains('hidden');
const install = async (panel) => { await panel.get('install-plan').fire('click'); await panel.get('install-confirm').fire('click'); };

test('有目標失敗時結果畫面除了「完成」還有「只重試失敗的目標」', async () => {
  const { panel } = await open([{ status: 'partial', problems: [], targets: [res(codex, 'succeeded'), res(claude, 'rolledBack', [{ severity: 'Blocking', summary: '寫入失敗' }])] }]);
  await install(panel);
  assert.equal(shown(panel), true);
  assert.equal(panel.get('install-done').classList.contains('hidden'), false);
  assert.match(readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8'), /id="install-retry"[^>]*>只重試失敗的目標</);
});

for (const failedStatus of ['failed', 'rolledBack', 'rollbackIncomplete']) {
  test(`目標狀態 ${failedStatus} 算失敗，顯示重試按鈕`, async () => {
    const { panel } = await open([{ status: 'partial', problems: [], targets: [res(codex, 'succeeded'), res(claude, failedStatus)] }]);
    await install(panel);
    assert.equal(shown(panel), true);
  });
}

test('全部成功或全部受阻時不顯示重試按鈕', async () => {
  let { panel } = await open([{ status: 'succeeded', problems: [], targets: [res(codex, 'succeeded'), res(claude, 'succeeded')] }]);
  await install(panel);
  assert.equal(shown(panel), false);
  ({ panel } = await open([{ status: 'failed', problems: [], targets: [res(codex, 'skipped'), res(claude, 'skipped')] }]));
  await install(panel);
  assert.equal(shown(panel), false);
});

test('按下重試：只對失敗的目標重新產生部署摘要，需再確認一次才套用，已成功的目標不再送出', async () => {
  const { panel, calls } = await open([
    { status: 'partial', problems: [], targets: [res(codex, 'succeeded'), res(claude, 'rolledBack')] },
    { status: 'succeeded', problems: [], targets: [res(claude, 'succeeded')] }]);
  await install(panel);
  await panel.get('install-retry').fire('click');
  const plans = calls.filter(c => c.method === 'rc.deploy.plan');
  assert.deepEqual(plans.at(-1).input.targets, [claude.id], '只重新規劃失敗的目標');
  assert.equal(calls.filter(c => c.method === 'rc.deploy.apply').length, 1, '重新規劃後不得自動套用');
  assert.match(textOf(panel.get('install-summary')), /部署摘要/);
  assert.match(panel.get('install-status').textContent, /失敗的目標.*重新確認/);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), false);
  assert.equal(shown(panel), false, '回到部署摘要後不顯示重試');
  assert.equal(panel.get('install-result').children.length, 0);
  assert.deepEqual(panel.get('install-target').children.map(l => l.children[0].checked), [false, true]);

  await panel.get('install-confirm').fire('click');
  assert.deepEqual(calls.filter(c => c.method === 'rc.deploy.apply').at(-1).input, { planDigest: 'd2', targets: [claude.id] });
  assert.match(textOf(panel.get('install-result')), /已完成/);
  assert.equal(shown(panel), false, '重試成功後不再顯示');
});

test('重試仍失敗時結果畫面再次提供重試，且只針對仍失敗的目標', async () => {
  const { panel, calls } = await open([
    { status: 'partial', problems: [], targets: [res(codex, 'succeeded'), res(claude, 'failed')] },
    { status: 'failed', problems: [], targets: [res(claude, 'failed')] },
    { status: 'succeeded', problems: [], targets: [res(claude, 'succeeded')] }]);
  await install(panel);
  await panel.get('install-retry').fire('click');
  await panel.get('install-confirm').fire('click');
  assert.equal(shown(panel), true);
  await panel.get('install-retry').fire('click');
  assert.deepEqual(calls.filter(c => c.method === 'rc.deploy.plan').at(-1).input.targets, [claude.id]);
});

test('「完成」後重試按鈕收起，結果清掉', async () => {
  const { panel } = await open([{ status: 'partial', problems: [], targets: [res(codex, 'succeeded'), res(claude, 'failed')] }]);
  await install(panel);
  await panel.get('install-done').fire('click');
  assert.equal(shown(panel), false);
});
