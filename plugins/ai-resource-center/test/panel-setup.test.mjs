// 面板的設定參數步驟（對照 LcAiPack.Tests MarketplaceSetupInputTests、GuiSetupFieldTests）：
// 部署摘要列出參數與缺少的項目，秘密以遮罩欄位輸入；儲存後重新產生摘要，補齊後才能確認安裝。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorker, leakedSecrets } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { startPanel, settle, textOf } from './panel-harness.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';
import { ofBytes } from '../worker/deploy/digest.mjs';

const CANARY = 'canary-panel-secret-09';
const find = (node, predicate) => predicate(node) ? node : node.children.map(c => find(c, predicate)).find(Boolean) ?? null;
const input = (panel, name) => find(panel.get('install-setup'), n => n.name === name);

test('部署摘要收集缺少的設定參數，秘密以遮罩輸入且不回顯；補齊後確認安裝', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-setup-09-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'user'), lcaipackHome = path.join(dir, 'lcaipack');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true }); fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), '{}');
  const bytes = zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: 'demo-params', name: 'Demo Params', type: 'mcp', version: '1.0.0', description: 'Synthetic',
    contents: [{ id: 'echo', kind: 'mcp', name: 'Echo', definition: { transport: 'stdio', command: 'npx', args: ['example'], parameters: [{ id: 'api-key', type: 'secret', secret: true, required: true }] } }],
    setup: { parameters: [
      { parameterId: 'endpoint', label: 'Endpoint', type: 'string', required: true, description: 'Synthetic endpoint' },
      { parameterId: 'region', label: 'Region', type: 'choice', required: true, default: 'north', options: [{ value: 'north', label: 'North' }, { value: 'south', label: 'South' }] },
      { parameterId: 'verbose', label: 'Verbose', type: 'boolean', required: false, default: false },
      { parameterId: 'api-key', label: 'API key', type: 'secret', required: true, secretUsage: 'runtime' }] } }), 'README.md': '# Demo' });
  const item = { packageKey: 'demo-params', name: 'Demo Params', type: 'mcp', description: 'Synthetic', latestReleaseVersion: '1.0.0' };
  const market = await startFakeMarket({ packages: [item] }); t.after(() => market.close());
  market.override('GET /api/market/packages/demo-params', () => ({ status: 200, body: { ...item, recommendedVersion: '1.0.0',
    versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', status: 'active', hosts: ['claude-code'], sha256: ofBytes(bytes) }] } }));
  market.override('GET /api/market/packages/demo-params/versions/1.0.0/download', () => ({ status: 200, raw: bytes, contentType: 'application/zip' }));
  market.override('GET /api/market/packages/demo-params/versions/1.0.0/readme', () => ({ status: 200, body: { readme: '# Demo' } }));
  const secretStore = memoryStore();
  const launcher = path.join(dir, 'launcher.exe');
  const worker = startWorker({ deps: { userHome, lcaipackHome, env: {}, secretStore, mcpLauncherPath: launcher } }); t.after(() => worker.dispose());
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });

  const panel = await startPanel((method, payload) => worker.call(method, payload));
  for (let i = 0; i < 100 && !panel.get('catalog-list').children.length; i++) await delay(10);
  await panel.get('catalog-list').children[0].children.at(-1).fire('click'); await settle();
  for (let i = 0; i < 100 && !panel.get('install-target').children.length; i++) await delay(10);
  const cli = panel.get('install-target').children.find(l => /Claude Code/.test(textOf(l)));
  cli.children[0].checked = true; await cli.children[0].fire('change');
  await panel.get('install-plan').fire('click');

  const setupText = textOf(panel.get('install-setup'));
  assert.match(setupText, /設定參數/);
  assert.match(setupText, /Endpoint.*必填.*尚未提供/);
  assert.match(setupText, /API key.*尚未儲存/);
  assert.match(setupText, /使用者全域/);
  assert.equal(panel.get('install-confirm').classes.has('hidden'), true);
  assert.equal(panel.get('install-setup-save').classes.has('hidden'), false);
  assert.equal(input(panel, 'region').value, 'north');
  assert.deepEqual(input(panel, 'region').children.map(o => [o.value, o.textContent]), [['north', 'North'], ['south', 'South']]);
  assert.equal(input(panel, 'verbose').type, 'checkbox');
  assert.equal(input(panel, 'api-key').type, 'password');

  input(panel, 'endpoint').value = 'https://edited.example';
  input(panel, 'region').value = 'south';
  input(panel, 'verbose').checked = true;
  input(panel, 'api-key').value = CANARY;
  await panel.get('install-setup-save').fire('click');
  for (let i = 0; i < 100 && panel.get('install-confirm').classes.has('hidden'); i++) await delay(10);

  assert.equal(input(panel, 'api-key').value, '');
  assert.match(textOf(panel.get('install-setup')), /API key.*已儲存/);
  assert.equal(input(panel, 'endpoint').value, 'https://edited.example');
  assert.equal(panel.get('install-confirm').classes.has('hidden'), false);
  assert.match(fs.readFileSync(path.join(lcaipackHome, 'setup.json'), 'utf8'), /edited\.example/);
  await panel.get('install-confirm').fire('click');
  assert.match(textOf(panel.get('install-result')), /已完成/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userHome, '.claude.json'), 'utf8')).mcpServers.echo.command, launcher);
  assert.deepEqual(leakedSecrets([...worker.state.transcript, ...worker.state.logs, textOf(panel.get('install-summary')), textOf(panel.get('install-result')),
    fs.readFileSync(path.join(lcaipackHome, 'setup.json'), 'utf8'), fs.readFileSync(path.join(lcaipackHome, 'receipts.json'), 'utf8')], [CANARY]), []);
});
