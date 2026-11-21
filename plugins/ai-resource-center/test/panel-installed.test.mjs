import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf } from './panel-harness.mjs';

test('面板呈現逐目標已安裝版本、篩選及手動更新；摘要清楚區分變更與保留版本', async () => {
  const calls = [];
  const deployment = { id: 'target-a', hostId: 'codex', scope: 'global', rootPath: '/demo/.codex', version: '1.0.0', channel: 'release', status: 'updateAvailable', updateVersion: '1.1.0' };
  const item = { packageKey: 'demo', name: 'Demo', type: 'skill', latestVisibleVersion: '1.1.0', installationStatus: 'updateAvailable', deployments: [deployment] };
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.package.getDetails') return { ...item, selectedVersion: input.version || '1.1.0', recommendedVersion: '1.1.0', readme: '', versions: [{ version: '1.1.0', channel: 'release', hosts: ['codex'] }] };
    if (method === 'rc.deploy.listTargets') return { targets: [{ id: 'target-a', label: 'Codex 全域', rootPath: '/demo/.codex' }] };
    if (method === 'rc.deploy.plan') return { planDigest: 'digest', canApply: true, package: { name: 'Demo', version: '1.1.0' }, targets: [{ id: 'target-a', label: 'Codex 全域', rootPath: '/demo/.codex', canApply: true, installedVersions: ['1.0.0'], nextVersion: '1.1.0', changes: [], problems: [] }], unchangedDeployments: [{ id: 'target-b', rootPath: '/demo/.codex-team', version: '0.9.0' }], problems: [] };
  });
  assert.match(textOf(panel.get('catalog-list')), /已安裝.*1\.0\.0/);
  assert.match(textOf(panel.get('catalog-list')), /可更新.*1\.1\.0/);
  panel.get('catalog-installation').value = 'updates';
  await panel.get('catalog-installation').fire('change');
  assert.equal(calls.at(-1).input.installation, 'updates');
  await panel.get('catalog-list').children[0].children.at(-1).fire('click');
  await settle();
  assert.match(textOf(panel.get('details-installed')), /1\.0\.0/);
  assert.equal(calls.some(c => c.method === 'rc.deploy.plan'), false, '讀取不啟動更新');
  await panel.get('details-update').fire('click');
  assert.deepEqual(calls.at(-1), { method: 'rc.deploy.plan', input: { packageKey: 'demo', version: '1.1.0', action: 'update', previewMode: false, targets: ['target-a'] } });
  assert.match(textOf(panel.get('install-summary')), /1\.0\.0 → 1\.1\.0/);
  assert.match(textOf(panel.get('install-summary')), /維持.*0\.9\.0/);
  assert.equal(calls.some(c => c.method === 'rc.deploy.apply'), false, '摘要仍需確認');
});


test('面板分別標示 Orca 外掛與 LC-AI-Pack 市集用戶端版本', async () => {
  const panel = await startPanel(async method => {
    if (method === 'rc.session.getState') return { signedIn: true };
    if (method === 'rc.catalog.list') return { data: [] };
    if (method === 'rc.client.getVersions') return { orca: { version: '1.0.0' }, lcAiPack: { version: '0.9.7', source: 'marketRelease', receiptVersion: '0.9.5' } };
  });
  await settle();
  assert.match(textOf(panel.get('client-versions')), /Orca 外掛.*1\.0\.0/);
  assert.match(textOf(panel.get('client-versions')), /LC-AI-Pack.*收據最後部署.*0\.9\.5.*市集最新發行版.*0\.9\.7/);
});

test('共用收據沒有 LC-AI-Pack 部署紀錄時，明確標示未偵測', async () => {
  const panel = await startPanel(async method => {
    if (method === 'rc.session.getState') return { signedIn: true };
    if (method === 'rc.catalog.list') return { data: [] };
    if (method === 'rc.client.getVersions') return { orca: { version: '1.0.0' }, lcAiPack: { version: null, source: 'marketRelease', receiptVersion: null } };
  });
  await settle();
  assert.match(textOf(panel.get('client-versions')), /收據最後部署：未偵測/);
});

test('更新套用成功後重新讀取部署狀態，清除可更新提示並保留操作結果', async () => {
  let updated = false;
  const deployment = () => ({ id: 't', rootPath: '/demo', hostId: 'codex', scope: 'global', version: updated ? '1.1.0' : '1.0.0', status: updated ? 'current' : 'updateAvailable', updateVersion: updated ? null : '1.1.0' });
  const panel = await startPanel(async (method) => {
    if (method === 'rc.session.getState') return { signedIn: true };
    if (method === 'rc.catalog.list') return { data: [{ packageKey: 'demo', name: 'Demo', deployments: [deployment()] }] };
    if (method === 'rc.package.getDetails') return { packageKey: 'demo', name: 'Demo', selectedVersion: '1.1.0', versions: [{ version: '1.1.0', hosts: [] }], deployments: [deployment()] };
    if (method === 'rc.deploy.listTargets') return { targets: [{ id: 't', label: 'Codex', rootPath: '/demo' }] };
    if (method === 'rc.deploy.plan') return { planDigest: 'd', canApply: true, package: { version: '1.1.0' }, targets: [{ id: 't', changes: [], problems: [] }], problems: [] };
    if (method === 'rc.deploy.apply') { updated = true; return { status: 'succeeded', targets: [{ id: 't', label: 'Codex', status: 'succeeded', problems: [] }], problems: [] }; }
  });
  await panel.get('catalog-list').children[0].children.at(-1).fire('click');
  await settle();
  await panel.get('details-update').fire('click');
  await panel.get('install-confirm').fire('click');
  assert.match(textOf(panel.get('details-installed')), /已安裝資源版本 1\.1\.0/);
  assert.doesNotMatch(textOf(panel.get('details-installed')), /可更新/);
  assert.equal(panel.get('details-update').classList.contains('hidden'), true);
  assert.match(textOf(panel.get('install-result')), /已完成/);
});
