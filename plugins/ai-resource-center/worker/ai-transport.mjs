import { aiEndpointSecretKey } from './ai-endpoint-service.mjs';
import { createHttpAiTransport } from './ai-transport-http.mjs';
import { createClaudeAiTransport } from './ai-transport-claude.mjs';
import { createCodexAiTransport } from './ai-transport-codex.mjs';

/**
 * 每輪建立一個傳輸，兩階段共用。端點類型與平台的選擇集中於此。
 *
 * select({system, user, schema, signal}) -> Promise<{text, model}>
 *   schema 是挑選結果的 JSON Schema，解析與候選驗證仍由對話流程負責。
 * stream({system, messages, signal, onDelta, onModel}) -> Promise<{model, streamed}>
 *   messages 不含系統提示，包含歷史及本次提問，CLI 可在傳輸內攤平。
 *   onDelta(text) 收取回答文字，exec 退回也使用它一次傳回完整回答。
 *   onModel(model) 可在開始串流時回報 CLI 提供的模型。
 * 失敗以 AiTransportError 回報可顯示的文字，中止由傳入的 signal 控制。
 * osPlatform 是作業系統（process.platform），endpoint.platform 是本機 AI 工具的平台。
 */
export async function createAiTransport({ endpoint, orca, spawn, localTools, osPlatform, timeoutMs }) {
  if (endpoint.type === 'local-tool') {
    const create = endpoint.platform === 'codex' ? createCodexAiTransport : createClaudeAiTransport;
    return create({ endpoint, spawn, localTools, osPlatform });
  }
  const pat = await orca.secrets.get(aiEndpointSecretKey(endpoint.id));
  return createHttpAiTransport({ endpoint, pat, timeoutMs });
}
