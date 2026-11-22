// 市集網址的正規化與來源判斷。沒有預設網址（ADR 0001）：由使用者輸入。
import { ErrorCode, RcError } from './contract.mjs';

/**
 * 去頭尾空白與結尾斜線（對照 LC-AI-Pack LoginViewModel 存檔前的 Trim().TrimEnd('/')）。
 * 只接受 http / https 絕對網址，不接受帳密、查詢字串或片段。
 * @returns {string} 正規化後的市集根網址（保留子路徑）
 */
export function normalizeMarketUrl(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    throw new RcError(ErrorCode.invalidUrl, '網址格式不正確，請輸入完整的市集網址（例如 https://market.example.com）');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new RcError(ErrorCode.invalidUrl, '網址格式不正確：市集網址只支援 http 或 https');
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new RcError(ErrorCode.invalidUrl, '網址格式不正確：市集網址不可包含帳密、查詢字串或 #');
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** 市集根網址下的 API 位址（保留子路徑）。 */
export const apiUrl = (marketUrl, relative) => new URL(relative, `${marketUrl}/`).toString();

/** 是否與市集同源（scheme／host／port），對照 AuthenticatingHandler 的同源限制。 */
export function sameOrigin(url, marketUrl) {
  try {
    return new URL(url).origin === new URL(marketUrl).origin;
  } catch {
    return false;
  }
}
