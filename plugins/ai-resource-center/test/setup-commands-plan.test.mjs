// 設定命令的規劃與完成狀態（對照 SetupPlanningTests 的命令情境、SetupCommandCompletionTests、
// SetupPlanDigestTests、SetupRetrySessionTests 的判斷部分、SetupPerOsPackageTests 的規劃部分）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecretManager } from '../worker/setup/secrets.mjs';
import { planSetup, computeSetupDigest, appendSetupDigest, executableCommands, SetupIntent } from '../worker/setup/planning.mjs';
import { SetupCommandCompletionStore } from '../worker/setup/completions.mjs';
import { createRunnerRegistry } from '../worker/setup/runners.mjs';
import { memoryStore } from './fake-secret-store.mjs';

const SHA = '1'.repeat(64);
const fakeRunners = { resolve: (runner) => ({ runner, executable: `/fake/${runner}`, leadingArguments: ['--fake'] }) };
const unavailableRunners = { resolve: () => null };
/** 只解析該作業系統原生存在的 runner，用來驗「不適用的命令不該報 runner 問題」。 */
const nativeRunners = { resolve: (runner, operatingSystem) => (runner === (operatingSystem === 'windows' ? 'powershell' : 'bash')
  ? { runner, executable: `/fake/${runner}`, leadingArguments: ['--fake'] } : null) };

function environment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-cmd-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), userHome = path.join(dir, 'user'), projectRoot = path.join(dir, 'repo');
  fs.mkdirSync(userHome); fs.mkdirSync(projectRoot);
  const secrets = createSecretManager(memoryStore());
  const plan = (setup, { scope = 'project', intent = SetupIntent.install, os: operatingSystem = 'windows', arch = 'x64', runners = fakeRunners, pendingValues } = {}) =>
    planSetup({ setup, packageKey: 'demo-setup', packageVersion: '1.0.0', scope, projectRoot: scope === 'project' ? projectRoot : null, home, userHome, secrets,
      intent, pendingValues, runners, environment: { operatingSystem, architecture: arch }, scriptSha256: () => SHA });
  const completions = () => SetupCommandCompletionStore.forProject({ projectRoot });
  return { dir, home, userHome, projectRoot, secrets, plan, completions };
}
const command = (commandId = 'prepare', extra = {}) => ({ commandId, name: commandId, runner: 'powershell', script: 'setup/run.ps1', ...extra });
const param = (parameterId, extra = {}) => ({ parameterId, label: parameterId, type: 'string', required: false, ...extra });

// ---------- 完成狀態與「這次要不要跑」（SetupCommandCompletionTests） ----------

const decideInput = (extra = {}) => ({ packageKey: 'demo-setup', commandId: 'tfs.install', packageVersion: '1.0.0', scriptSha256: 'a1b2c3', intent: 'Install', runOnUpdate: false, ...extra });

test('完成狀態檔位置：全域在家目錄、專案在專案的 .lcaipack；專案範圍必須提供專案根', t => {
  const e = environment(t);
  assert.equal(SetupCommandCompletionStore.forGlobal({ home: e.home }).filePath, path.resolve(e.home, 'setup-commands.json'));
  assert.equal(SetupCommandCompletionStore.forProject({ projectRoot: e.projectRoot }).filePath, path.resolve(e.projectRoot, '.lcaipack', 'setup-commands.json'));
  assert.throws(() => SetupCommandCompletionStore.forScope({ scope: 'project', projectRoot: null, home: e.home }), TypeError);
});

test('沒有紀錄時為首次執行；同版重裝在成功後略過；上次未成功則重試；重新設定一律重跑', t => {
  const e = environment(t);
  const store = e.completions();
  assert.deepEqual(store.decide(decideInput()), { commandId: 'tfs.install', shouldRun: true, reason: 'FirstRun' });
  store.record('demo-setup', 'tfs.install', '1.0.0', 'a1b2c3', false, 'op-1');
  assert.deepEqual([store.decide(decideInput({ intent: 'Reinstall' })).shouldRun, store.decide(decideInput({ intent: 'Reinstall' })).reason], [true, 'PreviousFailure']);
  store.record('demo-setup', 'tfs.install', '1.0.0', 'a1b2c3', true, 'op-2');
  assert.deepEqual([store.decide(decideInput({ intent: 'Reinstall' })).shouldRun, store.decide(decideInput({ intent: 'Reinstall' })).reason], [false, 'SkippedAlreadySucceeded']);
  assert.equal(store.decide(decideInput({ intent: 'Repair' })).reason, 'SkippedAlreadySucceeded');
  assert.deepEqual([store.decide(decideInput({ intent: 'Reconfigure' })).shouldRun, store.decide(decideInput({ intent: 'Reconfigure' })).reason], [true, 'Reconfigure']);
});

test('更新只有在作者宣告 runOnUpdate 時重跑；版本改變即使意圖是安裝也依更新規則；腳本內容改變使既有成功失效', t => {
  const e = environment(t);
  const store = e.completions();
  store.record('demo-setup', 'tfs.install', '1.0.0', 'a1b2c3', true, 'op-1');
  assert.deepEqual([store.decide(decideInput({ packageVersion: '1.1.0', intent: 'Update', runOnUpdate: true })).shouldRun, store.decide(decideInput({ packageVersion: '1.1.0', intent: 'Update', runOnUpdate: true })).reason], [true, 'UpdateRunOnUpdate']);
  assert.deepEqual([store.decide(decideInput({ packageVersion: '1.1.0', intent: 'Update' })).shouldRun, store.decide(decideInput({ packageVersion: '1.1.0', intent: 'Update' })).reason], [false, 'SkippedUpdateWithoutRunOnUpdate']);
  assert.equal(store.decide(decideInput({ packageVersion: '2.0.0' })).reason, 'SkippedUpdateWithoutRunOnUpdate');
  assert.equal(store.decide(decideInput({ packageVersion: '2.0.0', runOnUpdate: true })).reason, 'UpdateRunOnUpdate');
  const changed = store.decide(decideInput({ scriptSha256: 'ffffff', intent: 'Reinstall' }));
  assert.deepEqual([changed.shouldRun, changed.reason], [true, 'ScriptChanged']);
});

test('完成紀錄以資源包與命令為身分、同一命令覆寫而非追加；專案與全域互相獨立；紀錄不含參數或秘密', t => {
  const e = environment(t);
  const store = e.completions();
  store.record('demo-setup', 'tfs.install', '1.0.0', 'a1b2c3', true, 'op-1');
  store.record('demo-setup', 'tfs.verify', '1.0.0', 'dddddd', false, 'op-1');
  store.record('other-pkg', 'tfs.install', '9.9.9', 'eeeeee', true, 'op-2');
  assert.equal(store.forPackage('demo-setup').length, 2);
  store.record('demo-setup', 'tfs.install', '1.0.0', 'a1b2c3', false, 'op-3');
  assert.deepEqual(store.forPackage('demo-setup').map(c => [c.commandId, c.succeeded, c.operationId]), [['tfs.install', false, 'op-3'], ['tfs.verify', false, 'op-1']]);
  assert.deepEqual(Object.keys(store.get('demo-setup', 'tfs.verify')).sort(),
    ['commandId', 'completedAt', 'extra', 'operationId', 'packageKey', 'packageVersion', 'scope', 'scriptSha256', 'succeeded']);
  const onDisk = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.completions[0]), ['packageKey', 'scope', 'commandId', 'packageVersion', 'scriptSha256', 'succeeded', 'completedAt', 'operationId']);
  const global = SetupCommandCompletionStore.forGlobal({ home: e.home });
  global.record('demo-setup', 'tfs.install', '1.0.0', 'a1b2c3', true, 'op-9');
  store.clearPackage('demo-setup');
  assert.deepEqual(store.forPackage('demo-setup'), []);
  assert.equal(global.get('demo-setup', 'tfs.install').succeeded, true);
});

test('完成狀態檔損壞或格式版本不支援時明確失敗；保留未知欄位並與 .NET 版序列化相同', t => {
  const e = environment(t);
  const store = SetupCommandCompletionStore.forGlobal({ home: e.home });
  fs.mkdirSync(e.home, { recursive: true });
  fs.writeFileSync(store.filePath, 'not json at all');
  assert.throws(() => store.decide(decideInput()), /setup 狀態檔/);
  fs.writeFileSync(store.filePath, '{"setupFormatVersion":42,"completions":[]}');
  assert.throws(() => store.load(), /42/);
  fs.writeFileSync(store.filePath, '{"setupFormatVersion":1,"completions":[],"future":{"a":1}}');
  store.record('demo-setup', 'c', '1.0.0', 'abc', true, 'op-1', new Date('2026-08-21T01:02:03.456Z'));
  const text = fs.readFileSync(store.filePath, 'utf8');
  const nl = os.EOL;
  assert.equal(text, ['{', '  "setupFormatVersion": 1,', '  "completions": [', '    {', '      "packageKey": "demo-setup",', '      "scope": "global",', '      "commandId": "c",',
    '      "packageVersion": "1.0.0",', '      "scriptSha256": "abc",', '      "succeeded": true,', '      "completedAt": "2026-08-21T01:02:03.456+00:00",', '      "operationId": "op-1"', '    }', '  ],',
    '  "future": {', '    "a": 1', '  }', '}'].join(nl));
});

// ---------- 命令規劃（SetupPlanningTests 的命令情境） ----------

test('命令預覽揭露身分、runner、腳本與已插值的參數；預設 timeout 30 分鐘且不重跑更新', t => {
  const e = environment(t);
  const plan = e.plan({ parameters: [param('server-url', { default: 'https://default.example' })], commands: [command('prepare', { arguments: ['-ServerUrl', '{{parameter:server-url}}'] })] });
  assert.equal(plan.commands.length, 1);
  assert.deepEqual({ ...plan.commands[0] }, { commandId: 'prepare', name: 'prepare', runner: 'powershell', script: 'setup/run.ps1', scriptSha256: SHA,
    arguments: ['-ServerUrl', 'https://default.example'], operatingSystems: [], architectures: [], timeoutMinutes: 30, runOnUpdate: false,
    eligibility: 'Eligible', runnerExecutable: '/fake/powershell', willExecute: true, reason: 'FirstRun' });
  assert.equal(plan.hasSetup, true);
  assert.equal(plan.canApply, true);
  const declared = e.plan({ commands: [command('prepare', { timeoutMinutes: 90, runOnUpdate: true })] });
  assert.deepEqual([declared.commands[0].timeoutMinutes, declared.commands[0].runOnUpdate], [90, true]);
});

test('timeout 超出 1–120 分鐘時以 invalid-setup 阻擋', t => {
  const e = environment(t);
  for (const timeoutMinutes of [121, 0]) {
    const plan = e.plan({ commands: [command('prepare', { timeoutMinutes })] });
    assert.equal(plan.canApply, false);
    assert.ok(plan.problems.some(p => p.code === 'deployment.invalid-setup'));
  }
});

test('宣告給其他作業系統的命令阻擋整份計畫；一個 OS 一條命令時手足命令不產生任何問題', t => {
  const e = environment(t);
  const mac = e.plan({ commands: [command('prepare', { runner: 'bash', operatingSystems: ['macos'] })] });
  assert.equal(mac.commands[0].eligibility, 'UnsupportedOperatingSystem');
  assert.equal(mac.commands[0].willExecute, false);
  assert.equal(mac.canApply, false);
  assert.ok(mac.problems.some(p => p.code === 'deployment.setup-unsupported-environment' && p.explanation.includes('windows')));
  const both = { commands: [command('prepare-windows', { operatingSystems: ['windows'] }), command('prepare-macos', { runner: 'bash', operatingSystems: ['macos'] })] };
  for (const [operatingSystem, expected] of [['windows', 'prepare-windows'], ['macos', 'prepare-macos']]) {
    const plan = e.plan(both, { os: operatingSystem, runners: nativeRunners });
    assert.equal(plan.canApply, true);
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(executableCommands(plan).map(c => c.commandId), [expected]);
    const other = plan.commands.find(c => c.commandId !== expected);
    assert.deepEqual([other.eligibility, other.willExecute], ['UnsupportedOperatingSystem', false]);
  }
  const all = e.plan({ commands: [command('a', { runner: 'bash', operatingSystems: ['macos'] }), command('b', { runner: 'bash', operatingSystems: ['macos'] })] });
  assert.equal(all.canApply, false);
  assert.deepEqual(executableCommands(all), []);
});

test('架構條件：一個架構一條命令時不阻擋；只宣告其他架構時阻擋；空宣告不縮小範圍', t => {
  const e = environment(t);
  const setup = { commands: [command('prepare-x64', { architectures: ['x64'] }), command('prepare-arm64', { architectures: ['arm64'] })] };
  for (const [arch, expected] of [['x64', 'prepare-x64'], ['arm64', 'prepare-arm64']]) {
    const plan = e.plan(setup, { arch });
    assert.deepEqual([plan.canApply, plan.problems], [true, []]);
    assert.deepEqual(executableCommands(plan).map(c => c.commandId), [expected]);
    assert.equal(plan.commands.find(c => c.commandId !== expected).eligibility, 'UnsupportedArchitecture');
  }
  assert.equal(e.plan({ commands: [command('prepare', { architectures: ['arm64'] })] }).canApply, false);
  assert.equal(e.plan({ commands: [command()] }, { os: 'macos', arch: 'arm64' }).commands[0].eligibility, 'Eligible');
});

test('找不到 runner 時在任何子行程啟動前阻擋', t => {
  const e = environment(t);
  const plan = e.plan({ commands: [command()] }, { runners: unavailableRunners });
  assert.equal(plan.canApply, false);
  assert.equal(plan.commands[0].runnerExecutable, null);
  assert.ok(plan.problems.some(p => p.code === 'deployment.setup-runner-unavailable'));
});

test('同版重裝略過已成功的命令；更新只在 runOnUpdate 時重跑；重新設定重跑；被略過的命令不要求它的參數', t => {
  const e = environment(t);
  e.completions().record('demo-setup', 'prepare', '1.0.0', SHA, true, 'op-x');
  const skipped = e.plan({ commands: [command()] }, { intent: SetupIntent.reinstall });
  assert.deepEqual([skipped.commands[0].willExecute, skipped.commands[0].reason, skipped.canApply], [false, 'SkippedAlreadySucceeded', true]);
  assert.equal(e.plan({ commands: [command()] }, { intent: SetupIntent.reconfigure }).commands[0].reason, 'Reconfigure');
  const needs = e.plan({ parameters: [param('server-url', { required: true })], commands: [command()] }, { intent: SetupIntent.reinstall });
  assert.equal(needs.parameters[0].needsInput, true);
  assert.equal(needs.canApply, true);
  e.completions().record('demo-setup', 'prepare', '0.9.0', SHA, true, 'op-x');
  const without = e.plan({ commands: [command()] }, { intent: SetupIntent.update });
  assert.deepEqual([without.commands[0].willExecute, without.commands[0].reason], [false, 'SkippedUpdateWithoutRunOnUpdate']);
  const withRun = e.plan({ commands: [command('prepare', { runOnUpdate: true })] }, { intent: SetupIntent.update });
  assert.deepEqual([withRun.commands[0].willExecute, withRun.commands[0].reason], [true, 'UpdateRunOnUpdate']);
});

test('上次失敗後再次安裝會重試；重試成功後同版乾淨重裝預設略過（SetupRetrySessionTests）', t => {
  const e = environment(t);
  const decide = intent => e.plan({ commands: [command()] }, { intent }).commands[0];
  assert.deepEqual([decide(SetupIntent.install).willExecute, decide(SetupIntent.install).reason], [true, 'FirstRun']);
  e.completions().record('demo-setup', 'prepare', '1.0.0', SHA, false, 'op-a');
  assert.deepEqual([decide(SetupIntent.install).willExecute, decide(SetupIntent.install).reason], [true, 'PreviousFailure']);
  e.completions().record('demo-setup', 'prepare', '1.0.0', SHA, true, 'op-a');
  assert.equal(decide(SetupIntent.reinstall).willExecute, false);
  assert.equal(decide(SetupIntent.repair).willExecute, false);
  assert.equal(decide(SetupIntent.reconfigure).willExecute, true);
});

test('有命令要執行時缺必填參數阻擋；只有 runtime 秘密在全部命令略過時仍阻擋', t => {
  const e = environment(t);
  const blocked = e.plan({ parameters: [param('server-url', { required: true })], commands: [command()] });
  assert.equal(blocked.canApply, false);
  assert.ok(blocked.problems.some(p => p.code === 'deployment.setup-parameter-missing' && p.summary.includes('server-url')));
  e.completions().record('demo-setup', 'prepare', '1.0.0', SHA, true, 'op-x');
  const runtime = e.plan({ parameters: [param('api-key', { type: 'secret', required: true, secretUsage: 'runtime' })], commands: [command()] }, { intent: SetupIntent.reinstall });
  assert.equal(runtime.canApply, false);
});

test('規劃零寫入：不建立 setup root、完成狀態檔或任何目錄', t => {
  const e = environment(t);
  const plan = e.plan({ parameters: [param('server-url', { required: true })], commands: [command()] });
  assert.equal(fs.existsSync(plan.setupRoot), false);
  assert.equal(fs.existsSync(e.home), false);
  assert.equal(fs.existsSync(path.join(e.projectRoot, '.lcaipack')), false);
});

// ---------- 計畫摘要涵蓋命令（SetupPlanDigestTests） ----------

test('摘要涵蓋命令：腳本雜湊、timeout、已插值參數與是否執行改變時摘要改變；runner 可執行檔位置與顯示文案不涵蓋', t => {
  const e = environment(t);
  const base = { parameters: [param('server-url', { default: 'https://tfs.example' })], commands: [command('prepare-gateway', { arguments: ['-ServerUrl', '{{parameter:server-url}}'], timeoutMinutes: 30 })] };
  const digest = (plan) => computeSetupDigest(plan);
  const baseline = digest(e.plan(base));
  assert.notEqual(baseline, digest(e.plan({ ...base, commands: [{ ...base.commands[0], timeoutMinutes: 45 }] })));
  assert.notEqual(baseline, digest(e.plan(base, { pendingValues: { 'server-url': 'https://other.example' } })));
  const changedScript = planSetup({ setup: base, packageKey: 'demo-setup', packageVersion: '1.0.0', scope: 'project', projectRoot: e.projectRoot, home: e.home, userHome: e.userHome,
    secrets: e.secrets, runners: fakeRunners, environment: { operatingSystem: 'windows', architecture: 'x64' }, scriptSha256: () => '2'.repeat(64) });
  assert.notEqual(baseline, digest(changedScript));
  // 不涵蓋：runner 可執行檔的本機位置、名稱等顯示文案。
  const renamed = e.plan({ ...base, commands: [{ ...base.commands[0], name: '另一個顯示名稱' }] }, { runners: { resolve: runner => ({ runner, executable: `/elsewhere/${runner}`, leadingArguments: [] }) } });
  assert.equal(baseline, digest(renamed));
  // 命令跑完後完成狀態改變（要跑 → 已成功略過），摘要隨之改變。
  e.completions().record('demo-setup', 'prepare-gateway', '1.0.0', SHA, true, 'op-1');
  assert.notEqual(baseline, digest(e.plan(base, { intent: SetupIntent.reinstall })));
});

test('摘要的命令行格式與既有格式相同（參數以 U+001F 串接、列舉以 .NET 名稱）', t => {
  const e = environment(t);
  const plan = e.plan({ commands: [command('prepare', { arguments: ['-A', 'b'], operatingSystems: ['windows'], architectures: ['x64', 'arm64'], timeoutMinutes: 5, runOnUpdate: true })] });
  const rows = computeSetupDigestText(plan).split('\n').filter(l => l.startsWith('setup.command='));
  assert.deepEqual(rows, [`setup.command=prepare|powershell|setup/run.ps1|${SHA}|-A\u001fb|windows|x64,arm64|5|run-on-update|Eligible|execute|FirstRun`]);
});
const computeSetupDigestText = plan => appendSetupDigest(plan);

// ---------- 真實 runner registry（SetupCommandRunnerTests 的 registry 部分、SetupPerOsPackageTests） ----------

test('runner registry 只提供固定 runner 並依作業系統配對；探測目錄為空時不可用', t => {
  const registry = createRunnerRegistry();
  assert.equal(registry.resolve('powershell', 'macos'), null);
  assert.equal(registry.resolve('bash', 'windows'), null);
  assert.equal(registry.resolve('cmd', 'windows'), null);
  assert.equal(registry.resolve('bash;rm -rf /', 'macos'), null);
  if (process.platform === 'win32') {
    const resolved = registry.resolve('powershell', 'windows');
    assert.ok(resolved);
    assert.deepEqual(resolved.leadingArguments, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.equal(fs.existsSync(resolved.executable), true);
  }
  const e = environment(t);
  assert.equal(createRunnerRegistry({ probeDirectories: [path.join(e.dir, 'nowhere')], exists: () => false }).resolve('bash', 'macos'), null);
  assert.deepEqual(createRunnerRegistry({ exists: p => p === '/bin/bash' }).resolve('bash', 'macos'), { runner: 'bash', executable: '/bin/bash', leadingArguments: ['--noprofile', '--norc'] });
});
