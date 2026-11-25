import { AiTransportError } from './ai-transport-error.mjs';
import { withLocalToolCwd } from './ai-local-tools.mjs';
import { CLAUDE_CODE } from './ai-local-tool-platforms.mjs';
import { cliError, flattenHistory, missingCliError, resolveChatAccount, writeSystemPrompt } from './ai-local-tool-chat.mjs';
import { parseJson } from './http.mjs';
import { runChild } from './process-spawner.mjs';

const ISOLATION_ARGS = ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--safe-mode',
  '--disable-slash-commands', '--no-session-persistence'];
const REPLY_ERROR = '無法取得 AI 回覆，請檢查端點連線或回應格式';

function assertResult({ code, stderr, account, version }, result, stdout = '') {
  if (code === 0 && result?.type === 'result' && result.is_error !== true) return;
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const diagnostic = [stderr, result?.result, ...errors, stdout].join('\n');
  throw cliError('claude-code', {
    diagnostic, signedOut: result?.api_error_status === 401, limited: result?.api_error_status === 429, account, version
  }) ?? new AiTransportError(REPLY_ERROR);
}

/** osPlatform 是作業系統，用於停止時結束程序樹。 */
export function createClaudeAiTransport({ endpoint, localTools, spawn, osPlatform = process.platform }) {
  async function run({ system, prompt, args, signal, onStdout }) {
    const resolved = await resolveChatAccount(localTools, 'claude-code', signal);
    return withLocalToolCwd(async cwd => {
      const systemFile = await writeSystemPrompt(cwd, system);
      try {
        const output = await runChild(spawn, CLAUDE_CODE.command, [...ISOLATION_ARGS, '--system-prompt-file', systemFile, ...args],
          { cwd, env: resolved.env, signal, osPlatform, input: prompt, onStdout });
        return { ...output, account: resolved.account, version: endpoint.status?.version };
      } catch (error) {
        if (error.code === 'ENOENT') throw missingCliError('claude-code');
        throw error;
      }
    });
  }

  /** 端點的模型不是空字串時才帶 --model，兩個階段規則相同。 */
  const modelArgs = () => endpoint.model ? ['--model', endpoint.model] : [];

  async function select({ system, user, signal }) {
    let stdout = '';
    const output = await run({ system, prompt: user, args: ['--output-format', 'json', ...modelArgs()],
      signal, onStdout: chunk => { stdout += chunk; } });
    const result = parseJson(stdout);
    assertResult(output, result, result ? '' : stdout);
    const usage = result.modelUsage;
    const model = usage && typeof usage === 'object' && !Array.isArray(usage) ? Object.keys(usage)[0] ?? '' : '';
    return { text: typeof result.result === 'string' ? result.result : '', model };
  }

  async function stream({ system, messages, signal, onDelta, onModel }) {
    const args = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...modelArgs()];
    let buffer = '', model = '', result = null;
    function consume(line) {
      const value = parseJson(line);
      if (value?.type === 'system' && value.subtype === 'init' && typeof value.model === 'string') {
        model = value.model;
        onModel?.(model);
      } else if (value?.type === 'stream_event' && value.event?.type === 'content_block_delta') {
        const delta = value.event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') onDelta(delta.text);
      } else if (value?.type === 'result') result = value;
    }
    const output = await run({ system, prompt: flattenHistory(messages), args, signal, onStdout: chunk => {
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop();
      for (const line of lines) consume(line);
    } });
    consume(buffer);
    assertResult(output, result);
    return { model, streamed: true };
  }
  return { select, stream };
}
