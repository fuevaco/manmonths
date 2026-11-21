import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-installed-'));
  const home = path.join(dir, 'state'), userHome = path.join(dir, 'user');
  await mkdir(home, { recursive: true });
  const packages = [{ packageKey: 'demo', name: 'Demo', type: 'skill', latestReleaseVersion: '1.1.0', latestPreviewVersion: '2.0.0' }];
  const market = await startFakeMarket({ packages });
  const worker = startWorker({ deps: { lcaipackHome: home, userHome, env: {} } });
  t.after(async () => { worker.dispose(); await market.close(); await rm(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const receipt = (extra = {}) => ({ packageKey: 'demo', packageVersion: '1.0.0', packageSha256: 'a'.repeat(64), channel: 'release',
    contentId: 'hello', kind: 'skill', hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', canonicalRoot: path.join(userHome, '.codex'), ...extra });
  const save = receipts => writeFile(path.join(home, 'receipts.json'), JSON.stringify({ receiptFormatVersion: 1, receipts }));
  return { dir, home, userHome, market, worker, packages, receipt, save };
}

test('已下架清單與明細提供 statusHint 與識別碼；可見狀態不提供提示', async t => {
  const e = await setup(t);
  const hint = '已自市集下架或你已無權限查看；本機仍可繼續使用與解除安裝';
  await e.save([e.receipt({ packageKey: 'removed' })]);
  const item = (await e.worker.call('rc.catalog.list', { installation: 'installed' })).data[0];
  assert.equal(item.name, 'removed'); assert.equal(item.installationStatus, 'unavailable'); assert.equal(item.statusHint, hint);
  for (const status of [404, 403]) {
    e.market.override('GET /api/market/packages/removed', () => ({ status, body: {} }));
    const detail = await e.worker.call('rc.package.getDetails', { packageKey: 'removed' });
    assert.equal(detail.name, 'removed'); assert.equal(detail.installationStatus, 'unavailable'); assert.equal(detail.statusHint, hint);
    assert.equal(detail.deployments.length, 1); assert.deepEqual(detail.parameters, []);
  }
  // 資源包擁有者或市集管理者仍讀得到主檔（200），但所有版本都已停用：同樣是已下架，不能顯示「請重新選擇版本」
  e.market.override('GET /api/market/packages/removed', () => ({ status: 200, body: { packageKey: 'removed', name: '已停用的資源包', type: 'skill', description: '',
    versions: [{ version: '1.0.0', channel: 'release', isEnabled: false, hosts: ['codex'] }] } }));
  const disabled = await e.worker.call('rc.package.getDetails', { packageKey: 'removed' });
  assert.equal(disabled.name, 'removed'); assert.equal(disabled.installationStatus, 'unavailable'); assert.equal(disabled.statusHint, hint);
  assert.equal(disabled.deployments.length, 1); assert.deepEqual(disabled.parameters, []);
  e.market.override('GET /api/market/packages/removed', () => ({ status: 503, body: {} }));
  await assert.rejects(e.worker.call('rc.package.getDetails', { packageKey: 'removed' }), { code: 'service_unavailable' });
  for (const receipts of [[], [e.receipt()], [e.receipt({ packageVersion: '1.1.0' })], [e.receipt({ packageVersion: '9.0.0' })]]) {
    await e.save(receipts);
    assert.equal(Object.hasOwn((await e.worker.call('rc.catalog.list')).data[0], 'statusHint'), false);
  }
});

test('依收據顯示每個部署目標版本；新版僅提示，更新後重新讀取清除提示', async t => {
  const e = await setup(t);
  await e.save([e.receipt(), e.receipt({ canonicalRoot: path.join(e.userHome, '.codex-team'), packageVersion: '1.1.0' })]);
  const before = await readFile(path.join(e.home, 'receipts.json'), 'utf8');
  const item = (await e.worker.call('rc.catalog.list', { previewMode: true })).data[0];
  assert.equal(item.installationStatus, 'updateAvailable');
  assert.deepEqual(item.deployments.map(d => [d.version, d.status, d.updateVersion]), [['1.0.0', 'updateAvailable', '2.0.0'], ['1.1.0', 'updateAvailable', '2.0.0']]);
  assert.equal(await readFile(path.join(e.home, 'receipts.json'), 'utf8'), before);
  await e.save([e.receipt({ packageVersion: '1.1.0' })]);
  assert.equal((await e.worker.call('rc.catalog.list', {})).data[0].installationStatus, 'current');
  await e.save([]);
  assert.equal((await e.worker.call('rc.catalog.list', {})).data[0].installationStatus, 'notInstalled');
});

test('已安裝與可更新篩選採目標狀態交集；本機來源不參與市集比較，條件型別須驗證', async t => {
  const e = await setup(t);
  e.packages.push({ packageKey: 'other', name: 'Other', type: 'agent', latestReleaseVersion: '1.0.0' });
  await e.save([e.receipt({ source: 'local', packageVersion: '0.1.0' })]);
  assert.deepEqual((await e.worker.call('rc.catalog.list', { installation: 'installed' })).data.map(p => p.packageKey), ['demo']);
  assert.deepEqual((await e.worker.call('rc.catalog.list', { installation: 'updates' })).data, []);
  assert.deepEqual((await e.worker.call('rc.catalog.list', { installation: 'installed', type: 'agent' })).data, []);
  await e.save([e.receipt()]);
  assert.deepEqual((await e.worker.call('rc.catalog.list', { installation: 'updates' })).data.map(p => p.packageKey), ['demo']);
  for (const installation of [true, [], 'unknown']) await assert.rejects(e.worker.call('rc.catalog.list', { installation }), { code: 'invalid_params' });
});

test('詳情採推薦版本判更新；同版同雜湊跟隨市集通道，內容不符另行提示而不假報更新', async t => {
  const e = await setup(t);
  const versions = [
    { version: '2.0.0', channel: 'preview', isEnabled: true, sha256: 'b'.repeat(64) },
    { version: '1.1.0', channel: 'release', isEnabled: true, sha256: 'a'.repeat(64) },
    { version: '1.0.0', channel: 'release', isEnabled: true, sha256: 'a'.repeat(64) }
  ];
  e.market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', name: 'Demo', type: 'skill', recommendedVersion: '1.1.0', versions } }));
  for (const v of versions) e.market.override(`GET /api/market/packages/demo/versions/${v.version}/readme`, () => ({ status: 200, body: { readme: '' } }));
  await e.save([e.receipt({ packageVersion: '1.1.0', channel: 'preview', packageSha256: 'A'.repeat(64) })]);
  let result = await e.worker.call('rc.package.getDetails', { packageKey: 'demo', previewMode: true, version: '1.0.0' });
  assert.equal(result.installationStatus, 'updateAvailable');
  assert.equal(result.deployments[0].channel, 'release');
  assert.equal(result.deployments[0].contentDiffersFromMarket, false);
  await e.save([e.receipt({ packageVersion: '1.1.0', channel: 'preview', packageSha256: 'c'.repeat(64) })]);
  result = await e.worker.call('rc.package.getDetails', { packageKey: 'demo', previewMode: true });
  assert.equal(result.deployments[0].channel, 'preview');
  assert.equal(result.deployments[0].contentDiffersFromMarket, true);
  assert.equal(result.deployments[0].updateVersion, '2.0.0');
  await e.save([e.receipt()]);
  result = await e.worker.call('rc.package.getDetails', { packageKey: 'demo', version: '1.0.0' });
  assert.equal(result.deployments[0].updateVersion, '1.1.0', '手選舊版不改更新候選');
  versions[1].isEnabled = false;
  result = await e.worker.call('rc.package.getDetails', { packageKey: 'demo', previewMode: true });
  assert.equal(result.installationStatus, 'updateAvailable', '停用 Release 後，Preview 開啟仍推薦可見的新版 Preview');
});

test('忽略已註冊專案部署；全域下架資源仍列入已安裝，損壞收據明確失敗', async t => {
  const e = await setup(t);
  const project = path.join(e.dir, 'project');
  await mkdir(path.join(project, '.lcaipack'), { recursive: true });
  await writeFile(path.join(e.home, 'config.json'), JSON.stringify({ registeredProjects: [project, project] }));
  await writeFile(path.join(project, '.lcaipack', 'receipts.json'), JSON.stringify({ receiptFormatVersion: 1, receipts: [e.receipt({ packageKey: 'removed', scope: 'project', canonicalRoot: project })] }));
  assert.deepEqual((await e.worker.call('rc.catalog.list', { installation: 'installed' })).data, []);
  await e.save([e.receipt({ packageKey: 'removed' })]);
  const result = await e.worker.call('rc.catalog.list', { installation: 'installed' });
  assert.deepEqual(result.data.map(p => p.packageKey), ['removed']);
  assert.equal(result.data[0].deployments.length, 1);
  assert.equal(result.data[0].deployments[0].status, 'unavailable');
  assert.equal(result.data[0].deployments[0].version, '1.0.0');
  assert.deepEqual((await e.worker.call('rc.catalog.list', { installation: 'updates' })).data, []);
  assert.deepEqual((await e.worker.call('rc.catalog.list', { installation: 'installed', search: 'demo' })).data, []);
  await writeFile(path.join(e.home, 'receipts.json'), '{broken');
  assert.equal((await e.worker.call('rc.catalog.list', {})).installedError.code, 'receipt_invalid');
  await assert.rejects(e.worker.call('rc.catalog.list', { installation: 'installed' }), { code: 'receipt_invalid' });
});

test('更新所有舊全域部署目標，即使內容相同仍更新收據，已是新版的收據保持不變',async t=>{
 const {setupMulti}=await import('./multi-env.mjs');const e=await setupMulti(t);await e.run();
 const file=path.join(e.lcaipackHome,'receipts.json');const ledger=JSON.parse(await readFile(file,'utf8'));ledger.receipts[0].packageVersion='1.1.0';await writeFile(file,JSON.stringify(ledger));
 const unchanged=ledger.receipts[0];e.recommend('pkg-a','1.1.0');const result=await e.run('pkg-a','update');assert.equal(result.ok,true);assert.equal(result.succeeded.length,2);
 const after=e.receipts();assert.ok(after.every(r=>r.packageVersion==='1.1.0'));assert.deepEqual(after.find(r=>r.targetKey===unchanged.targetKey),unchanged);
});
test('更新時明確排除的根即使有收據也保持原狀', async t => {
  const { setupMulti } = await import('./multi-env.mjs');
  const e = await setupMulti(t);
  await e.run();
  const excluded = e.roots.claudeWork;
  const file = path.join(e.dest(excluded), 'SKILL.md');
  const before = await readFile(file);
  await writeFile(path.join(e.lcaipackHome, 'config.json'), JSON.stringify({ excludedClientRoots: { 'claude-code': [excluded] } }));
  e.recommend('pkg-a', '1.1.0');
  const update = await e.run('pkg-a', 'update');
  assert.equal(update.ok, true);
  assert.equal(update.succeeded.length, 2);
  assert.deepEqual(await readFile(file), before);
});

test('收據中的既有全域根不必符合新安裝偵測規則；不存在的根不重建',async t=>{
 const {setupMulti}=await import('./multi-env.mjs');const {createPathRules}=await import('../worker/deploy/canonical-root.mjs');const rules=createPathRules();const e=await setupMulti(t);await e.run();
 const file=path.join(e.lcaipackHome,'receipts.json');const ledger=JSON.parse(await readFile(file,'utf8'));const old=path.join(e.dir,'legacy');await mkdir(old);
 const r=ledger.receipts.find(r=>r.canonicalRoot===rules.normalize(e.roots.claudeWork));r.canonicalRoot=rules.normalize(old);r.targetKey=`claude-code|claude-code-cli|global|${r.canonicalRoot}`;r.destinationPath=path.join(r.canonicalRoot,'skills','demo-skill');r.normalizedAddress=`${r.targetKey}|demo-skill`;
 await writeFile(file,JSON.stringify(ledger));await rm(e.roots.claudeWork,{recursive:true});e.recommend('pkg-a','1.1.0');
 const result=await e.run('pkg-a','update');assert.equal(result.ok,true);assert.ok(result.succeeded.some(t=>rules.normalize(t.rootPath)===rules.normalize(old)));
 await rm(old,{recursive:true});assert.equal((await e.run('pkg-a','reapply')).succeeded.length,2);
 await assert.rejects(readFile(old),{code:'ENOENT'});
});

test('Orca 只顯示外掛版本；既有部署用戶端版本及收據損壞不影響版本顯示', async t => {
  const e = await setup(t);
  const { readFileSync } = await import('node:fs');
  const version = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')).version;
  await e.save([e.receipt({ installedAt: '2026-11-01T00:00:00+00:00', clientVersion: '0.9.7' })]);
  assert.deepEqual(await e.worker.call('rc.client.getVersions'), { orca: { version, source: 'plugin' } });
  await writeFile(path.join(e.home, 'receipts.json'), '{broken');
  assert.deepEqual(await e.worker.call('rc.client.getVersions'), { orca: { version, source: 'plugin' } });
  assert.equal(e.market.requests.some(r => r.path.includes('/api/market/client/latest')), false);
});

test('已下架的已裝版本不降版；仍可升至較新版，僅 Preview 時依開關判更新', async t => {
  const e = await setup(t);
  let versions = [{ version: '1.1.0', channel: 'release', isEnabled: true }];
  e.market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', name: 'Demo', recommendedVersion: null, versions } }));
  e.market.override('GET /api/market/packages/demo/versions/1.1.0/readme', () => ({ status: 200, body: { readme: '' } }));
  await e.save([e.receipt({ packageVersion: '2.0.0' })]);
  const detail = await e.worker.call('rc.package.getDetails', { packageKey: 'demo' });
  assert.equal(detail.deployments[0].status, 'newer');
  assert.equal(detail.deployments[0].updateVersion, null);
  await e.save([e.receipt()]);
  assert.equal((await e.worker.call('rc.package.getDetails', { packageKey: 'demo' })).deployments[0].updateVersion, '1.1.0');
  versions = [{ version: '1.1.0', channel: 'preview', isEnabled: true }];
  await assert.rejects(e.worker.call('rc.package.getDetails', { packageKey: 'demo' }), { code: 'version_unavailable' });
  assert.equal((await e.worker.call('rc.package.getDetails', { packageKey: 'demo', previewMode: true })).deployments[0].updateVersion, '1.1.0');
});
