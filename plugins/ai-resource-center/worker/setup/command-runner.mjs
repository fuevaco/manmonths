// 設定命令的執行器（對照 Setup/SetupCommandRunner.cs）。這是平台唯一允許啟動 publisher setup script 的入口。
//
// 安全形狀：
// - 只接受固定 runner 白名單解析出的可執行檔；資源包永遠提供不了完整 shell command string；
// - argv 完全分離（spawn 的 args 陣列、shell:false），因此不存在引號逃逸；
// - script 由 package 相對路徑解析到 payload 目錄，且解析結果不得離開 payload；
// - working directory 固定為 runtime 目錄；環境變數只有身分與根目錄，沒有秘密；
// - 第一版不支援 elevation：不要求提權；
// - 秘密只透過子行程 stdin 的一次性框架交付，寫完立刻關閉 stdin。
//
// stdout 與 stderr 兩條管線各自獨立抽乾並餵給 operation log（已遮罩、串流安全），因此不會因其中一條寫滿而死結。
// exit code 0 是唯一的成功判定；stdout／stderr 只是診斷 log。取消與逾時都終止整棵子行程樹。
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

/** 等待輸出管線收尾的上限：行程已結束但有後代行程仍持有管線時，不讓安裝被無限期卡住。 */
const STREAM_DRAIN_GRACE_MS = 5000;

/** 本次實際採用的逾時；產品路徑的 timeout 完全由已審核計畫的分鐘數決定，覆寫只讓取消／逾時行為能用秒級測試驗證。 */
export const effectiveTimeoutMs = (command, overrideMs = null) => overrideMs ?? command.timeoutMinutes * 60 * 1000;

/**
 * 終止整棵子行程樹。Windows 以 taskkill /T /F；其餘平台子行程自成行程群組（detached），對整個群組送 SIGKILL。
 * 已結束或無權限不拋例外。
 */
export function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* 行程已結束或無權限終止某個後代 */ }
  try { child.kill('SIGKILL'); } catch { /* 已結束 */ }
}

/**
 * @param {object} request
 * @param {object} request.command   已審核的命令揭露（planCommands 的項目）
 * @param {object} request.context   createExecutionContext 的結果
 * @param {string} request.operatingSystem  權威本機 OS
 * @param {object} request.log       openOperationLog 的結果
 * @param {object} request.secrets   openSecretChannel 的結果（沒有秘密時為空通道）
 * @param {string|null} [request.operationId]
 * @param {AbortSignal} [request.signal]  使用者取消
 * @param {number} [request.timeoutMs]    逾時覆寫（產品路徑留空）
 * @param {{resolve(runner: string, operatingSystem: string): object|null}} request.registry
 * @returns {Promise<{commandId: string, outcome: 'Completed'|'Cancelled'|'TimedOut'|'StartFailed', exitCode: number|null, durationMs: number, failureSummary: string|null, succeeded: boolean}>}
 */
export async function runSetupCommand({ command, context, operatingSystem, log, secrets, operationId = null, signal, timeoutMs = null, registry }) {
  const runner = registry.resolve(command.runner, operatingSystem);
  if (!runner) {
    throw new Error(`設定命令 '${command.commandId}' 需要的 runner '${command.runner}' 不可用；Plan 應該已經以 blocking problem 攔下，執行階段不得自行代打。`);
  }
  const scriptPath = context.resolvePayloadPath(command.script);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`設定命令 '${command.commandId}' 的腳本尚未落地：${command.script}。執行前必須先 MaterializePayload。`);
  }
  fs.mkdirSync(context.runtimeRoot, { recursive: true });

  const timeout = effectiveTimeoutMs(command, timeoutMs);
  const args = [...runner.leadingArguments, scriptPath, ...command.arguments];
  log.writeCommandStart(command.commandId, command.runner, scriptPath, args);
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const result = (outcome, exitCode, failureSummary = null) => ({ commandId: command.commandId, outcome, exitCode, durationMs: elapsed(), failureSummary,
    succeeded: outcome === 'Completed' && exitCode === 0 });

  const child = spawn(runner.executable, args, {
    cwd: context.runtimeRoot, env: { ...process.env, ...context.buildEnvironment(operationId) }, stdio: ['pipe', 'pipe', 'pipe'],
    shell: false, windowsHide: true, detached: process.platform !== 'win32'
  });

  const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms).unref());
  const exited = new Promise(resolveExit => child.once('exit', (code, exitSignal) => resolveExit(code ?? (exitSignal ? -1 : 0))));
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  const startError = new Promise(resolveError => child.once('error', error => { if (!child.pid) resolveError(error); }));

  // 沒有 pid 代表行程根本沒能啟動（找不到可執行檔、權限不足）。
  if (!child.pid) {
    const error = await startError;
    log.writeCommandEnd(command.commandId, -1, elapsed());
    return result('StartFailed', null, `無法啟動 runner：${error.code ?? error.message}`);
  }
  for (const [stream, write] of [[child.stdout, chunk => log.writeStdout(chunk)], [child.stderr, chunk => log.writeStderr(chunk)]]) {
    stream.setEncoding('utf8');
    stream.on('data', write);
    stream.on('error', () => {});
  }
  // 腳本不讀 stdin 就結束時的 EPIPE 不是失敗。
  child.stdin.on('error', () => {});

  let requestStop;
  const stopRequested = new Promise(resolveStop => { requestStop = resolveStop; });
  const onAbort = () => requestStop('cancelled');
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => requestStop('timeout'), timeout);
  try {
    // 秘密框架必須是腳本讀到的第一段 stdin；寫完立刻關閉，值不在任何持久媒介停留。
    try { secrets.writeTo(child.stdin); child.stdin.end(); } catch (error) { killProcessTree(child); throw error; }
    const outcome = await Promise.race([exited.then(code => ({ code })), stopRequested.then(reason => ({ reason }))]);
    if (outcome.reason === undefined) {
      // 等輸出管線收尾（有上限）才算完成，log 才收得到全部輸出。
      await Promise.race([closed, wait(STREAM_DRAIN_GRACE_MS)]);
      const failureDetail = log.writeCommandEnd(command.commandId, outcome.code, elapsed());
      return result('Completed', outcome.code, outcome.code === 0 ? null : failureDetail ?? `設定命令以非零 exit code ${outcome.code} 結束；詳細輸出見 operation log。`);
    }
    killProcessTree(child);
    // 已被終止的行程仍要等它真的收屍，否則 log 可能少掉最後幾行輸出。
    await Promise.race([exited, wait(30000)]);
    await Promise.race([closed, wait(STREAM_DRAIN_GRACE_MS)]);
    const stopped = elapsed();
    if (outcome.reason === 'timeout') {
      log.writeTimedOut(command.commandId, timeout);
      return result('TimedOut', null, `設定命令逾時（${Math.round(timeout / 60000 * 100) / 100} 分鐘），整棵子行程樹已終止。`);
    }
    log.writeCancelled(command.commandId, stopped);
    return result('Cancelled', null, '設定命令已由使用者取消，整棵子行程樹已終止。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    child.stdout.destroy(); child.stderr.destroy();
  }
}
