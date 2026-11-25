import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpAiTransport } from '../worker/ai-transport-http.mjs';

// 工項 01 明確要求的公開傳輸回傳契約，不新增面板欄位來觀察內部的模型資訊。
test('HTTP 挑選傳輸回傳端點設定的模型', async t => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.end(JSON.stringify({ model: 'server-alias', choices: [{ message: { content: '{"keys":[]}' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const transport = createHttpAiTransport({ endpoint: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'configured-model' } });
  assert.deepEqual(await transport.select({ system: '挑選', user: '找資源包', schema: { type: 'object' }, signal: new AbortController().signal }),
    { text: '{"keys":[]}', model: 'configured-model' });
});

test('HTTP 串流傳輸回傳端點設定的模型與串流狀態', async t => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.end(`data: ${JSON.stringify({ model: 'server-alias', choices: [{ delta: { content: '回答' } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const transport = createHttpAiTransport({ endpoint: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'configured-model' } });
  let text = '';
  const result = await transport.stream({ system: '回答', messages: [{ role: 'user', content: '找資源包' }],
    signal: new AbortController().signal, onDelta: delta => { text += delta; } });
  assert.deepEqual(result, { model: 'configured-model', streamed: true });
  assert.equal(text, '回答');
});
