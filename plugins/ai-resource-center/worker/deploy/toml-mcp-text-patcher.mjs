// TomlMcpTextPatcher：LC-AI-Pack 的 table 文字替換規則；不重序列化整份設定檔。
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
