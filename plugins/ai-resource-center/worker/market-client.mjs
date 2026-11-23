// 帶登入工作階段的市集請求（對照 AuthenticatingHandler）。後續工項的目錄、詳情、下載都經過這裡。
//
// - 只有與市集同源（scheme／host／port）的請求才帶 token 並走 401 流程；其他請求原樣送出。
// - 每次送出前即時讀取目前 access token。
// - 第一次回應為 401：若 token 已被其他請求換新，直接以新 token 重送；否則續期（single-flight）：
//   refreshed → 以新 token 重送一次（仍 401 也直接回傳）；transient → 擲 session_unavailable；
//   rejected → 回原 401（拒絕事件由 SessionManager 發出）；unsupported → 回原 401 並通知一次「無法續期」；
//   SessionManager 已停止（登出中）→ 回原 401，不通知、不重送。
// - 最終回應為 2xx 時通知 SessionManager（補續）。

import { ErrorCode, RcError } from './contract.mjs';
import { send } from './http.mjs';
import { apiUrl, sameOrigin } from './market-url.mjs';
import { Outcome, RejectionReason } from './session-manager.mjs';

export const SESSION_TEMPORARILY_UNAVAILABLE = '暫時無法向伺服器驗證，將自動重試';

export function createMarketClient({ manager, marketUrl, transport = send, timeoutMs = 20000, onUnauthorizedWithoutRefresh }) {
  let unauthorizedRaised = false;

  function raiseUnauthorizedWithoutRefresh() {
    if (unauthorizedRaised) return;
    unauthorizedRaised = true;
    try { onUnauthorizedWithoutRefresh?.({ reason: RejectionReason.sessionExpired }); } catch { /* 不影響回傳的 401 */ }
  }

  function completed(res) {
    if (res.status >= 200 && res.status < 300) {
      try { manager.notifyRequestSucceeded(); } catch { /* best effort */ }
    }
    return res;
  }

  const withToken = (req, token) => ({ ...req, headers: { ...(req.headers || {}), Authorization: `Bearer ${token}` } });

  /**
   * @param {object} req  { method, path（相對於市集根網址）或 url, json?, body?: Buffer, headers?, timeoutMs?, signal? }
   * @returns {Promise<{status, headers, text}>}  傳輸失敗時擲 HttpError
   */
  async function request(req) {
    const url = req.url ?? apiUrl(marketUrl, req.path);
    const base = { method: req.method ?? 'GET', url, json: req.json, ...(req.body !== undefined ? { body: req.body } : {}), headers: req.headers, timeoutMs: req.timeoutMs ?? timeoutMs, signal: req.signal,
      ...(req.maxBytes !== undefined ? { maxBytes: req.maxBytes } : {}), ...(req.responseType ? { responseType: req.responseType } : {}) };
    if (!sameOrigin(url, marketUrl)) {
      const { Authorization, ...headers } = base.headers || {};
      return transport({ ...base, headers });
    }

    const sentToken = manager.currentAccessToken;
    const res = await transport(withToken(base, sentToken));
    if (res.status !== 401) return completed(res);

    if (manager.currentAccessToken === sentToken) {
      let result;
      try {
        result = await manager.refresh();
      } catch {
        return res; // SessionManager 已停止（登出中）
      }
      if (result.outcome === Outcome.transient) throw new RcError(ErrorCode.sessionUnavailable, SESSION_TEMPORARILY_UNAVAILABLE);
      if (result.outcome === Outcome.unsupported) {
        raiseUnauthorizedWithoutRefresh();
        return res;
      }
      if (result.outcome !== Outcome.refreshed) return res;
    }

    return completed(await transport(withToken(base, manager.currentAccessToken)));
  }

  return { marketUrl, request };
}
