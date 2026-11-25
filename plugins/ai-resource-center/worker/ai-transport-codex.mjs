import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AiTransportError } from './ai-transport-error.mjs';
import { createLocalToolCwd } from './ai-local-tools.mjs';
import { cliError, flattenHistory, missingCliError, resolveChatAccount, systemPrompt, writeSystemPrompt } from './ai-local-tool-chat.mjs';
import { CODEX_ISOLATION_ARGS, protocolError, startCodexAppServer } from './ai-codex-app-server.mjs';
import { runCodexExec } from './ai-codex-exec.mjs';

const SELECTION_EFFORT = 'low';
const LIMIT_ERRORS = new Set(['usageLimitExceeded', 'rateLimitExceeded']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 依錯誤代碼與訊息對應草圖文字，無法辨識時原樣拋出，由對話流程顯示一般錯誤。 */
function displayError(error, { account, version }) {
  if (error.code === 'ENOENT') return missingCliError('codex');
  const info = error.codexErrorInfo;
  return cliError('codex', {
    diagnostic: [error.message, error.stderr].join('\n'), signedOut: info === 'unauthorized', limited: LIMIT_ERRORS.has(info), account, version
  }) ?? error;
}

/** osPlatform 是作業系統，用於停止時結束程序樹。 */
export function createCodexAiTransport({ endpoint, localTools, spawn, osPlatform = process.platform }) {
  let workspace, app, config, env, account = '', fellBack = false;

  async function prepare(signal) {
    if (workspace) return;
    ({ account, env } = await resolveChatAccount(localTools, 'codex', signal));
    workspace = await createLocalToolCwd();
  }

  async function connect(signal) {
    await prepare(signal);
    const { cwd } = workspace;
    app = startCodexAppServer(spawn, { cwd, env, signal, osPlatform });
    await app.initialize();
    const result = await app.request('config/read', { cwd });
    const servers = result?.config?.mcp_servers;
    if (!isObject(result?.config) || (servers != null && !isObject(servers))) throw protocolError('Invalid config/read response');
    config = { mcp_servers: Object.fromEntries(Object.keys(servers ?? {}).map(name => [name, { enabled: false }])) };
  }

  async function run({ system, prompt, model, execModel, turnOptions, signal, onModel, onDelta }) {
    let emitted = false;
    const delta = onDelta && (text => { emitted = true; onDelta(text); });
    try {
      if (!fellBack) {
        try { return await runTurn({ system, prompt, model, turnOptions, signal, onModel, onDelta: delta }); }
        catch (error) {
          signal.throwIfAborted();
          // 只有通訊協定層的失敗才退回。已辨識的錯誤（登入、額度、版本、找不到 CLI）與已顯示的串流文字不退回。
          if (!error.protocol || error instanceof AiTransportError || emitted
              || displayError(error, { account, version: endpoint.status?.version }) instanceof AiTransportError) throw error;
          fellBack = true;
          await closeApp();
        }
      }
      return await runExec({ system, prompt, model: execModel, turnOptions, signal, onDelta: delta });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AiTransportError) throw error;
      throw displayError(error, { account, version: endpoint.status?.version });
    }
  }

  async function closeApp() {
    const closing = app;
    app = null;
    await closing?.close().catch(() => {});
  }

  async function runTurn({ system, prompt, model, turnOptions, signal, onModel, onDelta }) {
    if (!app) await connect(signal);
    const result = await app.request('thread/start', {
      cwd: workspace.cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      baseInstructions: systemPrompt(system), config, ...(model ? { model } : {})
    });
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string' || !threadId || typeof result.model !== 'string') throw protocolError('Invalid thread/start response');
    onModel?.(result.model);
    const text = await app.turn({ threadId, input: [{ type: 'text', text: prompt }], ...turnOptions }, onDelta);
    return { text, model: result.model };
  }

  /**
   * 退回路徑：同一個帳號與空 cwd，沒有串流，每則 agent_message 完成時一次傳回。
   * exec 不回報模型，所以明確帶 -m，畫面才寫得出模型。不知道名稱時不帶，模型留空。
   */
  async function runExec({ system, prompt, model, turnOptions, signal, onDelta }) {
    await prepare(signal);
    const { cwd } = workspace;
    const systemFile = await writeSystemPrompt(cwd, system);
    // -c 的值是 TOML，Windows 路徑的反斜線要跳脫。
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'read-only', '--color', 'never', ...CODEX_ISOLATION_ARGS, '-c', `model_instructions_file=${JSON.stringify(systemFile)}`];
    if (turnOptions?.outputSchema) {
      const schemaFile = path.join(cwd, 'output-schema.json');
      await writeFile(schemaFile, JSON.stringify(turnOptions.outputSchema), 'utf8');
      args.push('--output-schema', schemaFile, '-c', `model_reasoning_effort=${JSON.stringify(turnOptions.effort)}`);
    }
    if (model) args.push('-m', model);
    args.push('-');
    const messages = [];
    await runCodexExec(spawn, { args, cwd, env, signal, prompt, osPlatform, onMessage: text => {
      onDelta?.(messages.length ? '\n\n' + text : text);
      messages.push(text);
    } });
    return { text: messages.at(-1) ?? '', model: model ?? '' };
  }

  return {
    async select({ system, user, schema, signal }) {
      const { text, model } = await run({ system, prompt: user, model: endpoint.model, execModel: endpoint.model || endpoint.defaultModel,
        turnOptions: { effort: SELECTION_EFFORT, outputSchema: schema }, signal });
      return { text, model, ...(fellBack ? { appServerFallback: true } : {}) };
    },
    async stream({ system, messages, signal, onDelta, onModel }) {
      const { model } = await run({ system, prompt: flattenHistory(messages), model: endpoint.model,
        execModel: endpoint.model || endpoint.defaultModel, signal, onDelta, onModel });
      return { model, streamed: !fellBack, ...(fellBack ? { appServerFallback: true } : {}) };
    },
    async dispose() {
      try { await app?.close(); }
      finally { await workspace?.remove(); }
    }
  };
}
