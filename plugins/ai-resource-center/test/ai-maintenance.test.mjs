import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('PAT 儲存命名空間只由端點服務定義，對話透過共用介面存取', async () => {
  const endpoint = await source('worker/ai-endpoint-service.mjs');
  const chat = await source('worker/ai-chat.mjs');
  assert.equal(endpoint.split('resource-center.ai-pat.').length - 1, 1);
  assert.doesNotMatch(chat, /resource-center\.ai-pat\./);
});

test('AI 面板請求集中由領域 handler 註冊，入口只組裝服務且使用英文 log 代碼', async () => {
  const index = await source('worker/index.mjs');
  const handler = await source('worker/handlers/ai.mjs');
  assert.match(handler, /export function registerAiHandlers\(/);
  assert.match(index, /registerAiHandlers\(router,/);
  assert.doesNotMatch(index, /router\.handle\(['"`]rc\.ai\./);
  const codes = [...index.matchAll(/\[ai\] ([^'"]+)/g)].map(match => match[1]);
  assert.ok(codes.length > 0);
  for (const code of codes) assert.match(code, /^[a-z][a-z0-9_]*$/);
});

test('README 並行、字數、候選上限與歷史輪數均以具名常數表達', async () => {
  const catalog = await source('worker/ai-catalog.mjs');
  const chat = await source('worker/ai-chat.mjs');
  for (const value of ['4', '6000']) {
    assert.ok(new RegExp(`const [A-Z_]+ = ${value.replace('.', '\\.')};`).test(catalog), `缺少 ${value} 的具名常數`);
  }
  assert.doesNotMatch(catalog, /active >= 4|slice\(0, 6000\)/);
  assert.match(chat, /const HISTORY_TURNS = 6;/);
  assert.match(chat, /const SELECTION_LIMIT = 5;/);
  assert.match(chat, /const CANDIDATE_LIMIT = 8;/);
});

test('AI 對話與端點測試的靜態 import 集中於檔頭', async () => {
  for (const file of ['ai-chat.test.mjs', 'ai-endpoints.test.mjs']) {
    const text = await source(`test/${file}`);
    let body = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^import\s/.test(line)) assert.equal(body, false, `${file} 的 import 位於測試中段`);
      else if (line.trim() && !line.startsWith('//')) body = true;
    }
  }
});

test('一鍵操作短提示註解緊鄰 toast，不標示 AI 視圖', async () => {
  const html = await source('panel/index.html');
  assert.match(html, /<!-- 一鍵操作的結果短提示 -->\s*<div id="toast"/);
  assert.equal(html.split('<!-- 一鍵操作的結果短提示 -->').length - 1, 1);
});
