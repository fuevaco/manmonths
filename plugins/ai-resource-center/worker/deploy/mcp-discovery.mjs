// McpDiscovery 唯讀 API：探索現有設定，不把未受管節點當成已安裝資源包。
import fs from 'node:fs';
import { createPathRules } from './canonical-root.mjs';
import { resolveCodexBase } from './codex-roots.mjs';
import { HostRootBaseIds } from './host-profiles.mjs';
import { parseToml } from './config-document-adapters.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function readDocument(file, fsApi) {
  try { const bytes = fsApi.readFileSync(file); return file.toLowerCase().endsWith('.toml') ? parseToml(bytes) : JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function readServers(options, file, servers, disabled = []) {
  if (!object(servers)) return [];
  return Object.entries(servers).filter(([name, node]) => name.trim() && object(node)).map(([name]) => ({
    hostId: options.hostId, surfaceId: options.surfaceId, scope: options.scope, canonicalRoot: options.canonicalRoot,
    displayRoot: options.displayRoot ?? options.canonicalRoot, kind: 'mcp', name, actualPath: file, configPath: file,
    isDirectory: false, isDisabledProjectMcp: disabled.some(id => String(id).toLowerCase() === name.toLowerCase())
  }));
}
export function discoverGlobalMcp({ fsApi = fs, rules = createPathRules(), ...input }) {
  const options = { ...input, scope: 'global' }, api = rules.path, root = input.canonicalRoot;
  let file;
  if (input.hostId === 'codex') {
    file = api.join(resolveCodexBase(root, input.userHome ?? '', HostRootBaseIds.codexConfigRoot, rules), 'config.toml');
    if (!fsApi.existsSync(file)) file = api.join(root, '.codex', 'config.toml');
  } else if (input.hostId === 'claude-code') {
    file = api.join(root, input.surfaceId === 'claude-desktop' ? 'claude_desktop_config.json' : '.claude.json');
    if (input.surfaceId !== 'claude-desktop' && !fsApi.existsSync(file)) file = api.join(api.dirname(root), '.claude.json');
  } else return [];
  const doc = readDocument(file, fsApi);
  return readServers(options, file, doc?.[input.hostId === 'codex' ? 'mcp_servers' : 'mcpServers']);
}

export function discoverProjectMcp({ fsApi = fs, rules = createPathRules(), ...input }) {
  const options = { ...input, scope: 'project', canonicalRoot: input.projectRoot }, api = rules.path;
  const standard = api.join(input.projectRoot, '.mcp.json');
  const results = readServers(options, standard, readDocument(standard, fsApi)?.mcpServers);
  if (input.hostId === 'codex') {
    const file = api.join(input.projectRoot, '.codex', 'config.toml');
    results.push(...readServers(options, file, readDocument(file, fsApi)?.mcp_servers));
  }
  if (input.hostId === 'claude-code' && input.globalClaudeJsonPath) {
    const doc = readDocument(input.globalClaudeJsonPath, fsApi);
    const project = object(doc?.projects) ? Object.entries(doc.projects).find(([p, node]) => object(node) && rules.normalize(p) === rules.normalize(input.projectRoot))?.[1] : null;
    results.push(...readServers(options, input.globalClaudeJsonPath, project?.mcpServers, Array.isArray(project?.disabledMcpjsonServers) ? project.disabledMcpjsonServers : []));
  }
  const seen = new Set();
  return results.filter(r => { const key = `${r.name}|${r.actualPath}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}
