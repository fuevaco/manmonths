import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';
import { zip } from './zip-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { ofBytes } from '../worker/deploy/digest.mjs';

const CODEX_CONFIG = ['# keep', 'model = "user"', '[mcp_servers.other]', 'command = "user"', ''].join('\r\n');

// 同一案例串起真正 rc.install.run（一鍵安裝／更新）、面板卡片與明細、設定與收據：MCP 資源包含 Claude Desktop。
test('panel one-click installs then updates direct MCP across Codex, Claude Code and Claude Desktop global surfaces', { skip: process.platform !== 'win32' && '使用 Windows 的 Claude Desktop 安裝樹（AppData、Packages/Claude_*）；Linux 沒有 Claude Desktop（ADR-0005）' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-panel-08-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'user'), lcaipackHome = path.join(dir, 'lcaipack');
  const codex = path.join(userHome, '.codex'), claude = path.join(userHome, '.claude');
  const roaming = path.join(userHome, 'roaming'), local = path.join(userHome, 'local');
  const desktop = path.join(roaming, 'Claude');
  for (const root of [codex, claude, desktop, path.join(local, 'Packages', 'Claude_demo')]) fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(codex, 'config.toml'), CODEX_CONFIG);
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}');
  const json = { theme: { mode: 'dark' }, mcpServers: { other: { command: 'user' } } };
  for (const file of [path.join(userHome, '.claude.json'), path.join(desktop, 'claude_desktop_config.json')]) fs.writeFileSync(file, JSON.stringify(json));
  const packages = Object.fromEntries(['1.0.0', '1.1.0'].map(version => [version, zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: 'demo-mcp', name: 'Demo MCP', type: 'mcp', version, description: 'Synthetic', contents: [{ id: 'echo', kind: 'mcp', name: 'Echo', definition: { transport: 'stdio', command: 'npx', args: ['example'], env: { REV: version } } }] }), 'README.md': '# Demo' })]));
  let recommended = '1.0.0'; // 市集改推薦 1.1.0 後，在明細按 ↻ 即出現「更新」
  const item = () => ({ packageKey: 'demo-mcp', name: 'Demo MCP', type: 'mcp', description: 'Synthetic', latestReleaseVersion: recommended });
  const market = await startFakeMarket(); t.after(() => market.close());
  market.override('GET /api/market/packages', () => ({ status: 200, body: { data: [item()], meta: { total: 1 } } }));
  market.override('GET /api/market/packages/demo-mcp', () => ({ status: 200, body: { ...item(), recommendedVersion: recommended, versions: ['1.0.0', '1.1.0'].filter(version => version <= recommended).map(version => ({ version, isEnabled: true, channel: 'release', status: 'active', hosts: ['codex', 'claude-code'], sha256: ofBytes(packages[version]) })) } }));
  for (const version of ['1.0.0', '1.1.0']) {
    market.override(`GET /api/market/packages/demo-mcp/versions/${version}/download`, () => ({ status: 200, raw: packages[version], contentType: 'application/zip' }));
    market.override(`GET /api/market/packages/demo-mcp/versions/${version}/readme`, () => ({ status: 200, body: { readme: '# Demo' } }));
  }
  const worker = startWorker({ deps: { userHome, lcaipackHome, env: { APPDATA: roaming, LOCALAPPDATA: local } } }); t.after(() => worker.dispose());
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const panel = await startPanel((method, input) => worker.call(method, input));
  const card = () => findByData(panel.get('catalog-list'), 'package-key', 'demo-mcp');
  for (let i = 0; i < 200 && !card(); i++) await delay(10);
  assert.deepEqual(findAllByData(card(), 'tool').map(n => n.getAttribute('data-tool')), ['codex', 'claude-code', 'claude-desktop'], 'MCP 資源包列出 Claude Desktop');
  const toast = () => panel.get('toast').classList.contains('hidden') ? '' : textOf(panel.get('toast')).trim();
  const verify = (version) => {
    const receipts = JSON.parse(fs.readFileSync(path.join(lcaipackHome, 'receipts.json'))).receipts;
    assert.equal(receipts.length, 3);
    assert.ok(receipts.every(r => r.packageVersion === version && r.ownedConfigFields.length > 1));
    for (const file of [path.join(userHome, '.claude.json'), path.join(desktop, 'claude_desktop_config.json')]) {
      const doc = JSON.parse(fs.readFileSync(file)); assert.deepEqual(doc.theme, json.theme); assert.deepEqual(doc.mcpServers.other, json.mcpServers.other); assert.equal(doc.mcpServers.echo.env.REV, version);
    }
    assert.ok(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8').startsWith(CODEX_CONFIG));
  };
  await findByData(card(), 'action', 'install').fire('click'); await settle();
  for (let i = 0; i < 200 && !toast(); i++) await delay(10);
  assert.equal(toast(), '已安裝到 3 個位置');
  assert.equal(panel.get('confirm-layer').classList.contains('hidden'), true, '沒有例外時不顯示確認');
  verify('1.0.0');
  for (let i = 0; i < 200 && !findAllByData(card(), 'tool').every(n => n.getAttribute('data-deployed') === 'true'); i++) await delay(10);
  assert.ok(findAllByData(card(), 'tool').every(n => n.getAttribute('data-deployed') === 'true'));

  await card().fire('click'); await settle();
  recommended = '1.1.0'; await panel.get('btn-refresh').fire('click'); await settle();
  const update = () => findByData(panel.get('details-status-row'), 'action', 'update');
  for (let i = 0; i < 200 && !update(); i++) await delay(10);
  await panel.timeouts.fireAll();
  await update().fire('click'); await settle();
  for (let i = 0; i < 200 && !toast(); i++) await delay(10);
  assert.equal(toast(), '已更新 3 個位置');
  verify('1.1.0');
  assert.match(textOf(panel.get('details-installed')), /Claude Desktop/);
});



test('Claude Desktop offers the MCP portion of a bundle and omits file-only packages and project scope', { skip: process.platform !== 'win32' && '使用 Windows 的 Claude Desktop 安裝樹（AppData、Packages/Claude_*）；Linux 沒有 Claude Desktop（ADR-0005）' }, async t => {
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
    market.override(`GET /api/market/packages/demo-${type}`, () => ({ status: 200, body: { packageKey: `demo-${type}`, name: 'Demo', type, recommendedVersion: '1.0.0', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', status: 'active', hosts: ['claude-code'], sha256: ofBytes(packages[type]) }] } }));
    market.override(`GET /api/market/packages/demo-${type}/versions/1.0.0/download`, () => ({ status: 200, raw: packages[type], contentType: 'application/zip' }));
  }
  const worker = startWorker({ deps: { userHome, lcaipackHome, env: { APPDATA: roaming, LOCALAPPDATA: local } } }); t.after(() => worker.dispose());
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const result = await worker.call('rc.install.run',{packageKey:'demo-bundle',action:'install'});
  assert.equal(result.ok,true); assert.equal(result.succeeded.length,1); assert.equal(result.succeeded[0].hostId,'claude-desktop');
  assert.deepEqual((await worker.call('rc.install.run',{packageKey:'demo-skill',action:'install'})).succeeded,[]);
  const receipts = JSON.parse(fs.readFileSync(path.join(lcaipackHome,'receipts.json'),'utf8')).receipts;
  assert.deepEqual(receipts.map(r=>r.kind),['mcp']);
  assert.equal(fs.existsSync(path.join(userHome, '.claude.json')), false);
  assert.equal(fs.existsSync(path.join(roaming, 'Claude', 'claude_desktop_config.json')), true);
});
