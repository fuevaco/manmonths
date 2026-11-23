// 登入工作階段續期（對照 SessionManager）。
//
// - single-flight：並行呼叫共用同一個 HTTP 請求與結果。
// - 分類：200 且內容完整 → refreshed；401 auth.account-unavailable → rejected(account_unavailable)；
//   其他 401、400、422 → rejected(session_expired)；404 → unsupported；其餘 → transient。
// - 「可能已送達」的暫時性失敗（逾時、5xx、2xx 內容不完整、連線中斷）在同一次續期內以同一個 refresh token
//   等 2 秒後重送一次；「確定未送出」（DNS、拒絕連線、TLS）與 408／429／403 等直接退避。
// - 排程：成功後 24 小時；暫時性失敗依 1、5、15、60 分鐘退避（之後固定 60 分鐘）；每次最多等 1 分鐘再檢查，
//   睡眠或時鐘跳躍後很快補上；時鐘被調回時最晚 24 小時。
// - 補續：非補續觸發的暫時性失敗會「上膛」，之後任一 API 請求成功時補續一次。
// - stop：終態；取消進行中的請求與等待，之後不送請求、不發事件、不存檔。
// - 機密：refresh token 只在記憶體與儲存處；結果、事件、例外都不含 token。

import { logAuthDiagnostic } from './auth.mjs';
import { ErrorCode } from './contract.mjs';
import { HttpError, parseJson, send } from './http.mjs';
import { apiUrl } from './market-url.mjs';
import { hasRefreshToken } from './session-store.mjs';

export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_INTERVAL_MS = 60 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1000;
export const IMMEDIATE_RETRY_DELAY_MS = 2 * 1000;
export const TRANSIENT_BACKOFF_MS = Object.freeze([1, 5, 15, 60].map((m) => m * 60 * 1000));

const ACCOUNT_UNAVAILABLE_CODE = 'auth.account-unavailable';

export const Outcome = Object.freeze({
  refreshed: 'refreshed',
  transient: 'transient',
  rejected: 'rejected',
  unsupported: 'unsupported'
});

export const RejectionReason = Object.freeze({
  sessionExpired: ErrorCode.sessionExpired,
  accountUnavailable: ErrorCode.accountUnavailable
});

const R = {
  refreshed: Object.freeze({ outcome: Outcome.refreshed }),
  transient: Object.freeze({ outcome: Outcome.transient }),
  unsupported: Object.freeze({ outcome: Outcome.unsupported }),
  rejected: (reason) => Object.freeze({ outcome: Outcome.rejected, reason })
};

const stoppedError = () => Object.assign(new Error('工作階段已停止'), { code: 'stopped' });

export const realDelay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stoppedError());
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(stoppedError()); }, { once: true });
  });

function initialDueAt(lastRefreshedAt, now) {
  const last = Date.parse(lastRefreshedAt ?? '');
  if (!Number.isFinite(last)) return now;
  const due = last + REFRESH_INTERVAL_MS;
  if (due < now) return now;
  return Math.min(due, now + REFRESH_INTERVAL_MS);
}

function parseRenewed(text) {
  const body = parseJson(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const s = (k) => (typeof body[k] === 'string' && body[k] ? body[k] : null);
  const d = (k) => {
    const t = Date.parse(s(k) ?? '');
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  const token = s('token');
  const refreshToken = s('refreshToken');
  const expiresAt = d('expiresAt');
  const refreshExpiresAt = d('refreshExpiresAt');
  if (!token || !refreshToken || !expiresAt || !refreshExpiresAt) return null;
  return { token, refreshToken, expiresAt, refreshExpiresAt };
}

function classify(status, text) {
  if (status === 200) {
    const renewed = parseRenewed(text);
    return renewed ? { result: R.refreshed, renewed } : { result: R.transient, possiblyDelivered: true };
  }
  if (status === 401) {
    const code = parseJson(text)?.code;
    return { result: R.rejected(code === ACCOUNT_UNAVAILABLE_CODE ? RejectionReason.accountUnavailable : RejectionReason.sessionExpired) };
  }
  if (status === 400 || status === 422) return { result: R.rejected(RejectionReason.sessionExpired) };
  if (status === 404) return { result: R.unsupported };
  if (status >= 500 || (status >= 200 && status < 300)) return { result: R.transient, possiblyDelivered: true };
  return { result: R.transient, possiblyDelivered: false }; // 408、429、403、其他
}

/**
 * @param {object} opts
 * @param {object} opts.session        目前工作階段（含 marketUrl）
 * @param {{save: (s: object) => Promise<void>}} opts.store
 * @param {Function} [opts.transport]  http.send 相容的傳輸函式
 * @param {() => number} [opts.now]
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [opts.delay]
 * @param {number} [opts.requestTimeoutMs]
 */
export function createSessionManager({ session, store, transport = send, now = () => Date.now(), delay = realDelay, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, log = () => {} }) {
  const refreshUrl = apiUrl(session.marketUrl, 'api/auth/refresh');
  const lifetime = new AbortController();
  const listeners = { refreshed: new Set(), rejected: new Set() };

  let current = session;
  let state = hasRefreshToken(session) ? 'healthy' : 'unsupported';
  let terminal = state === 'unsupported' ? R.unsupported : null;
  let nextRefreshAt = terminal ? null : initialDueAt(session.lastRefreshedAt, now());
  let inflight = null;
  let consecutiveFailures = 0;
  let notifyArmed = false;
  let started = false;
  let stopped = false;
  let resolveScheduler;
  const schedulerDone = new Promise((r) => { resolveScheduler = r; });

  function emit(kind, args) {
    if (lifetime.signal.aborted) return;
    for (const fn of listeners[kind]) {
      try { fn(args); } catch { /* 訂閱者錯誤不得破壞續期狀態機 */ }
    }
  }

  async function sendOnce(refreshToken) {
    try {
      const res = await transport({ method: 'POST', url: refreshUrl, json: { refreshToken }, timeoutMs: requestTimeoutMs, signal: lifetime.signal });
      if (lifetime.signal.aborted) throw stoppedError();
      if (res.status !== 200) logAuthDiagnostic(log, 'refresh', res, [refreshToken, current.token]);
      return classify(res.status, res.text);
    } catch (e) {
      if (lifetime.signal.aborted) throw stoppedError();
      logAuthDiagnostic(log, 'refresh', e, [refreshToken, current.token]);
      if (e instanceof HttpError && e.notSent) return { result: R.transient, possiblyDelivered: false };
      return { result: R.transient, possiblyDelivered: true }; // 逾時、連線中斷、其他非預期錯誤
    }
  }

  async function runFlight(refreshToken, trigger) {
    let attempt;
    try {
      attempt = await sendOnce(refreshToken);
      if (attempt.result === R.transient && attempt.possiblyDelivered) {
        // 伺服器可能已輪替：以同一個 token 在寬限期內重送一次。
        await delay(IMMEDIATE_RETRY_DELAY_MS, lifetime.signal);
        if (lifetime.signal.aborted) throw stoppedError();
        attempt = await sendOnce(refreshToken);
      }
    } catch (e) {
      if (lifetime.signal.aborted) {
        inflight = null;
        throw stoppedError();
      }
      attempt = { result: R.transient }; // 只可能來自注入的等待失敗
    }

    inflight = null;
    if (stopped) throw stoppedError();

    const t = now();
    const { result } = attempt;
    if (result === R.refreshed) {
      const renewed = { ...current, ...attempt.renewed, account: current.account, marketUrl: current.marketUrl, lastRefreshedAt: new Date(t).toISOString() };
      try { await store.save(renewed); } catch { /* 存檔失敗：記憶體仍更新，下次成功續期再存 */ }
      if (stopped) throw stoppedError();
      current = renewed;
      state = 'healthy';
      consecutiveFailures = 0;
      notifyArmed = false;
      nextRefreshAt = t + REFRESH_INTERVAL_MS;
      emit('refreshed', { account: renewed.account, expiresAt: renewed.expiresAt });
    } else if (result === R.transient) {
      consecutiveFailures += 1;
      state = 'transient_failure';
      nextRefreshAt = t + TRANSIENT_BACKOFF_MS[Math.min(consecutiveFailures, TRANSIENT_BACKOFF_MS.length) - 1];
      notifyArmed = trigger !== 'notify';
    } else if (result.outcome === Outcome.rejected) {
      state = 'rejected';
      terminal = result;
      nextRefreshAt = null;
      emit('rejected', { reason: result.reason });
    } else {
      state = 'unsupported';
      terminal = result;
      nextRefreshAt = null;
    }
    return result;
  }

  function startFlight(trigger) {
    const flight = runFlight(current.refreshToken, trigger);
    flight.catch(() => {}); // 補續觸發時沒有等待者
    inflight = flight;
    return flight;
  }

  function startOrJoin(trigger) {
    if (stopped) return Promise.reject(stoppedError());
    if (terminal) return Promise.resolve(terminal);
    return inflight ?? startFlight(trigger);
  }

  async function runScheduler() {
    try {
      while (!lifetime.signal.aborted) {
        const t = now();
        if (nextRefreshAt === null) return;
        if (nextRefreshAt > t + REFRESH_INTERVAL_MS) nextRefreshAt = t + REFRESH_INTERVAL_MS; // 時鐘被調回
        if (t >= nextRefreshAt) {
          await startOrJoin('scheduled');
          continue;
        }
        await delay(Math.min(CHECK_INTERVAL_MS, nextRefreshAt - t), lifetime.signal);
      }
    } catch {
      // 停止或非預期錯誤：結束迴圈
    } finally {
      resolveScheduler();
    }
  }

  return {
    get current() { return current; },
    get currentAccessToken() { return current.token; },
    get account() { return current.account; },
    get state() { return state; },
    get canRefresh() { return state === 'healthy' || state === 'transient_failure'; },
    get nextRefreshAt() { return nextRefreshAt; },
    get isRefreshing() { return inflight !== null; },
    schedulerDone,

    onRefreshed(fn) { listeners.refreshed.add(fn); return () => listeners.refreshed.delete(fn); },
    onRejected(fn) { listeners.rejected.add(fn); return () => listeners.rejected.delete(fn); },

    /** 續期（single-flight）。停止後呼叫會失敗（code: stopped）。 */
    refresh: () => startOrJoin('manual'),

    /** 任一 API 請求成功的通知：暫時性失敗且已上膛時補續一次，不阻塞呼叫者。 */
    notifyRequestSucceeded() {
      if (stopped || inflight || state !== 'transient_failure' || !notifyArmed) return;
      notifyArmed = false;
      startFlight('notify');
    },

    start() {
      if (stopped) throw stoppedError();
      if (started) return;
      started = true;
      if (terminal) return resolveScheduler();
      runScheduler();
    },

    stop() {
      if (stopped) return;
      stopped = true;
      state = 'stopped';
      nextRefreshAt = null;
      lifetime.abort();
      if (!started || terminal) resolveScheduler();
    }
  };
}
