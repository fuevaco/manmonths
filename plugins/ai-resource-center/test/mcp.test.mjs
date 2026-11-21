import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfigAdapter } from '../worker/deploy/config-document-adapters.mjs';

test('JSON MCP patch preserves unrelated nodes and fields, renders direct platform command and records field hashes', () => {
  const adapter = getConfigAdapter('mcp-json');
  const local = Buffer.from(JSON.stringify({ theme: { mode: 'dark' }, mcpServers: { other: { command: 'user' }, echo: { command: 'old', custom: true } } }));
  const patch = adapter.planPatch(local, true, { id: 'echo', definition: { command: 'npx', args: ['-y', 'example'], env: { REV: '1' } } }, [],
    { packageKey: 'demo', operatingSystem: 'windows', configPath: 'config.json' });
  const result = JSON.parse(adapter.applyPatch(local, true, patch));
  assert.deepEqual(result, { theme: { mode: 'dark' }, mcpServers: { other: { command: 'user' }, echo: { command: 'cmd', args: ['/c', 'npx', '-y', 'example'], env: { REV: '1' }, type: 'stdio', custom: true } } });
  assert.deepEqual(patch.ownedFieldPaths, ['mcpServers.echo', 'mcpServers.echo.args', 'mcpServers.echo.command', 'mcpServers.echo.env', 'mcpServers.echo.type']);
  assert.equal(patch.baseValueHashes.length, 5);
  assert.equal(adapter.readNodeJson(adapter.removeNode(adapter.applyPatch(local, true, patch), 'mcpServers.echo'), 'mcpServers.echo'), null);
});

test('Codex TOML patch matches LC BOM removal and keeps CRLF, comments, unrelated tables and host tools approvals', () => {
  const adapter = getConfigAdapter('mcp-toml');
  const prefix = '\uFEFF# user comment\r\nmodel = "user-model"\r\n\r\n[mcp_servers.other]\r\ncommand = "user" # keep\r\n\r\n';
  const suffix = '\r\n[mcp_servers.echo.tools.search]\r\napproval_mode = "approve"\r\n\r\n[projects."/my project"]\r\ntrust_level = "trusted"\r\n';
  const local = Buffer.from(prefix + '[mcp_servers.echo]\r\ncommand = "old"\r\ncustom = true\r\n' + suffix);
  const patch = adapter.planPatch(local, true, { id: 'echo', definition: { command: 'npx', args: ['-y', 'example'], env: { REV: '2' }, cwd: '/tmp/demo' } }, [],
    { packageKey: 'demo', operatingSystem: 'macos', configPath: 'config.toml' });
  const updated = adapter.applyPatch(local, true, patch);
  assert.ok(updated.toString().startsWith(prefix.slice(1)));
  assert.ok(updated.toString().endsWith(suffix));
  assert.deepEqual(JSON.parse(adapter.readNodeJson(updated, 'mcp_servers.echo')), { args: ['-y', 'example'], command: 'npx', custom: true, cwd: '/tmp/demo', env: { REV: '2' }, tools: { search: { approval_mode: 'approve' } } });
  assert.equal(JSON.parse(adapter.readComparableNodeJson(updated, 'mcp_servers.echo')).tools, undefined);
  assert.deepEqual(JSON.parse(adapter.readOwnedNodeJson(updated, 'mcp_servers.echo', patch.ownedFieldPaths)), { args: ['-y', 'example'], command: 'npx', cwd: '/tmp/demo', env: { REV: '2' } });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeploymentPlanner } from '../worker/deploy/planner.mjs';
import { ofBytes } from '../worker/deploy/digest.mjs';
import { ReceiptStore } from '../worker/deploy/receipts.mjs';
import { zip } from './zip-fixture.mjs';

export function mcpPackage(version = '1.0.0', extra = {}) {
  const manifest = { packageFormatVersion: 1, key: 'demo-mcp', name: 'Demo MCP', type: 'mcp', version, description: 'Synthetic',
    contents: [{ id: 'echo', name: 'Echo', kind: 'mcp', definition: { transport: 'stdio', command: 'npx', args: ['-y', 'example'], env: { REV: version } } }], ...extra };
  const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo' });
  return { bytes, expectedSha256: ofBytes(bytes) };
}
function environment(t, host = { hostId: 'claude-code', surfaceId: 'claude-code-cli' }, scope = 'project') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-08-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'user'); fs.mkdirSync(userHome);
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const home = path.join(dir, 'lcaipack');
  const planner = createDeploymentPlanner({ home, userHome, clientVersion: '1.0.0-test' });
  const intent = (pkg = mcpPackage(), extra = {}) => ({ package: pkg, hosts: [host], scope, projectRoot: root,
    hostRoots: [{ host, canonicalRoots: [root] }], existingContent: 'Block', ...extra });
  const config = path.join(root, host.hostId === 'codex' ? '.codex/config.toml' : host.surfaceId === 'claude-desktop' ? 'claude_desktop_config.json' : '.mcp.json');
  const apply = plan => planner.apply(plan, { planDigest: plan.planDigest, replaceUnmanagedFiles: true });
  return { dir, root, userHome, home, planner, intent, config, apply };
}

test('planner installs and updates MCP JSON and TOML with compatible managed field receipts', t => {
  for (const host of [{ hostId: 'claude-code', surfaceId: 'claude-code-cli' }, { hostId: 'codex', surfaceId: 'codex-cli' }, { hostId: 'claude-code', surfaceId: 'claude-desktop' }]) {
    const e = environment(t, host, host.surfaceId === 'claude-desktop' ? 'global' : 'project');
    const toml = host.hostId === 'codex';
    fs.mkdirSync(path.dirname(e.config), { recursive: true });
    const initial = toml ? '# keep\r\nmodel = "test"\r\n[mcp_servers.other]\r\ncommand = "user"\r\n' : JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'user' } } });
    fs.writeFileSync(e.config, initial);
    for (const version of ['1.0.0', '1.1.0']) {
      const plan = e.planner.plan(e.intent(mcpPackage(version)));
      assert.equal(plan.canApply, true, JSON.stringify(plan));
      assert.equal(e.apply(plan).status, 'Succeeded');
      const adapter = getConfigAdapter(toml ? 'mcp-toml' : 'mcp-json');
      const bytes = fs.readFileSync(e.config);
      assert.equal(JSON.parse(adapter.readNodeJson(bytes, `${toml ? 'mcp_servers' : 'mcpServers'}.echo`)).env.REV, version);
      assert.deepEqual(JSON.parse(adapter.readNodeJson(bytes, 'root.other')), { command: 'user' });
      if (toml) assert.ok(bytes.toString().startsWith(initial)); else assert.equal(JSON.parse(bytes).theme, 'dark');
      const store = host.surfaceId === 'claude-desktop' ? ReceiptStore.forGlobal({ home: e.home, userProfile: e.userHome }) : ReceiptStore.forProject({ projectRoot: e.root });
      const [r] = store.load().receipts;
      assert.equal(r.packageVersion, version);
      assert.equal(r.mutationKind, 'PatchConfig');
      assert.equal(r.ownedConfigFields[0], `${toml ? 'mcp_servers' : 'mcpServers'}.echo`);
      assert.equal(r.baseValueHashes[0], r.installedSha256);
      const again = e.planner.plan(e.intent(mcpPackage(version)));
      assert.equal(again.targets[0].mutations[0].change, 'NoOp');
      assert.equal(again.targets[0].mutations[0].ownership.isSameOwner, true);
    }
  }
});


test('one apply shares neutral project MCP config across hosts without falsely reporting stale', t => {
  const e = environment(t);
  const plan = e.planner.plan(e.intent(undefined, { hosts: [{ hostId: 'claude-code', surfaceId: 'claude-code-cli' }, { hostId: 'github-copilot', surfaceId: 'copilot-cli' }] }));
  assert.equal(plan.canApply, true);
  assert.equal(e.apply(plan).status, 'Succeeded');
  assert.equal(ReceiptStore.forProject({ projectRoot: e.root }).load().receipts.length, 2);
});

test('Claude Code global MCP follows default, environment-origin and custom profile user-config locations', t => {
  const e = environment(t);
  const host = { hostId: 'claude-code', surfaceId: 'claude-code-cli' };
  const defaultRoot = path.join(e.userHome, '.claude');
  fs.mkdirSync(defaultRoot); fs.writeFileSync(path.join(defaultRoot, '.claude.json'), '{}');
  for (const [root, origin, expected] of [[defaultRoot, 'HomeScan', path.join(e.userHome, '.claude.json')],
    [defaultRoot, 'ConfigDirEnvironment', path.join(defaultRoot, '.claude.json')], [e.root, 'ManualInclude', path.join(e.root, '.claude.json')]]) {
    const plan = e.planner.plan(e.intent(undefined, { scope: 'global', hostRoots: [{ host, canonicalRoots: [root], origins: { [root]: origin } }] }));
    assert.equal(plan.canApply, true, JSON.stringify(plan.problems));
    assert.equal(plan.targets[0].mutations[0].destinationPath.toLowerCase(), expected.toLowerCase());
  }
});

for (const mode of ['tampered', 'backup', 'deleted', 'emptied', 'other-node', 'collision', 'secret', 'stale-node', 'fresh-other-node', 'receipt-failure', 'unmanaged', 'invalid-json', 'invalid-toml', 'unwritable', 'codex-tools', 'setup']) {
  test(`MCP protection: ${mode}`, t => {
    const codex = mode === 'invalid-toml' || mode === 'codex-tools';
    const e = environment(t, codex ? { hostId: 'codex', surfaceId: 'codex-cli' } : undefined);
    const store = ReceiptStore.forProject({ projectRoot: e.root });
    if (mode === 'setup') {
      const plan = e.planner.plan(e.intent(mcpPackage('1.0.0', { setup: { parameters: [{ parameterId: 'endpoint', label: 'Endpoint', type: 'string', required: true }] } })));
      assert.equal(plan.canApply, false); assert.ok(plan.problems.some(p => p.code === 'deployment.setup-parameter-missing')); return;
    }
    if (['invalid-json', 'invalid-toml', 'unwritable', 'unmanaged'].includes(mode)) {
      fs.mkdirSync(path.dirname(e.config), { recursive: true });
      const original = mode === 'unmanaged' ? '{"mcpServers":{"echo":{"command":"user"}}}' : mode === 'invalid-toml' ? 'model = [' : '{broken';
      fs.writeFileSync(e.config, original);
      if (mode === 'unwritable') { fs.writeFileSync(e.config, '{}'); t.mock.method(fs, 'accessSync', () => { throw new Error('denied'); }); }
      const before = fs.readFileSync(e.config);
      const plan = e.planner.plan(e.intent());
      assert.equal(plan.canApply, false);
      assert.ok(plan.targets[0].problems.some(p => p.code === (mode === 'unmanaged' ? 'deployment.unmanaged-collision' : 'deployment.config-conflict')));
      assert.deepEqual(fs.readFileSync(e.config), before); return;
    }
    assert.equal(e.apply(e.planner.plan(e.intent())).status, 'Succeeded');
    let document = codex ? null : JSON.parse(fs.readFileSync(e.config));
    const reviewed = e.planner.plan(e.intent(mcpPackage('1.1.0')));
    if (mode === 'codex-tools') {
      fs.appendFileSync(e.config, '\r\n[mcp_servers.echo.tools.search]\r\napproval_mode = "approve"\r\n');
      const plan = e.planner.plan(e.intent());
      assert.equal(plan.canApply, true); assert.equal(plan.targets[0].mutations[0].change, 'NoOp');
      assert.equal(e.apply(plan).status, 'Succeeded');
      const update = e.planner.plan(e.intent(mcpPackage('1.1.0')));
      assert.equal(e.apply(update).status, 'Succeeded');
      assert.match(fs.readFileSync(e.config, 'utf8'), /approval_mode = "approve"/); return;
    }
    if (mode === 'deleted') delete document.mcpServers.echo;
    else if (mode === 'emptied') document.mcpServers.echo = {};
    else if (['other-node', 'fresh-other-node'].includes(mode)) { document.theme = 'keep'; document.mcpServers.other = { command: 'user' }; }
    else if (mode === 'secret') document.mcpServers.echo.env = { API_TOKEN: 'sensitive-test-value' };
    else if (mode !== 'collision' && mode !== 'receipt-failure') document.mcpServers.echo.args.push('--user-added');
    fs.writeFileSync(e.config, JSON.stringify(document));
    const before = fs.readFileSync(e.config);
    if (mode === 'stale-node') { assert.equal(e.apply(reviewed).status, 'Stale'); assert.deepEqual(fs.readFileSync(e.config), before); return; }
    if (mode === 'fresh-other-node') { assert.equal(e.apply(reviewed).status, 'Succeeded'); assert.equal(JSON.parse(fs.readFileSync(e.config)).theme, 'keep'); return; }
    if (mode === 'receipt-failure') {
      const original = fs.readFileSync(store.filePath); fs.rmSync(store.filePath); fs.mkdirSync(store.filePath);
      // The receipt path fails only after planning (same public transaction seam as existing Skill test).
      fs.rmdirSync(store.filePath); fs.writeFileSync(store.filePath, original);
      const plan = e.planner.plan(e.intent(mcpPackage('1.1.0')));
      const write = fs.writeFileSync;
      t.mock.method(fs, 'writeFileSync', (p, ...args) => { if (String(p).includes('receipts.json.') && String(p).endsWith('.part')) throw new Error('receipt denied'); return write(p, ...args); });
      const result = e.apply(plan);
      assert.equal(result.targets[0].status, 'RolledBack'); assert.deepEqual(fs.readFileSync(e.config), before); assert.equal(store.load().receipts[0].packageVersion, '1.0.0'); return;
    }
    const pkg = mode === 'collision' ? mcpPackage('1.1.0', { key: 'other-package' }) : mcpPackage();
    const plan = e.planner.plan(e.intent(pkg, { existingContent: ['backup', 'collision'].includes(mode) ? 'BackupAndReplace' : 'Block' }));
    if (['tampered', 'secret', 'collision'].includes(mode)) {
      assert.equal(plan.canApply, false);
      assert.ok(plan.targets[0].problems.some(p => p.code === (mode === 'collision' ? 'deployment.ownership-collision' : 'deployment.local-modification')));
      assert.deepEqual(fs.readFileSync(e.config), before);
      assert.equal(JSON.stringify(plan.targets).includes('sensitive-test-value'), false); return;
    }
    assert.equal(plan.canApply, true, JSON.stringify(plan.targets));
    assert.equal(plan.targets[0].mutations[0].change, mode === 'other-node' ? 'NoOp' : mode === 'deleted' ? 'Create' : 'Merge');
    const result = e.apply(plan); assert.equal(result.status, 'Succeeded');
    if (mode === 'backup') { assert.equal(result.targets[0].backupPaths.length, 1); assert.deepEqual(fs.readFileSync(result.targets[0].backupPaths[0]), before); }
    if (mode === 'other-node') assert.equal(JSON.parse(fs.readFileSync(e.config)).theme, 'keep');
  });
}

