import { runChild } from './process-spawner.mjs';
import { CODEX } from './ai-local-tool-platforms.mjs';

/**
 * 執行一次 `codex exec --json`，提示經 stdin 傳入。每個 agent_message 完成時呼叫 onMessage(text)，
 * 整段完成才結束。失敗時拋出的錯誤帶有 stderr，供傳輸對應成草圖文字。
 */
export async function runCodexExec(spawn, { args, cwd, env, signal, prompt, osPlatform, onMessage }) {
  let buffer = '', completed = false;
  const reported = [];
  function consume(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') onMessage(event.item.text);
    else if (event?.type === 'turn.completed') completed = true;
    else if (event?.type === 'turn.failed' && typeof event.error?.message === 'string') reported.push(event.error.message);
    else if (event?.type === 'error' && typeof event.message === 'string') reported.push(event.message);
  }
  const { code, stderr } = await runChild(spawn, CODEX.command, args, { cwd, env, signal, osPlatform, input: prompt, onStdout: chunk => {
    const lines = (buffer + chunk).split('\n');
    buffer = lines.pop();
    for (const line of lines) consume(line);
  } });
  if (buffer) consume(buffer);
  if (code === 0 && completed) return;
  throw Object.assign(new Error(reported.join('\n') || 'codex exec failed'), { stderr, exitCode: code });
}
