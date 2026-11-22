// 部署規劃與設定參數整合（對照 LcAiPack.Tests SetupPlanDigestTests、SecretCanaryScanTests、ManagedMcpLauncherTests 的部署面）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeploymentPlanner } from '../worker/deploy/planner.mjs';
import { ofBytes } from '../worker/deploy/digest.mjs';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';
import { SetupValueStore } from '../worker/setup/values.mjs';
import { createSecretManager, setupSecretReference } from '../worker/setup/secrets.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';

const rules = createPathRules();
function setupPackage({ setup, parameters, version = '1.0.0', key = 'demo-mcp' } = {}) {
  const definition = { transport: 'stdio', command: 'npx', args: ['-y', 'example'], env: { MODE: 'params' }, ...(parameters ? { parameters } : {}) };
  const manifest = { packageFormatVersion: 1, key, name: 'Demo MCP', type: 'mcp', version, description: 'Synthetic',
    contents: [{ id: 'echo', name: 'Echo', kind: 'mcp', definition }], ...(setup ? { setup } : {}) };
  const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo' });
  return { bytes, expectedSha256: ofBytes(bytes) };
}
const endpoint = { parameterId: 'endpoint', label: 'Endpoint', type: 'string', required: true };
const apiKey = { parameterId: 'api-key', label: 'API key', type: 'secret', required: true, secretUsage: 'runtime' };

function environment(t, { launcher } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'user'), root = path.join(dir, 'project'), home = path.join(dir, 'lcaipack');
  fs.mkdirSync(userHome); fs.mkdirSync(root);
  const store = memoryStore();
  const secrets = createSecretManager(store);
  const host = { hostId: 'claude-code', surfaceId: 'claude-code-cli' };
  const planner = createDeploymentPlanner({ home, userHome, clientVersion: '1.0.0-test', secrets, mcpLauncherPath: launcher });
  const intent = pkg => ({ package: pkg, hosts: [host], scope: 'global', hostRoots: [{ host, canonicalRoots: [root] }], existingContent: 'Block' });
  const apply = plan => planner.apply(plan, { planDigest: plan.planDigest, replaceUnmanagedFiles: false });
  return { dir, userHome, root, home, store, secrets, planner, intent, apply, config: path.join(root, '.claude.json') };
}

test('缺少必要設定參數時部署計畫列出缺少項目並阻擋，套用被拒且不寫入任何檔案', t => {
  const e = environment(t);
  const plan = e.planner.plan(e.intent(setupPackage({ setup: { parameters: [endpoint] } })));
  assert.equal(plan.canApply, false);
  assert.equal(plan.setup.parameters[0].needsInput, true);
  assert.ok(plan.problems.some(p => p.code === 'deployment.setup-parameter-missing' && p.summary.includes('endpoint')));
  assert.equal(e.apply(plan).status, 'Rejected');
  assert.equal(fs.existsSync(e.config), false);
});

test('全域值補齊參數後即可安裝；沒有執行期秘密的 MCP 直接寫入，不出現 launcher', t => {
  const e = environment(t);
  SetupValueStore.forGlobal({ home: e.home, userProfile: e.userHome }).setValues('demo-mcp', { endpoint: 'https://global.example' });
  SetupValueStore.forGlobal({ home: e.home, userProfile: e.userHome }).setValues('demo-mcp', { endpoint: 'https://project.example' });
  const plan = e.planner.plan(e.intent(setupPackage({ setup: { parameters: [endpoint] } })));
  assert.equal(plan.canApply, true, JSON.stringify(plan.problems));
  assert.deepEqual([plan.setup.parameters[0].effectiveValue, plan.setup.parameters[0].source], ['https://project.example', 'Global']);
  assert.equal(e.apply(plan).status, 'Succeeded');
  assert.equal(JSON.parse(fs.readFileSync(e.config, 'utf8')).mcpServers.echo.env.MODE, 'params');
});

test('審核後設定值改變時套用前即判定過期，零寫入', t => {
  const e = environment(t);
  const setup = { parameters: [{ ...endpoint, default: 'https://default.example' }] };
  const plan = e.planner.plan(e.intent(setupPackage({ setup })));
  assert.equal(plan.canApply, true);
  SetupValueStore.forGlobal({ home: e.home, userProfile: e.userHome }).setValues('demo-mcp', { endpoint: 'https://changed.example' });
  const result = e.apply(plan);
  assert.equal(result.status, 'Rejected');
  assert.ok(result.problems.some(p => p.code === 'deployment.plan-stale'));
  assert.equal(fs.existsSync(e.config), false);
  assert.notEqual(e.planner.plan(e.intent(setupPackage({ setup }))).planDigest, plan.planDigest);
});

test('執行期秘密 MCP：設定檔只寫受管 launcher 與非秘密身分，啟動描述只留秘密身分，秘密不落地', t => {
  const e = environment(t, { launcher: path.join(os.tmpdir(), 'launcher', 'lcaipack.exe') });
  const pkg = setupPackage({ setup: { parameters: [apiKey] }, parameters: [{ id: 'api-key', type: 'secret', secret: true, required: true }] });
  const blocked = e.planner.plan(e.intent(pkg));
  assert.ok(blocked.problems.some(p => p.code === 'deployment.setup-parameter-missing'));
  e.secrets.set(setupSecretReference({ packageKey: 'demo-mcp', parameterId: 'api-key', scope: 'global', canonicalRoot: e.userHome }), 'canary-runtime-secret');
  const plan = e.planner.plan(e.intent(pkg));
  assert.equal(plan.canApply, true, JSON.stringify(plan.problems));
  assert.equal(e.apply(plan).status, 'Succeeded');
  const node = JSON.parse(fs.readFileSync(e.config, 'utf8')).mcpServers.echo;
  assert.deepEqual(node, { command: path.join(os.tmpdir(), 'launcher', 'lcaipack.exe'),
    args: ['mcp-launch', '--package', 'demo-mcp', '--content', 'echo', '--scope', 'global', '--root', rules.normalize(e.root)], type: 'stdio' });
  const descriptorPath = path.join(plan.setup.setupRoot, 'mcp', 'echo.json');
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  assert.deepEqual(descriptor, { launchFormatVersion: 1, packageKey: 'demo-mcp', packageVersion: '1.0.0', contentId: 'echo', scope: 'global',
    canonicalRoot: rules.normalize(e.userHome), setupRoot: plan.setup.setupRoot, command: process.platform === 'win32' ? 'cmd' : 'npx',
    args: process.platform === 'win32' ? ['/c', 'npx', '-y', 'example'] : ['-y', 'example'], cwd: null, env: { MODE: 'params' },
    runtimeSecrets: [{ parameterId: 'api-key', required: true }] });
  // 秘密值不出現在任何寫出的檔案、計畫或收據。
  const files = [];
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p); } };
  walk(e.dir);
  for (const f of files) assert.equal(fs.readFileSync(f, 'utf8').includes('canary-runtime-secret'), false, f);
  assert.equal(JSON.stringify(plan).includes('canary'), false);
});

test('Orca 沒有可用的受管 MCP launcher 時，需要執行期秘密的 MCP 揭露為阻擋問題', t => {
  const e = environment(t);
  const pkg = setupPackage({ setup: { parameters: [apiKey] }, parameters: [{ id: 'api-key', type: 'secret', secret: true, required: true }] });
  e.secrets.set(setupSecretReference({ packageKey: 'demo-mcp', parameterId: 'api-key', scope: 'global', canonicalRoot: e.userHome }), 'x');
  const plan = e.planner.plan(e.intent(pkg));
  assert.equal(plan.canApply, false);
  assert.ok(plan.targets[0].problems.some(p => p.code === 'deployment.unsupported-content-kind' && p.contentId === 'echo'));
});

test('宣告設定命令的資源包可以規劃：摘要揭露命令、規劃零執行；不相容的命令在整包都不適用時阻擋（執行見 setup-orchestrator）', t => {
  const e = environment(t);
  const fakeRunners = { resolve: runner => ({ runner, executable: `/fake/${runner}`, leadingArguments: [] }) };
  const planner = createDeploymentPlanner({ home: e.home, userHome: e.userHome, clientVersion: '1.0.0-test', secrets: e.secrets,
    setupPlanning: { runners: fakeRunners, environment: { operatingSystem: 'windows', architecture: 'x64' } } });
  const setup = { parameters: [{ ...endpoint, default: 'x' }], commands: [{ commandId: 'init', name: 'Init', runner: 'powershell', script: 'setup/init.ps1', operatingSystems: ['windows'] }] };
  const manifest = JSON.stringify({ packageFormatVersion: 1, key: 'demo-mcp', name: 'Demo MCP', type: 'mcp', version: '1.0.0', description: 'Synthetic',
    contents: [{ id: 'echo', name: 'Echo', kind: 'mcp', definition: { transport: 'stdio', command: 'npx', args: ['-y', 'example'] } }], setup });
  const bytes = zip({ 'lcpack.json': manifest, 'README.md': '# Demo', 'setup/init.ps1': 'exit 0\n' });
  const plan = planner.plan(e.intent({ bytes, expectedSha256: ofBytes(bytes) }));
  assert.equal(plan.canApply, true, JSON.stringify(plan.problems));
  assert.deepEqual(plan.setup.commands.map(c => [c.commandId, c.willExecute, c.reason]), [['init', true, 'FirstRun']]);
  assert.equal(fs.existsSync(plan.setup.setupRoot), false);
  const mac = createDeploymentPlanner({ home: e.home, userHome: e.userHome, clientVersion: '1.0.0-test', secrets: e.secrets,
    setupPlanning: { runners: fakeRunners, environment: { operatingSystem: 'macos', architecture: 'x64' } } }).plan(e.intent({ bytes, expectedSha256: ofBytes(bytes) }));
  assert.equal(mac.canApply, false);
  assert.ok(mac.problems.some(p => p.code === 'deployment.setup-unsupported-environment'));
});

test('安全儲存區無法查詢時規劃被拒，說明不含秘密', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-deploy-fail-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'p'); fs.mkdirSync(root);
  const host = { hostId: 'claude-code', surfaceId: 'claude-code-cli' };
  const planner = createDeploymentPlanner({ home: path.join(dir, 'h'), userHome: dir, clientVersion: 't', secrets: createSecretManager(memoryStore({ fail: true })) });
  const plan = planner.plan({ package: setupPackage({ setup: { parameters: [apiKey] } }), hosts: [host], scope: 'global', hostRoots: [{host,canonicalRoots:[root]}], existingContent: 'Block' });
  assert.equal(plan.canApply, false);
  assert.ok(plan.problems.some(p => p.code === 'deployment.secret-unresolved'),JSON.stringify(plan.problems));
});
