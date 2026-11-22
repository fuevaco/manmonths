// 工項 09～12 面板驗收（真實 worker ＋ 假市集 ＋ 臨時家目錄）：一鍵安裝到多個根目錄、三種例外確認、部分受阻、
// 全部受阻、過期重規劃、設定命令失敗、只重試失敗、補裝、設定參數重新套用。取代舊的部署摘要面板測試。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorker, leakedSecrets } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';

const key = 'one-click-panel';
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : '';
async function until(check, message = '等待逾時') {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  assert.fail(message);
}

async function environment(t, { setup, hosts = ['codex'], type = 'skill', deps = {}, roots = ['.codex'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-panel-one-click-'));
  const userHome = path.join(dir, 'user'), lcaipackHome = path.join(dir, 'shared');
  function root(name) {
    const p = path.join(userHome, name); fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, name.startsWith('.codex') ? 'config.toml' : 'settings.json'), name.startsWith('.codex') ? '' : '{}'); return p;
  }
  roots.forEach(root);
  let recommended = '1.0.0';
  const versions = ['1.0.0', '2.0.0'].map(version => {
    const bytes = zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key, name: '一鍵合成包', type, version, description: 'Synthetic',
      contents: [{ id: 'hello', kind: 'skill', path: 'resources/hello' }], ...(setup ? { setup } : {}) }),
    'README.md': '# Hello', 'resources/hello/SKILL.md': `---\nname: hello\ndescription: Synthetic\n---\nVersion ${version}`, 'setup/init.ps1': 'exit 0' });
    return { version, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), hosts, isEnabled: true, channel: 'release' };
  });
  const market = await startFakeMarket();
  market.override('GET /api/market/packages', () => ({ status: 200, body: { data: [{ packageKey: key, name: '一鍵合成包', type, latestReleaseVersion: recommended }], meta: { total: 1 } } }));
  market.override(`GET /api/market/packages/${key}`, () => ({ status: 200, body: { packageKey: key, name: '一鍵合成包', type, recommendedVersion: recommended, versions: versions.filter(v => v.version <= recommended).map(({ bytes, ...v }) => v) } }));
  for (const v of versions) {
    market.override(`GET /api/market/packages/${key}/versions/${v.version}/download`, () => ({ status: 200, raw: v.bytes, contentType: 'application/zip' }));
    market.override(`GET /api/market/packages/${key}/versions/${v.version}/readme`, () => ({ status: 200, body: { readme: '# Hello' } }));
  }
  const worker = startWorker({ deps: { userHome, lcaipackHome, env: {}, secretStore: memoryStore(), ...deps } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const receiptFile = path.join(lcaipackHome, 'receipts.json');
  const e = {
    worker, root, userHome, lcaipackHome, receiptFile, recommend(v) { recommended = v; },
    receipts: () => { try { return JSON.parse(fs.readFileSync(receiptFile, 'utf8')).receipts; } catch { return []; } },
    detail: () => worker.call('rc.package.getDetails', { packageKey: key }),
    async openPanel() {
      e.panel = await startPanel((method, input) => worker.call(method, input));
      await until(() => e.card(), '清單未載入');
      return e.panel;
    },
    card: () => findByData(e.panel.get('catalog-list'), 'package-key', key),
    status: () => text(findByData(e.card(), 'role', 'status-text')),
    toast: () => e.panel.get('toast').classList.contains('hidden') ? '' : text(e.panel.get('toast')),
    layerOpen: () => !e.panel.get('confirm-layer').classList.contains('hidden'),
    async click(node) { assert.ok(node, '找不到按鈕'); await node.fire('click'); await settle(); },
    async refresh(expected) { await e.panel.get('btn-refresh').fire('click'); await until(() => e.card() && e.status() === expected, `重新整理後應顯示「${expected}」`); },
    tamper() { const ledger = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); ledger.receipts[0].packageKey = 'another-package'; fs.writeFileSync(receiptFile, JSON.stringify(ledger)); },
    untamper() { const ledger = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); ledger.receipts = ledger.receipts.filter(r => r.packageKey !== 'another-package'); fs.writeFileSync(receiptFile, JSON.stringify(ledger)); }
  };
  return e;
}
const action = (root, name) => findByData(root, 'action', name);
const commandDeps = (state) => ({
  runners: { resolve: runner => ({ runner, executable: '/fake/powershell', leadingArguments: [] }) },
  setupEnvironment: { operatingSystem: 'windows', architecture: 'x64' },
  commandExecutor: { run: async (request) => { state.calls.push(request.command.arguments); return state.fail
    ? { commandId: request.command.commandId, outcome: 'Completed', exitCode: 17, durationMs: 1, failureSummary: '設定命令以非零 exit code 17 結束', succeeded: false }
    : { commandId: request.command.commandId, outcome: 'Completed', exitCode: 0, durationMs: 1, failureSummary: null, succeeded: true }; } }
});

test('一鍵安裝：按卡片「安裝」直接部署到所有相容的全域根目錄，不顯示確認，短提示並更新卡片', async t => {
  const e = await environment(t, { hosts: ['codex', 'claude-code'], roots: ['.codex', '.codex-work', '.claude'] });
  await e.openPanel();
  assert.equal(e.status(), '未安裝');
  await e.click(action(e.card(), 'install'));
  await until(() => e.toast(), '沒有結果提示');
  assert.equal(e.layerOpen(), false);
  assert.equal(e.toast(), '已安裝到 2 個位置');
  assert.equal(e.receipts().length, 2);
  assert.deepEqual([...new Set(e.receipts().map(r => r.scope))], ['global'], 'Orca 只建立全域部署');
  await until(() => e.status() === '已安裝 1.0.0', '卡片狀態未更新');
  assert.deepEqual(findAllByData(e.card(), 'tool').map(n => [n.getAttribute('data-tool'), n.getAttribute('data-deployed')]), [['codex', 'true'], ['claude-code', 'true']]);
  assert.equal(action(e.card(), 'install'), null);
  assert.equal((await e.detail()).deployments.length, 2);
});

test('缺少必要參數：確認層以表單收集（秘密為 password），儲存後安裝；值與 LC-AI-Pack 共用且秘密不外洩', async t => {
  const CANARY = 'canary-one-click-panel-secret';
  const e = await environment(t, { setup: { parameters: [
    { parameterId: 'endpoint', label: '服務網址', type: 'string', required: true },
    { parameterId: 'token', label: 'API 金鑰', type: 'secret', secretUsage: 'setup-time', required: true }] } });
  await e.openPanel();
  await e.click(action(e.card(), 'install'));
  await until(() => e.layerOpen(), '沒有確認層');
  const body = e.panel.get('confirm-body');
  assert.ok(findByData(body, 'section', 'missingParameters'));
  assert.equal(findByData(body, 'param', 'token').type, 'password');
  assert.equal(e.receipts().length, 0, '確認前不寫入');
  findByData(body, 'param', 'endpoint').value = 'https://synthetic.example';
  findByData(body, 'param', 'token').value = CANARY;
  await e.click(e.panel.get('confirm-primary'));
  await until(() => e.toast(), '沒有結果提示');
  assert.equal(e.toast(), '已安裝到 1 個位置');
  assert.equal(e.layerOpen(), false);
  assert.match(fs.readFileSync(path.join(e.lcaipackHome, 'setup.json'), 'utf8'), /synthetic\.example/);
  const params = (await e.detail()).parameters;
  assert.equal(params.find(p => p.parameterId === 'token').isSet, true);
  assert.deepEqual(leakedSecrets([...e.worker.state.transcript, ...e.worker.state.logs, textOf(e.panel.get('view-main')), textOf(e.panel.get('confirm-layer')),
    fs.readFileSync(path.join(e.lcaipackHome, 'setup.json'), 'utf8'), fs.readFileSync(e.receiptFile, 'utf8')], [CANARY]), []);
});

test('設定命令：確認層列出用途與命令，確認前不執行；確認一次後先執行再安裝', async t => {
  const state = { calls: [], fail: false };
  const e = await environment(t, { setup: { commands: [{ commandId: 'init', name: '準備環境', runner: 'powershell', script: 'setup/init.ps1' }] }, deps: commandDeps(state) });
  await e.openPanel();
  await e.click(action(e.card(), 'install'));
  await until(() => e.layerOpen(), '沒有確認層');
  const row = findByData(e.panel.get('confirm-body'), 'role', 'setup-command');
  assert.match(text(row), /準備環境/);
  assert.match(text(row), /powershell setup\/init\.ps1/);
  assert.equal(state.calls.length, 0);
  await e.click(e.panel.get('confirm-primary'));
  await until(() => e.toast(), '沒有結果提示');
  assert.equal(state.calls.length, 1);
  assert.equal(e.toast(), '已安裝到 1 個位置');
});

test('缺少參數又有設定命令：填入參數並確認一次即執行（命令帶入新值），不重複詢問', async t => {
  const state = { calls: [], fail: false };
  const e = await environment(t, { setup: { parameters: [{ parameterId: 'mode', label: '模式', type: 'string', required: true }],
    commands: [{ commandId: 'init', name: '準備環境', runner: 'powershell', script: 'setup/init.ps1', arguments: ['-Mode', '{{parameter:mode}}'] }] }, deps: commandDeps(state) });
  await e.openPanel();
  await e.click(action(e.card(), 'install'));
  await until(() => e.layerOpen(), '沒有確認層');
  const body = e.panel.get('confirm-body');
  assert.ok(findByData(body, 'section', 'missingParameters'));
  assert.ok(findByData(body, 'section', 'setupCommands'));
  findByData(body, 'param', 'mode').value = 'quick';
  await e.click(e.panel.get('confirm-primary'));
  await until(() => e.toast(), '沒有結果提示');
  assert.equal(e.layerOpen(), false);
  assert.deepEqual(state.calls, [['-Mode', 'quick']]);
});

test('部分受阻：確認一次後可部署的部署目標完成，受阻的記為略過（中性提示、灰色徽章、無重試），重新開啟後仍顯示；排除原因後補裝會再嘗試', async t => {
  const e = await environment(t, { hosts: ['claude-code'], roots: ['.claude'] });
  await e.worker.call('rc.install.run', { packageKey: key, action: 'install' });
  e.tamper(); e.root('.claude-work');
  await e.openPanel();
  await e.click(action(e.card(), 'install'));
  await until(() => e.layerOpen(), '沒有確認層');
  const body = e.panel.get('confirm-body');
  const blocked = findByData(body, 'role', 'blocked-target');
  assert.match(text(blocked), /Claude Code/);
  assert.ok(text(blocked).includes(path.join(e.userHome, '.claude')));
  assert.match(text(body), /其餘 1 個位置仍會安裝/);
  await e.click(e.panel.get('confirm-primary'));
  await until(() => e.toast(), '沒有結果提示');
  assert.equal(e.toast(), '已安裝到 1 個位置，略過 1 個位置');
  assert.ok(e.panel.get('toast').classList.contains('info'), '中性樣式');
  assert.equal(e.panel.get('toast').classList.contains('error'), false);
  await until(() => findByData(e.card(), 'role', 'skipped'), '卡片沒有略過徽章');
  assert.equal(text(findByData(e.card(), 'role', 'skipped')), '略過 1 個位置');
  assert.equal(findByData(e.card(), 'role', 'failure'), null, '略過不是失敗');
  await e.click(findByData(e.card(), 'role', 'skipped'));
  const list = findByData(e.card(), 'role', 'skipped-list');
  assert.ok(list, '點徽章展開清單');
  assert.ok(text(list).includes(path.join(e.userHome, '.claude')));
  assert.equal(findAllByData(list, 'action').length, 0, '沒有重試按鈕');
  assert.equal(e.receipts().filter(r => r.packageKey === key).length, 1);

  await e.openPanel(); // 重新開啟面板：依 lastSkipped 仍顯示
  await until(() => findByData(e.card(), 'role', 'skipped'), '重新開啟後沒有略過徽章');
  assert.equal(text(findByData(e.card(), 'role', 'skipped')), '略過 1 個位置');
  assert.equal(findByData(e.card(), 'role', 'failure'), null);

  e.untamper();
  await e.panel.get('btn-refresh').fire('click');
  await until(() => action(e.card(), 'fill-pending'), '排除原因後應可補裝');
  await e.click(action(e.card(), 'fill-pending'));
  await until(() => e.toast().includes('補裝'), '補裝沒有結果');
  assert.equal(e.receipts().filter(r => r.packageKey === key).length, 2);
  await until(() => !findByData(e.card(), 'role', 'skipped'), '略過提示未清除');
});

test('全部受阻：確認層只顯示原因與「關閉」，不套用', async t => {
  const e = await environment(t);
  await e.worker.call('rc.install.run', { packageKey: key, action: 'install' });
  e.tamper();
  await e.openPanel();
  await e.click(action(e.card(), 'install'));
  await until(() => e.layerOpen(), '沒有確認層');
  assert.match(text(e.panel.get('confirm-title')), /無法安裝/);
  assert.ok(findByData(e.panel.get('confirm-body'), 'role', 'blocked-target'));
  assert.equal(e.panel.get('confirm-primary').classList.contains('hidden'), true);
  assert.equal(text(e.panel.get('confirm-cancel')), '關閉');
  await e.click(e.panel.get('confirm-cancel'));
  assert.equal(e.layerOpen(), false);
  assert.equal(e.receipts().filter(r => r.packageKey === key).length, 0);
});

test('過期重規劃：確認前本機狀態改變，確認層更新內容並要求再確認；之後才執行命令', async t => {
  const state = { calls: [], fail: false };
  const e = await environment(t, { setup: { commands: [{ commandId: 'init', name: '準備', runner: 'powershell', script: 'setup/init.ps1' }] }, deps: commandDeps(state) });
  await e.openPanel();
  await e.click(action(e.card(), 'install'));
  await until(() => e.layerOpen(), '沒有確認層');
  const dest = path.join(e.userHome, '.agents', 'skills', 'hello'); fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'SKILL.md'), '本機修改');
  await e.click(e.panel.get('confirm-primary'));
  await until(() => text(e.panel.get('confirm-body')).includes('本機狀態已改變'), '沒有更新確認層');
  assert.equal(e.layerOpen(), true);
  assert.equal(state.calls.length, 0);
  await e.click(e.panel.get('confirm-primary'));
  await until(() => e.toast(), '沒有結果提示');
  assert.equal(state.calls.length, 1);
  assert.equal(e.layerOpen(), false);
});

test('設定命令失敗：卡片與明細顯示失敗與原因；重新開啟面板仍顯示，修正後重試（依例外確認）即清除', async t => {
  const state = { calls: [], fail: true };
  const e = await environment(t, { setup: { commands: [{ commandId: 'init', name: '準備環境', runner: 'powershell', script: 'setup/init.ps1' }] }, deps: commandDeps(state) });
  await e.openPanel();
  await e.click(action(e.card(), 'install'));
  await until(() => e.layerOpen(), '沒有確認層');
  await e.click(e.panel.get('confirm-primary'));
  await until(() => findByData(e.card(), 'role', 'failure'), '沒有失敗提示');
  assert.ok(e.panel.get('toast').classList.contains('error'));
  assert.match(text(findByData(e.card(), 'role', 'failure-list')), /結束代碼 17/);

  await e.openPanel(); // 重新開啟面板：依 lastFailure 仍顯示
  assert.equal(text(findByData(e.card(), 'role', 'failure')), '1 個位置失敗');
  await e.click(e.card());
  await until(() => findByData(e.panel.get('details-status-row'), 'role', 'failure'), '明細沒有失敗提示');
  await e.click(findByData(e.panel.get('details-status-row'), 'role', 'failure'));
  state.fail = false;
  await e.click(action(findByData(e.panel.get('details-status-row'), 'role', 'failure-list'), 'retry'));
  await until(() => e.layerOpen(), '重試仍需依設定命令確認');
  assert.equal(text(e.panel.get('confirm-primary')), '重試');
  await e.click(e.panel.get('confirm-primary'));
  await until(() => e.toast().includes('重新安裝'), '重試沒有結果');
  await until(() => !findByData(e.panel.get('details-status-row'), 'role', 'failure'), '失敗提示未清除');
  assert.equal(state.calls.length, 2);
});

test('補裝：新增根目錄後顯示「N 個新位置」與「補裝」，只部署待補裝目標並沿用已安裝版本；有新版時「更新」一併補齊', async t => {
  const e = await environment(t, { hosts: ['claude-code'], roots: ['.claude'] });
  await e.worker.call('rc.install.run', { packageKey: key, action: 'install' });
  e.root('.claude-work');
  await e.openPanel();
  assert.equal(e.status(), '已安裝 1.0.0 · 1 個新位置');
  e.recommend('1.0.0');
  await e.click(action(e.card(), 'fill-pending'));
  await until(() => e.toast(), '沒有結果提示');
  assert.equal(e.toast(), '已補裝到 1 個位置');
  await until(() => e.status() === '已安裝 1.0.0', '狀態未更新');
  assert.equal(action(e.card(), 'fill-pending'), null);
  assert.deepEqual((await e.detail()).deployments.map(d => d.version), ['1.0.0', '1.0.0']);

  e.root('.claude-third'); e.recommend('2.0.0');
  await e.refresh('可更新 1.0.0 → 2.0.0');
  await e.click(action(e.card(), 'update'));
  await until(() => e.toast().startsWith('已更新'), '沒有更新結果');
  assert.equal(e.toast(), '已更新 3 個位置');
  assert.ok((await e.detail()).deployments.every(d => d.version === '2.0.0'));
  assert.equal((await e.detail()).deployments.length, 3);
});

test('設定參數：明細修改後「儲存並重新套用」，LC-AI-Pack 共用設定讀到新值，秘密只顯示已設定', async t => {
  const CANARY = 'canary-reapply-secret';
  const e = await environment(t, { setup: { parameters: [{ parameterId: 'endpoint', label: '服務網址', type: 'string', default: 'before' },
    { parameterId: 'token', label: 'API 金鑰', type: 'secret', secretUsage: 'setup-time', required: false }] } });
  await e.worker.call('rc.install.run', { packageKey: key, action: 'install' });
  await e.openPanel();
  await e.click(e.card());
  await until(() => findByData(e.panel.get('details-setup'), 'role', 'setup'), '沒有設定參數區塊');
  const section = findByData(e.panel.get('details-setup'), 'role', 'setup');
  assert.equal(findByData(section, 'param', 'endpoint').value, 'before');
  assert.match(text(findByData(section, 'param-row', 'token')), /未設定/);
  findByData(section, 'param', 'endpoint').value = 'after';
  findByData(section, 'param', 'token').value = CANARY;
  await e.click(action(section, 'save-setup'));
  await until(() => e.toast(), '沒有結果提示');
  assert.equal(e.toast(), '已重新套用到 1 個位置');
  assert.match(fs.readFileSync(path.join(e.lcaipackHome, 'setup.json'), 'utf8'), /"after"/);
  await until(() => text(findByData(findByData(e.panel.get('details-setup'), 'role', 'setup'), 'param-row', 'token')).includes('已設定'), '秘密狀態未更新');
  assert.deepEqual(leakedSecrets([...e.worker.state.transcript, ...e.worker.state.logs, textOf(e.panel.get('view-details'))], [CANARY]), []);
});
