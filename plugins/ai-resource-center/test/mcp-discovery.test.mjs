import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverGlobalMcp } from '../worker/deploy/mcp-discovery.mjs';

function environment(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-08-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (name, text) => { const file = path.join(home, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  return { home, write };
}
test('global MCP read API discovers Codex, Claude Code and Desktop servers while ignoring malformed config', t => {
  const e = environment(t);
  e.write('.codex/config.toml', '[mcp_servers.codex-sql]\ncommand = "sql-mcp"');
  e.write('.claude/settings.json', '{}');
  e.write('.claude.json', '{"mcpServers":{"claude-fs":{"command":"fs-server"},"not-a-server":1}}');
  e.write('desktop/claude_desktop_config.json', '{"mcpServers":{"desktop-fs":{"command":"fs-server"}}}');
  for (const [hostId, surfaceId, root, expected] of [['codex', 'codex-cli', '.codex', 'codex-sql'], ['claude-code', 'claude-code-cli', '.claude', 'claude-fs'], ['claude-code', 'claude-desktop', 'desktop', 'desktop-fs']]) {
    const results = discoverGlobalMcp({ hostId, surfaceId, canonicalRoot: path.join(e.home, root), userHome: e.home });
    assert.equal(results.length, 1); assert.equal(results[0].name, expected); assert.equal(results[0].kind, 'mcp');
  }
  e.write('.codex/config.toml', '[malformed');
  assert.deepEqual(discoverGlobalMcp({ hostId: 'codex', surfaceId: 'codex-cli', canonicalRoot: path.join(e.home, '.codex') }), []);
});


import { discoverProjectMcp } from '../worker/deploy/mcp-discovery.mjs';
test('project MCP reads standard JSON, Codex TOML and Claude projects entries including disabled state', t => {
  const e = environment(t), projectRoot = path.join(e.home, 'project');
  e.write('project/.mcp.json', '{"mcpServers":{"standard-project-server":{"command":"node","args":["server.js"]}}}');
  e.write('project/.codex/config.toml', '[mcp_servers.codex-project]\ncommand = "codex-server"');
  const globalClaudeJsonPath = e.write('.claude.json', JSON.stringify({ projects: { [projectRoot]: { mcpServers: { 'claude-project-server': { command: 'python' }, 'disabled-server': { command: 'test' } }, disabledMcpjsonServers: ['DISABLED-server'] } } }));
  const results = discoverProjectMcp({ hostId: 'claude-code', surfaceId: 'claude-code-cli', projectRoot, globalClaudeJsonPath });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map(r => [r.name, r.isDisabledProjectMcp]), [['standard-project-server', false], ['claude-project-server', false], ['disabled-server', true]]);
  assert.deepEqual(discoverProjectMcp({ hostId: 'codex', surfaceId: 'codex-cli', projectRoot }).map(r => r.name), ['standard-project-server', 'codex-project']);
});
