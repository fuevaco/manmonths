// 含設定命令的組合包（工項 10）：從面板實際使用的 worker 請求契約進入，以真實子行程執行設定命令
// （對照 LcAiPack.Tests CliSetupEndToEndTests、SetupPerOsPackageTests、SetupSecretDeliveryTests、SetupCancellationTests 的端到端部分）。
// Windows 以 PowerShell、macOS 以 bash；腳本只在臨時目錄寫入無害的證據檔。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker, leakedSecrets } from './harness.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';
import { setupSecretReference } from '../worker/setup/secrets.mjs';
import { SetupValueStore } from '../worker/setup/values.mjs';

const WINDOWS = process.platform === 'win32';
const sha = b => createHash('sha256').update(b).digest('hex');
const CANARY = 'canary-setup-time-secret-10';
const KEY = 'demo-setup-bundle';
const SKILL = '---\nname: setup-skill\ndescription: Synthetic\n---\nHello';

// 腳本先讀完 stdin 的秘密框架（平台一律寫入），再把一行證據寫到 <dir>/runs.txt；<dir>/fail.flag 存在時以 exit 17 失敗。
const POWERSHELL = `param([string]$Dir, [string]$Label)
$received = @()
while (($line = [Console]::In.ReadLine()) -ne $null) { if ($line -eq 'LCAIPACK-SECRET-END') { break }; if ($line -notlike 'LCAIPACK-SECRET-BEGIN*') { $received += $line } }
Add-Content -LiteralPath (Join-Path $Dir 'runs.txt') -Value ('os=windows label=' + $Label)
if (Test-Path -LiteralPath (Join-Path $Dir 'echo-secret.flag')) { foreach ($entry in $received) { [Console]::Out.WriteLine('secret-entry=' + [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($entry.Split(' ')[1]))) } }
if (Test-Path -LiteralPath (Join-Path $Dir 'sleep.flag')) { Add-Content -LiteralPath (Join-Path $Dir 'sleeping.txt') -Value $PID; Start-Sleep -Seconds 300 }
if (Test-Path -LiteralPath (Join-Path $Dir 'fail.flag')) { [Console]::Error.WriteLine('precondition missing: fail.flag'); exit 17 }
Write-Output ('wrote=' + (Join-Path $Dir 'runs.txt'))
exit 0
`;
const BASH = `#!/usr/bin/env bash
dir=""; label=""
while [ "$#" -gt 0 ]; do case "$1" in --dir) dir="$2"; shift 2 ;; --label) label="$2"; shift 2 ;; *) exit 3 ;; esac; done
received=()
while IFS= read -r line; do [ "$line" = "LCAIPACK-SECRET-END" ] && break; case "$line" in LCAIPACK-SECRET-BEGIN*) ;; *) received+=("$line") ;; esac; done
echo "os=macos label=$label" >> "$dir/runs.txt"
if [ -f "$dir/echo-secret.flag" ]; then for entry in "\${received[@]}"; do echo "secret-entry=$(printf '%s' "\${entry#* }" | base64 -d)"; done; fi
if [ -f "$dir/sleep.flag" ]; then echo $$ >> "$dir/sleeping.txt"; sleep 300; fi
if [ -f "$dir/fail.flag" ]; then echo "precondition missing: fail.flag" >&2; exit 17; fi
echo "wrote=$dir/runs.txt"
exit 0
`;

function bundleZip({ version = '1.0.0', runOnUpdate = false, secret = false, markerDir }) {
  const parameters = [{ parameterId: 'marker-label', label: 'Marker label', type: 'string', required: true, default: 'orca-rc-demo' },
    ...(secret ? [{ parameterId: 'setup-pat', label: 'Setup PAT', type: 'secret', required: true, secretUsage: 'setup-time' }] : [])];
  const manifest = { packageFormatVersion: 1, key: KEY, name: 'Demo Setup Bundle', type: 'bundle', version, description: 'Synthetic', contents: [{ id: 'setup-skill', kind: 'skill', path: 'resources/skills/setup-skill' }],
    setup: { parameters, commands: [
      { commandId: 'write-marker-windows', name: '寫入證據檔（Windows）', runner: 'powershell', script: 'setup/write-marker.ps1', arguments: ['-Dir', markerDir, '-Label', '{{parameter:marker-label}}'], operatingSystems: ['windows'], architectures: ['x64', 'arm64'], timeoutMinutes: 1, runOnUpdate },
      { commandId: 'write-marker-macos', name: '寫入證據檔（macOS）', runner: 'bash', script: 'setup/write-marker.sh', arguments: ['--dir', markerDir, '--label', '{{parameter:marker-label}}'], operatingSystems: ['macos'], architectures: ['x64', 'arm64'], timeoutMinutes: 1, runOnUpdate }] } };
  return zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo', 'resources/skills/setup-skill/SKILL.md': SKILL,
    'setup/write-marker.ps1': String.fromCharCode(0xfeff) + POWERSHELL, 'setup/write-marker.sh': BASH });
}

async function environment(t, { secret = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-setup-cmd-'));
  const userHome = path.join(dir, 'home'), lcaipackHome = path.join(dir, 'lcaipack'), project = path.join(dir, 'project'), markerDir = path.join(dir, 'markers');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true }); fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), '{}');
  fs.mkdirSync(project); fs.mkdirSync(markerDir);
  const versions = { '1.0.0': bundleZip({ secret, markerDir }), '1.1.0': bundleZip({ version: '1.1.0', secret, markerDir, runOnUpdate: true }), '1.2.0': bundleZip({ version: '1.2.0', secret, markerDir, runOnUpdate: false }) };
  const item = { packageKey: KEY, name: 'Demo Setup Bundle', type: 'bundle', description: 'Synthetic', latestReleaseVersion: '1.2.0' };
  const market = await startFakeMarket({ packages: [item] });
  market.override(`GET /api/market/packages/${KEY}`, () => ({ status: 200, body: { ...item, recommendedVersion: '1.0.0',
    versions: Object.entries(versions).map(([version, bytes]) => ({ version, isEnabled: true, channel: 'release', status: 'active', hosts: ['claude-code'], sha256: sha(bytes) })) } }));
  for (const [version, bytes] of Object.entries(versions)) market.override(`GET /api/market/packages/${KEY}/versions/${version}/download`, () => ({ status: 200, raw: bytes, contentType: 'application/zip' }));
  const secretStore = memoryStore();
  const worker = startWorker({ deps: { lcaipackHome, userHome, env: {}, secretStore } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const marker = name => path.join(markerDir, name);
  const runs = () => { try { return fs.readFileSync(marker('runs.txt'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } };
  const skill = path.join(project, '.claude', 'skills', 'setup-skill', 'SKILL.md');
  const receipts = path.join(project, '.lcaipack', 'receipts.json');
  async function plan(version = '1.0.0', extra = {}) {
    const { targets } = await worker.call('rc.deploy.listTargets', { scope: 'project', projectRoot: project });
    const target = targets.find(x => x.surfaceId === 'claude-code-cli');
    return worker.call('rc.deploy.plan', { packageKey: KEY, version, targets: [target.id], scope: 'project', projectRoot: project, ...extra });
  }
  const apply = summary => worker.call('rc.deploy.apply', { planDigest: summary.planDigest, targets: summary.targets.map(x => x.id) });
  return { dir, userHome, lcaipackHome, project, markerDir, worker, secretStore, marker, runs, skill, receipts, plan, apply };
}
const allFiles = dir => { const out = []; const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else out.push(p); } }; walk(dir); return out; };

test('摘要列出設定命令與作用；確認前不執行任何命令、不建立任何設定狀態', async t => {
  const e = await environment(t);
  const summary = await e.plan();
  assert.equal(summary.canApply, true, JSON.stringify(summary.problems));
  const local = summary.setup.commands.find(c => c.willExecute);
  const foreign = summary.setup.commands.find(c => !c.willExecute);
  assert.equal(summary.setup.commands.length, 2);
  assert.equal(local.commandId, WINDOWS ? 'write-marker-windows' : 'write-marker-macos');
  assert.equal(local.name, WINDOWS ? '寫入證據檔（Windows）' : '寫入證據檔（macOS）');
  assert.deepEqual([local.runner, local.script, local.timeoutMinutes, local.reason, local.eligibility], [WINDOWS ? 'powershell' : 'bash', WINDOWS ? 'setup/write-marker.ps1' : 'setup/write-marker.sh', 1, 'FirstRun', 'Eligible']);
  assert.deepEqual(local.arguments.slice(-1), ['orca-rc-demo']);
  assert.equal(foreign.eligibility, 'UnsupportedOperatingSystem');
  assert.ok(summary.setup.executableCommandIds.includes(local.commandId) && summary.setup.executableCommandIds.length === 1);
  // 確認前什麼都沒發生：沒有證據檔、沒有 setup root、完成狀態、operation 紀錄，也沒有部署。
  assert.deepEqual(e.runs(), []);
  assert.equal(fs.existsSync(e.skill), false);
  assert.equal(fs.existsSync(path.join(e.lcaipackHome, 'setup-roots')), false);
  assert.equal(fs.existsSync(path.join(e.lcaipackHome, 'operations')), false);
  assert.equal(fs.existsSync(path.join(e.project, '.lcaipack')), false);
});

test('確認後命令只執行一次，接著依同一份已確認的計畫部署；結果揭露命令結局與 operation，沒有秘密', async t => {
  const e = await environment(t);
  const summary = await e.plan();
  const result = await e.apply(summary);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(e.runs().length, 1);
  assert.ok(e.runs()[0].includes(WINDOWS ? 'os=windows label=orca-rc-demo' : 'os=macos label=orca-rc-demo'));
  assert.equal(fs.existsSync(e.skill), true);
  assert.equal(fs.existsSync(e.receipts), true);
  const executed = result.setup.commands.filter(c => c.executed);
  assert.deepEqual(executed.map(c => [c.commandId, c.succeeded, c.exitCode]), [[executable(summary).commandId, true, 0]]);
  assert.equal(result.setup.commands.length, 2);
  assert.match(result.operation.id, /^op-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  assert.equal(result.operation.state, 'succeeded');
  assert.equal(fs.existsSync(result.operation.logPath), true);
  assert.equal(fs.existsSync(path.join(e.lcaipackHome, 'setup-roots')), true);
  // 同一版本的乾淨重裝預設略過已成功的命令：不再執行，但摘要揭露原因。
  const again = await e.plan();
  assert.deepEqual([again.setup.commands.find(c => c.commandId === executable(summary).commandId).willExecute, again.setup.commands.find(c => c.commandId === executable(summary).commandId).reason], [false, 'SkippedAlreadySucceeded']);
  assert.equal((await e.apply(again)).status, 'succeeded');
  assert.equal(e.runs().length, 1);
});
const executable = summary => summary.setup.commands.find(c => c.willExecute);

test('命令失敗：依賴它的部署目標不被改動、不寫新版收據；結果列出受影響的目標與原因；修正條件後重新安裝成功', async t => {
  const e = await environment(t);
  fs.writeFileSync(e.marker('fail.flag'), '');
  const summary = await e.plan();
  const result = await e.apply(summary);
  assert.equal(result.status, 'failed');
  assert.equal(fs.existsSync(e.skill), false);
  assert.equal(fs.existsSync(e.receipts), false);
  // 受影響的目標與原因。
  assert.deepEqual(result.targets.map(x => [x.id, x.status]), summary.targets.map(x => [x.id, 'notDeployed']));
  assert.ok(result.targets.every(x => x.label && x.writtenPaths.length === 0));
  const reason = result.targets[0].problems.find(p => p.code === 'deployment.setup-command-failed');
  assert.ok(reason && reason.summary.includes(executable(summary).name) && /17/.test(reason.explanation));
  assert.deepEqual([result.operation.state, result.operation.canResume, result.operation.checkpoint], ['failed', true, `setup-command:${executable(summary).commandId}`]);
  const failure = result.setup.commands.find(c => c.executed);
  assert.deepEqual([failure.succeeded, failure.exitCode], [false, 17]);
  assert.ok(failure.output.some(line => line.includes('precondition missing: fail.flag')));
  assert.equal(e.runs().length, 1);
  // 修正條件後重新安裝：同一個命令因「上次未成功」重試，這次成功並部署。
  fs.rmSync(e.marker('fail.flag'));
  const retry = await e.plan();
  assert.equal(retry.setup.commands.find(c => c.willExecute).reason, 'PreviousFailure');
  const fixed = await e.apply(retry);
  assert.equal(fixed.status, 'succeeded');
  assert.equal(e.runs().length, 2);
  assert.equal(fs.existsSync(e.skill), true);
  assert.equal(fs.existsSync(e.receipts), true);
});

test('明細中的命令輸出與日誌不含秘密值：腳本回吐 setup-time 秘密時只剩遮罩字樣', async t => {
  const e = await environment(t, { secret: true });
  fs.writeFileSync(e.marker('echo-secret.flag'), ''); fs.writeFileSync(e.marker('fail.flag'), '');
  const first = await e.plan();
  assert.equal(first.canApply, false);
  const saved = await e.worker.call('rc.deploy.saveSetup', { planDigest: first.planDigest, values: {}, secrets: { 'setup-pat': CANARY } });
  assert.equal(saved.canApply, true, JSON.stringify(saved.problems));
  const result = await e.apply(saved);
  assert.equal(result.status, 'failed');
  const failure = result.setup.commands.find(c => c.executed);
  assert.ok(failure.output.some(line => line.includes('secret-entry=<redacted>')), JSON.stringify(failure.output));
  const texts = [...allFiles(e.dir).map(f => fs.readFileSync(f, 'utf8')), ...e.worker.state.transcript, ...e.worker.state.logs, JSON.stringify(result)];
  assert.deepEqual(leakedSecrets(texts, [CANARY, Buffer.from(CANARY).toString('base64')]), []);
  // 秘密只存在於（測試用的）安全儲存區。
  const ref = setupSecretReference({ packageKey: KEY, parameterId: 'setup-pat', scope: 'project', canonicalRoot: e.project });
  assert.equal(e.secretStore.values.get(ref.key), CANARY);
});

test('審核後設定值改變：套用被判定過期，命令一個都沒啟動、目標零寫入，並回傳依目前狀態重新產生的摘要', async t => {
  const e = await environment(t);
  const summary = await e.plan();
  SetupValueStore.forProject({ projectRoot: e.project }).setValues(KEY, { 'marker-label': 'changed-after-review' });
  const result = await e.apply(summary);
  assert.equal(result.status, 'stale');
  assert.equal(result.plan.setup.commands.find(c => c.willExecute).arguments.slice(-1)[0], 'changed-after-review');
  assert.deepEqual(e.runs(), []);
  assert.equal(fs.existsSync(e.skill), false);
  // 重新確認後套用。
  assert.equal((await e.apply(result.plan)).status, 'succeeded');
  assert.equal(e.runs().length, 1);
});

test('更新：只重跑宣告 runOnUpdate 的命令版本；沒有宣告的版本略過命令但仍更新內容', async t => {
  const e = await environment(t);
  assert.equal((await e.apply(await e.plan('1.0.0'))).status, 'succeeded');
  assert.equal(e.runs().length, 1);
  const update = await e.plan('1.1.0', { action: 'update' });
  assert.equal(executable({ setup: update.setup }).reason, 'UpdateRunOnUpdate');
  assert.equal((await e.apply(update)).status, 'succeeded');
  assert.equal(e.runs().length, 2);
  const quiet = await e.plan('1.2.0', { action: 'update' });
  assert.equal(quiet.setup.commands.find(c => c.reason === 'SkippedUpdateWithoutRunOnUpdate') !== undefined, true);
  assert.equal((await e.apply(quiet)).status, 'succeeded');
  assert.equal(e.runs().length, 2);
  assert.ok(fs.readFileSync(e.receipts, 'utf8').includes('1.2.0'));
  // 動作與規劃意圖不一致的請求不被接受。
  await assert.rejects(() => e.plan('1.1.0', { action: 'teleport' }), /部署動作/);
});

test('取消：命令執行中取消會終止整棵子行程樹，目標零寫入、operation 可繼續', async t => {
  const e = await environment(t);
  fs.writeFileSync(e.marker('sleep.flag'), '');
  const summary = await e.plan();
  const pending = e.apply(summary);
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(e.marker('sleeping.txt')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(e.marker('sleeping.txt'), 'utf8').trim().split(/\r?\n/)[0]);
  assert.ok(Number.isInteger(pid));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已終止 */ } });
  const cancel = await e.worker.call('rc.deploy.cancel', {});
  assert.equal(cancel.cancelled, true);
  const result = await pending;
  assert.deepEqual([result.status, result.operation.state, result.operation.canResume], ['cancelled', 'cancelled', true]);
  assert.equal(fs.existsSync(e.skill), false);
  assert.equal(fs.existsSync(e.receipts), false);
  assert.ok(result.targets.every(x => x.status === 'notDeployed'));
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 50)); } catch { alive = false; } }
  assert.equal(alive, false, '腳本行程在取消後仍存活');
  assert.equal((await e.worker.call('rc.deploy.cancel', {})).cancelled, false);
});
