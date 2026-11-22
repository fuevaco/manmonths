import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { patchToml } from '../worker/deploy/toml-mcp-text-patcher.mjs';

const require = createRequire(import.meta.url);
const toml = require('../worker/vendor/smol-toml/index.cjs');

const plain = o => JSON.parse(JSON.stringify(o));
const remove = (text, id) => Buffer.from(patchToml(Buffer.from(text), id, null)).toString('utf8');

test('移除唯一的 MCP 伺服器：只靠子表格標頭產生的 mcp_servers 一併消失，其他內容與 CRLF 保留', () => {
  const text = [
    'model = "demo-model"',
    '[tui]',
    'status_line = ["model"]',
    '',
    "[projects.'c:\\users\\alice\\demo']",
    'trust_level = "trusted"',
    '',
    '[mcp_servers.demo-gateway]',
    'args = ["--port", "1"]',
    'command = "node"',
    'env = { DEMO_URL = "https://market.example.com", MODE = "local" }'
  ].join('\r\n');
  const result = remove(text, 'demo-gateway');
  assert.equal(result.includes('demo-gateway'), false);
  assert.equal(result.includes('DEMO_URL'), false);
  assert.ok(result.startsWith('model = "demo-model"\r\n[tui]\r\n'));
  assert.equal(/[^\r]\n/.test(result), false, '維持 CRLF');
  const parsed = toml.parse(result);
  assert.deepEqual(Object.keys(parsed), ['model', 'tui', 'projects']);
});

test('移除其中一個 MCP 伺服器時保留其他伺服器', () => {
  const text = '[mcp_servers.keep]\ncommand = "a"\n\n[mcp_servers.drop]\ncommand = "b"\n';
  const parsed = toml.parse(remove(text, 'drop'));
  assert.deepEqual(plain(parsed), { mcp_servers: { keep: { command: 'a' } } });
});

test('明確寫出空的 [mcp_servers] 表格時，移除最後一個伺服器後保留該表格', () => {
  const text = '[mcp_servers]\n\n[mcp_servers.only]\ncommand = "a"\n';
  const result = remove(text, 'only');
  assert.deepEqual(plain(toml.parse(result)), { mcp_servers: {} });
  assert.ok(result.includes('[mcp_servers]'));
});

test('移除後若其他內容被改動仍拒絕（安全檢查保留）', () => {
  // 伺服器的鍵寫在 mcp_servers 表格內（dotted key），逐行移除無法安全處理，應拒絕而不是誤刪。
  const text = '[mcp_servers]\nonly.command = "a"\nother.command = "b"\n';
  assert.throws(() => remove(text, 'only'), /無法安全移除/);
});
