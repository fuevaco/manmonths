import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * 按 spawn 次序消耗情境，沒有情境時立即失敗，絕不啟動真實程序。
 * lines 每項是一行 stdout，stderr 是原始文字，code 預設為 0。
 * hang 保持程序存活直到 kill，error 模擬啟動失敗的錯誤代碼。
 * calls 保存獨立的參數副本與累積的 UTF-8 stdin。
 */
export function createFakeSpawner(scenarios) {
  const pending = [...scenarios], calls = [];
  const spawn = (file, args = [], options = {}) => {
    if (!pending.length) throw new Error(`沒有假啟動情境：${file}`);
    const scenario = pending.shift();
    const call = { file, args: [...args], argv: [file, ...args], options: { ...options, ...(options.env ? { env: { ...options.env } } : {}) },
      env: { ...(options.env ?? {}) }, cwd: options.cwd ?? null, stdin: '' };
    calls.push(call);
    const child = new EventEmitter();
    call.child = child;
    child.pid = 1000 + calls.length;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const decoder = new StringDecoder('utf8');
    child.stdin = new Writable({
      write(chunk, encoding, next) {
        const text = decoder.write(chunk);
        call.stdin += text;
        if (scenario.onStdin) queueMicrotask(() => { if (!ended) scenario.onStdin(text, call); });
        next();
      },
      final(next) { call.stdin += decoder.end(); next(); }
    });
    let ended = false;
    const finish = (code, signal = null) => {
      if (ended) return;
      ended = true;
      child.stdout.end();
      child.stderr.end();
      child.stdin.destroy();
      child.exitCode = code;
      child.signalCode = signal;
      // 先讓 stdout/stderr 的 end 送達，再發出程序的 close。
      setImmediate(() => { child.emit('exit', code, signal); child.emit('close', code, signal); });
    };
    child.kill = (signal = 'SIGTERM') => {
      if (ended) return false;
      child.killed = true;
      finish(null, signal);
      return true;
    };
    setImmediate(() => {
      if (ended) return;
      if (scenario.error) {
        finish(-2);
        child.emit('error', Object.assign(new Error(`spawn ${file} ${scenario.error}`), { code: scenario.error }));
        return;
      }
      for (const line of scenario.lines ?? []) {
        if (ended) return;
        child.stdout.write(line + '\n');
      }
      if (ended) return;
      if (scenario.stderr) child.stderr.write(scenario.stderr);
      if (!scenario.hang) finish(scenario.code ?? 0);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}
