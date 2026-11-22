// 設定命令的固定 runner 與本機環境（對照 LcAiPack.Core Setup/SetupRunnerRegistry.cs、SetupPlanEnvironment）。
// runner 是白名單而非查表執行：runner 只能是 powershell（Windows）或 bash（macOS），對應的可執行檔由平台決定，
// 資源包無法影響；永遠以 argv 陣列啟動，不接受完整 shell command string；第一版不支援提權。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SetupRunners = Object.freeze({ powershell: 'powershell', bash: 'bash', all: ['powershell', 'bash'] });
export const SetupCommandLimits = Object.freeze({ defaultTimeoutMinutes: 30, minTimeoutMinutes: 1, maxTimeoutMinutes: 120, defaultRunOnUpdate: false });

const POWERSHELL_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
const BASH_ARGS = Object.freeze(['--noprofile', '--norc']);

/**
 * @param {object} [options]
 * @param {string[]} [options.probeDirectories]  PATH 探測目錄（測試注入）；預設為環境變數 PATH
 * @param {(p: string) => boolean} [options.exists]  檔案存在檢查（測試注入）
 * @param {object} [options.env]
 * @returns {{resolve(runner: string, operatingSystem: string): ({runner, executable, leadingArguments}|null)}}
 */
export function createRunnerRegistry({ probeDirectories, exists, env = process.env } = {}) {
  const fileExists = exists ?? (p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const directories = () => probeDirectories ?? (env.PATH ?? env.Path ?? '').split(path.delimiter);
  function findOnPath(fileName) {
    for (const directory of directories()) {
      if (!directory?.trim()) continue;
      let candidate;
      try { candidate = path.join(directory.trim().replace(/^"|"$/g, ''), fileName); } catch { continue; }
      if (fileExists(candidate)) return candidate;
    }
    return null;
  }
  function resolvePowerShell() {
    // PowerShell 7 優先；找不到才退回 Windows 內建的 Windows PowerShell 5.1。
    for (const candidate of ['pwsh.exe', 'powershell.exe']) {
      const found = findOnPath(candidate);
      if (found) return { runner: SetupRunners.powershell, executable: found, leadingArguments: [...POWERSHELL_ARGS] };
    }
    const system = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
    const builtin = path.win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fileExists(builtin) ? { runner: SetupRunners.powershell, executable: builtin, leadingArguments: [...POWERSHELL_ARGS] } : null;
  }
  function resolveBash() {
    for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
      if (fileExists(candidate)) return { runner: SetupRunners.bash, executable: candidate, leadingArguments: [...BASH_ARGS] };
    }
    const found = findOnPath('bash');
    return found ? { runner: SetupRunners.bash, executable: found, leadingArguments: [...BASH_ARGS] } : null;
  }
  return {
    resolve(runner, operatingSystem) {
      const windows = String(operatingSystem).toLowerCase() === 'windows';
      if (runner === SetupRunners.powershell && windows) return resolvePowerShell();
      if (runner === SetupRunners.bash && !windows) return resolveBash();
      return null;
    }
  };
}

/** 偵測本機環境；GUI 與外掛都以本機判斷為準，市集不參與。未知架構回傳原始名稱，讓計畫能如實揭露不相容。 */
export function detectSetupEnvironment({ platform = process.platform, arch = os.arch() } = {}) {
  return { operatingSystem: platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'windows', architecture: arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : String(arch).toLowerCase() };
}
