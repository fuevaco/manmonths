import { send } from './http.mjs';
import { StringDecoder } from 'node:string_decoder';
import { AiTransportError } from './ai-transport-error.mjs';

const SELECTION_MAX_TOKENS = 200;

function mapError(error) {
  return new AiTransportError(error.kind === 'timeout' ? 'AI 回覆逾時，請再試一次'
    : /^HTTP \d+$/.test(error.message) ? `AI 回覆失敗（${error.message}）` : '無法取得 AI 回覆，請檢查端點連線或回應格式');
}

/** v1.3.0 的 OpenAI 相容呼叫，模型以端點設定為準。 */
export function createHttpAiTransport({ endpoint, pat = '', timeoutMs = 120000 }) {
  const headers = pat ? { Authorization: `Bearer ${pat}` } : {};
  async function select({ system, user, schema, signal }) {
    // 保留 json_object 相容性，不把 schema 改送成 json_schema。
    const json = { model: endpoint.model, stream: false, temperature: 0, max_tokens: SELECTION_MAX_TOKENS,
      response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    try {
      const request = () => send({ method: 'POST', url: `${endpoint.baseUrl}/chat/completions`, headers, json, timeoutMs, signal });
      let response = await request();
      if (response.status === 400) { delete json.response_format; response = await request(); }
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      let text = '';
      try { text = JSON.parse(response.text).choices[0].message.content; } catch { /* 交由對話流程降級為只用說明回答。 */ }
      return { text: typeof text === 'string' ? text : '', model: endpoint.model };
    } catch (error) { throw mapError(error); }
  }
  async function stream({ system, messages, signal, onDelta }) {
    // [DONE] 要立刻關閉 HTTP 連線，不能中止呼叫端共用的 signal。
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const decoder = new StringDecoder('utf8');
    let buffer = '', done = false;
    const consume = chunk => {
      buffer += decoder.write(chunk);
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || done) continue;
        if (data === '[DONE]') { done = true; controller.abort(); continue; }
        const value = JSON.parse(data);
        if (value.error) throw new Error('model');
        const text = value.choices?.[0]?.delta?.content;
        if (text !== undefined && typeof text !== 'string') throw new Error('format');
        if (text) onDelta(text);
      }
    };
    try {
      const response = await send({ method: 'POST', url: `${endpoint.baseUrl}/chat/completions`, headers,
        json: { model: endpoint.model, stream: true, messages: [{ role: 'system', content: system }, ...messages] },
        timeoutMs, signal: controller.signal, onChunk: consume });
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      if (!done) throw new Error('incomplete');
    } catch (error) { if (!done) throw mapError(error); }
    finally { signal?.removeEventListener('abort', abort); }
    return { model: endpoint.model, streamed: true };
  }
  return { select, stream };
}
