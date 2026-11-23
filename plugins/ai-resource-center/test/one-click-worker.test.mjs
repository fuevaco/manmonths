import { createPathRules } from '../worker/deploy/canonical-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startWorker, status } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';

const key = 'one-click';
async function environment(t, { setup, hosts = ['codex'], type = 'skill', deps = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-one-click-'));
  const userHome = path.join(dir, 'user'), lcaipackHome = path.join(dir, 'shared');
  function root(name) { const p = path.join(userHome, name); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, name.startsWith('.codex') ? 'config.toml' : 'settings.json'), ''); return p; }
  root('.codex'); root('.claude');
  let recommended = '1.0.0';
  const versions = ['1.0.0', '2.0.0', '3.0.0-preview.1', '4.0.0'].map(version => {
    const contents = type === 'mcp' ? [{ id: 'echo', name: 'Echo', kind: 'mcp', definition: { transport: 'stdio', command: 'echo', args: ['hello'] } }] : [{ id: 'hello', kind: 'skill', path: 'resources/hello' }];
    const bytes = zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key, name: '合成包', type, version, description: 'Synthetic', contents, ...(setup ? { setup } : {}) }), 'README.md': '# Hello', 'resources/hello/SKILL.md': '---\nname: hello\ndescription: Synthetic\n---\nHello', 'setup/init.ps1': 'exit 0' });
    return { version, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), hosts, isEnabled: true, channel: version.includes('preview') ? 'preview' : 'release' };
  });
  const market = await startFakeMarket();
  market.override('GET /api/market/packages', () => ({ status: 200, body: { data: [{ packageKey: key, name: '合成包', type, latestReleaseVersion: recommended, latestPreviewVersion: '3.0.0-preview.1' }], meta: { total: 1 } } }));
  market.override(`GET /api/market/packages/${key}`, () => ({ status: 200, body: { packageKey: key, name: '合成包', type, recommendedVersion: recommended, versions: versions.filter(v => v.channel === 'preview' || v.version <= recommended).map(({ bytes, ...v }) => v) } }));
  for (const v of versions) {
    market.override(`GET /api/market/packages/${key}/versions/${v.version}/download`, () => ({ status: 200, raw: v.bytes, contentType: 'application/zip' }));
    market.override(`GET /api/market/packages/${key}/versions/${v.version}/readme`, () => ({ status: 200, body: { readme: '# Hello' } }));
  }
  const worker = startWorker({ deps: { userHome, lcaipackHome, env: {}, secretStore: memoryStore(), ...deps } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { worker, root, userHome, lcaipackHome, market, recommend(v) { recommended = v; }, run: input => worker.call('rc.install.run', { packageKey: key, ...input }), detail: () => worker.call('rc.package.getDetails', { packageKey: key }), list: async input => (await worker.call('rc.catalog.list', input ?? {})).data };
}

test('外掛內更新成功後立即重核收據，狀態列與面板摘要一起歸零', async t => {
  const e = await environment(t);
  await e.run({ action: 'install' }); e.recommend('2.0.0');
  await e.worker.call('rc.updates.checkNow');
  assert.equal(status(e.worker).text, '1');
  assert.equal((await e.run({ action: 'update' })).ok, true);
  assert.equal(status(e.worker).visible, false);
  assert.equal((await e.worker.call('rc.updates.summary')).count, 0);
});

for (const action of ['install', 'uninstall']) {
  test(`外掛內${action === 'install' ? '安裝' : '解除安裝'}成功後立即移除過時的狀態列更新數`, async t => {
    const e = await environment(t);
    await e.run({ action: 'install' }); e.recommend('2.0.0');
    await e.worker.call('rc.updates.checkNow');
    assert.equal(status(e.worker).text, '1');
    assert.equal((await e.run({ action })).ok, true);
    assert.equal(status(e.worker).visible, false);
    assert.equal((await e.worker.call('rc.updates.summary')).count, 0);
  });
}

test('一鍵安裝直接套用所有Codex 共用技能，不部署不相容工具', async t => {
  const e = await environment(t); e.root('.codex-work');
  const result = await e.run({ action: 'install' });
  assert.equal(result.ok, true); assert.equal(result.succeeded.length, 1); assert.deepEqual(result.failed, []);
  const detail = await e.detail();
  assert.equal(detail.deployments.length, 1); assert.ok(detail.deployments.every(d => d.hostId === 'codex' && d.scope === 'global'));
});

test('缺少必要參數只要求 missingParameters 確認，不寫入；已儲存值直接沿用', async t => {
  const e = await environment(t, { setup: { parameters: [{ parameterId: 'endpoint', label: '服務', type: 'string', required: true }] } });
  const first = await e.run({ action: 'install' });
  assert.equal(first.needsConfirmation, true); assert.deepEqual(first.reasons, ['missingParameters']);
  assert.equal(first.allBlocked, false); assert.equal(first.plan.missingParameters[0].parameterId, 'endpoint');
  assert.equal((await e.detail()).deployments.length, 0);
  await e.worker.call('rc.install.saveSetup', { packageKey: key, values: { endpoint: 'https://synthetic.example' } });
  assert.equal((await e.run({ action: 'install', confirmedPlanId: first.planId })).ok, true);
  assert.equal((await e.detail()).parameters[0].value, 'https://synthetic.example');
});

test('設定命令先列出用途，確認後才執行與安裝', async t => {
  let executions = 0;
  const e = await environment(t, { setup: { commands: [{ commandId: 'init', name: '準備環境', runner: 'powershell', script: 'setup/init.ps1' }] }, deps: {
    runners: { resolve: runner => ({ runner, executable: '/fake/powershell', leadingArguments: [] }) },
    setupEnvironment: { operatingSystem: 'windows', architecture: 'x64' },
    commandExecutor: { run: async () => { executions++; return { succeeded: true, outcome: 'succeeded', exitCode: 0 }; } }
  } });
  const first = await e.run({ action: 'install' });
  assert.deepEqual(first.reasons, ['setupCommands']); assert.equal(executions, 0);
  assert.equal(first.plan.setupCommands[0].name, '準備環境');
  const result = await e.run({ action: 'install', confirmedPlanId: first.planId });
  assert.equal(result.ok, true); assert.equal(executions, 1);
});

test('一鍵安裝可按資源包取消設定，未部署且保留可重試的部署目標', async t => {
  let started;
  let executions = 0;
  const running = new Promise(resolve => { started = resolve; });
  const e = await environment(t, { setup: { commands: [{ commandId: 'init', name: '準備', runner: 'powershell', script: 'setup/init.ps1' }] }, deps: {
    runners: { resolve: runner => ({ runner, executable: '/fake/powershell', leadingArguments: [] }) },
    setupEnvironment: { operatingSystem: 'windows', architecture: 'x64' },
    commandExecutor: { run: async ({ signal }) => {
      if (++executions > 1) return { succeeded: true, outcome: 'succeeded', exitCode: 0 };
      started();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { succeeded: false, outcome: 'Cancelled', exitCode: null, durationMs: 1, failureSummary: '使用者取消' };
    } }
  } });
  assert.deepEqual(await e.worker.call('rc.install.cancel', { packageKey: key }), { cancelled: false });
  const review = await e.run({ action: 'install' });
  const resultPromise = e.run({ action: 'install', confirmedPlanId: review.planId });
  await running;
  try {
    assert.deepEqual(await e.worker.call('rc.install.cancel', { packageKey: 'another-package' }), { cancelled: false });
    assert.deepEqual(await e.worker.call('rc.install.cancel', { packageKey: key }), { cancelled: true });
  } finally { await e.worker.call('rc.install.cancel', { packageKey: key }); }
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.deepEqual(result.succeeded, []);
  assert.equal(result.failed[0].reason, '已取消設定，尚未完成安裝');
  assert.equal(result.failed[0].detail[0].code, 'deployment.setup-cancelled');
  const detail = await e.detail();
  assert.deepEqual(detail.deployments, []);
  assert.equal(detail.lastFailure.count, 1);
  assert.equal(fs.existsSync(path.join(e.userHome, '.codex', 'skills', 'hello')), false);
  assert.deepEqual(await e.worker.call('rc.install.cancel', { packageKey: key }), { cancelled: false });
  const retryInput = { action: 'retry', targetIds: result.failed.map(t => t.targetId) };
  const retry = await e.run(retryInput);
  assert.equal((await e.run({ ...retryInput, confirmedPlanId: retry.planId })).ok, true);
  assert.equal((await e.detail()).lastFailure, null);
});

test('待補裝目標不算更新，補裝沿用最高已裝版本；有新版時更新一併補齊', async t => {
  const e = await environment(t, { hosts: ['claude-code'] });
  await e.run({ action: 'install' }); e.root('.claude-work');
  let item = (await e.list())[0];
  assert.equal(item.installationStatus, 'current'); assert.equal(item.pendingTargets.count, 1);
  assert.equal(item.pendingTargets.targets[0].label, 'Claude Code');
  assert.equal((await e.list({ installation: 'updates' })).length, 0);
  assert.equal((await e.detail()).pendingTargets.count, 1);
  assert.equal((await e.run({ action: 'update' })).succeeded.length, 0);
  assert.equal((await e.detail()).pendingTargets.count, 1);
  e.recommend('2.0.0');
  const fill = await e.run({ action: 'fillPending' });
  assert.equal(fill.succeeded.length, 1);
  assert.ok((await e.detail()).deployments.every(d => d.version === '1.0.0'));
  e.root('.claude-third');
  const update = await e.run({ action: 'update' });
  assert.equal(update.succeeded.length, 3);
  assert.ok((await e.detail()).deployments.every(d => d.version === '2.0.0'));
  assert.equal((await e.detail()).pendingTargets.count, 0);
});

test('取消分版本重新套用後，不再執行後續版本的設定命令', async t => {
  let pause = false, started, executions = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const e = await environment(t, { hosts: ['claude-code'], setup: { commands: [{ commandId: 'init', name: '準備', runner: 'powershell', script: 'setup/init.ps1' }] }, deps: {
    runners: { resolve: runner => ({ runner, executable: '/fake/powershell', leadingArguments: [] }) },
    setupEnvironment: { operatingSystem: 'windows', architecture: 'x64' },
    commandExecutor: { run: async ({ signal }) => {
      executions++;
      if (!pause) return { succeeded: true, outcome: 'succeeded', exitCode: 0 };
      started();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { succeeded: false, outcome: 'Cancelled', exitCode: null, durationMs: 1 };
    } }
  } });
  const first = await e.run({ action: 'install' });
  await e.run({ action: 'install', confirmedPlanId: first.planId });
  const root = e.root('.claude-work'); e.recommend('2.0.0');
  fs.renameSync(path.join(e.userHome, '.claude'), path.join(e.userHome, 'old-root'));
  const install = await e.run({ action: 'install' });
  await e.run({ action: 'install', confirmedPlanId: install.planId });
  fs.renameSync(path.join(e.userHome, 'old-root'), path.join(e.userHome, '.claude'));
  const before = executions;
  const review = await e.run({ action: 'reapply' });
  pause = true;
  const operation = e.run({ action: 'reapply', confirmedPlanId: review.planId });
  await entered;
  await e.worker.call('rc.install.cancel', { packageKey: key });
  const result = await operation;
  assert.equal(executions, before + 1);
  assert.equal(result.failed.length, 2);
  assert.ok(result.failed.every(t => t.reason === '已取消設定，尚未完成安裝'));
  assert.deepEqual((await e.detail()).deployments.map(t => t.version).sort(), ['1.0.0', '2.0.0']);
});

test('重新套用依已安裝版本分組，補裝選多個已安裝版本中的最新版', async t => {
  const e = await environment(t, { hosts: ['claude-code'] }); await e.run({ action: 'install' });
  e.recommend('2.0.0');
  e.root('.claude-work');
  fs.renameSync(path.join(e.userHome, '.claude'), path.join(e.userHome, 'old-root'));
  await e.run({ action: 'install' });
  fs.renameSync(path.join(e.userHome, 'old-root'), path.join(e.userHome, '.claude'));
  e.root('.claude-third');
  const reapply = await e.run({ action: 'reapply' });
  assert.equal(reapply.succeeded.length, 2);
  assert.deepEqual((await e.detail()).deployments.map(d => d.version).sort(), ['1.0.0', '2.0.0']);
  await e.run({ action: 'fillPending' });
  assert.equal((await e.detail()).deployments.find(d => d.rootPath.endsWith('.claude-third')).version, '2.0.0');
});

test('確認過的受阻位置略過並持久化，不列失敗或待補裝；下次安裝重新規劃', async t => {
  const e = await environment(t, { hosts: ['claude-code'] }); await e.run({ action: 'install' });
  const receiptFile = path.join(e.lcaipackHome, 'receipts.json');
  const ledger = JSON.parse(fs.readFileSync(receiptFile));
  ledger.receipts[0].packageKey = 'another-package'; fs.writeFileSync(receiptFile, JSON.stringify(ledger));
  e.root('.claude-work');
  const first = await e.run({ action: 'install' });
  assert.deepEqual(first.reasons, ['blockedTargets']);
  const result = await e.run({ action: 'install', confirmedPlanId: first.planId });
  assert.equal(result.ok, true); assert.equal(result.succeeded.length, 1); assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, first.plan.blockedTargets);
  assert.equal(result.skipped[0].reason, '這個位置已有其他資源包『another-package』安裝的同名內容');
  assert.equal(e.worker.state.storage.has(`resource-center.lastFailure.${key}`), false);
  for (const item of [(await e.list())[0], await e.detail()]) {
    assert.equal(item.lastFailure, null); assert.deepEqual(item.lastSkipped, { count: 1, targets: result.skipped });
    assert.deepEqual(item.pendingTargets, { count: 0, targets: [] });
  }
  const restarted = startWorker({ state: e.worker.state, deps: { userHome: e.userHome, lcaipackHome: e.lcaipackHome, env: {} } });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.call('rc.package.getDetails', { packageKey: key })).lastSkipped.count, 1);
  const again = await e.run({ action: 'install' });
  assert.equal((await e.run({ action: 'install', confirmedPlanId: again.planId })).skipped.length, 1);
  const current = JSON.parse(fs.readFileSync(receiptFile)); current.receipts = current.receipts.filter(r => r.packageKey !== 'another-package');
  fs.writeFileSync(receiptFile, JSON.stringify(current));
  assert.equal((await e.run({ action: 'fillPending' })).succeeded.length, 1);
  assert.equal((await e.detail()).lastSkipped, null);
  assert.equal((await e.detail()).deployments.length, 2);
});

test('全部受阻只回原因且不可確認，不套用任何位置', async t => {
  const e = await environment(t); await e.run({ action: 'install' });
  const file = path.join(e.lcaipackHome, 'receipts.json'); const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  ledger.receipts[0].packageKey = 'another-package'; fs.writeFileSync(file, JSON.stringify(ledger));
  const result = await e.run({ action: 'install' });
  assert.equal(result.allBlocked, true); assert.equal(result.needsConfirmation, false); assert.equal(result.planId, null);
  assert.equal(result.plan.blockedTargets.length, 1);
  assert.equal(result.plan.blockedTargets[0].reason, '這個位置已有其他資源包『another-package』安裝的同名內容');
  assert.equal(result.plan.blockedTargets[0].detail[0].code, 'deployment.ownership-collision');
});

test('既有可備份衝突直接安裝，結果附備份位置', async t => {
  const e = await environment(t);
  const destination = path.join(e.userHome, '.agents', 'skills', 'hello'); fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'SKILL.md'), '本機內容');
  const result = await e.run({ action: 'install' });
  assert.equal(result.ok, true); assert.ok(result.backups.length > 0);
  assert.ok(fs.existsSync(result.backups[0].backupPath));
  assert.ok((await e.detail()).deployments[0].backupPaths.includes(result.backups[0].backupPath));
});

test('設定明細秘密只回 isSet，儲存後重新套用保留版本並讀到新的一般值', async t => {
  const e = await environment(t, { setup: { parameters: [{ parameterId: 'endpoint', label: '服務', type: 'string', default: 'before' }, { parameterId: 'token', label: '密鑰', type: 'secret', secretUsage: 'setup-time', required: false }] } });
  await e.run({ action: 'install' });
  const saved = await e.worker.call('rc.install.saveSetup', { packageKey: key, values: { endpoint: 'after' }, secrets: { token: 'canary-one-click-secret' } });
  const secret = saved.parameters.find(p => p.parameterId === 'token');
  assert.equal(secret.isSet, true); assert.equal('value' in secret, false);
  assert.equal((await e.detail()).parameters.find(p => p.parameterId === 'token').isSet, true);
  e.recommend('2.0.0');
  assert.equal((await e.run({ action: 'reapply' })).ok, true);
  assert.equal((await e.detail()).deployments[0].version, '1.0.0');
  assert.equal([...e.worker.state.transcript, ...e.worker.state.logs].join('\n').includes('canary-one-click-secret'), false);
});

test('showPreview 安裝最新 Preview，關閉後補裝仍沿用已安裝 Preview', async t => {
  const e = await environment(t, { type: 'mcp' });
  await e.worker.call('rc.preferences.set', { showPreview: true });
  await e.run({ action: 'install' });
  assert.equal((await e.detail()).deployments[0].version, '3.0.0-preview.1');
  await e.worker.call('rc.preferences.set', { showPreview: false }); e.root('.codex-work');
  assert.equal((await e.run({ action: 'fillPending' })).ok, true);
  assert.ok((await e.detail()).deployments.every(d => d.version === '3.0.0-preview.1'));
});

for (const [release, expected] of [['2.0.0', '3.0.0-preview.1'], ['4.0.0', '4.0.0']]) {
  test(`Preview 開啟：Release ${release} 的清單、明細、更新檢查與實際更新皆選 ${expected}`, async t => {
    const e = await environment(t);
    if (release === '4.0.0') await e.worker.call('rc.preferences.set', { showPreview: true });
    await e.run({ action: 'install' });
    assert.equal((await e.detail()).deployments[0].version, release === '4.0.0' ? '3.0.0-preview.1' : '1.0.0');
    e.recommend(release);
    await e.worker.call('rc.preferences.set', { showPreview: true });
    assert.equal((await e.list())[0].latestVisibleVersion, expected);
    assert.equal((await e.worker.call('rc.package.getDetails', { packageKey: key, previewMode: true })).recommendedVersion, expected);
    assert.equal((await e.detail()).recommendedVersion, expected, '明細省略 Preview 時沿用偏好');
    const check = await e.worker.call('rc.updates.checkNow');
    assert.equal(check.packages[0].updateVersion, expected);
    assert.equal((await e.run({ action: 'update' })).succeeded.length, 1);
    assert.equal((await e.detail()).deployments[0].version, expected);
    assert.equal((await e.list())[0].installationStatus, 'current');
  });
}

test('Preview 關閉時，四個入口一致選 Release，不安裝較新的 Preview', async t => {
  const e = await environment(t);
  await e.run({ action: 'install' });
  e.recommend('2.0.0');
  assert.equal((await e.list())[0].latestVisibleVersion, '2.0.0');
  assert.equal((await e.detail()).recommendedVersion, '2.0.0');
  assert.equal((await e.worker.call('rc.updates.checkNow')).packages[0].updateVersion, '2.0.0');
  assert.equal((await e.run({ action: 'update' })).succeeded.length, 1);
  assert.equal((await e.detail()).deployments[0].version, '2.0.0');
});

test('不接受專案範圍、手選安裝目標或未經確認的計畫', async t => {
  const e = await environment(t);
  for (const input of [{ action: 'install', scope: 'project' }, { action: 'install', targetIds: ['x'] }, { action: 'install', targets: ['x'] }, { action: 'retry', targetIds: [] }]) await assert.rejects(e.run(input), { code: 'invalid_params' });
  await assert.rejects(e.run({ action: 'install', confirmedPlanId: 'unknown' }), { code: 'plan_stale' });
});

test('Claude Desktop 只有 MCP 列入安裝，工具名稱保持友善', async t => {
  for (const type of ['skill', 'mcp']) {
    const e = await environment(t, { type, hosts: ['claude-code'] });
    fs.mkdirSync(path.join(e.userHome, 'AppData', 'Local', 'Packages', 'Claude_synthetic'), { recursive: true });
    fs.mkdirSync(path.join(e.userHome, 'AppData', 'Roaming', 'Claude'), { recursive: true });
    const result = await e.run({ action: 'install' });
    assert.equal(result.ok, true);
    // 這裡建立的是 Windows 的 Claude Desktop 安裝樹；Linux 沒有 Claude Desktop（ADR-0005），一律不列入。
    const desktop = type === 'mcp' && process.platform === 'win32';
    assert.equal(result.succeeded.some(t => t.hostId === 'claude-desktop'), desktop);
    if (desktop) assert.equal(result.succeeded.find(t => t.hostId === 'claude-desktop').label, 'Claude Desktop');
  }
});

test('確認後狀態改變而仍有設定命令時回傳新確認，登出後舊確認失效', async t => {
  let executions = 0;
  const e = await environment(t, { setup: { commands: [{ commandId: 'init', name: '準備', runner: 'powershell', script: 'setup/init.ps1' }] }, deps: {
    runners: { resolve: runner => ({ runner, executable: '/fake/powershell', leadingArguments: [] }) },
    setupEnvironment: { operatingSystem: 'windows', architecture: 'x64' },
    commandExecutor: { run: async () => { executions++; return { succeeded: true, outcome: 'succeeded', exitCode: 0 }; } }
  } });
  const first = await e.run({ action: 'install' });
  const dest = path.join(e.userHome, '.agents', 'skills', 'hello'); fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'SKILL.md'), '本機修改');
  const second = await e.run({ action: 'install', confirmedPlanId: first.planId });
  assert.equal(second.needsConfirmation, true); assert.notEqual(second.planId, first.planId); assert.equal(executions, 0);
  await e.worker.call('rc.session.signOut', {});
  await assert.rejects(e.run({ action: 'install', confirmedPlanId: second.planId }), { code: 'plan_stale' });
});

test('只安裝在專案的收據不產生待補裝目標；安裝仍只寫全域收據', async t => {
  const e = await environment(t); const project = path.join(e.userHome, 'synthetic-project'); fs.mkdirSync(project);
  fs.mkdirSync(e.lcaipackHome, { recursive: true });
  fs.writeFileSync(path.join(e.lcaipackHome, 'receipts.json'), JSON.stringify({ receiptFormatVersion: 1, receipts: [
    { packageKey: key, packageVersion: '1.0.0', hostId: 'codex', surfaceId: 'codex-cli', scope: 'project', canonicalRoot: project }
  ] }));
  const before = (await e.list())[0]; assert.equal(before.installationStatus, 'notInstalled'); assert.equal(before.pendingTargets.count, 0);
  assert.equal((await e.run({ action: 'fillPending' })).succeeded.length, 0);
  assert.equal((await e.run({ action: 'install' })).succeeded.length, 1);
  assert.equal((await e.detail()).deployments[0].scope, 'global');
});


test('設定命令失敗逐一回傳原因；重開 worker 仍可重試原版本，成功後清除紀錄', async t => {
  const runners = { resolve: runner => ({ runner, executable: '/fake/powershell', leadingArguments: [] }) };
  const setupEnvironment = { operatingSystem: 'windows', architecture: 'x64' };
  const e = await environment(t, { setup: { commands: [{ commandId: 'init', name: '準備', runner: 'powershell', script: 'setup/init.ps1' }] }, deps: {
    runners, setupEnvironment, commandExecutor: { run: async () => ({ succeeded: false, outcome: 'Completed', exitCode: 17, failureSummary: '設定命令以非零 exit code 17 結束；詳細輸出見 operation log。' }) }
  } });
  const first = await e.run({ action: 'install' });
  const failed = await e.run({ action: 'install', confirmedPlanId: first.planId });
  assert.equal(failed.ok, false); assert.equal(failed.failed.length, 1);
  assert.equal(failed.failed[0].reason, '設定命令「準備」執行失敗：結束代碼 17');
  assert.equal(failed.failed[0].detail[0].code, 'deployment.setup-command-failed');
  e.worker.dispose(); e.recommend('2.0.0');
  const restarted = startWorker({ state: e.worker.state, deps: { userHome: e.userHome, lcaipackHome: e.lcaipackHome, env: {}, runners, setupEnvironment,
    commandExecutor: { run: async () => ({ succeeded: true, outcome: 'succeeded', exitCode: 0 }) } } });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.call('rc.catalog.list', {})).data[0].lastFailure.count, 1);
  const input = { packageKey: key, action: 'retry', targetIds: failed.failed.map(t => t.targetId) };
  const review = await restarted.call('rc.install.run', input);
  assert.equal(review.needsConfirmation, true);
  const result = await restarted.call('rc.install.run', { ...input, confirmedPlanId: review.planId });
  assert.equal(result.ok, true);
  const detail = await restarted.call('rc.package.getDetails', { packageKey: key });
  assert.equal(detail.lastFailure, null); assert.equal(detail.deployments[0].version, '1.0.0');
});

test('待補裝排除失敗的部署目標，保留其他待補裝目標；失敗紀錄清除而仍未部署時重新計入', async t => {
  const e = await environment(t, { type: 'mcp' }); await e.run({ action: 'install' });
  const root = e.root('.codex-failed');
  const failed = { id: `codex|codex-cli|global|${createPathRules().normalize(root)}` };
  e.worker.state.storage.set(`resource-center.lastFailure.${key}`, { action: 'install', targets: [
    { targetId: failed.id, hostId: 'codex', label: 'Codex', rootPath: root, reason: '測試失敗', version: '1.0.0', deployAction: 'install' }
  ] });
  e.root('.codex-new');
  assert.equal((await e.list())[0].pendingTargets.count, 1);
  assert.equal((await e.detail()).pendingTargets.targets[0].rootPath.endsWith('.codex-new'), true);
  const fill = await e.run({ action: 'fillPending' });
  assert.equal(fill.succeeded.length, 1);
  assert.equal(fill.succeeded[0].rootPath.endsWith('.codex-new'), true);
  assert.equal((await e.detail()).lastFailure.count, 1);
  assert.deepEqual((await e.detail()).pendingTargets, { count: 0, targets: [] });
  e.worker.state.storage.delete(`resource-center.lastFailure.${key}`);
  assert.equal((await e.list())[0].pendingTargets.count, 1);
  assert.equal((await e.detail()).pendingTargets.targets[0].targetId, failed.id);
});

test('設定檔無法安全修改時顯示檔名，詳細規則保留於 detail', async t => {
  const e = await environment(t, { type: 'mcp' });
  fs.writeFileSync(path.join(e.userHome, '.codex', 'config.toml'), '[invalid');
  const result = await e.run({ action: 'install' });
  assert.equal(result.allBlocked, true);
  assert.equal(result.plan.blockedTargets[0].reason, '這個位置的設定檔無法安全修改（config.toml）');
  assert.equal(result.plan.blockedTargets[0].detail[0].code, 'deployment.config-conflict');
});

test('無法建立備份時停止，顯示資料保護原因且保留原內容', async t => {
  const e = await environment(t, { hosts: ['claude-code'] });
  const destination = path.join(e.userHome, '.claude', 'skills', 'hello');
  fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'SKILL.md'), '原內容');
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, target, ...args) => {
    if (target.startsWith(path.join(e.lcaipackHome, 'backups') + path.sep)) {
      throw Object.assign(new Error('EACCES: permission denied, copyfile'), { code: 'EACCES' });
    }
    return copy(source, target, ...args);
  });
  const result = await e.run({ action: 'install' });
  assert.equal(result.ok, false);
  assert.equal(result.failed[0].reason, '無法先備份這個位置的現有內容，為避免遺失資料已停止');
  assert.equal(result.failed[0].detail[0].code, 'deployment.apply-failed');
  assert.match(result.failed[0].detail[0].explanation, /EACCES/);
  assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '原內容');
});

test('重新安裝已完成設定命令的組合包直接完成，不再因略過的命令確認', async t => {
  let executions = 0;
  const e = await environment(t, { type: 'bundle', setup: { commands: [{ commandId: 'init', name: '準備環境', runner: 'powershell', script: 'setup/init.ps1' }] }, deps: {
    runners: { resolve: runner => ({ runner, executable: '/fake/powershell', leadingArguments: [] }) },
    setupEnvironment: { operatingSystem: 'windows', architecture: 'x64' },
    commandExecutor: { run: async () => { executions++; return { succeeded: true, outcome: 'succeeded', exitCode: 0 }; } }
  } });
  const review = await e.run({ action: 'install' });
  assert.equal((await e.run({ action: 'install', confirmedPlanId: review.planId })).ok, true);
  assert.equal((await e.run({ action: 'uninstall' })).ok, true);
  const result = await e.run({ action: 'install' });
  assert.equal(result.needsConfirmation, undefined); assert.equal(result.ok, true);
  assert.equal(result.succeeded.length, 1); assert.equal(executions, 1);
});

test('面板路徑沿用偵測根目錄大小寫，涵蓋待補裝、部署、確認、略過及失敗', async t => {
  const e = await environment(t, { hosts: ['claude-code'] }); await e.run({ action: 'install' });
  const root = e.root('.claude-Work');
  assert.equal((await e.detail()).pendingTargets.targets[0].rootPath, root);
  await e.run({ action: 'fillPending' });
  for (const item of [(await e.list())[0], await e.detail()]) assert.equal(item.deployments.find(d => d.rootPath.toLowerCase() === root.toLowerCase()).rootPath, root);
  const file = path.join(e.lcaipackHome, 'receipts.json'), ledger = JSON.parse(fs.readFileSync(file));
  const r = ledger.receipts.find(r => r.canonicalRoot.toLowerCase() === root.toLowerCase());
  const canonical = r.canonicalRoot; r.packageKey = 'another-package'; fs.writeFileSync(file, JSON.stringify(ledger));
  const review = await e.run({ action: 'install' }); assert.equal(review.plan.blockedTargets[0].rootPath, root);
  const skipped = await e.run({ action: 'install', confirmedPlanId: review.planId }); assert.equal(skipped.skipped[0].rootPath, root);
  assert.equal((await e.detail()).lastSkipped.targets[0].rootPath, root);
  const doc = JSON.parse(fs.readFileSync(file)); doc.receipts = doc.receipts.filter(r => r.packageKey !== 'another-package'); fs.writeFileSync(file, JSON.stringify(doc));
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (dest, ...args) => {
    if (String(dest).toLowerCase().startsWith(root.toLowerCase()) && String(dest).endsWith('SKILL.md')) throw new Error('合成寫入失敗');
    return write(dest, ...args);
  });
  const result = await e.run({ action: 'fillPending' });
  assert.equal(result.failed[0].rootPath, root);
  assert.equal((await e.detail()).lastFailure.targets[0].rootPath, root);
  assert.equal(canonical, createPathRules().normalize(root));
  assert.equal(JSON.parse(fs.readFileSync(file)).receipts.some(r => r.canonicalRoot === canonical), false);
});

for (const action of ['update', 'reapply', 'fillPending']) {
  test(`${action} 重新規劃上次略過的位置，解除阻擋後正常處理`, async t => {
    const e = await environment(t, { hosts: ['claude-code'] }); await e.run({ action: 'install' });
    const file = path.join(e.lcaipackHome, 'receipts.json');
    const ledger = JSON.parse(fs.readFileSync(file)); ledger.receipts[0].packageKey = 'another-package'; fs.writeFileSync(file, JSON.stringify(ledger));
    e.root('.claude-work');
    const review = await e.run({ action: 'install' }); await e.run({ action: 'install', confirmedPlanId: review.planId });
    if (action === 'update') e.recommend('2.0.0');
    const blocked = await e.run({ action });
    assert.ok(blocked.reasons.includes('blockedTargets'));
    if (blocked.needsConfirmation) assert.equal((await e.run({ action, confirmedPlanId: blocked.planId })).skipped.length, 1);
    assert.equal((await e.detail()).lastSkipped.count, 1);
    const doc = JSON.parse(fs.readFileSync(file)); doc.receipts = doc.receipts.filter(r => r.packageKey !== 'another-package'); fs.writeFileSync(file, JSON.stringify(doc));
    const result = await e.run({ action });
    assert.equal(result.ok, true); assert.ok(result.succeeded.some(t => t.rootPath.endsWith('.claude')));
    assert.equal((await e.detail()).lastSkipped, null);
  });
}

test('解除安裝成功清除本包略過紀錄，不影響其他資源包的紀錄', async t => {
  const e = await environment(t); await e.run({ action: 'install' });
  e.worker.state.storage.set(`resource-center.lastSkipped.${key}`, { targets: [{ targetId: 'old', reason: '舊原因', rootPath: 'old' }] });
  e.worker.state.storage.set('resource-center.lastSkipped.other', { targets: [{ targetId: 'other' }] });
  assert.equal((await e.run({ action: 'uninstall' })).ok, true);
  assert.equal((await e.detail()).lastSkipped, null);
  assert.equal(e.worker.state.storage.has('resource-center.lastSkipped.other'), true);
});

test('只重試執行失敗的位置時保留未重試的略過紀錄，不讓受阻根重新變成待補裝', async t => {
  const e = await environment(t, { hosts: ['claude-code'] }); await e.run({ action: 'install' });
  const file = path.join(e.lcaipackHome, 'receipts.json'), ledger = JSON.parse(fs.readFileSync(file));
  ledger.receipts[0].packageKey = 'another-package'; fs.writeFileSync(file, JSON.stringify(ledger));
  e.root('.claude-work'); e.root('.claude-third');
  const review = await e.run({ action: 'install' });
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (dest, ...args) => {
    if (String(dest).includes('.claude-third') && String(dest).endsWith('SKILL.md')) throw new Error('合成執行失敗');
    return write(dest, ...args);
  });
  const first = await e.run({ action: 'install', confirmedPlanId: review.planId }); t.mock.restoreAll();
  assert.equal(first.failed.length, 1); assert.equal(first.skipped.length, 1);
  const retry = await e.run({ action: 'retry', targetIds: first.failed.map(t => t.targetId) });
  assert.equal(retry.ok, true); assert.equal(retry.succeeded.length, 1);
  const detail = await e.detail();
  assert.equal(detail.lastFailure, null); assert.equal(detail.lastSkipped.count, 1); assert.equal(detail.pendingTargets.count, 0);
});

async function skippedEnvironment(t) {
  const e = await environment(t, { hosts: ['claude-code'] });
  await e.run({ action: 'install' });
  const file = path.join(e.lcaipackHome, 'receipts.json');
  const ledger = JSON.parse(fs.readFileSync(file));
  ledger.receipts[0].packageKey = 'another-package';
  fs.writeFileSync(file, JSON.stringify(ledger));
  e.root('.claude-work');
  const review = await e.run({ action: 'install' });
  const result = await e.run({ action: 'install', confirmedPlanId: review.planId });
  assert.equal(result.skipped.length, 1);
  return e;
}

function deploymentSnapshot(e) {
  function tree(dir) {
    if (!fs.existsSync(dir)) return null;
    return Object.fromEntries(fs.readdirSync(dir).sort().map(name => {
      const file = path.join(dir, name);
      return [name, fs.statSync(file).isDirectory() ? tree(file) : fs.readFileSync(file).toString('base64')];
    }));
  }
  return [tree(e.lcaipackHome), tree(path.join(e.userHome, '.claude')), tree(path.join(e.userHome, '.claude-work'))];
}

for (const read of ['list', 'detail']) {
  test(`${read} 唯讀重查略過目標：更新原因、解除阻擋後轉待補裝並沿用已安裝版本`, async t => {
    const e = await skippedEnvironment(t);
    const readPackage = async () => read === 'list' ? (await e.list())[0] : e.detail();
    const savedKey = `resource-center.lastSkipped.${key}`;
    e.worker.state.storage.get(savedKey).targets[0].reason = '舊原因';
    e.recommend('2.0.0');
    const before = deploymentSnapshot(e);
    const blocked = await readPackage();
    assert.match(blocked.lastSkipped.targets[0].reason, /another-package/);
    assert.equal(blocked.pendingTargets.count, 0);
    assert.equal(e.worker.state.storage.get(savedKey).targets[0].reason, blocked.lastSkipped.targets[0].reason);
    assert.deepEqual(deploymentSnapshot(e), before, '規劃不得寫部署檔案、收據、設定或操作紀錄');
    assert.equal((await e.worker.call('rc.install.run', { packageKey: 'another-package', action: 'uninstall' })).ok, true);
    const afterRemoval = deploymentSnapshot(e);
    const ready = await readPackage();
    assert.equal(ready.lastSkipped, null);
    assert.equal(e.worker.state.storage.has(savedKey), false);
    assert.equal(ready.pendingTargets.count, 1);
    assert.deepEqual(deploymentSnapshot(e), afterRemoval);
    assert.equal((await e.run({ action: 'fillPending' })).succeeded.length, 1);
    assert.ok((await e.detail()).deployments.every(d => d.version === '1.0.0'));
  });
}

test('略過重查讀取失敗保留紀錄、寫 log，清單仍正常回傳', async t => {
  const e = await skippedEnvironment(t);
  const savedKey = `resource-center.lastSkipped.${key}`;
  const saved = structuredClone(e.worker.state.storage.get(savedKey));
  const before = deploymentSnapshot(e);
  const cache = path.join(e.userHome, '.orca', 'plugin-data', 'ai-resource-center', 'cache', key, '1.0.0');
  for (const file of fs.readdirSync(cache)) fs.writeFileSync(path.join(cache, file), '無法驗證的合成快取');
  e.market.override(`GET /api/market/packages/${key}/versions/1.0.0/download`, () => ({ status: 503, body: {} }));
  const item = (await e.list())[0];
  assert.equal(item.lastSkipped.targets[0].reason, saved.targets[0].reason);
  assert.equal(item.pendingTargets.count, 0);
  assert.deepEqual(e.worker.state.storage.get(savedKey), saved);
  assert.deepEqual(deploymentSnapshot(e), before);
  assert.ok(e.worker.state.logs.some(line => line.includes('[skipped-targets]')));
});
