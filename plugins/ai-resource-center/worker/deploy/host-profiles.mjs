// Host Profiles（對照 LcAiPack.Core Deployment/HostProfiles.cs）：client 內建、版本化的路由表。
// 修改任何 template 都必須同步 LC-AI-Pack、提升 profile 版本，並更新 golden 測試的 matrix digest。
// 路由表完整保留，讓既有收據都能被辨識；安裝入口另依已實作的 driver 篩選能力。
import { ofText, ordinal } from './digest.mjs';

export const HostIds = Object.freeze({ codex: 'codex', claudeCode: 'claude-code', gitHubCopilot: 'github-copilot' });
export const SurfaceIds = Object.freeze({
  codexCli: 'codex-cli', claudeCodeCli: 'claude-code-cli', claudeDesktop: 'claude-desktop', copilotCli: 'copilot-cli', vsCode: 'vscode'
});
export const Scope = Object.freeze({ project: 'project', global: 'global' });
/** canonical kind；陣列順序等於 LC-AI-Pack enum 順序（排序與 digest 用）。 */
export const Kinds = Object.freeze(['skill', 'agent', 'mcp', 'prompt', 'command']);
export const MutationKind = Object.freeze({ writeFile: 'WriteFile', syncTree: 'SyncTree', patchConfig: 'PatchConfig' });
export const Severity = Object.freeze({ warning: 'Warning', blocking: 'Blocking' });
export const ArtifactDialectIds = Object.freeze({
  codexAgentToml: 'codex-agent-toml', claudeAgentMarkdown: 'claude-agent-md', copilotAgentMarkdown: 'copilot-agent-md',
  markdownPassthrough: 'markdown-passthrough', skillTree: 'skill-tree'
});
export const ConfigAdapterIds = Object.freeze({ mcpJson: 'mcp-json', mcpJsonCopilot: 'mcp-json-copilot', mcpToml: 'mcp-toml' });
export const HostLocatorIds = Object.freeze({
  projectRoot: 'project-root', userHome: 'user-home', codexConfigDirectory: 'codex-config-directory',
  claudeDesktopConfigDirectory: 'claude-desktop-config-directory', claudeCodeConfigDirectory: 'claude-code-config-directory'
});
export const HostRootBaseIds = Object.freeze({
  canonicalRoot: 'canonical-root', codexConfigRoot: 'codex-config-root', codexSkillsRoot: 'codex-skills-root',
  claudeCodeUserConfigFile: 'claude-code-user-config-file'
});

function route(projectTemplate, globalTemplate, mutationKind, { dialect = null, adapter = null, globalAdapter = null, globalRootBase = null } = {}) {
  return Object.freeze({
    projectTemplate, globalTemplate, mutationKind, artifactDialectId: dialect, configDocumentAdapterId: adapter,
    globalConfigDocumentAdapterId: globalAdapter, globalRootBaseId: globalRootBase,
    templateFor: (scope) => (scope === Scope.global ? globalTemplate : projectTemplate),
    rootBaseFor: (scope) => (scope === Scope.global ? globalRootBase ?? HostRootBaseIds.canonicalRoot : HostRootBaseIds.canonicalRoot),
    configAdapterFor: (scope) => (scope === Scope.global ? globalAdapter ?? adapter : adapter)
  });
}

function surface(surfaceId, scopes, projectLocatorId, globalLocatorId, routes, { multiRoot = false, unsupportedRouteSeverity = Severity.blocking } = {}) {
  return Object.freeze({
    surfaceId, scopes, projectLocatorId, globalLocatorId, routes, enableMultiRootLocatorEnumeration: multiRoot, unsupportedRouteSeverity,
    locatorFor: (scope) => (scope === Scope.global ? globalLocatorId : projectLocatorId)
  });
}

function profile(hostId, version, displayName, surfaces) {
  return Object.freeze({ hostId, version, displayName, surfaces, findSurface: (id) => surfaces.find(s => s.surfaceId === id) ?? null });
}

const W = MutationKind.writeFile, T = MutationKind.syncTree, P = MutationKind.patchConfig;
const both = [Scope.project, Scope.global];

const codex = profile(HostIds.codex, 'codex/2026.10.1', 'OpenAI Codex', [
  surface(SurfaceIds.codexCli, both, HostLocatorIds.projectRoot, HostLocatorIds.codexConfigDirectory, new Map([
    ['skill', route('{root}/.agents/skills/{id}', '{root}/skills/{id}', T, { dialect: ArtifactDialectIds.skillTree, globalRootBase: HostRootBaseIds.codexSkillsRoot })],
    ['agent', route('{root}/.codex/agents/{id}.toml', '{root}/agents/{id}.toml', W, { dialect: ArtifactDialectIds.codexAgentToml, globalRootBase: HostRootBaseIds.codexConfigRoot })],
    ['mcp', route('{root}/.codex/config.toml', '{root}/config.toml', P, { adapter: ConfigAdapterIds.mcpToml, globalRootBase: HostRootBaseIds.codexConfigRoot })],
    ['prompt', route('{root}/.codex/prompts/{id}.md', '{root}/prompts/{id}.md', W, { dialect: ArtifactDialectIds.markdownPassthrough, globalRootBase: HostRootBaseIds.codexConfigRoot })],
    ['command', route('{root}/.codex/prompts/{id}.md', '{root}/prompts/{id}.md', W, { dialect: ArtifactDialectIds.markdownPassthrough, globalRootBase: HostRootBaseIds.codexConfigRoot })]
  ]), { multiRoot: true })
]);

const claudeCode = profile(HostIds.claudeCode, 'claude-code/2026.08.3', 'Claude', [
  surface(SurfaceIds.claudeCodeCli, both, HostLocatorIds.projectRoot, HostLocatorIds.claudeCodeConfigDirectory, new Map([
    ['skill', route('{root}/.claude/skills/{id}', '{root}/skills/{id}', T, { dialect: ArtifactDialectIds.skillTree })],
    ['agent', route('{root}/.claude/agents/{id}.md', '{root}/agents/{id}.md', W, { dialect: ArtifactDialectIds.claudeAgentMarkdown })],
    ['mcp', route('{root}/.mcp.json', '{root}/.claude.json', P, { adapter: ConfigAdapterIds.mcpJson, globalRootBase: HostRootBaseIds.claudeCodeUserConfigFile })],
    ['prompt', route('{root}/.claude/commands/{id}.md', '{root}/commands/{id}.md', W, { dialect: ArtifactDialectIds.markdownPassthrough })],
    ['command', route('{root}/.claude/commands/{id}.md', '{root}/commands/{id}.md', W, { dialect: ArtifactDialectIds.markdownPassthrough })]
  ]), { multiRoot: true }),
  surface(SurfaceIds.claudeDesktop, [Scope.global], HostLocatorIds.projectRoot, HostLocatorIds.claudeDesktopConfigDirectory, new Map([
    ['mcp', route(null, '{root}/claude_desktop_config.json', P, { adapter: ConfigAdapterIds.mcpJson })]
  ]), { multiRoot: true, unsupportedRouteSeverity: Severity.warning })
]);

const gitHubCopilot = profile(HostIds.gitHubCopilot, 'github-copilot/2026.08.1', 'GitHub Copilot', [
  surface(SurfaceIds.copilotCli, both, HostLocatorIds.projectRoot, HostLocatorIds.userHome, new Map([
    ['skill', route('{root}/.github/skills/{id}', '{root}/.copilot/skills/{id}', T, { dialect: ArtifactDialectIds.skillTree })],
    ['agent', route('{root}/.github/agents/{id}.agent.md', '{root}/.copilot/agents/{id}.agent.md', W, { dialect: ArtifactDialectIds.copilotAgentMarkdown })],
    ['mcp', route('{root}/.mcp.json', '{root}/.copilot/mcp-config.json', P, { adapter: ConfigAdapterIds.mcpJson, globalAdapter: ConfigAdapterIds.mcpJsonCopilot })]
  ])),
  surface(SurfaceIds.vsCode, [Scope.project], HostLocatorIds.projectRoot, HostLocatorIds.userHome, new Map([
    ['prompt', route('{root}/.github/prompts/{id}.prompt.md', null, W, { dialect: ArtifactDialectIds.markdownPassthrough })],
    ['command', route('{root}/.github/prompts/{id}.prompt.md', null, W, { dialect: ArtifactDialectIds.markdownPassthrough })],
    ['mcp', route('{root}/.vscode/mcp.json', null, P, { adapter: ConfigAdapterIds.mcpJson })]
  ]))
]);

const all = [codex, claudeCode, gitHubCopilot];
const scopeOrder = [Scope.project, Scope.global];

function buildRows() {
  const rows = [];
  for (const p of all) for (const s of p.surfaces) for (const scope of scopeOrder) for (const [kind, r] of s.routes) {
    rows.push(Object.freeze({
      hostId: p.hostId, hostProfileVersion: p.version, surfaceId: s.surfaceId, scope, kind,
      destinationTemplate: s.scopes.includes(scope) ? r.templateFor(scope) : null, mutationKind: r.mutationKind,
      artifactDialectId: r.artifactDialectId, configDocumentAdapterId: r.configAdapterFor(scope),
      enableMultiRootLocatorEnumeration: s.enableMultiRootLocatorEnumeration, unsupportedRouteSeverity: s.unsupportedRouteSeverity,
      rootBaseId: r.rootBaseFor(scope)
    }));
  }
  // .NET OrderBy 是穩定排序；Array.prototype.sort 也是。
  return rows.sort((a, b) => ordinal(a.hostId, b.hostId) || ordinal(a.surfaceId, b.surfaceId) ||
    scopeOrder.indexOf(a.scope) - scopeOrder.indexOf(b.scope) || Kinds.indexOf(a.kind) - Kinds.indexOf(b.kind));
}

const rows = Object.freeze(buildRows());
const matrixDigest = ofText(rows.map(r => [r.hostId, r.hostProfileVersion, r.surfaceId, r.scope, r.kind, r.destinationTemplate ?? '-',
  r.mutationKind, r.artifactDialectId ?? '-', r.configDocumentAdapterId ?? '-', r.enableMultiRootLocatorEnumeration ? 'multi-root' : 'single-root',
  r.rootBaseId, r.unsupportedRouteSeverity].join('|') + '\n').join(''));

export const HostProfiles = Object.freeze({
  all, rows, matrixDigest,
  defaultSurfaces: Object.freeze({ [HostIds.codex]: SurfaceIds.codexCli, [HostIds.claudeCode]: SurfaceIds.claudeCodeCli, [HostIds.gitHubCopilot]: SurfaceIds.copilotCli }),
  find: (hostId) => all.find(p => p.hostId === hostId) ?? null,
  findRoute: (s, kind) => s.routes.get(kind) ?? null,
  defaultSelection(hostId) { return { hostId, surfaceId: this.defaultSurfaces[hostId] ?? hostId }; }
});

/** template 只能以 {root}/ 開頭、不含 ..，且除 {root}／{id} 外沒有其他 token。 */
export function isSafeTemplate(template) {
  if (!template.startsWith('{root}/') || template.includes('..')) return false;
  const remainder = template.slice('{root}'.length).replaceAll('{id}', 'id');
  return !remainder.includes('{') && !remainder.includes('}');
}
