// 生命週期編排（對照 LcAiPack.Tests DeploymentOperationOrchestratorTests、SetupCancellationTests 的編排部分、SetupRetrySessionTests）：
// operation 先落地 → 前置檢查 → 依宣告順序執行設定命令 → 受管 MCP 啟動描述 → 命令全部成功後才逐 target 套用。
// 命令以替身 executor 注入，因此順序保證（命令失敗時 target 零呼叫）能在不啟動真實子行程的情況下被鎖定；真實子行程見 setup-runner 與 setup-worker。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeploymentPlanner } from '../worker/deploy/planner.mjs';
import { createOperationOrchestrator } from '../worker/setup/orchestrator.mjs';
import { createOperationStore } from '../worker/setup/operations.mjs';
import { SetupCommandCompletionStore } from '../worker/setup/completions.mjs';
import { SetupIntent } from '../worker/setup/planning.mjs';
import { createSecretManager, setupSecretReference } from '../worker/setup/secrets.mjs';
import { Placeholder } from '../worker/setup/masker.mjs';
import { ofBytes } from '../worker/deploy/digest.mjs';
import { SetupValueStore } from '../worker/setup/values.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';

const KEY = 'demo-bundle';
const SKILL = '---\nname: hello\ndescription: Synthetic\n---\nHello';
const fakeRunners = { resolve: runner => ({ runner, executable: `/fake/${runner}`, leadingArguments: [] }) };
const host = { hostId: 'claude-code', surfaceId: 'claude-code-cli' };
const command = (commandId, extra = {}) => ({ commandId, name: `命令 ${commandId}`, runner: 'powershell', script: `setup/${commandId}.ps1`, operatingSystems: ['windows'], ...extra });
const ok = (commandId = 'prepare') => ({ commandId, outcome: 'Completed', exitCode: 0, durationMs: 5, failureSummary: null, succeeded: true });
const failed = (commandId = 'prepare', exitCode = 17) => ({ commandId, outcome: 'Completed', exitCode, durationMs: 5, failureSummary: `設定命令以非零 exit code ${exitCode} 結束；詳細輸出見 operation log。`, succeeded: false });

/** 腳本內容與版本無關：更新情境才能用「同一份腳本、不同版本」驗證 runOnUpdate。 */
const scriptOf = id => `Write-Host '${id}'\n`;
const scriptSha = id => ofBytes(Buffer.from(scriptOf(id)));

function packageOf({ setup, version = '1.0.0', scripts = ['prepare'], content = 'skill' }) {
  const contents = content === 'mcp'
    ? [{ id: 'gw', kind: 'mcp', name: 'Gateway', definition: { transport: 'stdio', command: 'node', args: ['{{setupRoot}}/runtime/server.js'], env: { MODE: 'demo' } } }]
    : [{ id: 'hello', kind: 'skill', path: 'resources/hello' }];
  const manifest = { packageFormatVersion: 1, key: KEY, name: 'Demo Bundle', type: content === 'mcp' ? 'mcp' : 'skill', version, description: 'Synthetic', contents, ...(setup ? { setup } : {}) };
  const entries = { 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo', 'resources/hello/SKILL.md': SKILL };
  for (const id of scripts) entries[`setup/${id}.ps1`] = scriptOf(id);
  const bytes = zip(entries);
  return { bytes, expectedSha256: ofBytes(bytes) };
}

function environment(t, { intent = SetupIntent.install, launcher, secretStore = memoryStore() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-orch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'user'), root = path.join(dir, 'repo'), home = path.join(dir, 'lcaipack');
  fs.mkdirSync(userHome); fs.mkdirSync(root);
  const secrets = createSecretManager(secretStore);
  const planner = createDeploymentPlanner({ home, userHome, clientVersion: '1.0.0-test', secrets, mcpLauncherPath: launcher, operatingSystem: 'windows',
    setupPlanning: { intent, runners: fakeRunners, environment: { operatingSystem: 'windows', architecture: 'x64' } } });
  const intentOf = pkg => ({ package: pkg, hosts: [host], scope: 'global', hostRoots: [{ host, canonicalRoots: [root] }], existingContent: 'Block' });
  const skill = path.join(root, 'skills', 'hello', 'SKILL.md');
  const receipts = path.join(home, 'receipts.json');
  /** 替身 executor：記錄呼叫、依序回傳預先指定的結果，並在執行當下觀察磁碟狀態。 */
  function executor(results = [], onRun = () => {}) {
    const calls = [];
    return { calls, run: async request => {
      const observed = { operationFiles: fs.existsSync(path.join(home, 'operations')) ? fs.readdirSync(path.join(home, 'operations')) : [], skillExists: fs.existsSync(skill), receiptsExist: fs.existsSync(receipts) };
      calls.push({ commandId: request.command.commandId, operationId: request.operationId, args: request.command.arguments, observed, payload: fs.existsSync(request.context.resolvePayloadPath(request.command.script)) });
      await onRun(request);
      return results.shift() ?? ok(request.command.commandId);
    } };
  }
  const orchestrate = (exec, extra = {}) => createOperationOrchestrator({ planner, executor: exec, ...extra });
  const store = createOperationStore({ home });
  const completions = () => SetupCommandCompletionStore.forGlobal({ home });
  return { dir, userHome, root, home, secrets, planner, intentOf, skill, receipts, executor, orchestrate, store, completions, secretStore };
}
const request = (plan, action = 'install', extra = {}) => ({ reviewedPlan: plan, authorization: { planDigest: plan.planDigest, replaceUnmanagedFiles: false }, action, ...extra });

test('operation 在任何命令之前就已落地；命令在任何 target 寫入之前執行，且 payload 已落地；全部成功後才套用並寫入收據', async t => {
  const e = environment(t);
  const exec = e.executor();
  const plan = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })));
  assert.equal(plan.canApply, true, JSON.stringify(plan.problems));
  const result = await e.orchestrate(exec).apply(request(plan));
  assert.equal(result.state, 'succeeded');
  assert.equal(result.checkpoint, 'completed');
  assert.equal(result.status, 'Succeeded');
  assert.equal(exec.calls.length, 1);
  const call = exec.calls[0];
  assert.equal(call.observed.operationFiles.some(n => n.endsWith('.json')), true, 'operation 檔必須先存在');
  assert.deepEqual([call.observed.skillExists, call.observed.receiptsExist, call.payload], [false, false, true]);
  assert.equal(call.operationId, result.operationId);
  assert.equal(fs.existsSync(e.skill), true);
  assert.equal(fs.existsSync(e.receipts), true);
  assert.deepEqual(result.commands.map(c => [c.commandId, c.executed, c.reason, c.succeeded]), [['prepare', true, 'FirstRun', true]]);
  assert.equal(e.completions().get(KEY, 'prepare').succeeded, true);
  const record = e.store.get(result.operationId);
  assert.deepEqual([record.state, record.checkpoint, record.kind, record.sessionCount], ['succeeded', 'completed', 'install', 1]);
  assert.equal(record.targets.length, 1);
  assert.ok(fs.readFileSync(result.logPath, 'utf8').includes('setup command run: prepare (FirstRun)'));
});

test('命令失敗時停在該命令：target 完全沒被呼叫、沒有寫入、沒有收據；失敗狀態被記錄並可重試', async t => {
  const e = environment(t);
  const exec = e.executor([failed('prepare', 17)]);
  const plan = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })));
  let targetCalls = 0;
  const spy = { ...e.planner, apply: (...args) => { targetCalls += 1; return e.planner.apply(...args); } };
  const result = await createOperationOrchestrator({ planner: spy, executor: exec }).apply(request(plan));
  assert.equal(targetCalls, 0);
  assert.deepEqual([result.state, result.checkpoint, result.status, result.apply], ['failed', 'setup-command:prepare', 'Failed', null]);
  assert.equal(result.canResume, true);
  assert.equal(fs.existsSync(e.skill), false);
  assert.equal(fs.existsSync(e.receipts), false);
  assert.deepEqual(result.commands.map(c => [c.commandId, c.executed, c.succeeded, c.exitCode]), [['prepare', true, false, 17]]);
  const problem = result.problems.find(p => p.code === 'deployment.setup-command-failed');
  assert.ok(problem && problem.severity === 'Blocking' && problem.summary.includes('命令 prepare') && problem.explanation.includes('17'));
  assert.equal(e.completions().get(KEY, 'prepare').succeeded, false);
  const record = e.store.get(result.operationId);
  assert.deepEqual([record.state, record.checkpoint], ['failed', 'setup-command:prepare']);
  assert.ok(record.failureSummary.includes('17'));
  // 修正條件後重新安裝：同一個命令「上次未成功」會重試，這次成功並部署。
  const fixed = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })));
  assert.equal(fixed.setup.commands[0].reason, 'PreviousFailure');
  const retry = await e.orchestrate(e.executor()).apply(request(fixed));
  assert.deepEqual([retry.state, retry.status, fs.existsSync(e.skill)], ['succeeded', 'Succeeded', true]);
});

test('多個命令依宣告順序執行，第一個沒有成功的命令就是終點，後面的命令不啟動', async t => {
  const e = environment(t);
  const exec = e.executor([ok('a'), failed('b', 2), ok('c')]);
  const plan = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('a'), command('b'), command('c')] }, scripts: ['a', 'b', 'c'] })));
  const result = await e.orchestrate(exec).apply(request(plan));
  assert.deepEqual(exec.calls.map(c => c.commandId), ['a', 'b']);
  assert.equal(result.checkpoint, 'setup-command:b');
  assert.deepEqual(result.commands.map(c => c.commandId), ['a', 'b']);
  assert.equal(e.completions().get(KEY, 'a').succeeded, true);
  assert.equal(e.completions().get(KEY, 'c'), null);
  assert.equal(fs.existsSync(e.skill), false);
});

test('命令成功但 target 套用部分未收斂時留下可繼續的 incomplete operation，且沿用同一 operation 與 log', async t => {
  const e = environment(t);
  const plan = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })));
  let applied = 0;
  const partial = { ...e.planner, apply: (p, a) => { applied += 1; return applied === 1
    ? { status: 'Partial', planDigest: p.planDigest, targets: [{ targetKey: p.targets[0].targetKey, status: 'Failed', diagnosticId: 'diag-1', problems: [{ code: 'deployment.apply-failed', severity: 'Blocking', summary: '寫入失敗' }] }], problems: [] }
    : e.planner.apply(p, a); } };
  const exec = e.executor();
  const first = await createOperationOrchestrator({ planner: partial, executor: exec }).apply(request(plan));
  assert.deepEqual([first.state, first.checkpoint, first.canResume], ['incomplete', 'targets-incomplete', true]);
  assert.equal(e.store.get(first.operationId).targets[0].result, 'failed');
  // 使用者修正後按「重試」：重新規劃並重新確認（命令已成功，新計畫顯示略過），再沿用同一個 operation 繼續。
  const replanned = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })));
  const second = await createOperationOrchestrator({ planner: partial, executor: e.executor() }).apply(request(replanned, 'install', { resumeOperationId: first.operationId }));
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.state, 'succeeded');
  assert.equal(e.store.get(first.operationId).sessionCount, 2);
  assert.equal(exec.calls.length, 1);
  const log = fs.readFileSync(first.logPath, 'utf8');
  assert.ok(log.includes('=== session 1') && log.includes('=== session 2') && log.includes('| retry ==='));
  assert.equal(e.completions().get(KEY, 'prepare').succeeded, true);
  // 第二次的 session 內，已經成功的命令不會再跑（完成狀態使其略過）。
  assert.deepEqual(second.commands.map(c => [c.executed, c.reason]), [[false, 'SkippedAlreadySucceeded']]);
});

test('審核後實際狀態改變時零命令、零 target 寫入並判定過期', async t => {
  const e = environment(t);
  const exec = e.executor();
  const pkg = packageOf({ setup: { parameters: [{ parameterId: 'server', label: 'Server', type: 'string', required: true, default: 'a' }], commands: [command('prepare')] } });
  const plan = e.planner.plan(e.intentOf(pkg));
  SetupValueStore.forGlobal({ home: e.home, userProfile: e.userHome }).setValues(KEY, { server: 'changed' });
  const result = await e.orchestrate(exec).apply(request(plan));
  assert.equal(exec.calls.length, 0);
  assert.deepEqual([result.state, result.checkpoint, result.status, result.commands, result.apply], ['failed', 'rejected-stale', 'Stale', [], null]);
  assert.ok(result.problems.some(p => p.code === 'deployment.plan-stale'));
  assert.equal(fs.existsSync(e.skill), false);
});

test('授權綁定其他計畫、計畫含 blocking problem、或動作與規劃意圖不一致時，在任何命令啟動前被拒', async t => {
  const e = environment(t);
  const exec = e.executor();
  const plan = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })));
  const other = await e.orchestrate(exec).apply({ ...request(plan), authorization: { planDigest: 'not-the-reviewed-digest' } });
  assert.deepEqual([other.state, other.checkpoint, other.status], ['failed', 'rejected', 'Rejected']);
  assert.ok(other.problems.some(p => p.code === 'deployment.plan-stale'));
  const mismatch = await e.orchestrate(exec).apply(request(plan, 'update'));
  assert.ok(mismatch.problems.some(p => p.code === 'deployment.setup-intent-mismatch'));
  const blocked = e.planner.plan(e.intentOf(packageOf({ setup: { parameters: [{ parameterId: 'server', label: 'S', type: 'string', required: true }], commands: [command('prepare')] } })));
  assert.equal(blocked.canApply, false);
  const refused = await e.orchestrate(exec).apply(request(blocked));
  assert.ok(refused.problems.some(p => p.code === 'deployment.apply-failed'));
  assert.equal(exec.calls.length, 0);
  assert.equal(fs.existsSync(e.skill), false);
  assert.ok(e.store.list().every(r => r.state === 'failed'));
});

test('同版乾淨重裝不跑任何命令但仍套用內容；更新只重跑宣告 runOnUpdate 的命令；重新設定一律重跑；修復不重跑', async t => {
  const e = environment(t, { intent: SetupIntent.reinstall });
  const setup = { commands: [command('prepare')] };
  e.completions().record(KEY, 'prepare', '1.0.0', scriptSha('prepare'), true, 'op-seed');
  const exec = e.executor();
  const plan = e.planner.plan(e.intentOf(packageOf({ setup })));
  assert.equal(plan.setup.commands[0].reason, 'SkippedAlreadySucceeded');
  const result = await e.orchestrate(exec).apply(request(plan, 'reinstall'));
  assert.equal(exec.calls.length, 0);
  assert.deepEqual([result.state, fs.existsSync(e.skill), result.commands[0].executed], ['succeeded', true, false]);

  const update = environment(t, { intent: SetupIntent.update });
  update.completions().record(KEY, 'a', '0.9.0', scriptSha('a'), true, 'op-seed');
  update.completions().record(KEY, 'b', '0.9.0', scriptSha('b'), true, 'op-seed');
  const updateExec = update.executor();
  const updatePlan = update.planner.plan(update.intentOf(packageOf({ version: '1.1.0', scripts: ['a', 'b'], setup: { commands: [command('a'), command('b', { runOnUpdate: true })] } })));
  const updated = await update.orchestrate(updateExec).apply(request(updatePlan, 'update'));
  assert.deepEqual(updateExec.calls.map(c => c.commandId), ['b']);
  assert.deepEqual(updated.commands.map(c => [c.commandId, c.executed, c.reason]), [['a', false, 'SkippedUpdateWithoutRunOnUpdate'], ['b', true, 'UpdateRunOnUpdate']]);
  assert.equal(update.store.get(updated.operationId).kind, 'update');

  const reconfigure = environment(t, { intent: SetupIntent.reconfigure });
  const sha = scriptSha('prepare');
  reconfigure.completions().record(KEY, 'prepare', '1.0.0', sha, true, 'op-seed');
  const reconfigureExec = reconfigure.executor();
  const reconfigured = await reconfigure.orchestrate(reconfigureExec).apply(request(reconfigure.planner.plan(reconfigure.intentOf(packageOf({ setup }))), 'reconfigure'));
  assert.deepEqual([reconfigureExec.calls.length, reconfigured.commands[0].reason], [1, 'Reconfigure']);

  const repair = environment(t, { intent: SetupIntent.repair });
  repair.completions().record(KEY, 'prepare', '1.0.0', sha, true, 'op-seed');
  const repairExec = repair.executor();
  const repaired = await repair.orchestrate(repairExec).apply(request(repair.planner.plan(repair.intentOf(packageOf({ setup }))), 'repair'));
  assert.deepEqual([repairExec.calls.length, repaired.state], [0, 'succeeded']);
});

test('沒有設定命令的資源包（只有參數或完全沒有 setup）走同一入口但不執行任何命令', async t => {
  const e = environment(t);
  const exec = e.executor();
  const bare = await e.orchestrate(exec).apply(request(e.planner.plan(e.intentOf(packageOf({ setup: null })))));
  assert.deepEqual([bare.state, bare.commands, exec.calls.length, fs.existsSync(e.skill)], ['succeeded', [], 0, true]);
});

test('受管 MCP 啟動描述在命令之後、target 之前寫入（managed-mcp checkpoint）', async t => {
  const launcher = path.join(os.tmpdir(), 'launcher', 'lcaipack.exe');
  const e = environment(t, { launcher });
  const setup = { parameters: [{ parameterId: 'api-key', label: 'API key', type: 'secret', required: true, secretUsage: 'runtime' }], commands: [command('prepare')] };
  const manifestPkg = () => {
    const manifest = { packageFormatVersion: 1, key: KEY, name: 'Demo', type: 'mcp', version: '1.0.0', description: 'Synthetic',
      contents: [{ id: 'gw', kind: 'mcp', name: 'Gateway', definition: { transport: 'stdio', command: 'node', args: ['{{setupRoot}}/runtime/server.js'], parameters: [{ id: 'api-key', type: 'secret', secret: true, required: true }] } }], setup };
    const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo', 'setup/prepare.ps1': 'exit 0\n' });
    return { bytes, expectedSha256: ofBytes(bytes) };
  };
  e.secrets.set(setupSecretReference({ packageKey: KEY, parameterId: 'api-key', scope: 'global', canonicalRoot: e.userHome }), 'runtime-canary');
  const plan = e.planner.plan(e.intentOf(manifestPkg()));
  assert.equal(plan.canApply, true, JSON.stringify(plan));
  let descriptorAtTargets = null;
  const spy = { ...e.planner, apply: (p, a) => { descriptorAtTargets = fs.existsSync(path.join(plan.setup.setupRoot, 'mcp', 'gw.json')); return e.planner.apply(p, a); } };
  const exec = e.executor([], () => { assert.equal(fs.existsSync(path.join(plan.setup.setupRoot, 'mcp', 'gw.json')), false, '命令執行時還不該有啟動描述'); });
  const result = await createOperationOrchestrator({ planner: spy, executor: exec }).apply(request(plan));
  assert.equal(result.state, 'succeeded');
  assert.equal(descriptorAtTargets, true);
  assert.ok(fs.readFileSync(result.logPath, 'utf8').includes('managed mcp launch descriptor written: gw'));
  assert.ok(!fs.readFileSync(path.join(plan.setup.setupRoot, 'mcp', 'gw.json'), 'utf8').includes('runtime-canary'));
});

test('全域範圍的 setup root：計畫揭露的與磁碟上實際建立的是同一個目錄', async t => {
  const e = environment(t);
  const claude = path.join(e.userHome, '.claude'); fs.mkdirSync(claude);
  const pkg = packageOf({ setup: { commands: [command('prepare')] } });
  const plan = e.planner.plan({ package: pkg, hosts: [host], scope: 'global', projectRoot: null, hostRoots: [{ host, canonicalRoots: [claude] }], existingContent: 'Block' });
  assert.equal(plan.canApply, true, JSON.stringify(plan.problems));
  assert.equal(fs.existsSync(plan.setup.setupRoot), false);
  const result = await e.orchestrate(e.executor()).apply(request(plan));
  assert.equal(result.state, 'succeeded');
  assert.equal(fs.statSync(path.join(plan.setup.setupRoot, 'runtime')).isDirectory(), true);
  assert.equal(SetupCommandCompletionStore.forGlobal({ home: e.home }).get(KEY, 'prepare').scope, 'global');
});

// ---------- 取消 ----------

test('命令執行中取消會留下可繼續的 cancelled operation，target 零寫入；逾時對應 timed-out', async t => {
  const e = environment(t);
  const plan = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })));
  const controller = new AbortController();
  const exec = e.executor([{ commandId: 'prepare', outcome: 'Cancelled', exitCode: null, durationMs: 3, failureSummary: '設定命令已由使用者取消，整棵子行程樹已終止。', succeeded: false }], () => controller.abort());
  const result = await e.orchestrate(exec).apply(request(plan, 'install', { signal: controller.signal }));
  assert.deepEqual([result.state, result.checkpoint, result.canResume], ['cancelled', 'setup-command:prepare', true]);
  assert.equal(fs.existsSync(e.skill), false);
  assert.equal(fs.existsSync(e.receipts), false);
  assert.equal(e.store.get(result.operationId).state, 'cancelled');
  assert.equal(e.completions().get(KEY, 'prepare').succeeded, false);
  const timedOut = await e.orchestrate(e.executor([{ commandId: 'prepare', outcome: 'TimedOut', exitCode: null, durationMs: 3, failureSummary: '設定命令逾時（1 分鐘），整棵子行程樹已終止。', succeeded: false }]))
    .apply(request(e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })))));
  assert.deepEqual([timedOut.state, e.store.get(timedOut.operationId).state], ['timed-out', 'timed-out']);
  // 取消之後再次安裝（沿用同一 operation）可以成功。
  const retry = await e.orchestrate(e.executor()).apply(request(e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } }))), 'install', { resumeOperationId: result.operationId }));
  assert.deepEqual([retry.operationId, retry.state], [result.operationId, 'succeeded']);
});

test('開始前就已取消：不啟動任何命令也不寫入 target', async t => {
  const e = environment(t);
  const exec = e.executor();
  const plan = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })));
  const controller = new AbortController(); controller.abort();
  const result = await e.orchestrate(exec).apply(request(plan, 'install', { signal: controller.signal }));
  assert.deepEqual([result.state, exec.calls.length, fs.existsSync(e.skill)], ['cancelled', 0, false]);
  assert.ok(result.problems.some(p => p.code === 'deployment.setup-cancelled'));
});

// ---------- 進度與秘密 ----------

test('進度是選填的純觀察出口：operation-started 最先到且帶最終 log 路徑；命令成對回報；Completed 恰好一則；沒有進度出口時結果相同', async t => {
  const e = environment(t);
  const events = [];
  const plan = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('a'), command('b')] }, scripts: ['a', 'b'] })));
  const result = await e.orchestrate(e.executor()).apply(request(plan, 'install', { onProgress: event => events.push(event) }));
  assert.equal(events[0].kind, 'operation-started');
  assert.equal(events[0].logPath, result.logPath);
  assert.deepEqual(events.map(x => x.kind), ['operation-started', 'setup-command-started', 'setup-command-finished', 'setup-command-started', 'setup-command-finished', 'targets-started', 'target-finished', 'completed']);
  assert.deepEqual(events.filter(x => x.kind.startsWith('setup-command')).map(x => x.commandId), ['a', 'a', 'b', 'b']);
  assert.ok(events.every(x => x.operationId === result.operationId && x.logPath === result.logPath));
  assert.deepEqual([events.at(-1).state, events.at(-1).succeeded], ['succeeded', true]);
  assert.equal(events.filter(x => x.kind === 'completed').length, 1);
  const plain = environment(t);
  const without = await plain.orchestrate(plain.executor()).apply(request(plain.planner.plan(plain.intentOf(packageOf({ setup: { commands: [command('a'), command('b')] }, scripts: ['a', 'b'] })))));
  assert.deepEqual([without.state, without.status], [result.state, result.status]);
});

test('被拒的 operation 仍收到 operation-started 與 completed；進度出口丟例外不改變安裝結果', async t => {
  const e = environment(t);
  const events = [];
  const plan = e.planner.plan(e.intentOf(packageOf({ setup: { commands: [command('prepare')] } })));
  await e.orchestrate(e.executor()).apply({ ...request(plan), authorization: { planDigest: 'nope' }, onProgress: x => events.push(x.kind) });
  assert.deepEqual(events, ['operation-started', 'completed']);
  const result = await e.orchestrate(e.executor()).apply(request(plan, 'install', { onProgress: () => { throw new Error('ui closed'); } }));
  assert.deepEqual([result.state, fs.existsSync(e.skill)], ['succeeded', true]);
});

test('秘密：setup-time 秘密只經通道交付且在 log 遮罩；進度事件、operation 狀態、結果與完成狀態都沒有秘密、argv 或腳本輸出', async t => {
  const e = environment(t);
  const CANARY = 'fake-setup-time-canary-77';
  e.secrets.set(setupSecretReference({ packageKey: KEY, parameterId: 'setup-pat', scope: 'global', canonicalRoot: e.userHome }), CANARY);
  const setup = { parameters: [{ parameterId: 'setup-pat', label: 'PAT', type: 'secret', required: true, secretUsage: 'setup-time' }, { parameterId: 'mode', label: 'Mode', type: 'string', required: true, default: 'fast' }],
    commands: [command('prepare', { arguments: ['-Mode', '{{parameter:mode}}'] })] };
  const events = [];
  let frame = '';
  const exec = e.executor([failed('prepare', 9)], request => {
    request.secrets.writeTo({ write: text => { frame += text; } });
    request.log.writeStdout(`leaked=${CANARY}\n`);
    request.log.writeStderr(`also=${CANARY}\n`);
  });
  const plan = e.planner.plan(e.intentOf(packageOf({ setup })));
  assert.equal(plan.canApply, true, JSON.stringify(plan.problems));
  const result = await e.orchestrate(exec).apply(request(plan, 'install', { onProgress: x => events.push(x) }));
  assert.ok(frame.includes(Buffer.from(CANARY).toString('base64')));
  const everything = [fs.readFileSync(result.logPath, 'utf8'), JSON.stringify(events), JSON.stringify(result), fs.readFileSync(e.store.getStatePath(result.operationId), 'utf8'), fs.readFileSync(e.completions().filePath, 'utf8')];
  for (const text of everything) assert.ok(!text.includes(CANARY) && !text.includes(Buffer.from(CANARY).toString('base64')));
  assert.ok(everything[0].includes(`leaked=${Placeholder}`));
  // 進度事件只有結構化里程碑：沒有 argv、輸出或失敗全文。
  for (const event of events) assert.ok(!('arguments' in event) && !('output' in event) && !('failureSummary' in event));
  assert.deepEqual(events.filter(x => x.kind === 'setup-command-finished').map(x => [x.succeeded, x.exitCode]), [[false, 9]]);
});

test('缺少必填的 setup-time 秘密在命令啟動前以 secret-unresolved 中止，且 target 零寫入', async t => {
  const e = environment(t);
  const setup = { parameters: [{ parameterId: 'setup-pat', label: 'PAT', type: 'secret', required: true, secretUsage: 'setup-time' }], commands: [command('prepare')] };
  const plan = e.planner.plan(e.intentOf(packageOf({ setup })));
  assert.equal(plan.canApply, false);
  // 規劃階段已阻擋；即使有人繞過（審核後秘密被刪除），執行階段也以相同原因中止。
  e.secrets.set(setupSecretReference({ packageKey: KEY, parameterId: 'setup-pat', scope: 'global', canonicalRoot: e.userHome }), 'temp');
  const reviewed = e.planner.plan(e.intentOf(packageOf({ setup })));
  assert.equal(reviewed.canApply, true);
  e.secrets.delete(setupSecretReference({ packageKey: KEY, parameterId: 'setup-pat', scope: 'global', canonicalRoot: e.userHome }));
  const exec = e.executor();
  const result = await e.orchestrate(exec).apply(request(reviewed));
  assert.equal(exec.calls.length, 0);
  assert.equal(result.status === 'Stale' || result.problems.some(p => p.code === 'deployment.secret-unresolved'), true);
  assert.equal(fs.existsSync(e.skill), false);
});
