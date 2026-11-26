import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeploymentPlanner } from '../worker/deploy/planner.mjs';
import { ofBytes, ofText } from '../worker/deploy/digest.mjs';
import { ReceiptStore } from '../worker/deploy/receipts.mjs';
import { nodeJson } from '../worker/deploy/config-document-adapters.mjs';
import { zip } from './zip-fixture.mjs';

// env 鍵不是字母順序：寫進設定檔時會排序，欄位雜湊若照定義順序算，讀回時會被誤判為本機修改。
function envPackage(version, mode) {
  const manifest = { packageFormatVersion: 1, key: 'demo-env', name: 'Demo Env', type: 'mcp', version, description: 'Synthetic',
    contents: [{ id: 'gateway', name: 'Gateway', kind: 'mcp', definition: { transport: 'stdio', command: 'node', args: ['gateway.js'],
      env: { TFS_MCP_AUTH_MODE: mode, AZURE_DEVOPS_ORG_URL: 'demo-collection' } } }] };
  const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo' });
  return { bytes, expectedSha256: ofBytes(bytes) };
}

const hosts = [{ hostId: 'claude-code', surfaceId: 'claude-code-cli' }, { hostId: 'codex', surfaceId: 'codex-cli' }, { hostId: 'claude-code', surfaceId: 'claude-desktop' }];

function environment(t, host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-env-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'user'); fs.mkdirSync(userHome);
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const home = path.join(dir, 'lcaipack');
  const planner = createDeploymentPlanner({ home, userHome, clientVersion: '1.0.0-test' });
  const intent = pkg => ({ package: pkg, hosts: [host], scope: 'global', hostRoots: [{ host, canonicalRoots: [root] }], existingContent: 'Block' });
  const config = path.join(root, host.hostId === 'codex' ? 'config.toml' : host.surfaceId === 'claude-desktop' ? 'claude_desktop_config.json' : '.claude.json');
  const apply = plan => planner.apply(plan, { planDigest: plan.planDigest, replaceUnmanagedFiles: true });
  const store = ReceiptStore.forGlobal({ home, userProfile: userHome });
  return { planner, intent, config, apply, store };
}
const conflicts = plan => plan.targets.flatMap(t => t.problems).filter(p => p.code === 'deployment.config-conflict');

for (const host of hosts) {
  const name = `${host.hostId}/${host.surfaceId}`;

  test(`${name}：env 鍵非字母順序，本機未修改，新版改 env 值時不衝突`, t => {
    const e = environment(t, host);
    assert.equal(e.apply(e.planner.plan(e.intent(envPackage('1.0.0', 'windows')))).status, 'Succeeded');
    const plan = e.planner.plan(e.intent(envPackage('2.0.0', 'local-auto')));
    assert.deepEqual(conflicts(plan), []);
    assert.equal(plan.canApply, true, JSON.stringify(plan.targets[0].problems));
    assert.equal(e.apply(plan).status, 'Succeeded');
    assert.match(fs.readFileSync(e.config, 'utf8'), /local-auto/);
  });

  test(`${name}：舊版收據（欄位雜湊依定義順序）升級時不衝突`, t => {
    const e = environment(t, host);
    assert.equal(e.apply(e.planner.plan(e.intent(envPackage('1.0.0', 'windows')))).status, 'Succeeded');
    // 模擬舊版外掛寫下的收據：env 欄位雜湊依套件定義順序、未排序。
    const legacyEnv = ofText(nodeJson({ TFS_MCP_AUTH_MODE: 'windows', AZURE_DEVOPS_ORG_URL: 'demo-collection' }, false));
    const data = e.store.load();
    for (const r of data.receipts) {
      const i = r.ownedConfigFields.findIndex(f => f.endsWith('.env'));
      r.baseValueHashes[i] = legacyEnv;
    }
    e.store.save(data);
    const plan = e.planner.plan(e.intent(envPackage('2.0.0', 'local-auto')));
    assert.deepEqual(conflicts(plan), []);
    assert.equal(plan.canApply, true, JSON.stringify(plan.targets[0].problems));
    assert.equal(e.apply(plan).status, 'Succeeded');
  });
}

test('本機真的改了 env 且新版也改 env 時，仍判定為設定衝突', t => {
  const e = environment(t, hosts[0]);
  assert.equal(e.apply(e.planner.plan(e.intent(envPackage('1.0.0', 'windows')))).status, 'Succeeded');
  const document = JSON.parse(fs.readFileSync(e.config, 'utf8'));
  document.mcpServers.gateway.env.TFS_MCP_AUTH_MODE = 'user-choice';
  fs.writeFileSync(e.config, JSON.stringify(document));
  const plan = e.planner.plan(e.intent(envPackage('2.0.0', 'local-auto')));
  assert.equal(plan.canApply, false);
  assert.ok(conflicts(plan).some(p => p.path.endsWith('#mcpServers.gateway.env')), JSON.stringify(plan.targets[0].problems));
});
