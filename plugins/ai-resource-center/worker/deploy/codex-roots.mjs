// Codex 設定根偵測（對照 LcAiPack.Core Detection/CodexRootLocator、ClientRootRules、CodexRootLayout）。
// 唯讀：名稱只縮小候選範圍，設定檔（config.toml 或 auth.json）才是判準；不建立任何檔案或目錄。
import fs from 'node:fs';
import os from 'node:os';
import { createPathRules, isCaseInsensitive } from './canonical-root.mjs';
import { HostRootBaseIds } from './host-profiles.mjs';

export const CodexConfigDirEnvironmentVariable = 'CODEX_HOME';
export const PrimaryRootDirectoryName = '.codex';
export const ToolBackupMarker = '.bak-lcaipack-';
export const ClientRootOrigin = Object.freeze({ homeScan: 'HomeScan', configDirEnvironment: 'ConfigDirEnvironment', manualInclude: 'ManualInclude' });

/** 真實檔案系統的唯讀探針。 */
export const realProbe = Object.freeze({
  isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  listDirectories: (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory() || (e.isSymbolicLink() && realProbe.isDirectory(`${p}/${e.name}`))).map(e => e.name); } catch { return []; } }
});

/** 測試用記憶體探針（模擬其他平台的檔案系統）。 */
export function memoryProbe({ dirs = [], files = [] }) {
  const d = new Set(dirs), f = new Set(files);
  return {
    isDirectory: (p) => d.has(p), isFile: (p) => f.has(p),
    listDirectories: (p) => dirs.filter(x => x.startsWith(p + '/') && !x.slice(p.length + 1).includes('/')).map(x => x.slice(p.length + 1))
  };
}

export function isToolOwnedBackup(p, api) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const name = api.basename(p.trim().replace(/[\\/]+$/, ''));
  return name.toLowerCase().includes(ToolBackupMarker);
}

/**
 * @returns {{canonicalRoot:string, displayPath:string, isPrimary:boolean, origin:string}[]}
 */
export function locateCodexRoots({ userHome = os.homedir(), env = process.env, manualRoots = [], excludedRoots = [], platform = process.platform, probe = realProbe } = {}) {
  const rules = createPathRules({ platform });
  const api = rules.path;
  const roots = new Map();
  const add = (candidate, origin) => {
    if (typeof candidate !== 'string' || !candidate.trim() || isToolOwnedBackup(candidate, api)) return;
    if (!probe.isDirectory(candidate) || !(probe.isFile(api.join(candidate, 'config.toml')) || probe.isFile(api.join(candidate, 'auth.json')))) return;
    const displayPath = api.resolve(candidate);
    const canonicalRoot = rules.normalize(displayPath);
    const isPrimary = api.basename(canonicalRoot) === PrimaryRootDirectoryName;
    const existing = roots.get(canonicalRoot);
    if (!existing || existing.origin === ClientRootOrigin.homeScan) roots.set(canonicalRoot, { canonicalRoot, displayPath, isPrimary, origin });
  };
  if (probe.isDirectory(userHome)) {
    const fold = isCaseInsensitive(platform);
    for (const name of probe.listDirectories(userHome)) {
      if ((fold ? name.toLowerCase() : name).startsWith('.codex')) add(api.join(userHome, name), ClientRootOrigin.homeScan);
    }
  }
  add(env?.[CodexConfigDirEnvironmentVariable], ClientRootOrigin.configDirEnvironment);
  for (const root of manualRoots) add(root, ClientRootOrigin.manualInclude);
  for (const root of excludedRoots) if (typeof root === 'string' && root.trim()) roots.delete(rules.normalize(root));
  return [...roots.values()].sort((a, b) => (b.isPrimary - a.isPrimary) || (a.displayPath < b.displayPath ? -1 : a.displayPath > b.displayPath ? 1 : 0));
}

/** 舊 Codex 家目錄收據的落點：根即家目錄時，技能在 .agents、其餘在 .codex；新設定根直接承載。 */
export function resolveCodexBase(root, userHome, rootBaseId, rules) {
  if (rootBaseId !== HostRootBaseIds.codexConfigRoot && rootBaseId !== HostRootBaseIds.codexSkillsRoot) return root;
  return rules.normalize(root) === rules.normalize(userHome)
    ? rules.path.join(root, rootBaseId === HostRootBaseIds.codexSkillsRoot ? '.agents' : '.codex')
    : root;
}
