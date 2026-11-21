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

test('依收據顯示每個部署目標版本；新版僅提示，更新後重新讀取清除提示', async t => {
  const e = await setup(t);
  await e.save([e.receipt(), e.receipt({ canonicalRoot: path.join(e.userHome, '.codex-team'), packageVersion: '1.1.0' })]);
  const before = await readFile(path.join(e.home, 'receipts.json'), 'utf8');
  const item = (await e.worker.call('rc.catalog.list', { previewMode: true })).data[0];
  assert.equal(item.installationStatus, 'updateAvailable');
  assert.deepEqual(item.deployments.map(d => [d.version, d.status, d.updateVersion]), [['1.0.0', 'updateAvailable', '1.1.0'], ['1.1.0', 'current', null]]);
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
  assert.equal(result.installationStatus, 'current');
  assert.equal(result.deployments[0].channel, 'release');
  assert.equal(result.deployments[0].contentDiffersFromMarket, false);
  await e.save([e.receipt({ packageVersion: '1.1.0', channel: 'preview', packageSha256: 'c'.repeat(64) })]);
  result = await e.worker.call('rc.package.getDetails', { packageKey: 'demo', previewMode: true });
  assert.equal(result.deployments[0].channel, 'preview');
  assert.equal(result.deployments[0].contentDiffersFromMarket, true);
  assert.equal(result.deployments[0].updateVersion, null);
  await e.save([e.receipt()]);
  result = await e.worker.call('rc.package.getDetails', { packageKey: 'demo', version: '1.0.0' });
  assert.equal(result.deployments[0].updateVersion, '1.1.0', '手選舊版不改更新候選');
  versions[1].isEnabled = false;
  result = await e.worker.call('rc.package.getDetails', { packageKey: 'demo', previewMode: true });
  assert.equal(result.installationStatus, 'current', '停用推薦版回退到 Release，不追較新的 Preview');
});

test('讀取已註冊專案及下架資源的部署，不以偵測到的新根目錄虛構已安裝；損壞收據明確失敗', async t => {
  const e = await setup(t);
  const project = path.join(e.dir, 'project');
  await mkdir(path.join(project, '.lcaipack'), { recursive: true });
  await writeFile(path.join(e.home, 'config.json'), JSON.stringify({ registeredProjects: [project, project] }));
  await writeFile(path.join(project, '.lcaipack', 'receipts.json'), JSON.stringify({ receiptFormatVersion: 1, receipts: [e.receipt({ packageKey: 'removed', scope: 'project', canonicalRoot: project })] }));
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

test('更新摘要列出選定目標舊新版與未選目標原版；套用只改所選位址且更新無內容差異的收據', async t => {
  const e = await setup(t);
  const { zip } = await import('./zip-fixture.mjs');
  const { createHash } = await import('node:crypto');
  const roots = [path.join(e.userHome, '.codex'), path.join(e.userHome, '.codex-team')];
  for (const root of roots) { await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'config.toml'), ''); }
  const bytes = version => zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: 'demo', name: 'Demo', type: 'skill', description: 'Synthetic', version,
    contents: [{ id: 'hello', kind: 'skill', path: 'resources/skills/hello' }] }), 'README.md': '# Demo',
    'resources/skills/hello/SKILL.md': '---\nname: hello\ndescription: Synthetic\n---\nHello\n' });
  const versions = ['1.0.0', '1.1.0'].map(version => ({ version, channel: 'release', isEnabled: true, sha256: createHash('sha256').update(bytes(version)).digest('hex') }));
  e.market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', name: 'Demo', type: 'skill', recommendedVersion: '1.1.0', versions } }));
  for (const v of versions) e.market.override(`GET /api/market/packages/demo/versions/${v.version}/download`, () => ({ status: 200, raw: bytes(v.version), contentType: 'application/zip', headers: { 'X-Checksum-Sha256': v.sha256 } }));
  const { targets } = await e.worker.call('rc.deploy.listTargets', {});
  for (const target of targets) {
    const plan = await e.worker.call('rc.deploy.plan', { packageKey: 'demo', version: '1.0.0', targets: [target.id] });
    assert.equal((await e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [target.id] })).status, 'succeeded');
  }
  const file = path.join(e.home, 'receipts.json');
  const before = JSON.parse(await readFile(file, 'utf8')).receipts;
  const plan = await e.worker.call('rc.deploy.plan', { packageKey: 'demo', version: '1.1.0', targets: [targets[0].id] });
  assert.deepEqual(plan.targets[0].installedVersions, ['1.0.0']);
  assert.equal(plan.targets[0].nextVersion, '1.1.0');
  assert.equal(plan.targets[0].changes[0].change, 'NoOp');
  assert.deepEqual(plan.unchangedDeployments.map(d => [d.id, d.version]), [[targets[1].id, '1.0.0']]);
  assert.equal((await e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [targets[0].id] })).status, 'succeeded');
  const after = JSON.parse(await readFile(file, 'utf8')).receipts;
  assert.equal(after.length, 2);
  assert.equal(after.find(r => r.targetKey === targets[0].id).packageVersion, '1.1.0');
  assert.deepEqual(after.find(r => r.targetKey === targets[1].id), before.find(r => r.targetKey === targets[1].id));
});


test('既有收據根目錄不需符合新安裝偵測規則，更新仍使用同一部署目標；不存在根目錄不重建', async t => {
  const e = await setup(t);
  await mkdir(e.userHome, { recursive: true });
  await e.save([e.receipt({ canonicalRoot: e.userHome })]);
  assert.deepEqual((await e.worker.call('rc.deploy.listTargets', {})).targets, []);
  const result = await e.worker.call('rc.deploy.listTargets', { packageKey: 'demo' });
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].rootPath.toLowerCase(), e.userHome.toLowerCase());
  assert.equal(result.targets[0].origin, 'Receipt');
  assert.deepEqual((await e.worker.call('rc.deploy.listTargets', { packageKey: 'other' })).targets, []);
  await rm(e.userHome, { recursive: true });
  assert.deepEqual((await e.worker.call('rc.deploy.listTargets', { packageKey: 'demo' })).targets, []);
});

test('用戶端版本與已安裝資源版本分開，LC-AI-Pack 版本明確來自市集發行資料', async t => {
  const e = await setup(t);
  const { readFileSync } = await import('node:fs');
  const version = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')).version;
  e.market.override('GET /api/market/client/latest', () => ({ status: 200, body: { product: 'gui', version: '0.9.7', token: 'hidden' } }));
  const result = await e.worker.call('rc.client.getVersions', {});
  assert.deepEqual(result, { orca: { version, source: 'plugin' }, lcAiPack: { version: '0.9.7', source: 'marketRelease', receiptVersion: null } });
  e.market.override('GET /api/market/client/latest', () => ({ status: 404 }));
  assert.equal((await e.worker.call('rc.client.getVersions', {})).lcAiPack.version, null);
});

test('故事 36：LC-AI-Pack 用戶端版本取自共用收據最後部署的用戶端版本；Orca 自己寫的收據不算，收據損壞時不影響版本顯示', async t => {
  const e = await setup(t);
  const { readFileSync } = await import('node:fs');
  const orcaVersion = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')).version;
  e.market.override('GET /api/market/client/latest', () => ({ status: 200, body: { product: 'gui', version: '0.9.9' } }));
  const at = (installedAt, clientVersion, extra = {}) => e.receipt({ installedAt, clientVersion, ...extra });
  await e.save([
    at('2026-10-01T00:00:00+00:00', '0.9.5', { contentId: 'a' }),
    at('2026-11-01T00:00:00+00:00', '0.9.7', { contentId: 'b' }),
    at('2026-11-15T00:00:00+00:00', orcaVersion, { contentId: 'c' })
  ]);
  const result = await e.worker.call('rc.client.getVersions', {});
  assert.deepEqual(result.lcAiPack, { version: '0.9.9', source: 'marketRelease', receiptVersion: '0.9.7' });
  assert.equal(result.orca.version, orcaVersion);
  await writeFile(path.join(e.home, 'receipts.json'), '{broken');
  assert.deepEqual((await e.worker.call('rc.client.getVersions', {})).lcAiPack, { version: '0.9.9', source: 'marketRelease', receiptVersion: null });
});

test('已下架的已裝版本不降版；仍可升至較新版，僅 Preview 時依開關判更新', async t => {
  const e = await setup(t);
  let versions = [{ version: '1.1.0', channel: 'release', isEnabled: true }];
  e.market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', name: 'Demo', recommendedVersion: null, versions } }));
  e.market.override('GET /api/market/packages/demo/versions/1.1.0/readme', () => ({ status: 200, body: { readme: '' } }));
  await e.save([e.receipt({ packageVersion: '2.0.0' })]);
  const detail = await e.worker.call('rc.package.getDetails', { packageKey: 'demo' });
  assert.equal(detail.deployments[0].status, 'unavailable');
  assert.equal(detail.deployments[0].updateVersion, null);
  await e.save([e.receipt()]);
  assert.equal((await e.worker.call('rc.package.getDetails', { packageKey: 'demo' })).deployments[0].updateVersion, '1.1.0');
  versions = [{ version: '1.1.0', channel: 'preview', isEnabled: true }];
  await assert.rejects(e.worker.call('rc.package.getDetails', { packageKey: 'demo' }), { code: 'version_unavailable' });
  assert.equal((await e.worker.call('rc.package.getDetails', { packageKey: 'demo', previewMode: true })).deployments[0].updateVersion, '1.1.0');
});
