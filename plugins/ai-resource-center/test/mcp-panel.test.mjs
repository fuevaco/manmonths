import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { startPanel, settle, textOf } from './panel-harness.mjs';
import { zip } from './zip-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { ofBytes } from '../worker/deploy/digest.mjs';

// 同一案例串起真正 rc.deploy.* handlers、panel 摘要／結果、設定與收據。
test('panel installs then updates direct MCP across Codex Desktop shared root and Claude Desktop global surface', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-panel-08-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'user'), lcaipackHome = path.join(dir, 'lcaipack');
  const codex = path.join(userHome, '.codex'), claude = path.join(userHome, '.claude');
  const roaming = path.join(userHome, 'roaming'), local = path.join(userHome, 'local');
  const desktop = path.join(roaming, 'Claude');
  for (const root of [codex, claude, desktop, path.join(local, 'Packages', 'Claude_demo')]) fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(codex, 'config.toml'), '# keep\r\nmodel = "user"\r\n[mcp_servers.other]\r\ncommand = "user"\r\n');
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}');
  const json = { theme: { mode: 'dark' }, mcpServers: { other: { command: 'user' } } };
  for (const file of [path.join(userHome, '.claude.json'), path.join(desktop, 'claude_desktop_config.json')]) fs.writeFileSync(file, JSON.stringify(json));
  const packages = Object.fromEntries(['1.0.0', '1.1.0'].map(version => [version, zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: 'demo-mcp', name: 'Demo MCP', type: 'mcp', version, description: 'Synthetic', contents: [{ id: 'echo', kind: 'mcp', name: 'Echo', definition: { transport: 'stdio', command: 'npx', args: ['example'], env: { REV: version } } }] }), 'README.md': '# Demo' })]));
  const item = { packageKey: 'demo-mcp', name: 'Demo MCP', type: 'mcp', description: 'Synthetic', latestReleaseVersion: '1.1.0' };
  const market = await startFakeMarket({ packages: [item] }); t.after(() => market.close());
  market.override('GET /api/market/packages/demo-mcp', () => ({ status: 200, body: { ...item, recommendedVersion: '1.0.0', versions: ['1.0.0', '1.1.0'].map(version => ({ version, isEnabled: true, channel: 'release', status: 'active', hosts: ['codex', 'claude-code'], sha256: ofBytes(packages[version]) })) } }));
  for (const version of ['1.0.0', '1.1.0']) {
    market.override(`GET /api/market/packages/demo-mcp/versions/${version}/download`, () => ({ status: 200, raw: packages[version], contentType: 'application/zip' }));
    market.override(`GET /api/market/packages/demo-mcp/versions/${version}/readme`, () => ({ status: 200, body: { readme: '# Demo' } }));
  }
  const worker = startWorker({ deps: { userHome, lcaipackHome, env: { APPDATA: roaming, LOCALAPPDATA: local } } }); t.after(() => worker.dispose());
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const { targets } = await worker.call('rc.deploy.listTargets', { packageKey: 'demo-mcp', version: '1.0.0' });
  assert.deepEqual(targets.map(t => t.surfaceId).sort(), ['claude-code-cli', 'claude-desktop', 'codex-cli']);
  const projectTargets = await worker.call('rc.deploy.listTargets', { packageKey: 'demo-mcp', version: '1.0.0', scope: 'project', projectRoot: dir });
  assert.equal(projectTargets.targets.some(t => t.surfaceId === 'claude-desktop'), false);
  const panel = await startPanel((method, input) => worker.call(method, input));
  for (let i = 0; i < 100 && !panel.get('catalog-list').children.length; i++) await delay(10);
  await panel.get('catalog-list').children[0].children.at(-1).fire('click'); await settle();
  for (let i = 0; i < 100 && panel.get('install-target').children.length !== 3; i++) await delay(10);
  assert.match(textOf(panel.get('install-target')), /Claude Desktop/);
  assert.match(textOf(panel.get('install-target')), /Codex/);
  for (const label of panel.get('install-target').children) { label.children[0].checked = true; await label.children[0].fire('change'); }
  for (const version of ['1.0.0', '1.1.0']) {
    if (version === '1.1.0') {
      panel.get('details-version').value = version; await panel.get('details-version').fire('change'); await settle();
      for (let i = 0; i < 100 && panel.get('install-target').children.length !== 3; i++) await delay(10);
      for (const label of panel.get('install-target').children) { label.children[0].checked = true; await label.children[0].fire('change'); }
    }
    await panel.get('install-plan').fire('click');
    assert.match(textOf(panel.get('install-summary')), new RegExp(version.replaceAll('.', '\\.')));
    assert.match(textOf(panel.get('install-summary')), /claude_desktop_config.json/);
    assert.match(textOf(panel.get('install-summary')), /mcpServers.echo.env/);
    assert.match(textOf(panel.get('install-summary')), /REV/);
    await panel.get('install-confirm').fire('click');
    assert.match(textOf(panel.get('install-result')), /已完成/);
    const receipts = JSON.parse(fs.readFileSync(path.join(lcaipackHome, 'receipts.json'))).receipts;
    assert.equal(receipts.length, 3);
    assert.ok(receipts.every(r => r.packageVersion === version && r.ownedConfigFields.length > 1));
    for (const file of [path.join(userHome, '.claude.json'), path.join(desktop, 'claude_desktop_config.json')]) {
      const doc = JSON.parse(fs.readFileSync(file)); assert.deepEqual(doc.theme, json.theme); assert.deepEqual(doc.mcpServers.other, json.mcpServers.other); assert.equal(doc.mcpServers.echo.env.REV, version);
    }
    assert.ok(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8').startsWith('# keep\r\nmodel = "user"\r\n[mcp_servers.other]\r\ncommand = "user"\r\n'));
  }
});



test('Claude Desktop offers the MCP portion of a bundle and omits file-only packages and project scope', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-bundle-08-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'home'), lcaipackHome = path.join(dir, 'state');
  const roaming = path.join(userHome, 'roaming'), local = path.join(userHome, 'local');
  fs.mkdirSync(path.join(local, 'Packages', 'Claude_demo'), { recursive: true });
  const skill = { id: 'hello', name: 'Hello', kind: 'skill', path: 'resources/hello' };
  const mcp = { id: 'echo', kind: 'mcp', name: 'Echo', definition: { command: 'node', args: ['echo.js'] } };
  const files = { 'README.md': '# Demo', 'resources/hello/SKILL.md': '---\nname: hello\ndescription: Synthetic\n---\nHello' };
  const packages = Object.fromEntries([['bundle', [skill, mcp]], ['skill', [skill]]].map(([type, contents]) => [type, zip({ ...files, 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: `demo-${type}`, name: 'Demo', type, version: '1.0.0', description: 'Synthetic', contents }) })]));
  const market = await startFakeMarket(); t.after(() => market.close());
  for (const type of ['bundle', 'skill']) {
    market.override(`GET /api/market/packages/demo-${type}`, () => ({ status: 200, body: { packageKey: `demo-${type}`, name: 'Demo', type, recommendedVersion: '1.0.0', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', status: 'active', sha256: ofBytes(packages[type]) }] } }));
    market.override(`GET /api/market/packages/demo-${type}/versions/1.0.0/download`, () => ({ status: 200, raw: packages[type], contentType: 'application/zip' }));
  }
  const worker = startWorker({ deps: { userHome, lcaipackHome, env: { APPDATA: roaming, LOCALAPPDATA: local } } }); t.after(() => worker.dispose());
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const selection = { packageKey: 'demo-bundle', version: '1.0.0' };
  const { targets } = await worker.call('rc.deploy.listTargets', selection);
  assert.equal(targets.length, 1); assert.equal(targets[0].surfaceId, 'claude-desktop');
  assert.deepEqual((await worker.call('rc.deploy.listTargets', { ...selection, packageKey: 'demo-skill' })).targets, []);
  const plan = await worker.call('rc.deploy.plan', { ...selection, targets: targets.map(t => t.id) });
  assert.equal(plan.targets.length, 1); assert.equal(plan.canApply, true);
  assert.deepEqual(plan.targets[0].changes.map(m => m.kind), ['mcp']);
  assert.ok(plan.targets[0].problems.some(p => p.code === 'deployment.unsupported-route' && p.severity === 'Warning'));
  assert.equal((await worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: targets.map(t => t.id) })).status, 'succeeded');
  assert.equal(fs.existsSync(path.join(userHome, '.claude.json')), false);
  assert.equal(fs.existsSync(path.join(roaming, 'Claude', 'claude_desktop_config.json')), true);
});
