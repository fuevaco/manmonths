// 損壞的 receipts.json 不得讓目錄瀏覽整個失敗：「全部」檢視與資源詳情照常載入，
// 已安裝狀態改以明確的錯誤呈現；需要收據才有意義的篩選（已安裝、可更新）與部署則明確失敗。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { startPanel, settle, textOf } from './panel-harness.mjs';

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-corrupt-'));
  const home = path.join(dir, 'state'), userHome = path.join(dir, 'user');
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'receipts.json'), '{broken');
  const market = await startFakeMarket({ packages: [{ packageKey: 'demo', name: 'Demo', type: 'skill', latestReleaseVersion: '1.0.0' }] });
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', name: 'Demo', type: 'skill', recommendedVersion: '1.0.0',
    versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', sha256: 'a'.repeat(64) }] } }));
  market.override('GET /api/market/packages/demo/versions/1.0.0/readme', () => ({ status: 200, body: { readme: '# Demo' } }));
  const worker = startWorker({ deps: { lcaipackHome: home, userHome, env: {} } });
  t.after(async () => { worker.dispose(); await market.close(); await rm(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { worker };
}

test('收據損壞時「全部」目錄仍可瀏覽，並附上已安裝狀態的明確錯誤', async t => {
  const { worker } = await setup(t);
  const result = await worker.call('rc.catalog.list', {});
  assert.deepEqual(result.data.map(p => p.packageKey), ['demo']);
  assert.equal(result.data[0].deployments, undefined, '不虛構安裝狀態');
  assert.equal(result.installedError.code, 'receipt_invalid');
  assert.match(result.installedError.message, /部署收據/);
});

test('收據損壞時「已安裝」與「可更新」篩選明確失敗，不假裝沒有安裝', async t => {
  const { worker } = await setup(t);
  for (const installation of ['installed', 'updates']) await assert.rejects(worker.call('rc.catalog.list', { installation }), { code: 'receipt_invalid' });
});

test('收據損壞時資源詳情仍可讀取，已安裝狀態以錯誤標示', async t => {
  const { worker } = await setup(t);
  const detail = await worker.call('rc.package.getDetails', { packageKey: 'demo' });
  assert.equal(detail.packageKey, 'demo');
  assert.equal(detail.installedError.code, 'receipt_invalid');
  assert.equal(detail.deployments, undefined);
});

test('面板：目錄照常顯示，並在狀態列與詳情標出已安裝狀態無法讀取', async () => {
  const error = { code: 'receipt_invalid', message: '部署收據檔不是有效的 JSON' };
  const panel = await startPanel(async (method, input) => {
    if (method === 'rc.session.getState') return { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
    if (method === 'rc.catalog.list') return { data: [{ packageKey: 'demo', name: 'Demo', type: 'skill', latestVisibleVersion: '1.0.0' }], installedError: error };
    if (method === 'rc.package.getDetails') return { packageKey: 'demo', name: 'Demo', selectedVersion: '1.0.0', recommendedVersion: '1.0.0', readme: '', versions: [{ version: '1.0.0', hosts: [] }], installedError: error };
    if (method === 'rc.deploy.listTargets') return { targets: [] };
  });
  assert.match(textOf(panel.get('catalog-list')), /Demo/);
  assert.match(textOf(panel.get('catalog-status')), /已安裝狀態無法讀取.*部署收據檔不是有效的 JSON/);
  await panel.get('catalog-list').children[0].children.at(-1).fire('click');
  await settle();
  assert.match(textOf(panel.get('details-installed')), /已安裝狀態無法讀取.*部署收據檔不是有效的 JSON/);
  assert.doesNotMatch(textOf(panel.get('details-installed')), /尚未安裝/);
});
