// Claude Code 設定根偵測（對照 Detection/ClaudeCodeRootLocator、ClientRootRules）。
// 候選第一層須有 settings.json 或 .claude.json；有根即可視為已安裝，不查 PATH。
import os from 'node:os';
import { createPathRules, isCaseInsensitive } from './canonical-root.mjs';
import { realProbe, isToolOwnedBackup, ClientRootOrigin } from './codex-roots.mjs';

export const ClaudeCodeConfigDirEnvironmentVariable = 'CLAUDE_CONFIG_DIR';
export const PrimaryRootDirectoryName = '.claude';

/** 預設 profile 的 .claude.json 在家目錄；環境指定與其他 profile 在設定目錄內。 */
export function resolveClaudeUserConfigDirectory(canonicalRoot, userHome, cameFromConfigDirEnvironment, rules = createPathRules()) {
  if (!cameFromConfigDirEnvironment && userHome?.trim() && rules.normalize(canonicalRoot) === rules.normalize(rules.path.join(userHome, '.claude'))) return rules.normalize(userHome);
  return rules.normalize(canonicalRoot);
}

/**
 * @returns {{canonicalRoot:string, displayPath:string, isPrimary:boolean, origin:string}[]}
 */
export function locateClaudeCodeRoots({ userHome = os.homedir(), env = process.env, manualRoots = [], excludedRoots = [], platform = process.platform, probe = realProbe } = {}) {
  const rules = createPathRules({ platform });
  const api = rules.path;
  const fold = isCaseInsensitive(platform);
  const roots = new Map();
  const add = (candidate, origin) => {
    if (typeof candidate !== 'string' || !candidate.trim() || isToolOwnedBackup(candidate, api)) return;
    if (!probe.isDirectory(candidate) || !(probe.isFile(api.join(candidate, 'settings.json')) || probe.isFile(api.join(candidate, '.claude.json')))) return;
    const displayPath = api.resolve(candidate);
    const canonicalRoot = rules.normalize(displayPath);
    const name = api.basename(displayPath);
    const isPrimary = (fold ? name.toLowerCase() : name) === PrimaryRootDirectoryName;
    const existing = roots.get(canonicalRoot);
    if (!existing || (!existing.isPrimary && isPrimary)) {
      roots.set(canonicalRoot, { canonicalRoot, displayPath, isPrimary, origin });
    } else if (existing.origin === ClientRootOrigin.homeScan && origin !== ClientRootOrigin.homeScan) {
      roots.set(canonicalRoot, { ...existing, origin });
    }
  };
  if (probe.isDirectory(userHome)) {
    for (const name of probe.listDirectories(userHome)) {
      if ((fold ? name.toLowerCase() : name).startsWith('.claude')) add(api.join(userHome, name), ClientRootOrigin.homeScan);
    }
  }
  add(env?.[ClaudeCodeConfigDirEnvironmentVariable], ClientRootOrigin.configDirEnvironment);
  for (const root of manualRoots) add(root, ClientRootOrigin.manualInclude);
  for (const root of excludedRoots) if (typeof root === 'string' && root.trim()) roots.delete(rules.normalize(root));
  return [...roots.values()].sort((a, b) => (b.isPrimary - a.isPrimary) || (a.displayPath < b.displayPath ? -1 : a.displayPath > b.displayPath ? 1 : 0));
}

