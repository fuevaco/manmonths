import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSetupEnvironment } from '../worker/setup/runners.mjs';
import { renderMcpNode } from '../worker/deploy/mcp-node-renderer.mjs';
import { planSetup, computeSetupDigest } from '../worker/setup/planning.mjs';
import { createDefaultSecretStore, SetupSecretStoreError, LinuxKeyringHelp } from '../worker/setup/secrets.mjs';
import { createSetupInputService } from '../worker/setup/input-service.mjs';
import { findMcpLauncher } from '../worker/setup/find-mcp-launcher.mjs';
import { buildSetupRenderContext } from '../worker/setup/managed-mcp.mjs';
import { registerSessionHandlers } from '../worker/handlers/session.mjs';
import { startWorker } from './harness.mjs';
import { createDeploymentPlanner } from '../worker/deploy/planner.mjs';
import { describeInstallProblems } from '../worker/install-problems.mjs';
import { createSecretManager } from '../worker/setup/secrets.mjs';
import { zip } from './zip-fixture.mjs';
import { ofBytes } from '../worker/deploy/digest.mjs';

test('Linux 系統值與 MCP 節點使用原始命令；Windows、macOS 行為不變', () => {
  const content = { definition: { command: 'npx', args: ['demo'] } };
  for (const [platform, expected] of [['linux', 'linux'], ['win32', 'windows'], ['darwin', 'macos']]) {
    const env = detectSetupEnvironment({ platform, arch: 'arm64' });
    assert.deepEqual(env, { operatingSystem: expected, architecture: 'arm64' });
    const node = renderMcpNode(content, 'json', env.operatingSystem);
    assert.equal(node.command, platform === 'win32' ? 'cmd' : 'npx');
    assert.deepEqual(node.args, platform === 'win32' ? ['/c', 'npx', 'demo'] : ['demo']);
  }
});

test('Linux 命令挑選：優先 Linux，否則借用架構相符的 macOS bash；揭露標記與摘要一致', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const command = (id, operatingSystems, runner = 'bash', architectures = ['x64']) => ({ commandId: id, runner, script: 'run.sh', operatingSystems, architectures });
  const mac = command('mac', ['macos']), win = command('win', ['windows'], 'powershell');
  const plan = (commands, operatingSystem = 'linux', architecture = 'x64') => planSetup({ setup: { commands }, packageKey: 'demo', packageVersion: '1.0.0', scope: 'global',
    home: dir, userHome: dir, secrets: { describe: () => [] }, environment: { operatingSystem, architecture },
    runners: { resolve: runner => ({ executable: runner }) } });
  const borrowed = plan([mac, win]);
  assert.equal(borrowed.canApply, true);
  assert.deepEqual(borrowed.commands.map(c => c.willExecute), [true, false]);
  assert.equal(borrowed.commands[0].borrowedFromOs, 'macos');
  const input = createSetupInputService({ home: dir, userHome: dir });
  assert.equal(input.summarize(borrowed).commands[0].borrowedFromOs, 'macos');
  assert.notEqual(computeSetupDigest(borrowed), computeSetupDigest({ ...borrowed, commands: borrowed.commands.map(c => ({ ...c, borrowedFromOs: undefined })) }));
  const native = plan([mac, command('linux', ['linux'])]);
  assert.deepEqual(native.commands.map(c => c.willExecute), [false, true]);
  assert.equal(native.commands[0].borrowedFromOs, undefined);
  assert.equal(plan([mac], 'linux', 'arm64').canApply, false);
  for (const commands of [[win], [command('ps-linux', ['linux'], 'powershell')], [command('ps', ['macos'], 'powershell')]]) {
    const blocked = plan(commands);
    assert.equal(blocked.canApply, false);
    assert.ok(blocked.commands.every(c => !c.willExecute));
  }
  assert.deepEqual(plan([mac, win], 'windows').commands.map(c => c.willExecute), [false, true]);
  assert.deepEqual(plan([mac, win], 'macos').commands.map(c => c.willExecute), [true, false]);
  assert.equal(plan([mac], 'macos').commands[0].borrowedFromOs, undefined);
});

test('secret-tool 屬性、stdin 寫入、原樣讀出及不存在', () => {
  const calls = [];
  const store = createDefaultSecretStore({ platform: 'linux', run: (file, args, input) => {
    calls.push({ file, args, input });
    if (args[0] === 'search') return { status: 0, stdout: '', stderr: '' };
    return args.includes('missing') ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: '  synthetic\n\n', stderr: '' };
  } });
  store.set('key', 'secret-value');
  assert.deepEqual(calls[0], { file: 'secret-tool', args: ['store', '--label=LC-AI-Pack', 'service', 'com.linkchain.lcaipack', 'account', 'key'], input: 'secret-value' });
  assert.equal(store.get('key'), '  synthetic\n\n');
  assert.deepEqual(store.existsMany(['key', 'missing']), [true, false]);
  store.delete('key');
  assert.deepEqual(calls.at(-1).args, ['clear', 'service', 'com.linkchain.lcaipack', 'account', 'key']);
  assert.ok(calls.every(c => !c.args.includes('secret-value')));
});

test('Linux 安全儲存區缺失、無 keyring 或鎖定時以穩定代碼受阻', () => {
  for (const run of [() => { throw new Error('ENOENT'); }, () => ({ status: 1, stderr: 'locked' }), () => ({ status: 2, stderr: 'no service' })]) {
    const store = createDefaultSecretStore({ platform: 'linux', run });
    for (const op of [() => store.get('key'), () => store.set('key', 'secret'), () => store.delete('key'), () => store.existsMany(['key'])]) {
      assert.throws(op, e => e instanceof SetupSecretStoreError && e.code === 'secret_store_failed' && e.message === LinuxKeyringHelp);
    }
  }
  const locked = createDefaultSecretStore({ platform: 'linux', run: (_, args) => args[0] === 'search'
    ? { status: 0, stdout: '[locked-item]\n', stderr: '' } : { status: 1, stdout: '', stderr: '' } });
  assert.throws(() => locked.get('key'), { message: LinuxKeyringHelp });
});

test('Linux launcher 安裝 Node 版本；無 Node 提供受阻原因', () => {
  const args = { platform: 'linux', env: { PATH: '/opt/bin:/usr/bin' } };
  assert.equal(findMcpLauncher({ ...args, hasNode: () => true, install: () => '/custom/launcher' }), '/custom/launcher');
  const lookup = () => findMcpLauncher({ ...args, hasNode: () => false });
  assert.throws(lookup, e => e.code === 'mcp_launcher_unavailable' && e.message === '需要 Node.js 才能啟動此 MCP');
  const context = buildSetupRenderContext({ identity: { key: 'demo' }, contents: [{ definition: { parameters: [{ id: 'pat' }] } }] },
    { hasSetup: true, parameters: [{ isSecret: true, secretUsage: 'runtime', parameterId: 'pat' }] }, lookup);
  assert.equal(context.launcherPath, null);
  assert.equal(context.launcherUnavailableReason, '需要 Node.js 才能啟動此 MCP');
});

test('worker getState 加上鑰匙圈狀態，舊 host 回應不變', async () => {
  for (const status of ['os-keyring', 'unavailable']) {
    const handlers = new Map();
    registerSessionHandlers({ handle: (k, fn) => handlers.set(k, fn) }, {
      session: { getState: async options => { assert.equal(options.secretsProtection, status); return { signedIn: false, marketUrl: '' }; } },
      host: { has: method => method === 'secrets.protection', call: async method => { assert.equal(method, 'secrets.protection'); return { status }; } }
    });
    assert.deepEqual(await handlers.get('rc.session.getState')(), { signedIn: false, marketUrl: '', secretsProtection: status });
  }
});

test('鑰匙圈不可用時仍能取得登入前狀態，不讀取秘密', async t => {
  const worker = startWorker();
  t.after(() => worker.dispose());
  worker.orca.host.has = method => method === 'secrets.protection';
  worker.orca.host.call = async () => ({ status: 'unavailable' });
  worker.orca.secrets.get = () => assert.fail('不可讀取不可用的鑰匙圈');
  assert.deepEqual(await worker.call('rc.session.getState'), { signedIn: false, marketUrl: '', secretsProtection: 'unavailable' });
});

test('Linux 部署規劃保留 MCP 原始命令，並將 keyring／Node 缺失原因送到確認資料', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = { hostId: 'claude-code', surfaceId: 'claude-code-cli' };
  const intent = secret => {
    const manifest = { packageFormatVersion: 1, key: 'demo', name: 'Demo', type: 'mcp', version: '1.0.0', description: 'Synthetic',
      contents: [{ id: 'echo', name: 'Echo', kind: 'mcp', definition: { transport: 'stdio', command: 'npx', args: ['demo'], ...(secret ? { parameters: [{ id: 'pat' }] } : {}) } }],
      ...(secret ? { setup: { parameters: [{ parameterId: 'pat', label: 'PAT', type: 'secret', required: true, secretUsage: 'runtime' }] } } : {}) };
    const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo' });
    return { package: { bytes, expectedSha256: ofBytes(bytes) }, hosts: [host], scope: 'global', hostRoots: [{ host, canonicalRoots: [dir] }], existingContent: 'Block' };
  };
  const options = { platform: 'linux', home: path.join(dir, 'data'), userHome: dir, clientVersion: '1.0.0' };
  const planner = createDeploymentPlanner(options);
  assert.equal(planner.config.operatingSystem, 'linux');
  const normal = planner.plan(intent(false));
  assert.equal(normal.canApply, true);
  assert.equal(planner.apply(normal, { planDigest: normal.planDigest }).status, 'Succeeded');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers.echo.command, 'npx');
  const locked = createDeploymentPlanner({ ...options, secrets: createSecretManager(createDefaultSecretStore({ platform: 'linux', run: () => { throw new Error('locked'); } })) }).plan(intent(true));
  assert.equal(locked.canApply, false);
  assert.equal(describeInstallProblems(locked.problems).reason, LinuxKeyringHelp);
  const noNode = createDeploymentPlanner({ ...options, secrets: { describe: () => [{ parameterId: 'pat', exists: true }] }, mcpLauncherPath: () => {
    const error = new Error('需要 Node.js 才能啟動此 MCP'); error.code = 'mcp_launcher_unavailable'; throw error;
  } }).plan(intent(true));
  assert.equal(noNode.canApply, false);
  assert.equal(describeInstallProblems(noNode.targets[0].problems).reason, '需要 Node.js 才能啟動此 MCP');
});
