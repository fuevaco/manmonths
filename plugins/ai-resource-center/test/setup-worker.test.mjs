// 設定參數的 worker 請求契約（對照 LcAiPack.Tests MarketplaceSetupInputTests、GuiSetupFieldTests、SecretCanaryScanTests）：
// 部署摘要揭露缺少的參數；面板送回的值依安裝範圍落地到共用的 setup.json，秘密只進安全儲存區，之後重新規劃。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker, leakedSecrets } from './harness.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';
import { SetupValueStore } from '../worker/setup/values.mjs';
import { setupSecretReference } from '../worker/setup/secrets.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const CANARY = 'canary-runtime-secret-09';
const parameters = [
  { parameterId: 'endpoint', label: 'Endpoint', type: 'string', required: true },
  { parameterId: 'region', label: 'Region', type: 'choice', required: true, default: 'north', options: [{ value: 'north', label: 'North' }, { value: 'south', label: 'South' }] },
  { parameterId: 'verbose', label: 'Verbose', type: 'boolean', required: false, default: false }
];
const apiKey = { parameterId: 'api-key', label: 'API key', type: 'secret', required: true, secretUsage: 'runtime' };
function pkgBytes({ secret }) {
  const definition = { transport: 'stdio', command: 'npx', args: ['-y', 'example'], env: { MODE: 'params' },
    ...(secret ? { parameters: [{ id: 'api-key', type: 'secret', secret: true, required: true }] } : {}) };
  return zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: 'demo-params', name: 'Demo Params', type: 'mcp', version: '1.0.0',
    description: 'Synthetic', contents: [{ id: 'echo', kind: 'mcp', name: 'Echo', definition }],
    setup: { parameters: secret ? [...parameters, apiKey] : parameters } }), 'README.md': '# Demo' });
}

async function environment(t, { secret = true, launcher } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-setup-'));
  const userHome = path.join(dir, 'home'), lcaipackHome = path.join(dir, 'lcaipack'), project = path.join(dir, 'project');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true }); fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), '{}');
  fs.mkdirSync(project);
  const bytes = pkgBytes({ secret });
  const item = { packageKey: 'demo-params', name: 'Demo Params', type: 'mcp', description: 'Synthetic', latestReleaseVersion: '1.0.0' };
  const market = await startFakeMarket({ packages: [item] });
  market.override('GET /api/market/packages/demo-params', () => ({ status: 200, body: { ...item, recommendedVersion: '1.0.0',
    versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', status: 'active', hosts: ['claude-code'], sha256: sha(bytes) }] } }));
  market.override('GET /api/market/packages/demo-params/versions/1.0.0/download', () => ({ status: 200, raw: bytes, contentType: 'application/zip' }));
  const secretStore = memoryStore();
  const worker = startWorker({ deps: { lcaipackHome, userHome, env: {}, secretStore, mcpLauncherPath: launcher } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { dir, userHome, lcaipackHome, project, worker, secretStore };
}
async function plan(e, scope = 'global') {
  const input = scope === 'project' ? { scope, projectRoot: e.project } : {};
  const { targets } = await e.worker.call('rc.deploy.listTargets', input);
  const target = targets.find(t => t.surfaceId === 'claude-code-cli');
  return e.worker.call('rc.deploy.plan', { packageKey: 'demo-params', version: '1.0.0', targets: [target.id], ...input });
}
const field = (summary, id) => summary.setup.parameters.find(p => p.parameterId === id);

test('部署摘要列出需要補上的設定參數；秘密欄位只回報有無，缺值時不可套用', async t => {
  const e = await environment(t);
  const summary = await plan(e);
  assert.equal(summary.canApply, false);
  assert.equal(summary.setup.scope, 'global');
  assert.deepEqual(summary.setup.parameters.filter(p => p.needsInput).map(p => p.parameterId), ['endpoint', 'api-key']);
  assert.deepEqual(field(summary, 'region'), { parameterId: 'region', label: 'Region', type: 'choice', description: null, required: true, visible: true,
    isSecret: false, secretUsage: null, value: 'north', source: 'ManifestDefault', secretProvided: false, needsInput: false,
    options: [{ value: 'north', label: 'North' }, { value: 'south', label: 'South' }] });
  assert.equal(field(summary, 'api-key').value, null);
  assert.ok(summary.problems.some(p => p.code === 'deployment.setup-parameter-missing'));
  const result = await e.worker.call('rc.deploy.apply', { planDigest: summary.planDigest, targets: summary.targets.map(t => t.id) });
  assert.equal(result.status, 'rejected');
  assert.equal(fs.existsSync(path.join(e.userHome, '.claude.json')), false);
});

test('在 Orca 補上全域參數與秘密後重新規劃；值寫入共用 setup.json，秘密依既有識別寫入安全儲存區且不外洩', async t => {
  const e = await environment(t);
  const first = await plan(e);
  const summary = await e.worker.call('rc.deploy.saveSetup', { planDigest: first.planDigest,
    values: { endpoint: ' https://edited.example ', region: 'south', verbose: true }, secrets: { 'api-key': CANARY } });
  assert.notEqual(summary.planDigest, first.planDigest);
  assert.deepEqual([field(summary, 'endpoint').value, field(summary, 'endpoint').source], ['https://edited.example', 'Global']);
  assert.deepEqual([field(summary, 'region').value, field(summary, 'verbose').value], ['south', 'true']);
  assert.equal(field(summary, 'api-key').secretProvided, true);
  assert.equal(summary.problems.some(p => p.code === 'deployment.setup-parameter-missing'), false);
  // LC-AI-Pack 讀得到的同一份全域值檔；秘密不在其中。
  assert.deepEqual(SetupValueStore.forGlobal({ home: e.lcaipackHome, userProfile: e.userHome }).getValues('demo-params'),
    { endpoint: 'https://edited.example', region: 'south', verbose: 'true' });
  const ref = setupSecretReference({ packageKey: 'demo-params', parameterId: 'api-key', scope: 'global', canonicalRoot: e.userHome });
  assert.equal(e.secretStore.values.get(ref.key), CANARY);
  const files = [];
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p); } };
  walk(e.dir);
  assert.deepEqual(leakedSecrets([...files.map(f => fs.readFileSync(f, 'utf8')), ...e.worker.state.transcript, ...e.worker.state.logs], [CANARY]), []);
  // Orca 尚無受管 launcher：需要執行期秘密的 MCP 仍受阻並說明原因。
  assert.equal(summary.canApply, false);
  assert.ok(summary.targets[0].problems.some(p => p.code === 'deployment.unsupported-content-kind' && /執行期秘密/.test(p.summary)));
});

test('專案範圍的值寫成專案覆寫，不改動全域值；疊合順序與桌面工具一致', async t => {
  const e = await environment(t, { secret: false });
  SetupValueStore.forGlobal({ home: e.lcaipackHome, userProfile: e.userHome }).setValues('demo-params', { endpoint: 'https://global.example', region: 'south' });
  const globalBytes = fs.readFileSync(path.join(e.lcaipackHome, 'setup.json'));
  const first = await plan(e, 'project');
  assert.deepEqual([field(first, 'endpoint').value, field(first, 'endpoint').source], ['https://global.example', 'Global']);
  assert.equal(first.canApply, true, JSON.stringify(first.problems));
  const summary = await e.worker.call('rc.deploy.saveSetup', { planDigest: first.planDigest, values: { endpoint: 'https://project.example', region: 'south', verbose: false } });
  assert.deepEqual([field(summary, 'endpoint').value, field(summary, 'endpoint').source], ['https://project.example', 'ProjectOverride']);
  assert.deepEqual([field(summary, 'region').value, field(summary, 'region').source], ['south', 'Global']);
  assert.deepEqual(fs.readFileSync(path.join(e.lcaipackHome, 'setup.json')), globalBytes);
  // 未變更、來源為 manifest 預設值的參數一併儲存（對照 SetupFormCollector.TryCollect）。
  assert.deepEqual(SetupValueStore.forProject({ projectRoot: e.project }).getValues('demo-params'), { endpoint: 'https://project.example', verbose: 'false' });
  const result = await e.worker.call('rc.deploy.apply', { planDigest: summary.planDigest, targets: summary.targets.map(t => t.id) });
  assert.equal(result.status, 'succeeded');
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.project, '.mcp.json'), 'utf8')).mcpServers.echo.env.MODE, 'params');
});

test('設定輸入驗證：未知參數、型別不符、選項外的值或把秘密當一般值送出時拒絕且不寫入', async t => {
  const e = await environment(t);
  const first = await plan(e);
  const bad = [{ values: { nope: 'x' } }, { values: { verbose: 'yes' } }, { values: { region: 'west' } }, { values: { 'api-key': CANARY } },
    { secrets: { endpoint: CANARY } }, { secrets: { 'api-key': '' } }];
  for (const input of bad) {
    await assert.rejects(e.worker.call('rc.deploy.saveSetup', { planDigest: first.planDigest, ...input }), { code: 'invalid_params' });
  }
  await assert.rejects(e.worker.call('rc.deploy.saveSetup', { planDigest: 'other', values: { endpoint: 'x' } }), { code: 'plan_stale' });
  assert.equal(fs.existsSync(path.join(e.lcaipackHome, 'setup.json')), false);
  assert.equal(e.secretStore.values.size, 0);
  assert.deepEqual(leakedSecrets([...e.worker.state.transcript, ...e.worker.state.logs], [CANARY]), []);
});
