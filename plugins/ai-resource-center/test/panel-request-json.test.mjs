// Orca 驗證面板請求必須是合法 JSON：值為 undefined 的欄位會被拒絕（input: Invalid input）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel } from './panel-harness.mjs';

const hasUndefined = value => value === undefined
  || (Array.isArray(value) ? value.some(hasUndefined)
    : value && typeof value === 'object' ? Object.values(value).some(hasUndefined) : false);

test('面板送給 worker 的輸入不含值為 undefined 的欄位', async () => {
  const inputs = [];
  const panel = await startPanel(async (method, input) => { inputs.push({ method, input }); return {}; });
  inputs.length = 0;
  await panel.window.RcPanel.call('rc.ai.endpoints.test', { id: undefined, baseUrl: 'http://127.0.0.1:1', nested: { pat: undefined, list: [1] } });
  const sent = inputs.find(r => r.method === 'rc.ai.endpoints.test').input;
  assert.equal(hasUndefined(sent), false);
  assert.equal(JSON.stringify(sent), JSON.stringify({ baseUrl: 'http://127.0.0.1:1', nested: { list: [1] } }));
});

test('沒有輸入的請求維持不帶輸入', async () => {
  const inputs = [];
  const panel = await startPanel(async (method, input) => { inputs.push({ method, input }); return {}; });
  inputs.length = 0;
  await panel.window.RcPanel.call('rc.ai.settings.get');
  assert.equal(inputs[0].input, undefined);
});
