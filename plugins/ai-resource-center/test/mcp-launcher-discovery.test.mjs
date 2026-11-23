import assert from 'node:assert/strict';
import test from 'node:test';
import { findMcpLauncher, mcpLauncherPath } from '../worker/setup/find-mcp-launcher.mjs';
import { renderMcpNode } from '../worker/deploy/mcp-node-renderer.mjs';
import { buildSetupRenderContext } from '../worker/setup/managed-mcp.mjs';

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} 只檢查 Node 並安裝自帶 launcher，忽略 PATH 及舊覆寫`, () => {
    const env = new Proxy({}, { get(_, key) {
      if (['PATH', 'Path', 'LCAIPACK_MCP_LAUNCHER'].includes(key)) assert.fail(`不應讀取 ${key}`);
    } });
    let checked = false;
    assert.equal(findMcpLauncher({ platform, env, userHome: '/synthetic/home',
      hasNode: () => { checked = true; return true; },
      install: options => { assert.ok(checked); assert.deepEqual(options, { platform, env, userHome: '/synthetic/home' }); return '/launcher.mjs'; }
    }), '/launcher.mjs');
    assert.throws(() => findMcpLauncher({ platform, env, hasNode: () => false, install: () => assert.fail() }),
      { code: 'mcp_launcher_unavailable', message: '需要 Node.js 才能啟動此 MCP' });
  });
}

test('只有使用執行期秘密的 MCP 會探測 launcher', () => {
  const setup = { hasSetup: true, canonicalRoot: '/home', parameters: [{ isSecret: true, secretUsage: 'runtime', parameterId: 'pat' }] };
  const identity = { key: 'demo', version: '1.0.0' };
  let probed = 0;
  const probe = () => { probed++; return '/synthetic/launcher.mjs'; };
  const legacy = buildSetupRenderContext({ identity, contents: [{ definition: { command: 'node' } }] }, setup, probe);
  assert.equal(legacy.launcherPath, null);
  assert.equal(probed, 0);
  const managed = buildSetupRenderContext({ identity, contents: [{ definition: { parameters: [{ id: 'pat' }] } }] }, setup, probe);
  assert.equal(managed.launcherPath, '/synthetic/launcher.mjs');
  assert.equal(managed.canonicalRoot, setup.canonicalRoot);
  assert.equal(probed, 1);
});

test('三平台固定 launcher 位置與 Windows LOCALAPPDATA fallback', () => {
  assert.equal(mcpLauncherPath({ platform: 'win32', userHome: 'C:\\Users\\alice', env: { LOCALAPPDATA: 'D:\\Local' } }),
    'D:\\Local\\orca-ai-resource-center\\bin\\lcaipack-mcp-launch.mjs');
  assert.equal(mcpLauncherPath({ platform: 'win32', userHome: 'C:\\Users\\alice', env: {} }),
    ['C:', 'Users', 'alice', 'AppData', 'Local', 'orca-ai-resource-center', 'bin', 'lcaipack-mcp-launch.mjs'].join('\\'));
  assert.equal(mcpLauncherPath({ platform: 'darwin', userHome: '/Users/alice', env: {} }),
    '/Users/alice/Library/Application Support/orca-ai-resource-center/bin/lcaipack-mcp-launch.mjs');
  assert.equal(mcpLauncherPath({ platform: 'linux', userHome: '/home/alice', env: {} }),
    '/home/alice/.local/share/orca-ai-resource-center/bin/lcaipack-mcp-launch.mjs');
});

for (const operatingSystem of ['windows', 'macos', 'linux']) {
  for (const flavor of ['json', 'toml', 'copilot']) {
    test(`${operatingSystem} ${flavor} 受管 MCP 以 node 加腳本路徑啟動，無執行期秘密維持原狀`, () => {
      const setup = { packageKey: 'example.demo', scope: 'global', canonicalRoot: '/home/alice',
        launcherPath: '/synthetic path/launcher.mjs', runtimeSecretParameterIds: new Set(['pat']) };
      const content = { id: 'demo', definition: { command: 'node', args: ['server.js'], parameters: [{ id: 'pat' }] } };
      const node = renderMcpNode(content, flavor, operatingSystem, setup);
      assert.equal(node.command, 'node');
      assert.deepEqual(node.args.slice(0, 2), [setup.launcherPath, 'mcp-launch']);
      assert.equal(node.type, flavor === 'toml' ? undefined : flavor === 'copilot' ? 'local' : 'stdio');
      if (flavor === 'copilot') assert.deepEqual(node.tools, ['*']);
      content.definition.parameters = [];
      const direct = renderMcpNode(content, flavor, operatingSystem, setup);
      assert.equal(direct.command, 'node');
      assert.deepEqual(direct.args, ['server.js']);
    });
  }
}
