// 面板安裝流程：選範圍與 Codex 根目錄 → 部署摘要（可展開明細）→ 確認一次 → 結果；過期時換成新摘要並要求重新確認。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, detailsOf } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const item = { packageKey: 'demo', name: '合成包', type: 'skill', latestVisibleVersion: '1.0.0' };
const detail = (version = '1.0.0') => ({ ...item, description: '說明', selectedVersion: version, readme: 'r',
  versions: ['1.0.0', '0.9.0'].map(v => ({ version: v, channel: 'release', hosts: ['codex'] })) });
const target = { id: 'codex|codex-cli|global|c:\\users\\alice\\.codex', label: 'Codex 全域', rootPath: 'C:\\Users\\alice\\.codex', isPrimary: true };
const summary = (digest, extra = {}) => ({ planDigest: digest, canApply: true, package: { packageKey: 'demo', name: '合成包', version: '1.0.0', channel: 'release' },
  targets: [{ id: target.id, label: target.label, rootPath: target.rootPath, canApply: true,
    changes: [{ contentId: 'hello', kind: 'skill', change: 'Create', changeLabel: '新增', destinationPath: 'c:\\users\\alice\\.codex\\skills\\hello', willBackup: false }], problems: [] }],
  problems: [], ...extra });

async function open(handler, targets = [target]) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.package.getDetails') return detail(input.version);
    if (method === 'rc.deploy.listTargets') return { targets: typeof targets === 'function' ? targets(input) : targets };
    return handler(method, input);
  });
  await panel.get('catalog-list').children[0].children.at(-1).fire('click');
  await settle();
  return { panel, calls };
}

test('選擇版本與 Codex 根目錄後顯示部署摘要，確認一次只套用該份計畫並顯示結果', async () => {
  const { panel, calls } = await open(async (method) => {
    if (method === 'rc.deploy.plan') return summary('d1');
    if (method === 'rc.deploy.apply') return { status: 'succeeded', targets: [{ id: target.id, label: target.label, status: 'succeeded', writtenPaths: ['c:\\users\\alice\\.codex\\skills\\hello'], backupPaths: [], problems: [] }], problems: [] };
  });
  assert.equal(panel.get('install-target').children.length, 1);
  assert.match(textOf(panel.get('install-target')), /Codex 全域/);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true, '沒有計畫前不能確認');
  await panel.get('install-plan').fire('click');
  assert.deepEqual(calls.at(-1), { method: 'rc.deploy.plan', input: { packageKey: 'demo', version: '1.0.0', action: 'install', previewMode: false, targets: [target.id] } });
  const text = textOf(panel.get('install-summary'));
  assert.match(text, /1\.0\.0/);
  assert.match(text, /Codex 全域/);
  assert.match(text, /新增/);
  assert.match(text, /skills\\hello/);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), false);
  await panel.get('install-confirm').fire('click');
  assert.deepEqual(calls.find(c => c.method === 'rc.deploy.apply'), { method: 'rc.deploy.apply', input: { planDigest: 'd1', targets: [target.id] } });
  assert.match(textOf(panel.get('install-result')), /已完成/);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true);
});

test('套用時本機狀態已改變：換成新的摘要並要求重新確認；受阻時不能確認', async () => {
  const { panel, calls } = await open(async (method) => {
    if (method === 'rc.deploy.plan') return summary('d1');
    if (method === 'rc.deploy.apply') return { status: 'stale', message: '本機狀態已在確認前改變，請重新確認。',
      plan: summary('d2', { canApply: false, targets: [{ ...summary('d2').targets[0], canApply: false, problems: [{ code: 'deployment.unmanaged-collision', severity: 'Blocking', summary: '目的地已存在但沒有管理紀錄' }] }] }) };
  });
  await panel.get('install-plan').fire('click');
  await panel.get('install-confirm').fire('click');
  assert.match(textOf(panel.get('install-status')), /重新確認/);
  assert.match(textOf(panel.get('install-summary')), /沒有管理紀錄/);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true);
  assert.equal(calls.filter(c => c.method === 'rc.deploy.apply').length, 1);
});

test('換版本或換目標後舊摘要失效，必須重新產生', async () => {
  const { panel } = await open(async (method) => method === 'rc.deploy.plan' ? summary('d1') : null);
  await panel.get('install-plan').fire('click');
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), false);
  await panel.get('install-target').fire('change');
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true);
  assert.equal(panel.get('install-summary').children.length, 0);
});

test('逐步選範圍並勾選多根，摘要確認一次保留同一組部署目標', async () => {
  const second = { ...target, id: 'second', rootPath: 'C:/profiles/second', isPrimary: false };
  const { panel, calls } = await open(async (method, input) => {
    if (method === 'rc.deploy.plan') return summary('multi', { targets: input.targets.map(id => ({ ...summary('').targets[0], id })) });
    if (method === 'rc.deploy.apply') return { status: 'succeeded', targets: [], problems: [] };
  }, [target, second]);
  const checks = panel.get('install-target').children.map(row => row.children[0]);
  assert.equal(checks[0].type, 'checkbox');
  assert.equal(checks[0].checked, true);
  assert.equal(checks[1].checked, false);
  checks[1].checked = true;
  await checks[1].fire('change');
  await panel.get('install-plan').fire('click');
  assert.deepEqual(calls.at(-1).input.targets, [target.id, second.id]);
  await panel.get('install-confirm').fire('click');
  assert.deepEqual(calls.find(c => c.method === 'rc.deploy.apply').input.targets, [target.id, second.id]);
});

test('本機專案先讀取路徑再產生摘要，修改路徑會清除目標與舊確認', async () => {
  const project = { ...target, id: 'project', rootPath: 'C:/projects/demo' };
  const { panel, calls } = await open(async () => summary('project', { targets: [{ ...summary('').targets[0], id: project.id }] }), input => input.scope === 'project' ? [project] : [target]);
  await panel.get('install-plan').fire('click');
  panel.get('install-scope').value = 'project';
  await panel.get('install-scope').fire('change');
  // 切換到專案範圍時先自動列出已有部署的專案（工項 12）；舊摘要與確認仍被清除。
  assert.deepEqual(calls.at(-1), { method: 'rc.deploy.listTargets', input: { packageKey: 'demo', version: '1.0.0', previewMode: false, scope: 'project' } });
  assert.equal(panel.get('install-target').children.length, 1);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true);
  panel.get('install-project-root').value = project.rootPath;
  await panel.get('install-project-root').fire('input');
  await panel.get('install-detect').fire('click');
  assert.deepEqual(calls.at(-1), { method: 'rc.deploy.listTargets', input: { packageKey: 'demo', version: '1.0.0', previewMode: false, scope: 'project', projectRoot: project.rootPath } });
  await panel.get('install-plan').fire('click');
  assert.deepEqual(calls.at(-1).input, { packageKey: 'demo', version: '1.0.0', action: 'install', previewMode: false, scope: 'project', projectRoot: project.rootPath, targets: [project.id] });
  panel.get('install-project-root').value = 'C:/projects/other';
  await panel.get('install-project-root').fire('input');
  assert.equal(panel.get('install-plan').disabled, true);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true);
});

test('套用途中切換範圍，舊回應不得恢復可確認的過期摘要', async () => {
  let finish;
  const { panel } = await open(async method => {
    if (method === 'rc.deploy.plan') return summary('old');
    if (method === 'rc.deploy.apply') return new Promise(resolve => { finish = resolve; });
  });
  await panel.get('install-plan').fire('click');
  const applying = panel.get('install-confirm').fire('click');
  panel.get('install-scope').value = 'project';
  await panel.get('install-scope').fire('change');
  finish({ status: 'stale', message: 'old', plan: summary('stale') });
  await applying;
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true);
  assert.equal(panel.get('install-summary').children.length, 0);
});

const conflictChange = { contentId: 'hello', kind: 'skill', change: 'Replace', changeLabel: '取代', destinationPath: 'c:\\users\\alice\\.codex\\skills\\hello', willBackup: true, backupReason: 'unmanaged' };
const precedence = { contentId: 'hello', kind: 'skill', rule: 'globalFirst', winner: 'global', text: 'Skill 同名時全域優先於專案：專案內實際使用全域版本 1.0.0，專案版本 1.1.0 被遮蔽。',
  locations: [{ scope: 'global', scopeLabel: '全域', path: 'c:\\users\\alice\\.codex\\skills\\hello', version: '1.0.0', current: false },
    { scope: 'project', scopeLabel: '專案', path: 'c:\\proj\\.agents\\skills\\hello', version: '1.1.0', current: true }] };

test('自動備份與載入優先順序在可展開的明細中說明，確認一次即可套用', async () => {
  const { panel, calls } = await open(async (method) => {
    if (method === 'rc.deploy.plan') return summary('c1', { targets: [{ ...summary('').targets[0], changes: [conflictChange], loadPrecedence: [precedence],
      problems: [{ code: 'deployment.unmanaged-collision', severity: 'Warning', summary: '目的地已存在但沒有管理紀錄', explanation: '套用時會自動先備份', path: conflictChange.destinationPath }] }] });
    if (method === 'rc.deploy.apply') return { status: 'succeeded', targets: [{ id: target.id, label: target.label, status: 'succeeded', writtenPaths: [conflictChange.destinationPath],
      backupPaths: ['c:\\users\\alice\\.codex\\skills\\hello.bak-lcaipack-20261121101500'], problems: [] }], problems: [] };
  });
  await panel.get('install-plan').fire('click');
  const summaryText = textOf(panel.get('install-summary'));
  assert.match(summaryText, /先備份/);
  assert.match(summaryText, /未受管的同名內容/);
  const details = detailsOf(panel.get('install-summary'));
  const changes = details.find(d => /變更明細/.test(d.summary));
  assert.match(changes.body, /取代：skill hello（先備份：目的地已有未受管的同名內容）/);
  const order = details.find(d => /載入優先順序/.test(d.summary));
  assert.match(order.body, /全域優先於專案/);
  assert.match(order.body, /全域 1\.0\.0.*skills\\hello/);
  assert.match(order.body, /專案 1\.1\.0（本次部署）.*\.agents\\skills\\hello/);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), false);
  await panel.get('install-confirm').fire('click');
  assert.equal(calls.filter(c => c.method === 'rc.deploy.apply').length, 1);
  assert.match(textOf(panel.get('install-result')), /備份：.*hello\.bak-lcaipack-20261121101500/);
});

test('受阻目標在摘要顯示位置與原因，無法確認；復原未完成的結果列出需人工處理的位置與備份', async () => {
  const blocked = { code: 'deployment.ownership-collision', severity: 'Blocking', summary: "目的地已由資源包 'other-pkg' 的 'hello' 擁有", explanation: '同一部署目標內不得由不同資源包擁有', path: 'c:\\users\\alice\\.codex\\skills\\hello' };
  const { panel } = await open(async (method) => {
    if (method === 'rc.deploy.plan') return summary('c2', { canApply: false, targets: [{ ...summary('').targets[0], canApply: false, problems: [blocked] }] });
  });
  await panel.get('install-plan').fire('click');
  assert.match(textOf(panel.get('install-summary')), /受阻：目的地已由資源包 'other-pkg'.*skills\\hello/);
  assert.equal(panel.get('install-confirm').classList.contains('hidden'), true);

  const { panel: second } = await open(async (method) => {
    if (method === 'rc.deploy.plan') return summary('c3');
    if (method === 'rc.deploy.apply') return { status: 'failed', problems: [], targets: [{ id: target.id, label: target.label, status: 'rollbackIncomplete', writtenPaths: [],
      backupPaths: ['c:\\x\\hello.bak-lcaipack-20261121101500'], residualPaths: ['c:\\users\\alice\\.codex\\skills\\hello'], problems: [] }] };
  });
  await second.get('install-plan').fire('click');
  await second.get('install-confirm').fire('click');
  const result = textOf(second.get('install-result'));
  assert.match(result, /寫入失敗且未完整還原/);
  assert.match(result, /需人工處理：c:\\users\\alice\\.codex\\skills\\hello/);
  assert.match(result, /備份：c:\\x\\hello\.bak-lcaipack-20261121101500/);
});

test('列出目標時傳入目前資源包與版本，Claude Code 多根可各自勾選', async () => {
  const second = { id: 'claude-code|claude-code-cli|global|c:/profiles/work', label: 'Claude Code 全域', rootPath: 'C:/profiles/work' };
  const { panel, calls } = await open(async method => method === 'rc.deploy.plan' ? summary('both') : null, [target, second]);
  const request = calls.find(c => c.method === 'rc.deploy.listTargets');
  assert.deepEqual(request.input, { packageKey: 'demo', version: '1.0.0', previewMode: false });
  assert.match(textOf(panel.get('install-target')), /Claude Code 全域/);
  const check = panel.get('install-target').children[1].children[0]; check.checked = true; await check.fire('change');
  await panel.get('install-plan').fire('click');
  assert.deepEqual(calls.at(-1).input.targets, [target.id, second.id]);
});
