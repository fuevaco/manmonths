// 設定命令的實際執行（對照 SetupCommandRunnerTests、SetupCommandOutputTests、SetupCancellationTests、
// SetupSecretDeliveryTests 的真實子行程部分、SetupRetrySessionTests 的實際重試、SetupPerOsPackageTests 的夾具執行）。
// 這是平台唯一允許啟動 publisher script 的入口，所以全部用「真實子行程」驗證：Windows 以 PowerShell、macOS 以 bash。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupCommand } from '../worker/setup/command-runner.mjs';
import { createRunnerRegistry } from '../worker/setup/runners.mjs';
import { createExecutionContext } from '../worker/setup/execution-context.mjs';
import { openOperationLog } from '../worker/setup/operation-log.mjs';
import { createOperationStore } from '../worker/setup/operations.mjs';
import { createSecretMasker, Placeholder } from '../worker/setup/masker.mjs';
import { openSecretChannel } from '../worker/setup/secret-channel.mjs';
import { createSecretManager, setupSecretReference } from '../worker/setup/secrets.mjs';
import { memoryStore } from './fake-secret-store.mjs';

const WINDOWS = process.platform === 'win32';
const OS = WINDOWS ? 'windows' : 'macos';
const RUNNER = WINDOWS ? 'powershell' : 'bash';
const KEY = 'runner-demo';
const CANARY = 'fake-setup-time-canary-0123456789';

/** 依平台選腳本：同一個情境在 Windows 用 PowerShell、在 macOS 用 bash。 */
const pick = (ps, sh) => (WINDOWS ? ps : sh);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'repo');
  fs.mkdirSync(project);
  const context = createExecutionContext({ home: path.join(dir, 'home'), packageKey: KEY, packageVersion: '1.0.0', scope: 'project', canonicalRoot: project, projectRoot: project });
  context.ensureDirectories();
  const logPath = path.join(dir, 'logs', 'op.log');
  const writeScript = (body, relative = pick('setup/run.ps1', 'setup/run.sh')) => {
    const file = context.resolvePayloadPath(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 含中文的 .ps1 必須帶 UTF-8 BOM，否則 Windows PowerShell 5.1 會以 ANSI 解析。
    fs.writeFileSync(file, (WINDOWS ? String.fromCharCode(0xfeff) : '') + body);
    return relative;
  };
  const command = (script, args = [], timeoutMinutes = 30) => ({ commandId: 'prepare', name: '準備', runner: RUNNER, script, scriptSha256: 'sha-not-used', arguments: args,
    operatingSystems: [], architectures: [], timeoutMinutes, runOnUpdate: false, eligibility: 'Eligible', runnerExecutable: 'resolved-at-run-time', willExecute: true, reason: 'FirstRun' });
  const emptyChannel = () => openSecretChannel({ manager: createSecretManager(memoryStore()), packageKey: KEY, scope: 'project', canonicalRoot: project, declarations: [], usage: 'setup-time' });
  /** 執行並回傳結果與 log 內容；log 在執行完成後才讀。 */
  async function run(cmd, { secrets, masker = createSecretMasker(), signal, timeoutMs, operationId = null, registry } = {}) {
    const log = openOperationLog({ logPath, masker, sessionNumber: 1, reason: 'first-run' });
    const channel = secrets ?? emptyChannel();
    try {
      const result = await runSetupCommand({ command: cmd, context, operatingSystem: OS, log, secrets: channel, operationId, signal, timeoutMs, registry: registry ?? createRunnerRegistry() });
      return { result, log: () => { log.close(); return fs.readFileSync(logPath, 'utf8'); } };
    } finally { channel.dispose(); }
  }
  const logText = () => fs.readFileSync(logPath, 'utf8');
  return { dir, project, context, logPath, writeScript, command, run, logText, emptyChannel };
}

const finish = async r => { const { result, log } = await r; log(); return result; };

// ---------- 執行形狀 ----------

test('腳本從 payload 目錄執行，runtime 目錄是 working directory，環境變數提供身分與根目錄', async t => {
  const f = fixture(t);
  const script = f.writeScript(pick(
    `[Console]::Out.WriteLine('cwd=' + (Get-Location).Path)\n[Console]::Out.WriteLine('script=' + $PSCommandPath)\n[Console]::Out.WriteLine('setupRoot=' + $env:LCAIPACK_SETUP_ROOT)\n[Console]::Out.WriteLine('scope=' + $env:LCAIPACK_SCOPE)\nexit 0\n`,
    `echo "cwd=$(pwd -P)"\necho "script=$0"\necho "setupRoot=$LCAIPACK_SETUP_ROOT"\necho "scope=$LCAIPACK_SCOPE"\nexit 0\n`));
  const r = await f.run(f.command(script), { operationId: 'op-20260821T010203Z-abcdef12' });
  assert.equal(r.result.succeeded, true);
  const log = r.log().toLowerCase();
  assert.ok(log.includes(`cwd=${f.context.runtimeRoot}`.toLowerCase()));
  assert.ok(log.includes(f.context.resolvePayloadPath(script).toLowerCase()));
  assert.ok(log.includes(`setuproot=${f.context.setupRoot}`.toLowerCase()));
  assert.ok(log.includes('scope=project'));
});

test('引數以分離的 argv 傳遞，絕不被 shell 重新解讀（含空白、引號與 shell metacharacter）', async t => {
  const f = fixture(t);
  const script = f.writeScript(pick(
    `param([string]$First, [string]$Second)\n[Console]::Out.WriteLine('first=[' + $First + ']')\n[Console]::Out.WriteLine('second=[' + $Second + ']')\nexit 0\n`,
    `echo "first=[$1]"\necho "second=[$2]"\nexit 0\n`));
  const hostile = 'a b" & echo PWNED & rem ';
  const args = WINDOWS ? ['-First', 'plain', '-Second', hostile] : ['plain', hostile];
  const r = await f.run(f.command(script, args));
  assert.equal(r.result.succeeded, true);
  const log = r.log();
  assert.ok(log.includes('first=[plain]'));
  assert.ok(log.includes(`second=[${hostile}]`));
  // 若有任何一層 shell 重新解讀了這個引數，log 會多出一行「內容就只有 PWNED」的 stdout。
  assert.ok(!log.split('\n').some(line => line.replace(/\r$/, '').endsWith('] PWNED')));
});

test('腳本尚未落地時在啟動任何行程前失敗；runner 不可用是執行錯誤而不是默默代打', async t => {
  const f = fixture(t);
  await assert.rejects(() => f.run(f.command(pick('setup/never-materialized.ps1', 'setup/never-materialized.sh'))), /MaterializePayload/);
  const script = f.writeScript('exit 0');
  await assert.rejects(() => f.run(f.command(script), { registry: { resolve: () => null } }), /blocking problem/);
});

test('runner 不要求提權：腳本以一般使用者權限執行', { skip: !WINDOWS && 'Windows 專屬檢查' }, async t => {
  const f = fixture(t);
  const script = f.writeScript(`$identity = [Security.Principal.WindowsIdentity]::GetCurrent()\n$principal = New-Object Security.Principal.WindowsPrincipal($identity)\n[Console]::Out.WriteLine('elevated=' + $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))\nexit 0\n`);
  const r = await f.run(f.command(script));
  assert.equal(r.result.succeeded, true);
  assert.ok(r.log().includes('elevated=False'));
});

// ---------- 輸出擷取與 exit code ----------

test('雙管線大量交錯輸出與超長單行不會死結，且完整擷取', async t => {
  const f = fixture(t);
  const script = f.writeScript(pick(
    `for ($i = 1; $i -le 1500; $i++) {\n  [Console]::Out.WriteLine('out-' + $i)\n  [Console]::Error.WriteLine('err-' + $i)\n}\n[Console]::Out.WriteLine('long-' + ('x' * 200000))\nexit 0\n`,
    `for i in $(seq 1 1500); do echo "out-$i"; echo "err-$i" >&2; done\nprintf 'long-'; head -c 200000 /dev/zero | tr '\\0' 'x'; echo\nexit 0\n`));
  const started = Date.now();
  const r = await f.run(f.command(script));
  assert.equal(r.result.succeeded, true);
  assert.ok(Date.now() - started < 120000);
  const log = r.log();
  assert.ok(log.includes('out-1\n') && log.includes('out-1500') && log.includes('err-1500') && log.includes('long-' + 'x'.repeat(1000)));
  // 每一行都是完整的一行：沒有被另一條管線切斷。
  for (const line of log.split('\n').filter(l => l.length)) assert.match(line, /^(\[\d{4}-|=== session)/, line.slice(0, 80));
});

test('stdout 與 stderr 各走自己的通道；log 是 UTF-8 無 BOM 且非 ASCII 輸出完整', async t => {
  const f = fixture(t);
  const script = f.writeScript(pick(
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n[Console]::Out.WriteLine('準備 TFS 閘道完成')\n[Console]::Out.WriteLine('to-stdout')\n[Console]::Error.WriteLine('to-stderr')\nexit 0\n`,
    `echo '準備 TFS 閘道完成'\necho to-stdout\necho to-stderr >&2\nexit 0\n`));
  const r = await f.run(f.command(script));
  const log = r.log();
  const lines = log.split('\n');
  assert.ok(lines.some(l => l.includes('[stdout] to-stdout')) && lines.some(l => l.includes('[stderr] to-stderr')) && !lines.some(l => l.includes('[stdout] to-stderr')));
  assert.ok(log.includes('準備 TFS 閘道完成'));
  const bytes = fs.readFileSync(f.logPath);
  assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
});

test('exit code 0 是唯一的成功判定；stderr 不代表失敗、stdout 不代表成功；非零 exit code 記在 log 與摘要', async t => {
  const f = fixture(t);
  const ok = await f.run(f.command(f.writeScript(pick(`[Console]::Error.WriteLine('這行 stderr 不代表失敗')\nexit 0\n`, `echo 'stderr-line' >&2\nexit 0\n`))));
  assert.deepEqual([ok.result.outcome, ok.result.exitCode, ok.result.succeeded, ok.result.failureSummary], ['Completed', 0, true, null]);
  ok.log();
  const failed = await f.run(f.command(f.writeScript(pick(`[Console]::Out.WriteLine('這行 stdout 不代表成功')\nexit 3\n`, `echo 'stdout-line'\nexit 3\n`))));
  assert.deepEqual([failed.result.outcome, failed.result.exitCode, failed.result.succeeded], ['Completed', 3, false]);
  assert.ok(failed.result.failureSummary.includes('3'));
  assert.ok(failed.log().includes('exitCode=3'));
});

test('失敗後在同一個 operation 與同一份 log 重試：整支腳本重跑、log 多一段 session（SetupRetrySessionTests）', async t => {
  const f = fixture(t);
  const marker = path.join(f.context.runtimeRoot, 'runs.txt');
  const script = f.writeScript(pick(
    `Add-Content -LiteralPath '${marker}' -Value 'ran'\nif (Test-Path -LiteralPath (Join-Path $env:LCAIPACK_RUNTIME_ROOT 'succeed.flag')) { exit 0 }\n[Console]::Error.WriteLine('not-ready')\nexit 1\n`,
    `echo ran >> '${marker}'\nif [ -f "$LCAIPACK_RUNTIME_ROOT/succeed.flag" ]; then exit 0; fi\necho not-ready >&2\nexit 1\n`));
  const store = createOperationStore({ home: path.join(f.dir, 'home') });
  const operation = store.create({ kind: 'install', packageKey: KEY, packageVersion: '1.0.0', scope: 'project', projectRoot: f.project });
  const attempt = async reason => {
    const session = store.beginSession(operation.operationId);
    const log = openOperationLog({ logPath: operation.logPath, masker: createSecretMasker(), sessionNumber: session, reason });
    const channel = f.emptyChannel();
    try { return { session, result: await runSetupCommand({ command: f.command(script), context: f.context, operatingSystem: OS, log, secrets: channel, operationId: operation.operationId, registry: createRunnerRegistry() }) }; }
    finally { log.close(); channel.dispose(); }
  };
  const first = await attempt('first-run');
  assert.equal(first.result.succeeded, false);
  store.transition(operation.operationId, 'incomplete', 'setup-commands', first.result.failureSummary);
  assert.equal(store.isTerminal(store.get(operation.operationId)), false);
  fs.writeFileSync(path.join(f.context.runtimeRoot, 'succeed.flag'), '');
  const second = await attempt('retry');
  assert.equal(second.result.succeeded, true);
  assert.equal(second.session, first.session + 1);
  const log = fs.readFileSync(operation.logPath, 'utf8');
  for (const expected of [`=== session ${first.session}`, `=== session ${second.session}`, '| retry ===', 'exitCode=1', 'exitCode=0', 'not-ready']) assert.ok(log.includes(expected), expected);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).length, 2);
  assert.equal(fs.readdirSync(store.directoryPath).filter(n => n.endsWith('.log')).length, 1);
});

// ---------- 秘密交付（SetupSecretDeliveryTests） ----------

function secretChannel(f, value = CANARY) {
  const manager = createSecretManager(memoryStore());
  manager.set(setupSecretReference({ packageKey: KEY, parameterId: 'setup-pat', scope: 'project', canonicalRoot: f.project }), value);
  return openSecretChannel({ manager, packageKey: KEY, scope: 'project', canonicalRoot: f.project, declarations: [{ parameterId: 'setup-pat', usage: 'setup-time', required: true }], usage: 'setup-time' });
}

test('子行程從 stdin 收到 setup-time 秘密，但命令列與環境變數都沒有它；log 不含明文也不含 base64', async t => {
  const f = fixture(t);
  const probe = path.join(f.context.runtimeRoot, 'probe.txt');
  const script = f.writeScript(pick(
    `$begin = [Console]::In.ReadLine()\n$received = ''\nwhile ($true) {\n  $line = [Console]::In.ReadLine()\n  if ($null -eq $line -or $line -eq 'LCAIPACK-SECRET-END') { break }\n  $received = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line.Split(' ')[1]))\n}\n$lines = @()\n$lines += 'begin=' + $begin\n$lines += 'commandLine=' + [Environment]::CommandLine\nforeach ($item in Get-ChildItem env:) { $lines += 'env:' + $item.Name + '=' + $item.Value }\n$lines += 'stdinSecret=' + $received\nSet-Content -LiteralPath $env:PROBE_PATH -Value $lines -Encoding utf8\nexit 0\n`,
    `IFS= read -r begin\nreceived=''\nwhile IFS= read -r line; do\n  [ "$line" = 'LCAIPACK-SECRET-END' ] && break\n  received=$(printf '%s' "\${line#* }" | base64 -d)\ndone\n{ echo "begin=$begin"; echo "commandLine=$(tr '\\0' ' ' < /proc/$$/cmdline 2>/dev/null || ps -o command= -p $$)"; env | sed 's/^/env:/'; echo "stdinSecret=$received"; } > "$PROBE_PATH"\nexit 0\n`));
  process.env.PROBE_PATH = probe;
  t.after(() => { delete process.env.PROBE_PATH; });
  const masker = createSecretMasker();
  const channel = secretChannel(f);
  channel.registerRedaction(masker.register);
  const r = await f.run(f.command(script), { secrets: channel, masker });
  assert.equal(r.result.succeeded, true);
  // Windows PowerShell 5.1 的 -Encoding utf8 會寫入 BOM；與 File.ReadAllLines 一樣讀取時略過。
  const lines = fs.readFileSync(probe, 'utf8').replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '').split(/\r?\n/);
  assert.ok(lines.includes('begin=LCAIPACK-SECRET-BEGIN 1'));
  assert.ok(lines.includes(`stdinSecret=${CANARY}`));
  assert.ok(!lines.find(l => l.startsWith('commandLine=')).includes(CANARY));
  assert.ok(!lines.filter(l => l.startsWith('env:')).some(l => l.includes(CANARY)));
  const log = r.log();
  assert.ok(!log.includes(CANARY) && !log.includes(Buffer.from(CANARY).toString('base64')));
});

test('腳本回吐秘密時 operation log 只剩遮罩字樣（stdout 與 stderr 皆然）', async t => {
  const f = fixture(t);
  const script = f.writeScript(pick(
    `[Console]::In.ReadLine() | Out-Null\n$line = [Console]::In.ReadLine()\n$value = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line.Split(' ')[1]))\n[Console]::Out.WriteLine('leaked=' + $value)\n[Console]::Error.WriteLine('also-leaked=' + $value)\nexit 0\n`,
    `IFS= read -r _\nIFS= read -r line\nvalue=$(printf '%s' "\${line#* }" | base64 -d)\necho "leaked=$value"\necho "also-leaked=$value" >&2\nexit 0\n`));
  const masker = createSecretMasker();
  const channel = secretChannel(f);
  channel.registerRedaction(masker.register);
  const r = await f.run(f.command(script), { secrets: channel, masker });
  assert.equal(r.result.succeeded, true);
  const text = r.log();
  assert.ok(!text.includes(CANARY));
  assert.ok(text.includes(`leaked=${Placeholder}`) && text.includes(`also-leaked=${Placeholder}`));
});

test('資源包沒有宣告秘密時腳本仍拿到只有 begin／end 兩行的空框架', async t => {
  const f = fixture(t);
  const script = f.writeScript(pick(
    `$n = 0\nwhile (($line = [Console]::In.ReadLine()) -ne $null) { $n++; if ($line -eq 'LCAIPACK-SECRET-END') { break } }\nWrite-Output ('secret-frame-lines=' + $n)\nexit 0\n`,
    `n=0\nwhile IFS= read -r line; do n=$((n+1)); [ "$line" = 'LCAIPACK-SECRET-END' ] && break; done\necho "secret-frame-lines=$n"\nexit 0\n`));
  const r = await f.run(f.command(script));
  assert.ok(r.log().includes('secret-frame-lines=2'));
});

// ---------- 取消與逾時：終止整棵子行程樹 ----------

const grandchildScript = pidPath => pick(
  `$child = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 300'\nSet-Content -LiteralPath '${pidPath}' -Value $child.Id -Encoding ascii\nStart-Sleep -Seconds 300\nexit 0\n`,
  `sleep 300 &\necho $! > '${pidPath}'\nsleep 300\nexit 0\n`);

async function waitForPid(pidPath, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(pidPath, 'utf8');
      if (/[\r\n]$/.test(text) && Number.isInteger(Number(text.trim()))) return Number(text.trim());
    } catch { /* 還沒寫完 */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('孫行程沒有在時限內啟動');
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function assertGone(pid) {
  for (let i = 0; i < 100; i++) { if (!alive(pid)) return; await new Promise(r => setTimeout(r, 50)); }
  assert.fail(`孫行程 ${pid} 在取消後仍存活：process tree 沒有被整棵終止`);
}

test('取消會終止整棵子行程樹（含孫行程），結局為 Cancelled 且 log 有取消紀錄', async t => {
  const f = fixture(t);
  const pidPath = path.join(f.context.runtimeRoot, 'grandchild.pid');
  const script = f.writeScript(grandchildScript(pidPath));
  const controller = new AbortController();
  const running = f.run(f.command(script), { signal: controller.signal });
  const pid = await waitForPid(pidPath);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已終止 */ } });
  controller.abort();
  const r = await running;
  assert.deepEqual([r.result.outcome, r.result.exitCode, r.result.succeeded], ['Cancelled', null, false]);
  assert.ok(r.result.failureSummary.includes('取消'));
  await assertGone(pid);
  const log = r.log();
  assert.ok(log.includes('[cancelled]') && !log.includes('[timed-out]'));
});

test('逾時同樣終止整棵樹，且與取消可區分', async t => {
  const f = fixture(t);
  const pidPath = path.join(f.context.runtimeRoot, 'grandchild.pid');
  const script = f.writeScript(grandchildScript(pidPath));
  // 產品路徑的 timeout 最短一分鐘；這裡以覆寫縮到秒級。必須遠大於「孫行程啟動並寫下 pid」所需的時間。
  const running = f.run(f.command(script), { timeoutMs: 8000 });
  const pid = await waitForPid(pidPath);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已終止 */ } });
  const r = await running;
  assert.deepEqual([r.result.outcome, r.result.exitCode, r.result.succeeded], ['TimedOut', null, false]);
  assert.ok(r.result.failureSummary.includes('逾時'));
  await assertGone(pid);
  const log = r.log();
  assert.ok(log.includes('[timed-out]') && !log.includes('[cancelled]'));
});

test('在時限內完成的命令既不是取消也不是逾時；產品路徑的 timeout 取自已審核計畫的分鐘數', async t => {
  const f = fixture(t);
  const r = await f.run(f.command(f.writeScript('exit 0'), [], 120), { timeoutMs: 60000 });
  assert.equal(r.result.outcome, 'Completed');
  const log = r.log();
  assert.ok(!log.includes('[cancelled]') && !log.includes('[timed-out]'));
  const { effectiveTimeoutMs } = await import('../worker/setup/command-runner.mjs');
  assert.equal(effectiveTimeoutMs({ timeoutMinutes: 120 }), 120 * 60 * 1000);
  assert.equal(effectiveTimeoutMs({ timeoutMinutes: 30 }), 30 * 60 * 1000);
  assert.equal(effectiveTimeoutMs({ timeoutMinutes: 30 }, 5), 5);
});

test('runner 本身無法啟動時回報 StartFailed 而不是丟出未處理例外', async t => {
  const f = fixture(t);
  const script = f.writeScript('exit 0');
  const r = await f.run(f.command(script), { registry: { resolve: runner => ({ runner, executable: path.join(f.dir, 'does-not-exist.exe'), leadingArguments: [] }) } });
  assert.deepEqual([r.result.outcome, r.result.exitCode, r.result.succeeded], ['StartFailed', null, false]);
  assert.ok(r.result.failureSummary);
});
