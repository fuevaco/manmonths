// 面板的多目標流程（工項 12，ADR 0002）：摘要同時列出可安裝與受阻的目標；確認一次後逐目標呈現結果（可展開）；
// 全部受阻時只列原因、不提供確認；多個待更新版本分批更新；專案範圍的既有部署自動列為目標。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, detailsOf } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const item = { packageKey: 'demo', name: '合成包', type: 'skill', latestVisibleVersion: '1.1.0' };
const targets = [
  { id: 'codex|global', label: 'Codex 全域', rootPath: '/home/a/.codex', scope: 'global' },
  { id: 'claude|global', label: 'Claude Code 全域', rootPath: '/home/a/.claude', scope: 'global' },
  { id: 'work|global', label: 'Claude Code 全域（.claude-work）', rootPath: '/home/a/.claude-work', scope: 'global' }
];
const planTarget = (t, extra = {}) => ({ id: t.id, label: t.label, rootPath: t.rootPath, canApply: true, changes: [], problems: [], ...extra });
const blockedProblem = { code: 'deployment.ownership-collision', severity: 'Blocking', summary: '目的地已由資源包 pkg-a 管理', path: '/home/a/.claude-work/skills/demo-skill' };
const plan = (digest, list, extra = {}) => ({ planDigest: digest, package: { packageKey: 'demo', name: '合成包', version: '1.1.0', channel: 'release' },
  targets: list, deployableCount: list.filter(t => t.canApply).length, blockedCount: list.filter(t => !t.canApply).length,
  canApply: list.some(t => t.canApply), problems: [], ...extra });

async function open({ handler, listTargets = targets, deployments = [] }) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.package.getDetails') return { ...item, selectedVersion: input.version || '1.1.0', recommendedVersion: '1.1.0', readme: '', versions: [{ version: '1.1.0', channel: 'release', hosts: ['codex'] }], deployments };
    if (method === 'rc.deploy.listTargets') return { targets: typeof listTargets === 'function' ? listTargets(input) : listTargets };
    return handler(method, input);
  });
  await panel.get('catalog-list').children[0].children.at(-1).fire('click');
  await settle();
  return { panel, calls };
}
const checkAll = async (panel) => { for (const label of panel.get('install-target').children) { label.children[0].checked = true; await label.children[0].fire('change'); } };

test('三個目標其中一個受阻：摘要顯示可安裝與受阻的數量與具體原因，確認一次送出全部三個目標', async () => {
  const list = [planTarget(targets[0]), planTarget(targets[1]), planTarget(targets[2], { canApply: false, problems: [blockedProblem] })];
  const { panel, calls } = await open({ handler: async (method) => {
    if (method === 'rc.deploy.plan') return plan('d1', list);
    if (method === 'rc.deploy.apply') return { status: 'partial', problems: [], targets: [
      { id: targets[0].id, label: targets[0].label, status: 'succeeded', writtenPaths: ['/home/a/.codex/skills/demo-skill'], backupPaths: ['/home/a/.codex/skills/demo-skill.bak-lcaipack-20261121100000'], problems: [] },
      { id: targets[1].id, label: targets[1].label, status: 'succeeded', writtenPaths: ['/home/a/.claude/skills/demo-skill'], backupPaths: [], problems: [] },
      { id: targets[2].id, label: targets[2].label, status: 'skipped', writtenPaths: [], backupPaths: [], problems: [blockedProblem] }] };
  } });
  await checkAll(panel);
  await panel.get('install-plan').fire('click');

  const summary = textOf(panel.get('install-summary'));
  assert.match(summary, /可安裝 2 個目標/);
  assert.match(summary, /受阻 1 個目標/);
  assert.match(summary, /Claude Code 全域（\.claude-work）（受阻）/);
  assert.match(summary, /受阻：目的地已由資源包 pkg-a 管理（\/home\/a\/\.claude-work\/skills\/demo-skill）/);
  assert.match(summary, /確認後只部署可安裝的目標，受阻的目標維持原狀/);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), false);
  assert.match(panel.get('install-status').textContent, /確認/);

  await panel.get('install-confirm').fire('click');
  assert.deepEqual(calls.find(c => c.method === 'rc.deploy.apply').input, { planDigest: 'd1', targets: targets.map(t => t.id) });
  assert.match(panel.get('install-status').textContent, /部分完成/);
  const entries = detailsOf(panel.get('install-result'));
  assert.deepEqual(entries.map(d => d.summary), ['Codex 全域：已完成', 'Claude Code 全域：已完成', 'Claude Code 全域（.claude-work）：未部署（受阻，維持原狀）']);
  assert.match(entries[0].body, /備份：.*demo-skill\.bak-lcaipack-20261121100000/);
  assert.match(entries[0].body, /寫入：\/home\/a\/\.codex\/skills\/demo-skill/);
  assert.match(entries[2].body, /目的地已由資源包 pkg-a 管理/);
});

test('結果逐項可展開：失敗與未完整還原預設展開並列出原因與需人工處理的路徑', async () => {
  const list = targets.map(t => planTarget(t));
  const { panel } = await open({ handler: async (method) => {
    if (method === 'rc.deploy.plan') return plan('d1', list);
    if (method === 'rc.deploy.apply') return { status: 'partial', problems: [], targets: [
      { id: targets[0].id, label: targets[0].label, status: 'succeeded', writtenPaths: [], backupPaths: [], problems: [] },
      { id: targets[1].id, label: targets[1].label, status: 'rolledBack', writtenPaths: [], backupPaths: [], problems: [{ code: 'deployment.apply-failed', severity: 'Blocking', summary: '寫入失敗，已完整還原該平台變更' }] },
      { id: targets[2].id, label: targets[2].label, status: 'rollbackIncomplete', writtenPaths: [], backupPaths: ['/b'], residualPaths: ['/home/a/.claude-work/skills/demo-skill'], problems: [] }] };
  } });
  await checkAll(panel);
  await panel.get('install-plan').fire('click');
  await panel.get('install-confirm').fire('click');
  const entries = detailsOf(panel.get('install-result'));
  assert.equal(entries.length, 3);
  assert.match(entries[1].summary, /寫入失敗，已還原/);
  assert.match(entries[1].body, /寫入失敗，已完整還原該平台變更/);
  assert.match(entries[2].body, /需人工處理：\/home\/a\/\.claude-work\/skills\/demo-skill/);
  const [success, failed, incomplete] = panel.get('install-result').children;
  assert.notEqual(success.open, true);
  assert.equal(failed.open, true);
  assert.equal(incomplete.open, true);
});

test('全部目標受阻：摘要逐一列出各自的原因，不提供確認按鈕', async () => {
  const list = targets.slice(1).map((t, i) => planTarget(t, { canApply: false, problems: [{ ...blockedProblem, summary: `原因 ${i + 1}` }] }));
  const { panel, calls } = await open({ handler: async (method) => { if (method === 'rc.deploy.plan') return plan('d1', list); } });
  await checkAll(panel);
  await panel.get('install-plan').fire('click');
  const summary = textOf(panel.get('install-summary'));
  assert.match(summary, /可安裝 0 個目標/);
  assert.match(summary, /受阻：原因 1/);
  assert.match(summary, /受阻：原因 2/);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true);
  assert.match(panel.get('install-status').textContent, /所有部署目標都受阻/);
  assert.equal(calls.some(c => c.method === 'rc.deploy.apply'), false);
});

test('所選目標有不同的可更新版本：先更新第一批，完成後自動選取其餘目標並提示，再更新下一批', async () => {
  const deployments = [
    { id: targets[0].id, hostId: 'codex', scope: 'global', rootPath: targets[0].rootPath, version: '1.0.0', status: 'updateAvailable', updateVersion: '1.1.0' },
    { id: targets[1].id, hostId: 'claude-code', scope: 'global', rootPath: targets[1].rootPath, version: '1.0.0', status: 'updateAvailable', updateVersion: '1.2.0' }];
  const done = new Set();
  const view = () => deployments.map(d => done.has(d.id) ? { ...d, version: d.updateVersion, status: 'current', updateVersion: null } : d);
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.package.getDetails') return { ...item, selectedVersion: input.version || '1.2.0', recommendedVersion: '1.2.0', readme: '', deployments: view(),
      versions: ['1.2.0', '1.1.0'].map(v => ({ version: v, channel: 'release', hosts: ['codex'] })) };
    if (method === 'rc.deploy.listTargets') return { targets: targets.slice(0, 2) };
    if (method === 'rc.deploy.plan') return plan(`d-${input.version}`, input.targets.map(id => planTarget(targets.find(t => t.id === id))), { package: { packageKey: 'demo', name: '合成包', version: input.version, channel: 'release' } });
    if (method === 'rc.deploy.apply') { input.targets.forEach(id => done.add(id)); return { status: 'succeeded', problems: [], targets: input.targets.map(id => ({ id, label: targets.find(t => t.id === id).label, status: 'succeeded', writtenPaths: [], backupPaths: [], problems: [] })) }; }
  });
  await panel.get('catalog-list').children[0].children.at(-1).fire('click');
  await settle();
  await checkAll(panel);
  assert.equal(panel.get('details-update').classList.contains('hidden'), false);

  await panel.get('details-update').fire('click');
  assert.deepEqual(calls.findLast(c => c.method === 'rc.deploy.plan').input, { packageKey: 'demo', version: '1.1.0', action: 'update', previewMode: false, targets: [targets[0].id] });
  assert.match(panel.get('install-status').textContent, /不同的可更新版本/);
  await panel.get('install-confirm').fire('click');
  assert.deepEqual(calls.findLast(c => c.method === 'rc.deploy.apply').input.targets, [targets[0].id]);
  // 第一批完成：結果仍在，其餘目標已自動選取並提示。
  assert.match(textOf(panel.get('install-result')), /Codex 全域：已完成/);
  assert.match(panel.get('install-status').textContent, /尚有 1 個目標可更新到 1\.2\.0/);
  assert.deepEqual(panel.get('install-target').children.map(l => l.children[0].checked), [false, true]);

  await panel.get('details-update').fire('click');
  assert.deepEqual(calls.findLast(c => c.method === 'rc.deploy.plan').input.version, '1.2.0');
  assert.deepEqual(calls.findLast(c => c.method === 'rc.deploy.plan').input.targets, [targets[1].id]);
  await panel.get('install-confirm').fire('click');
  assert.equal(panel.get('details-update').classList.contains('hidden'), true);
  assert.match(textOf(panel.get('details-installed')), /已安裝資源版本 1\.2\.0/);
});

test('專案範圍：切換後自動列出已有部署的專案目標（不必先輸入路徑）；不同專案的目標不能混選', async () => {
  const project = (root, name) => ({ id: `claude|project|${root}`, label: 'Claude Code 本機專案', rootPath: root, projectRoot: root, scope: 'project', name });
  const a = project('/work/one'), b = project('/work/two');
  const { panel, calls } = await open({ handler: async () => ({}), listTargets: (input) => input.scope === 'project' ? [a, b] : targets });
  panel.get('install-scope').value = 'project';
  await panel.get('install-scope').fire('change');
  await settle();
  assert.deepEqual(calls.findLast(c => c.method === 'rc.deploy.listTargets').input, { packageKey: 'demo', version: '1.1.0', previewMode: false, scope: 'project' });
  assert.equal(panel.get('install-target').children.length, 2);
  const [first, second] = panel.get('install-target').children.map(l => l.children[0]);
  first.checked = true; await first.fire('change');
  second.checked = true; await second.fire('change');
  assert.deepEqual([first.checked, second.checked], [false, true]);
});
