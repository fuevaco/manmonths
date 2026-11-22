import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** 所有平台使用外掛自帶的 Node 腳本，不探測其他產品的執行檔。 */
export function findMcpLauncher({ env = process.env, platform = process.platform,
  userHome = os.homedir(), install = installMcpLauncher,
  hasNode = () => spawnSync('node', ['--version'], { env, encoding: 'utf8', timeout: 2000, windowsHide: true }).status === 0
} = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) return null;
  if (!hasNode()) {
    const error = new Error('需要 Node.js 才能啟動此 MCP');
    error.code = 'mcp_launcher_unavailable';
    throw error;
  }
  return install({ userHome, env, platform });
}

/** 固定安裝位置；平台、home、env 可注入供測試使用。 */
export function mcpLauncherPath({ userHome = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const base = platform === 'win32' ? (env.LOCALAPPDATA || paths.join(userHome, 'AppData', 'Local'))
    : platform === 'darwin' ? paths.join(userHome, 'Library', 'Application Support') : paths.join(userHome, '.local', 'share');
  return paths.resolve(base, 'orca-ai-resource-center', 'bin', 'lcaipack-mcp-launch.mjs');
}

/**
 * 已安裝過 launcher 時更新成外掛目前的版本；沒有安裝過就不建立。
 * 已部署的 MCP 設定都指向這個固定路徑，外掛更新後不必重新安裝資源包就能用到 launcher 的修正。
 */
export function refreshMcpLauncher(options = {}) {
  try { statSync(mcpLauncherPath(options)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return installMcpLauncher(options);
}

/** launcher 為獨立單檔；同內容不重寫，更新用同目錄 rename 原子替換。 */
export function installMcpLauncher(options = {}) {
  const target = mcpLauncherPath(options);
  const source = readFileSync(new URL('./mcp-launcher/lcaipack-mcp-launch.mjs', import.meta.url), 'utf8');
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    if (readFileSync(target, 'utf8') === source) { return target; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, source, { encoding: 'utf8', mode: 0o755, flag: 'wx' });
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
  return target;
}
