// 本機路徑解析。平台、環境變數與家目錄都可注入，讓 Windows 與 macOS 的規則都能在任一平台以自動測試驗證。
import os from 'node:os';
import path from 'node:path';

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * 共用資料目錄：LCAIPACK_HOME 有值時使用，否則為 {家目錄}/.lcaipack。
 * 資源中心與其他用戶端共用這裡的設定參數與部署收據（ADR 0001），但登入工作階段不放這裡。
 */
export function resolveLcAiPackHome({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const custom = env.LCAIPACK_HOME;
  if (typeof custom === 'string' && custom.length > 0) return custom;
  return pathFor(platform).join(homedir, '.lcaipack');
}
