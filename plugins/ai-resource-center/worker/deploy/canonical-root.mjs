// 正規化根目錄與路徑（對照 LcAiPack.Core CanonicalRootResolver）。
// - 完整路徑化 → 只解析「最深一層已存在節點本身」的連結（含 Windows junction）→ 去除結尾分隔符；
// - Windows 與 macOS 視為大小寫不敏感，統一轉小寫。
// 平台可注入，讓 macOS 規則能在 Windows 上以自動測試驗證；注入非本機平台時不碰檔案系統。
import fs from 'node:fs';
import path from 'node:path';

export const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
export const isCaseInsensitive = (platform) => platform === 'win32' || platform === 'darwin';

function trimEndingSeparator(p, api) {
  const root = api.parse(p).root;
  return p.length > root.length && /[\\/]$/.test(p) ? p.slice(0, -1) : p;
}

function finalTarget(p, api) {
  let current = p;
  for (let i = 0; i < 40; i++) {
    let stat;
    try { stat = fs.lstatSync(current); } catch { return current; }
    if (!stat.isSymbolicLink()) return current;
    current = api.resolve(api.dirname(current), fs.readlinkSync(current));
  }
  return current;
}

function resolveLinks(full, api) {
  try {
    let current = full;
    while (current.length > 0) {
      let stat = null;
      try { stat = fs.statSync(current); } catch { stat = null; }
      if (stat?.isDirectory()) {
        const resolved = finalTarget(current, api);
        return current === full ? resolved : api.join(resolved, api.relative(current, full));
      }
      if (stat?.isFile()) {
        // 父層是檔案代表路徑本身無效；保留宣告形式，交給套用階段以真正的 IO 失敗處理。
        if (current !== full) return full;
        return finalTarget(current, api);
      }
      const parent = api.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch { /* 無法解析時回傳原始完整路徑；套用前的觀測比對仍會擋下不一致 */ }
  return full;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.platform]  預設 process.platform
 * @param {boolean} [opts.resolveLinks]  預設只在本機平台解析連結
 */
export function createPathRules({ platform = process.platform, resolveLinks: links } = {}) {
  const api = pathFor(platform);
  const useLinks = links ?? platform === process.platform;
  const fold = isCaseInsensitive(platform);
  function normalize(p) {
    if (typeof p !== 'string' || !p.trim()) return '';
    let full = api.resolve(p);
    if (useLinks) full = resolveLinks(full, api);
    full = trimEndingSeparator(full, api);
    return fold ? full.toLowerCase() : full;
  }
  function isWithin(root, candidate) {
    const r = normalize(root), c = normalize(candidate);
    if (!r) return false;
    if (r === c) return true;
    return c.startsWith(r.endsWith(api.sep) ? r : r + api.sep);
  }
  return { platform, path: api, sep: api.sep, normalize, isWithin, caseInsensitive: fold };
}
