// 對照 ArtifactDialects：Markdown 直通使用 UTF-8 without BOM、LF 與單一結尾換行。
export const utf8Lf = text => Buffer.from(text.replace(/^\uFEFF+/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/\n+$/, '') + '\n');

import { splitFrontmatter } from './canonical-package.mjs';
import { ArtifactDialectIds } from './host-profiles.mjs';

const yamlQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '').replaceAll('\n', ' ') + '"';
// TOML basic strings share JSON escapes, with DEL additionally escaped for TOML.
const tomlQuote = value => JSON.stringify(value).replaceAll('\u007f', '\\u007F');

export function renderArtifact(content, source, dialect) {
  if (content.kind === 'agent') {
    const text = source.toString('utf8');
    const body = (splitFrontmatter(text)?.body ?? text).replace(/^\uFEFF+/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/^\n+|\n+$/g, '');
    if (dialect === ArtifactDialectIds.codexAgentToml) {
      const declared = content.hostOverrides.codex ?? {};
      const fields = { name: content.id, description: content.description ?? content.name,
        ...(declared.model != null ? { model: declared.model } : {}), developer_instructions: body };
      return utf8Lf(Object.entries(fields).map(([key, value]) => `${key} = ${tomlQuote(value)}`).join('\n'));
    }
    if (dialect !== ArtifactDialectIds.claudeAgentMarkdown) throw new Error(`未支援的 Agent dialect：${dialect}`);
    const declared = content.hostOverrides['claude-code'] ?? {};
    const fields = [`name: ${yamlQuote(content.id)}`, `description: ${yamlQuote(content.description ?? content.name)}`];
    if (declared.tools != null) fields.push(`tools: ${Array.isArray(declared.tools) ? '[' + declared.tools.map(yamlQuote).join(', ') + ']' : yamlQuote(declared.tools)}`);
    if (declared.model != null) fields.push(`model: ${yamlQuote(declared.model)}`);
    return utf8Lf(`---\n${fields.join('\n')}\n---\n\n${body}`);
  }
  return utf8Lf(source.toString('utf8'));
}
