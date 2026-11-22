// 已安裝狀態與手動更新（ADR-0003）：清單與明細呈現已安裝版本與篩選；更新改為一鍵 rc.install.run，不再產生部署摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, findByData } from './panel-harness.mjs';

test('面板呈現逐目標已安裝版本與篩選；讀取不啟動更新，按「更新」才一鍵更新', async () => {
  const calls = [];
  const deployment = { id: 'target-a', hostId: 'codex', scope: 'global', rootPath: '/demo/.codex', version: '1.0.0', channel: 'release', status: 'updateAvailable', updateVersion: '1.1.0' };
  const item = { packageKey: 'demo', name: 'Demo', type: 'skill', latestVisibleVersion: '1.1.0', installationStatus: 'updateAvailable', deployments: [deployment] };
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.package.getDetails') return { ...item, selectedVersion: '1.1.0', recommendedVersion: '1.1.0', readme: '', versions: [{ version: '1.1.0', channel: 'release', hosts: ['codex'] }] };
    if (method === 'rc.install.run') return { ok: true, succeeded: [{ targetId: 'target-a', hostId: 'codex', label: 'Codex', rootPath: '/demo/.codex' }], failed: [], backups: [] };
  });
  assert.match(textOf(panel.get('catalog-list')), /可更新 1\.0\.0 → 1\.1\.0/);
  panel.get('catalog-installation').value = 'updates';
  await panel.get('catalog-installation').fire('change');
  assert.equal(calls.at(-1).input.installation, 'updates');
  await findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click');
  await settle();
  assert.match(textOf(panel.get('details-installed')), /1\.0\.0/);
  assert.equal(calls.some(c => c.method === 'rc.install.run'), false, '讀取不啟動更新');
  await findByData(panel.get('details-status-row'), 'action', 'update').fire('click');
  assert.deepEqual(calls.find(c => c.method === 'rc.install.run').input, { packageKey: 'demo', action: 'update' });
});

test('更新成功後重新讀取部署狀態，清除可更新提示與按鈕', async () => {
  let updated = false;
  const deployment = () => ({ id: 't', rootPath: '/demo', hostId: 'codex', scope: 'global', version: updated ? '1.1.0' : '1.0.0', status: updated ? 'current' : 'updateAvailable', updateVersion: updated ? null : '1.1.0' });
  const state = () => ({ installationStatus: updated ? 'current' : 'updateAvailable', deployments: [deployment()] });
  const panel = await startPanel(async (method) => {
    if (method === 'rc.session.getState') return { signedIn: true };
    if (method === 'rc.catalog.list') return { data: [{ packageKey: 'demo', name: 'Demo', ...state() }] };
    if (method === 'rc.package.getDetails') return { packageKey: 'demo', name: 'Demo', selectedVersion: '1.1.0', versions: [{ version: '1.1.0', hosts: [] }], ...state() };
    if (method === 'rc.install.run') { updated = true; return { ok: true, succeeded: [{ targetId: 't', hostId: 'codex', label: 'Codex', rootPath: '/demo' }], failed: [], backups: [] }; }
  });
  await findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click');
  await settle();
  await findByData(panel.get('details-status-row'), 'action', 'update').fire('click');
  await settle();
  assert.match(textOf(panel.get('details-installed')), /1\.1\.0 · 已是最新/);
  assert.doesNotMatch(textOf(panel.get('details-installed')), /可更新/);
  assert.equal(findByData(panel.get('details-status-row'), 'action', 'update'), null);
  assert.match(textOf(panel.get('toast')), /已更新 1 個位置/);
});
