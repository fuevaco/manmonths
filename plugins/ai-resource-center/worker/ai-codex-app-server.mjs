import { createInterface } from 'node:readline';
import { startChild } from './process-spawner.mjs';
import { CODEX } from './ai-local-tool-platforms.mjs';

const DISABLED_FEATURES = ['code_mode_host', 'shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2',
  'plugins', 'apps', 'remote_plugin', 'hooks', 'sleep_tool', 'goals', 'computer_use', 'browser_use',
  'image_generation', 'view_image', 'tool_suggest', 'skill_search', 'in_app_browser'];
const CONFIG_OVERRIDES = ['notify=[]', 'skills.include_instructions=false', 'project_doc_max_bytes=0',
  'web_search="disabled"', 'include_permissions_instructions=false', 'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false', 'include_environment_context=false'];
// app-server 與退回的 exec 共用同一組隔離參數。
export const CODEX_ISOLATION_ARGS = [...DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
  ...CONFIG_OVERRIDES.flatMap(config => ['-c', config])];
const APP_SERVER_ARGS = ['app-server', ...CODEX_ISOLATION_ARGS];
const INTERRUPT_FLUSH_MS = 25;

/** 通訊協定層的失敗（啟動、方法、參數或回應格式），傳輸可據此退回 codex exec。 */
export const protocolError = (message, props) => Object.assign(new Error(message), { protocol: true }, props);

export function startCodexAppServer(spawn, { cwd, env, signal, osPlatform }) {
  const pending = new Map();
  let nextId = 0, failure = null, stopping = false, activeTurn = null;
  // 中止時先送 turn/interrupt 再終止，由 abort() 取代預設的終止流程。
  const run = startChild(spawn, CODEX.command, APP_SERVER_ARGS, { cwd, env, signal, osPlatform, onAbort: () => abort() });
  const { child } = run;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  // 程序結束時統一處理尚未完成的請求。
  const closed = run.closed.then(({ error }) => {
    lines.close();
    fail(error ? Object.assign(error, { protocol: true }) : protocolError('app-server closed', { stderr: run.stderr() }));
  });

  function fail(error) {
    failure ??= error;
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
    activeTurn?.reject(failure);
  }

  function write(message, callback) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n', 'utf8', callback);
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      if (failure) throw failure;
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
  }

  function stop(interruptParams) {
    if (stopping) return;
    stopping = true;
    if (!failure && !signal.aborted) fail(new Error('app-server closed'));
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!interruptParams) {
      run.terminate();
      return;
    }
    // 讓中斷訊息寫進 pipe，若 pipe 卡住仍立即走終止流程。
    const flush = setTimeout(kill, INTERRUPT_FLUSH_MS);
    function kill() {
      clearTimeout(flush);
      if (child.exitCode === null && child.signalCode === null) run.terminate();
    }
    write({ id: ++nextId, method: 'turn/interrupt', params: interruptParams }, kill);
  }

  function abort() {
    fail(signal.reason);
    stop(activeTurn?.interruptParams());
  }

  lines.on('line', line => {
    if (failure || signal.aborted || !line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { fail(protocolError('Invalid app-server JSON')); return; }
    if (message?.method && message.id != null) {
      write({ id: message.id, error: { code: -32601, message: 'Method not supported' } });
    } else if (pending.has(message?.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(protocolError(String(message.error.message ?? 'app-server error'), { rpcError: message.error }));
      else resolve(message.result);
    } else if (message?.method) {
      try { activeTurn?.notify(message.method, message.params); }
      catch { fail(protocolError('Invalid app-server notification')); }
    }
  });

  async function initialize() {
    const result = await request('initialize', {
      clientInfo: { name: 'ai-resource-center', version: '1.0.0' }, capabilities: { experimentalApi: true }
    });
    if (!result || typeof result !== 'object') throw protocolError('Invalid initialize response');
    write({ method: 'initialized' });
  }

  async function turn(params, onDelta) {
    let turnId = '', text = '', reported = null;
    const completed = new Promise((resolve, reject) => {
      activeTurn = {
        reject,
        interruptParams: () => turnId ? { threadId: params.threadId, turnId } : null,
        notify(method, event) {
          if (event?.threadId !== params.threadId) return;
          if (method === 'turn/started') turnId = event.turn?.id ?? '';
          if (!turnId || (event.turnId ?? event.turn?.id) !== turnId) return;
          if (method === 'error' && event.willRetry !== true) reported = event.error;
          if (method === 'item/agentMessage/delta' && typeof event.delta === 'string') onDelta?.(event.delta);
          if (method === 'item/completed' && event.item?.type === 'agentMessage' && typeof event.item.text === 'string') text = event.item.text;
          if (method === 'turn/completed') {
            if (event.turn.status === 'completed') resolve(text);
            else {
              const error = event.turn.error ?? reported;
              reject(Object.assign(new Error(error?.message ?? 'app-server turn ' + event.turn.status), { codexErrorInfo: error?.codexErrorInfo ?? null }));
            }
          }
        }
      };
    });
    try {
      const begun = request('turn/start', params).then(result => {
        if (typeof result?.turn?.id !== 'string' || !result.turn.id) throw protocolError('Invalid turn/start response');
        turnId ||= result.turn.id;
      });
      const [, result] = await Promise.all([begun, completed]);
      return result;
    } finally { activeTurn = null; }
  }

  return { initialize, request, turn, close() { stop(); return closed; } };
}
