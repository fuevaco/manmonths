// QA 發現 1–3：面板的更新目標選取、確認後只留結果（對照 LC-AI-Pack 安裝精靈步驟 3「完成」）、
// 已安裝狀態只呈現所選範圍（全域＋目前專案），其他專案的部署收合保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, detailsOf } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const item = { packageKey: 'demo', name: '合成包', type: 'skill', latestVisibleVersion: '1.1.0' };
const globalCodex = { id: 'codex|codex-cli|global|/home/a/.codex', label: 'Codex 全域', rootPath: '/home/a/.codex', canonicalRoot: '/home/a/.codex', scope: 'global' };
const projectTarget = (host, surface, root) => ({ id: `${host}|${surface}|project|${root}`, label: `${host} 本機專案`, rootPath: root, projectRoot: root, canonicalRoot: root, scope: 'project' });
const deployment = (t, extra = {}) => ({ id: t.id, hostId: t.id.split('|')[0], surfaceId: t.id.split('|')[1], scope: t.scope, rootPath: t.canonicalRoot, version: '1.0.0', channel: 'release', status: 'updateAvailable', updateVersion: '1.1.0', ...extra });
const planFor = (version, ids, extra = {}) => ({ planDigest: `d-${version}`, canApply: true, package: { packageKey: 'demo', name: '合成包', version, channel: 'release' },
  deployableCount: ids.length, blockedCount: 0, targets: ids.map(id => ({ id, label: id, rootPath: id, canApply: true, installedVersions: ['1.0.0'], nextVersion: version, changes: [], problems: [] })), problems: [], ...extra });

async function open({ deployments, listTargets, apply = async (input) => ({ status: 'succeeded', problems: [], targets: input.targets.map(id => ({ id, label: id, status: 'succeeded', writtenPaths: [], backupPaths: [], problems: [] })) }), planExtra = {} }) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.package.getDetails') return { ...item, selectedVersion: input.version || '1.1.0', recommendedVersion: '1.1.0', readme: '', versions: [{ version: '1.1.0', channel: 'release', hosts: ['codex'] }], deployments: typeof deployments === 'function' ? deployments() : deployments };
    if (method === 'rc.deploy.listTargets') return { targets: listTargets(input) };
    if (method === 'rc.deploy.plan') return planFor(input.version, input.targets, planExtra);
    if (method === 'rc.deploy.apply') return apply(input);
  });
  await panel.get('catalog-list').children[0].children.at(-1).fire('click');
  await settle();
  return { panel, calls };
}
const switchToProject = async (panel) => { panel.get('install-scope').value = 'project'; await panel.get('install-scope').fire('change'); await settle(); };
const checkAll = async (panel) => { for (const label of panel.get('install-target').children) { label.children[0].checked = true; await label.children[0].fire('change'); } };

test('專案範圍：同一專案的 Codex 與 Claude Code 都在舊版且都勾選，更新計畫與套用都送出兩個目標', async () => {
  const codex = projectTarget('codex', 'codex-cli', '/work/one'), claude = projectTarget('claude-code', 'claude-code-cli', '/work/one');
  const { panel, calls } = await open({ deployments: [deployment(claude), deployment(codex)], listTargets: () => [codex, claude] });
  await switchToProject(panel);
  await checkAll(panel);
  assert.deepEqual(panel.get('install-target').children.map(l => l.children[0].checked), [true, true]);

  await panel.get('details-update').fire('click');
  assert.deepEqual(calls.findLast(c => c.method === 'rc.deploy.plan').input.targets, [codex.id, claude.id]);
  await panel.get('install-confirm').fire('click');
  assert.deepEqual(calls.findLast(c => c.method === 'rc.deploy.apply').input.targets, [codex.id, claude.id]);
});

test('確認後只留結果：舊部署摘要與「產生部署摘要」「更新所選目標」都收起，另有「完成」返回；返回後可再操作', async () => {
  const codex = projectTarget('codex', 'codex-cli', '/work/one');
  let done = false;
  const { panel } = await open({ deployments: () => [deployment(codex, done ? { version: '1.1.0', status: 'current', updateVersion: null } : {})], listTargets: () => [codex],
    apply: async (input) => { done = true; return { status: 'succeeded', problems: [], targets: [{ id: input.targets[0], label: 'Codex 本機專案', status: 'succeeded', writtenPaths: ['/work/one/.agents/skills/demo-skill'], backupPaths: [], problems: [] }] }; } });
  await switchToProject(panel);
  await panel.get('details-update').fire('click');
  assert.match(textOf(panel.get('install-summary')), /部署摘要/);
  assert.equal(panel.get('install-steps').classList.contains('hidden'), false);

  await panel.get('install-confirm').fire('click');
  assert.equal(panel.get('install-summary').children.length, 0, '已確認的部署摘要要清掉');
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true);
  assert.equal(panel.get('install-steps').classList.contains('hidden'), true, '範圍、目標、「產生部署摘要」「更新所選目標」都收起');
  assert.equal(panel.get('details-update').classList.contains('hidden'), true);
  assert.equal(panel.get('install-done').classList.contains('hidden'), false);
  assert.match(panel.get('install-status').textContent, /安裝已完成/);
  assert.match(textOf(panel.get('install-result')), /Codex 本機專案：已完成/);
  assert.match(textOf(panel.get('details-installed')), /已安裝資源版本 1\.1\.0/);

  await panel.get('install-done').fire('click');
  assert.equal(panel.get('install-steps').classList.contains('hidden'), false);
  assert.equal(panel.get('install-done').classList.contains('hidden'), true);
  assert.equal(panel.get('install-result').children.length, 0);
  assert.equal(panel.get('install-status').textContent, '');
  assert.equal(panel.get('install-plan').disabled, false);
});

test('套用結果為「狀態已改變」時仍停在部署摘要（重新確認），不進入完成畫面', async () => {
  const codex = projectTarget('codex', 'codex-cli', '/work/one');
  const { panel } = await open({ deployments: [deployment(codex)], listTargets: () => [codex],
    apply: async () => ({ status: 'stale', message: '本機狀態已改變', plan: planFor('1.1.0', [codex.id]) }) });
  await switchToProject(panel);
  await panel.get('details-update').fire('click');
  await panel.get('install-confirm').fire('click');
  assert.match(textOf(panel.get('install-summary')), /部署摘要/);
  assert.equal(panel.get('install-steps').classList.contains('hidden'), false);
  assert.equal(panel.get('install-done').classList.contains('hidden'), true);
});

test('已安裝狀態只列所選範圍（全域＋目前專案），其他專案的部署收合在「其他專案的部署」，資訊不遺失', async () => {
  const one = projectTarget('claude-code', 'claude-code-cli', '/work/one'), two = projectTarget('claude-code', 'claude-code-cli', '/work/two');
  const { panel } = await open({ deployments: [deployment(globalCodex), deployment(one), deployment(two)],
    listTargets: (input) => input.scope === 'project' ? [one] : [globalCodex] });
  const outside = () => panel.get('details-installed').children.filter(c => c.tagName !== 'details').map(textOf).join(' ');
  const others = () => detailsOf(panel.get('details-installed')).find(d => /其他專案的部署/.test(d.summary));

  // 全域範圍：全域部署在外，專案部署（兩個）都歸入其他專案。
  assert.match(outside(), /\/home\/a\/\.codex/);
  assert.doesNotMatch(outside(), /\/work\//);
  assert.match(others().summary, /其他專案的部署（2）/);

  // 專案範圍：全域＋專案 one 在外，只有專案 two 收合。
  await switchToProject(panel);
  assert.match(outside(), /\/home\/a\/\.codex/);
  assert.match(outside(), /\/work\/one/);
  assert.doesNotMatch(outside(), /\/work\/two/);
  assert.match(others().summary, /其他專案的部署（1）/);
  assert.match(others().body, /\/work\/two/);
});

test('沒有其他專案的部署時不出現「其他專案的部署」區塊', async () => {
  const { panel } = await open({ deployments: [deployment(globalCodex)], listTargets: () => [globalCodex] });
  assert.equal(detailsOf(panel.get('details-installed')).length, 0);
  assert.match(textOf(panel.get('details-installed')), /\/home\/a\/\.codex/);
});
