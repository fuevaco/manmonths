// 登出：撤銷後端工作階段（對照 SessionRevoker）與「撤銷 → 停止續期 → 清本機」順序（對照 LogoutFlow）。
import { send } from './http.mjs';
import { apiUrl } from './market-url.mjs';

export const REVOKE_TIMEOUT_MS = 5 * 1000;

/**
 * 是否值得送出撤銷：access token 未過期（過期則後端必回 401）且有 refresh token（否則後端沒有可撤銷的工作階段）。
 */
export function shouldRevoke(session, nowMs) {
  if (!session?.token || !session?.refreshToken) return false;
  const exp = Date.parse(session.expiresAt ?? '');
  return Number.isFinite(exp) && exp > nowMs;
}

/**
 * 撤銷後端工作階段；永不擲例外、不記 log。marketUrl 須為登入當時的市集網址（換網址時是舊網址）。
 */
export function createRevoker({ transport = send, now = () => Date.now(), timeoutMs = REVOKE_TIMEOUT_MS } = {}) {
  return async function revoke(marketUrl, session) {
    try {
      if (!marketUrl || !shouldRevoke(session, now())) return;
      await transport({
        method: 'POST',
        url: apiUrl(marketUrl, 'api/auth/logout'),
        headers: { Authorization: `Bearer ${session.token}` },
        json: { refreshToken: session.refreshToken },
        timeoutMs
      });
    } catch {
      // 離線、逾時、非預期回應：忽略（後端工作階段由閒置期限自然失效）。
    }
  };
}

/**
 * 清除工作階段。notice 為空（手動登出、換市集網址）時才撤銷；工作階段被拒絕時伺服器端已失效，不撤銷。
 * 撤銷在停止續期之前啟動（已取得 token），不等待結果，任何失敗都不影響本機清除。
 * 先停止續期再清儲存，避免進行中的續期把工作階段寫回。
 */
export async function clearSession({ notice, current, marketUrl, revoke, stopSession, store }) {
  if (!notice && current && marketUrl) {
    try {
      Promise.resolve(revoke(marketUrl, current)).catch(() => {});
    } catch {
      // 撤銷盡力而為
    }
  }
  stopSession();
  await store.clear();
}
