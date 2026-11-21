// 帳密登入（對照 LC-AI-Pack GUI AuthService）：POST {market}/api/auth/login，client 固定為 "gui"。
import { ErrorCode, RcError } from './contract.mjs';
import { HttpError, parseJson } from './http.mjs';
import { apiUrl } from './market-url.mjs';

const isoUtc = (v) => {
  const t = Date.parse(typeof v === 'string' ? v : '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** 伺服器錯誤內容的說明：detail 優先、其次 title（AuthService 的規則）。不讀其他欄位，避免帶出 token。 */
export function problemText(text, fallback) {
  const body = parseJson(text);
  if (body && typeof body === 'object') {
    if (typeof body.detail === 'string' && body.detail) return body.detail;
    if (typeof body.title === 'string' && body.title) return body.title;
  }
  return fallback;
}

/** 傳輸層失敗 → 使用者可辨識的「無法連線」。 */
export function unreachableError(err, marketUrl) {
  const origin = new URL(marketUrl).origin;
  if (err instanceof HttpError && err.tls) {
    return new RcError(ErrorCode.unreachable, `無法與 ${origin} 建立安全連線（憑證不受信任或 TLS 錯誤），請確認網址後重試`);
  }
  if (err instanceof HttpError && err.kind === 'timeout') {
    return new RcError(ErrorCode.unreachable, `連線 ${origin} 逾時，請確認網路或網址後重試`);
  }
  return new RcError(ErrorCode.unreachable, `無法連線到 ${origin}，請確認網址與網路後重試`);
}

/** 非 2xx 回應 → 依狀態碼分類的錯誤。 */
export function statusError(status, text, fallback) {
  const message = status === 403
    ? `沒有權限：${problemText(text, '權限不足')}（HTTP 403）`
    : `${problemText(text, fallback)}（HTTP ${status}）`;
  if (status === 401) return new RcError(ErrorCode.invalidCredentials, message);
  if (status === 403) return new RcError(ErrorCode.forbidden, message);
  if (status === 404 || status === 405) {
    return new RcError(ErrorCode.invalidUrl, `這個網址找不到市集服務，請確認網址是否正確（HTTP ${status}）`);
  }
  if (status === 422 || status === 400) return new RcError(ErrorCode.invalidParams, message);
  if (status >= 500) return new RcError(ErrorCode.serviceUnavailable, message);
  return new RcError(ErrorCode.marketError, message);
}

/**
 * @returns {Promise<object>} 新的工作階段（尚未儲存）
 */
export async function login({ marketUrl, username, password, transport, now, timeoutMs }) {
  let res;
  try {
    res = await transport({
      method: 'POST',
      url: apiUrl(marketUrl, 'api/auth/login'),
      json: { username, password, client: 'gui' },
      timeoutMs
    });
  } catch (e) {
    throw unreachableError(e, marketUrl);
  }

  if (res.status < 200 || res.status >= 300) throw statusError(res.status, res.text, '登入失敗');

  const body = parseJson(res.text);
  const token = typeof body?.token === 'string' ? body.token : '';
  const expiresAt = isoUtc(body?.expiresAt);
  if (!token || !expiresAt) {
    throw new RcError(ErrorCode.invalidUrl, '這個網址沒有回應市集的登入資料，請確認網址是否正確');
  }

  const session = { marketUrl, account: username, token, expiresAt };
  // 舊伺服器（相容模式）不回 refresh 欄位；有才填入。
  if (typeof body.refreshToken === 'string' && body.refreshToken) {
    session.refreshToken = body.refreshToken;
    const refreshExpiresAt = isoUtc(body.refreshExpiresAt);
    if (refreshExpiresAt) session.refreshExpiresAt = refreshExpiresAt;
    session.lastRefreshedAt = new Date(now()).toISOString();
  }
  return session;
}
