// Claude Desktop 偵測：macOS 只看固定設定檔；Windows 由套件、log 與目錄裁決。
import os from 'node:os';
import fs from 'node:fs';
import { createPathRules } from './canonical-root.mjs';
import { realProbe } from './codex-roots.mjs';

export const DesktopConfigFileName = 'claude_desktop_config.json';
const missing = source => ({ isDetected: false, configDirectory: null, configFilePath: null, source, disclosures: [], canonicalConfigDirectory: null });

/** FileSystemClaudeDesktopEnvironmentProvider；任何無權讀取的步驟皆退化，不建立路徑。 */
export function captureDesktopEnvironment({ appDataDirectory, localAppDataDirectory, windowsAppsDirectory = null, platform = process.platform, fsApi = fs }) {
  const api = createPathRules({ platform }).path;
  const dirs = root => { try { return fsApi.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; } };
  const creation = p => { try { return fsApi.statSync(p).birthtime; } catch { return null; } };
  const packagesRoot = api.join(localAppDataDirectory, 'Packages');
  const pfn = dirs(packagesRoot).find(n => n.startsWith('Claude_'));
  if (!pfn) return { package: null, appDataDirectory, localAppDataDirectory, selfReportLogLines: [] };
  const separator = pfn.indexOf('_'), prefix = pfn.slice(0, separator) + '_', suffix = '__' + pfn.slice(separator + 1);
  const version = windowsAppsDirectory && dirs(windowsAppsDirectory).filter(n => n.startsWith(prefix) && n.endsWith(suffix)).at(-1);
  const authoritative = version ? creation(api.join(windowsAppsDirectory, version)) : null;
  const installedAtLocal = authoritative ?? creation(api.join(packagesRoot, pfn)) ?? new Date('9999-12-31T23:59:59');
  const verdicts = [];
  for (const root of [api.join(appDataDirectory, 'Claude', 'logs'), api.join(packagesRoot, pfn, 'LocalCache', 'Roaming', 'Claude', 'logs')]) {
    let names; try { names = fsApi.readdirSync(root); } catch { continue; }
    for (const name of names.filter(n => /^main.*\.log$/.test(n))) {
      try { verdicts.push(...fsApi.readFileSync(api.join(root, name), 'utf8').split(/\r?\n/).map(parseDesktopVerdict).filter(Boolean)); } catch { /* inaccessible log skipped */ }
    }
  }
  return { package: { packageFamilyName: pfn, installedAtLocal, installedAtIsAuthoritative: authoritative !== null }, appDataDirectory, localAppDataDirectory,
    selfReportLogLines: verdicts.sort((a, b) => a.timestampLocal - b.timestampLocal).map(v => v.rawLine) };
}
export function parseDesktopVerdict(line) {
  if (typeof line !== 'string' || !line.includes('[MSIX]') || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(line)) return null;
  const timestampLocal = new Date(line.slice(0, 19).replace(' ', 'T'));
  if (!Number.isFinite(timestampLocal.getTime())) return null;
  const parts = line.slice(0, 19).match(/\d+/g).map(Number);
  if (parts[0] < 1 || [timestampLocal.getFullYear(), timestampLocal.getMonth() + 1, timestampLocal.getDate(), timestampLocal.getHours(), timestampLocal.getMinutes(), timestampLocal.getSeconds()].some((v, i) => v !== parts[i])) return null;
  const dash = line.indexOf('—'); if (dash < 0) return null;
  const tail = line.slice(dash + 1), keyword = /\b(absent|present)\b/i.exec(tail);
  if (!keyword || !tail.slice(0, keyword.index).trim()) return null;
  return { timestampLocal, virtualizedPath: tail.slice(0, keyword.index).trim(), virtualizedPathPresent: keyword[1].toLowerCase() === 'present', rawLine: line };
}

export function locateClaudeDesktop({ platform = process.platform, userHome, homedir = os.homedir, env = process.env, probe = realProbe, environment } = {}) {
  userHome = userHome?.trim() ? userHome : homedir();
  const rules = createPathRules({ platform });
  if (platform !== 'darwin') {
    environment ??= captureDesktopEnvironment({ appDataDirectory: env.APPDATA ?? rules.path.join(userHome, 'AppData', 'Roaming'),
      localAppDataDirectory: env.LOCALAPPDATA ?? rules.path.join(userHome, 'AppData', 'Local'),
      windowsAppsDirectory: env.ProgramFiles ? rules.path.join(env.ProgramFiles, 'WindowsApps') : null, platform });
    if (!environment?.package) return missing('PackageMissing');
    const appData = rules.path.join(environment.appDataDirectory, 'Claude');
    const candidate = rules.path.join(environment.localAppDataDirectory, 'Packages', environment.package.packageFamilyName, 'LocalCache', 'Roaming', 'Claude');
    const probeDirectory = () => { try { return probe.isDirectory(candidate) ? candidate : appData; } catch { return appData; } };
    const verdicts = environment.selfReportLogLines.map(parseDesktopVerdict).filter(Boolean);
    const credible = verdicts.filter(v => v.timestampLocal > new Date(environment.package.installedAtLocal));
    const last = credible.at(-1), source = last ? 'SelfReportLog' : 'DirectoryProbe', disclosures = [];
    let configDirectory = last ? last.virtualizedPathPresent ? last.virtualizedPath : appData : probeDirectory();
    if (credible.length < verdicts.length) disclosures.push(`有 ${verdicts.length - credible.length} 筆用戶端自述 log 判定行已視為過期並忽略。`);
    if (last && environment.package.installedAtIsAuthoritative === false) disclosures.push('本次採信了用戶端自述 log，但無法取得權威套件安裝時間，使用替代時間；可能有較舊的判定行未被判為過期。');
    if (configDirectory.split(/[\\/]/).some(s => s.toLowerCase() === 'claude-3p')) {
      disclosures.push(`已拒絕採用包含 Claude-3p 的位置「${configDirectory}」，改用「${appData}」。`); configDirectory = appData;
    }
    if (last && configDirectory !== probeDirectory()) disclosures.push(`用戶端自述 log 顯示「${configDirectory}」，與目錄推導「${probeDirectory()}」不一致；本次採信 log 判定行結論。`);
    return { isDetected: true, configDirectory, configFilePath: rules.path.join(configDirectory, DesktopConfigFileName), source, disclosures, canonicalConfigDirectory: rules.normalize(configDirectory) };
  }
  const configDirectory = rules.path.join(userHome, 'Library', 'Application Support', 'Claude');
  const configFilePath = rules.path.join(configDirectory, DesktopConfigFileName);
  let exists = false;
  try { exists = probe.isFile(configFilePath); } catch { /* inaccessible means undetected */ }
  return exists ? { isDetected: true, configDirectory, configFilePath, source: 'ConfigFileProbe', disclosures: [], canonicalConfigDirectory: rules.normalize(configDirectory) } : missing('ConfigFileProbe');
}
