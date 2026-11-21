// 面板的設定命令步驟（對照 LcAiPack.Tests GuiInstallProgressTests、GuiPlanSharingTests 的揭露與結果呈現）：
// 部署摘要列出命令與作用、確認前不執行；確認一次後命令先於部署；命令失敗時列出未部署的目標與原因；輸出不含秘密。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorker, leakedSecrets } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { startPanel, settle, textOf, detailsOf } from './panel-harness.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';
import { ofBytes } from '../worker/deploy/digest.mjs';

const CANARY = 'canary-panel-command-secret-10';
const KEY = 'demo-setup-bundle';

async function environment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-setup-10-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'user'), lcaipackHome = path.join(dir, 'lcaipack');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true }); fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), '{}');
  const bytes = zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: KEY, name: 'Demo Setup Bundle', type: 'bundle', version: '1.0.0', description: 'Synthetic',
    contents: [{ id: 'setup-skill', kind: 'skill', path: 'resources/skills/setup-skill' }],
    setup: { parameters: [{ parameterId: 'mode', label: 'Mode', type: 'string', required: true, default: 'short' }],
      commands: [{ commandId: 'write-marker', name: '寫入證據檔', runner: 'powershell', script: 'setup/write-marker.ps1', arguments: ['-Mode', '{{parameter:mode}}'], timeoutMinutes: 2 }] } }),
  'README.md': '# Demo', 'resources/skills/setup-skill/SKILL.md': '---\nname: setup-skill\ndescription: Synthetic\n---\nHello', 'setup/write-marker.ps1': 'exit 0\n' });
  const item = { packageKey: KEY, name: 'Demo Setup Bundle', type: 'bundle', description: 'Synthetic', latestReleaseVersion: '1.0.0' };
  const market = await startFakeMarket({ packages: [item] }); t.after(() => market.close());
  market.override(`GET /api/market/packages/${KEY}`, () => ({ status: 200, body: { ...item, recommendedVersion: '1.0.0',
    versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', status: 'active', hosts: ['claude-code'], sha256: ofBytes(bytes) }] } }));
  market.override(`GET /api/market/packages/${KEY}/versions/1.0.0/download`, () => ({ status: 200, raw: bytes, contentType: 'application/zip' }));
  market.override(`GET /api/market/packages/${KEY}/versions/1.0.0/readme`, () => ({ status: 200, body: { readme: '# Demo' } }));
  // 設定命令以替身執行（真實子行程見 setup-commands-worker）：記錄呼叫，依旗標回傳成功或失敗，並把輸出（含秘密）寫進 log。
  const state = { calls: 0, fail: false };
  const commandExecutor = { run: async request => {
    state.calls += 1;
    request.log.writeCommandStart(request.command.commandId, request.command.runner, request.command.script, request.command.arguments);
    request.log.writeStdout(`token=${CANARY}\n`);
    request.log.writeStderr('precondition missing\n');
    request.log.writeCommandEnd(request.command.commandId, state.fail ? 17 : 0, 1);
    return state.fail ? { commandId: request.command.commandId, outcome: 'Completed', exitCode: 17, durationMs: 1, failureSummary: '設定命令以非零 exit code 17 結束；詳細輸出見 operation log。', succeeded: false }
      : { commandId: request.command.commandId, outcome: 'Completed', exitCode: 0, durationMs: 1, failureSummary: null, succeeded: true };
  } };
  const fakeRunners = { resolve: runner => ({ runner, executable: `/fake/${runner}`, leadingArguments: [] }) };
  const worker = startWorker({ deps: { userHome, lcaipackHome, env: {}, secretStore: memoryStore(), commandExecutor, runners: fakeRunners, setupEnvironment: { operatingSystem: 'windows', architecture: 'x64' } } });
  t.after(() => worker.dispose());
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const panel = await startPanel((method, payload) => worker.call(method, payload));
  for (let i = 0; i < 100 && !panel.get('catalog-list').children.length; i++) await delay(10);
  await panel.get('catalog-list').children[0].children.at(-1).fire('click'); await settle();
  for (let i = 0; i < 100 && !panel.get('install-target').children.length; i++) await delay(10);
  const cli = panel.get('install-target').children.find(l => /Claude Code/.test(textOf(l)));
  cli.children[0].checked = true; await cli.children[0].fire('change');
  return { dir, userHome, lcaipackHome, worker, panel, state, skill: path.join(userHome, '.claude', 'skills', 'setup-skill', 'SKILL.md') };
}

test('部署摘要列出設定命令與作用、確認後先執行再部署；確認前不執行任何命令', async t => {
  const e = await environment(t);
  await e.panel.get('install-plan').fire('click');
  const summary = textOf(e.panel.get('install-summary'));
  assert.match(summary, /設定命令（確認後先執行 1 項，再部署）/);
  assert.match(summary, /寫入證據檔（此範圍從未成功執行過）/);
  assert.match(summary, /powershell setup\/write-marker\.ps1 -Mode short（逾時 2 分鐘）/);
  assert.equal(e.state.calls, 0);
  assert.equal(fs.existsSync(e.skill), false);
  assert.equal(e.panel.get('install-confirm').classes.has('hidden'), false);

  await e.panel.get('install-confirm').fire('click');
  assert.equal(e.state.calls, 1);
  assert.match(textOf(e.panel.get('install-status')), /安裝已完成/);
  const result = textOf(e.panel.get('install-result'));
  assert.match(result, /設定命令 寫入證據檔：成功/);
  assert.match(result, /操作 op-\d{8}T\d{6}Z-[0-9a-f]{8}；紀錄檔：/);
  assert.equal(fs.existsSync(e.skill), true);
  assert.equal(e.panel.get('install-cancel').classes.has('hidden'), true);
});

test('命令失敗：結果列出未部署的目標與原因、exit code 與已遮罩的輸出；目標不被改動，修正後可重新安裝', async t => {
  const e = await environment(t);
  e.state.fail = true;
  await e.panel.get('install-plan').fire('click');
  await e.panel.get('install-confirm').fire('click');
  assert.match(textOf(e.panel.get('install-status')), /安裝失敗/);
  const result = textOf(e.panel.get('install-result'));
  assert.match(result, /未部署（設定命令未成功，目標未被改動）/);
  assert.match(result, /受阻：設定命令 '寫入證據檔' 未成功/);
  assert.match(result, /設定命令 寫入證據檔：失敗（exit code 17）/);
  assert.match(result, /修正條件後按「完成」，再按「產生部署摘要」重新安裝/);
  assert.equal(e.panel.get('install-plan').classes.has('hidden'), false, '「產生部署摘要」在返回後的畫面');
  assert.equal(e.panel.get('install-steps').classes.has('hidden'), true, '失敗結果同樣只留結果，由「完成」返回');
  const output = detailsOf(e.panel.get('install-result')).find(d => /命令輸出/.test(d.summary));
  assert.ok(output, '命令輸出可展開');
  assert.ok(output.body.includes('[stderr] precondition missing') && output.body.includes('token=<redacted>'), output.body);
  assert.equal(fs.existsSync(e.skill), false);
  assert.equal(fs.existsSync(path.join(e.userHome, '.lcaipack')), false);
  assert.deepEqual(leakedSecrets([textOf(e.panel.get('install-result')), ...e.worker.state.transcript, ...e.worker.state.logs], [CANARY]), []);
  // 修正條件後重新產生摘要：上次未成功的命令重新執行並部署。
  e.state.fail = false;
  await e.panel.get('install-done').fire('click');
  assert.equal(e.panel.get('install-steps').classes.has('hidden'), false);
  await e.panel.get('install-plan').fire('click');
  assert.match(textOf(e.panel.get('install-summary')), /上一次執行沒有成功，這次重試/);
  await e.panel.get('install-confirm').fire('click');
  assert.match(textOf(e.panel.get('install-status')), /安裝已完成/);
  assert.equal(e.state.calls, 2);
  assert.equal(fs.existsSync(e.skill), true);
});
