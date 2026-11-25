import { spawn as nodeSpawn } from 'node:child_process';

const STDERR_TAIL = 8192;

// 新增的外部程序共用這個入口，測試可用 deps.spawn 取代作業系統邊界。
export function createProcessSpawner(spawn = nodeSpawn) {
  return (file, args = [], options = {}) => spawn(file, args, { ...options, shell: false, windowsHide: true });
}

/** osPlatform 是作業系統（process.platform），Windows 上程序未結束時改用 taskkill 結束整個程序樹。 */
export function terminateChild(spawn, child, osPlatform) {
  const fallback = setTimeout(() => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (osPlatform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.once('error', () => {});
      } else child.kill('SIGKILL');
    } catch { /* 程序可能在發出終止指令時已結束。 */ }
  }, 250);
  fallback.unref?.();
  child.once('close', () => clearTimeout(fallback));
  try { child.kill(); } catch { /* 交由 fallback 再試。 */ }
}

/**
 * 啟動子程序，統一處理 stderr 尾段、stdin 錯誤、中止時終止與結束事件。
 * - input 有值時經 stdin 以 UTF-8 寫入後關閉。stdin 為 'ignore' 時不開 stdin。
 * - onStdout 收到 UTF-8 文字，中止後不再呼叫。沒有 onStdout 時由呼叫端自行讀 child.stdout。
 * - onAbort 可取代預設的終止流程，例如先送中斷訊息再終止。
 * 回傳 { child, terminate, stderr(), closed }，closed 在程序關閉時取得 { code, error }。
 */
export function startChild(spawn, file, args, { cwd, env, signal, osPlatform, input, stdin = 'pipe', stderr: keepStderr = true, onStdout, onAbort }) {
  signal.throwIfAborted();
  const child = spawn(file, args, { cwd, env, stdio: [stdin, 'pipe', keepStderr ? 'pipe' : 'ignore'] });
  let stderr = '', error;
  const terminate = () => terminateChild(spawn, child, osPlatform);
  const abort = () => (onAbort ?? terminate)();
  if (onStdout) child.stdout.setEncoding('utf8').on('data', chunk => { if (!signal.aborted) onStdout(chunk); });
  if (keepStderr) child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
  if (stdin === 'pipe') child.stdin.on('error', () => {}); // CLI 提早離開時，由程序結果判斷錯誤。
  child.on('error', value => { error ??= value; });
  const closed = new Promise(resolve => child.once('close', code => {
    signal.removeEventListener('abort', abort);
    resolve({ code, error });
  }));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  else if (input !== undefined) child.stdin.end(input, 'utf8');
  return { child, terminate, closed, stderr: () => stderr };
}

/** 執行到結束。中止時以中止原因拒絕，無法啟動時以啟動錯誤拒絕，否則回傳結束代碼與 stderr 尾段。 */
export async function runChild(spawn, file, args, options) {
  const run = startChild(spawn, file, args, options);
  const { code, error } = await run.closed;
  if (options.signal.aborted) throw options.signal.reason;
  if (error) throw error;
  return { code, stderr: run.stderr() };
}
