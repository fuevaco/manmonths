// 對照 HostProfileGoldenTests：路由表與 matrix digest 必須與桌面工具逐字一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostProfiles, HostIds, SurfaceIds, isSafeTemplate } from '../worker/deploy/host-profiles.mjs';

const golden = [
  ['codex', 'codex-cli', 'project', 'skill', '{root}/.agents/skills/{id}'],
  ['codex', 'codex-cli', 'global', 'skill', '{root}/skills/{id}'],
  ['codex', 'codex-cli', 'project', 'agent', '{root}/.codex/agents/{id}.toml'],
  ['codex', 'codex-cli', 'global', 'agent', '{root}/agents/{id}.toml'],
  ['codex', 'codex-cli', 'project', 'mcp', '{root}/.codex/config.toml'],
  ['codex', 'codex-cli', 'global', 'mcp', '{root}/config.toml'],
  ['codex', 'codex-cli', 'project', 'prompt', '{root}/.codex/prompts/{id}.md'],
  ['codex', 'codex-cli', 'global', 'prompt', '{root}/prompts/{id}.md'],
  ['codex', 'codex-cli', 'project', 'command', '{root}/.codex/prompts/{id}.md'],
  ['codex', 'codex-cli', 'global', 'command', '{root}/prompts/{id}.md'],
  ['claude-code', 'claude-code-cli', 'project', 'skill', '{root}/.claude/skills/{id}'],
  ['claude-code', 'claude-code-cli', 'global', 'skill', '{root}/skills/{id}'],
  ['claude-code', 'claude-code-cli', 'project', 'agent', '{root}/.claude/agents/{id}.md'],
  ['claude-code', 'claude-code-cli', 'global', 'agent', '{root}/agents/{id}.md'],
  ['claude-code', 'claude-code-cli', 'project', 'mcp', '{root}/.mcp.json'],
  ['claude-code', 'claude-code-cli', 'global', 'mcp', '{root}/.claude.json'],
  ['claude-code', 'claude-desktop', 'project', 'mcp', null],
  ['claude-code', 'claude-desktop', 'global', 'mcp', '{root}/claude_desktop_config.json'],
  ['github-copilot', 'copilot-cli', 'project', 'skill', '{root}/.github/skills/{id}'],
  ['github-copilot', 'copilot-cli', 'global', 'skill', '{root}/.copilot/skills/{id}'],
  ['github-copilot', 'copilot-cli', 'project', 'agent', '{root}/.github/agents/{id}.agent.md'],
  ['github-copilot', 'copilot-cli', 'global', 'agent', '{root}/.copilot/agents/{id}.agent.md'],
  ['github-copilot', 'copilot-cli', 'project', 'mcp', '{root}/.mcp.json'],
  ['github-copilot', 'copilot-cli', 'global', 'mcp', '{root}/.copilot/mcp-config.json'],
  ['github-copilot', 'vscode', 'project', 'prompt', '{root}/.github/prompts/{id}.prompt.md'],
  ['github-copilot', 'vscode', 'project', 'mcp', '{root}/.vscode/mcp.json'],
  ['github-copilot', 'vscode', 'global', 'prompt', null],
  ['github-copilot', 'vscode', 'global', 'mcp', null]
];

test('路由表與 golden 逐列一致', () => {
  for (const [hostId, surfaceId, scope, kind, template] of golden) {
    const row = HostProfiles.rows.find(r => r.hostId === hostId && r.surfaceId === surfaceId && r.scope === scope && r.kind === kind);
    assert.ok(row, `${hostId}/${surfaceId}/${scope}/${kind}`);
    assert.equal(row.destinationTemplate, template, `${hostId}/${surfaceId}/${scope}/${kind}`);
  }
});

test('matrix digest 等於既有實作計算出的值，代表路由表、版本與 root base 完全相同', () => {
  // 取自 HostProfileGoldenTests.Matrix_digest_is_stable_and_changes_with_the_table
  assert.equal(HostProfiles.matrixDigest, '8c5d9f5e56667df678fbe89ab6985453d980e30e0608ca7889890a9de2b6afbf');
});

test('每條 template 只用 {root} 與 {id}，Codex CLI 的全域根由偵測提供並支援多根', () => {
  for (const row of HostProfiles.rows.filter(r => r.destinationTemplate)) assert.ok(isSafeTemplate(row.destinationTemplate));
  assert.equal(isSafeTemplate('{root}/../x'), false);
  assert.equal(isSafeTemplate('{root}/{name}'), false);
  const surface = HostProfiles.find(HostIds.codex).findSurface(SurfaceIds.codexCli);
  assert.equal(surface.globalLocatorId, 'codex-config-directory');
  assert.equal(surface.enableMultiRootLocatorEnumeration, true);
  assert.equal(HostProfiles.find(HostIds.codex).version, 'codex/2026.11.1');
});
