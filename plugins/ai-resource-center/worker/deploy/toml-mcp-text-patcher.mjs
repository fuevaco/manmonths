// TomlMcpTextPatcher：LC-AI-Pack 的 table 文字替換規則；不重序列化整份設定檔。
import toml from '../vendor/smol-toml/index.cjs';
import { isDeepStrictEqual } from 'node:util';
export const tomlKey = key => /^[a-zA-Z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
function value(v) {
  if (v === null) throw new Error('TOML MCP 節點不支援 null 值');
  if (Array.isArray(v)) return '[' + v.map(value).join(', ') + ']';
  if (typeof v === 'object') return '{ ' + Object.entries(v).map(([k, v]) => `${tomlKey(k)} = ${value(v)}`).join(', ') + ' }';
  return JSON.stringify(v);
}
export function patchToml(current, id, node) {
  const original = Buffer.from(current).toString('utf8'), bom = original.startsWith('\uFEFF');
  const text = bom ? original.slice(1) : original;
  if (node === null) {
    // 移除先驗證整份文件，不能把損壞設定視為成功；保留 BOM、換行與註解。
    const expected = toml.parse(text);
    if (expected.mcp_servers) delete expected.mcp_servers[id];
    let owned = false, multiline = null;
    const scanStrings = line => {
      let quote = multiline;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (quote[0] === '"' && c === '\\') { i++; continue; }
          if (line.startsWith(quote, i)) {
            i += quote.length - 1;
            if (quote.length === 3) while (line[i + 1] === quote[0]) i++;
            quote = null;
          }
        } else {
          if (c === '#') break;
          if (c === '"' || c === "'") { quote = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c; i += quote.length - 1; }
        }
      }
      multiline = quote?.length === 3 ? quote : null;
    };
    const result = text.replace(/[^\r\n]*(?:\r\n|\r|\n|$)/g, line => {
      const header = !multiline && /^\s*(\[.*\])\s*(?:#.*)?(?:\r\n|\r|\n)?$/.exec(line);
      if (header) {
        const table = toml.parse(header[1]);
        owned = Object.hasOwn(table.mcp_servers ?? {}, id);
      }
      scanStrings(line);
      return owned && line.trim() && !line.trimStart().startsWith('#') ? '' : line;
    });
    const actual = toml.parse(result);
    // 移除最後一個伺服器時，只靠 [mcp_servers.<id>] 標頭隱含產生的 mcp_servers 表格會一併消失，
    // 語意與空表格相同，不算改動其他內容；明確寫出的 [mcp_servers] 標頭仍會保留。
    if (expected.mcp_servers && Object.keys(expected.mcp_servers).length === 0 && !Object.hasOwn(actual, 'mcp_servers')) delete expected.mcp_servers;
    if (!isDeepStrictEqual(actual, expected)) throw new Error('TOML 設定無法安全移除指定節點');
    return Buffer.from((bom ? '\uFEFF' : '') + result);
  }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const tableName = `mcp_servers.${tomlKey(id)}`;
  const rendered = node === null ? '' : `[${tableName}]${nl}` + Object.entries(node).map(([k, v]) => `${tomlKey(k)} = ${value(v)}${nl}`).join('');
  const lines = []; let offset = 0;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) continue;
    lines.push({ start: offset, content: match[0].replace(/[\r\n]+$/, '') }); offset += match[0].length;
  }
  const norm = v => v.replace(/\s/g, '');
  const index = lines.findIndex(l => {
    const m = /^\s*\[([^\]].*?)\]\s*(?:#.*)?$/.exec(l.content);
    return m && !m[1].startsWith('[') && norm(m[1]) === norm(tableName);
  });
  let result;
  if (index < 0) {
    if (node === null) return Buffer.from(current);
    const separator = text.length === 0 ? '' : !text.trim() ? nl : !/[\r\n]$/.test(text) ? nl + nl : text.endsWith(nl + nl) ? '' : nl;
    result = text + separator + rendered;
  } else {
    let next = lines.findIndex((l, i) => i > index && /^\s*\[(?!\[)/.test(l.content));
    const end = next < 0 ? text.length : lines[next].start;
    let suffix = end;
    for (let i = (next < 0 ? lines.length : next) - 1; i > index && !lines[i].content.trim(); i--) suffix = lines[i].start;
    result = text.slice(0, lines[index].start) + rendered + text.slice(suffix);
  }
  // 對齊 LC-AI-Pack Encode：UTF8Encoding(true).GetBytes 不含 preamble，因此寫入會去除 BOM。
  return Buffer.from(result);
}
