// 登入工作階段的應用層流程（對照 App 的登入／登出接線、LoginViewModel 與 SessionRejectionGate）。
//
// - 首次使用時市集網址為空（ADR 0001）；登入成功後才儲存網址。
// - 工作階段存在外掛秘密儲存並綁定市集網址；設定中的網址改變時不沿用，並以舊網址撤銷舊工作階段。
// - 工作階段失效（續期被拒、相容模式 401）只處理一次：清除工作階段並在登入畫面顯示原因；不撤銷。
// - 手動登出：撤銷（不等待）→ 停止續期 → 清除儲存。不碰其他用戶端的登入狀態。
// - 登入成功即保留工作階段，不做權限探測（與既有行為一致）；沒有權限（403）等到實際的市集請求失敗時才顯示，不登出。
// - 後續工項透過 requireClient() 取得帶工作階段的市集用戶端。

import { badParams, ErrorCode, RcError } from './contract.mjs';
import { send } from './http.mjs';
import { login, logAuthDiagnostic } from './auth.mjs';
import { normalizeMarketUrl } from './market-url.mjs';
import { createSessionStore } from './session-store.mjs';
import { createSessionManager, realDelay, RejectionReason } from './session-manager.mjs';
import { createMarketClient } from './market-client.mjs';
import { clearSession, createRevoker } from './logout.mjs';

export const SESSION_EXPIRED_NOTICE = '登入已過期，請重新登入';
export const ACCOUNT_UNAVAILABLE_NOTICE = '帳號目前無法使用，請聯絡管理員';

export const noticeFor = (reason) =>
  reason === RejectionReason.accountUnavailable ? ACCOUNT_UNAVAILABLE_NOTICE : SESSION_EXPIRED_NOTICE;

export function createSessionService({
  orca,
  now = () => Date.now(),
  delay = realDelay,
  transport = send,
  requestTimeoutMs = 10000,
  onConnected = null,
  onSessionEnded = null
}) {
  const store = createSessionStore({ secrets: orca.secrets, now });
  const revoke = createRevoker({ transport, now });

  /** 目前啟用中的工作階段；null 表示未登入。 */
  let active = null; // { manager, client, marketUrl }
  /** 目前「武裝」中的 manager：工作階段失效只處理一次（SessionRejectionGate）。 */
  let armed = null;
  /** 回到登入畫面的原因提示；登入時清除。 */
  let notice = null;
  let loaded = false;
  /** 序列化會改變工作階段的操作，避免並行請求互相覆蓋。 */
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  /** 成功連線後通知（補送安裝回報）；回報是附帶作業，任何錯誤都不得影響登入流程。 */
  function notifyConnected() {
    try { Promise.resolve(onConnected?.()).catch(() => {}); } catch { /* 附帶作業 */ }
  }

  async function configuredUrl() {
    return String((await orca.settings.get('marketUrl')) ?? '').trim();
  }

  /** 工作階段結束（登出、失效、換市集）：通知持有「以該工作階段產生之資料」的一方丟棄，例如等待確認的部署計畫。 */
  function stopActive() {
    const ended = active !== null;
    armed = null;
    active?.manager.stop();
    active = null;
    if (ended) { try { onSessionEnded?.(); } catch { /* 附帶作業 */ } }
  }

  async function onSessionInvalid(source, reason) {
    if (armed !== source) return; // 舊工作階段或已處理過
    armed = null;
    const current = active;
    notice = noticeFor(reason);
    await clearSession({ notice, current: current?.manager.current, marketUrl: current?.marketUrl, revoke, stopSession: stopActive, store });
    orca.log(`工作階段失效：${reason}`);
  }

  function activate(session) {
    stopActive();
    const manager = createSessionManager({ session, store, transport, now, delay, requestTimeoutMs, log: message => orca.log(message) });
    const client = createMarketClient({
      manager,
      marketUrl: session.marketUrl,
      transport: async request => {
        let response;
        const secrets = [manager.current.token, manager.current.refreshToken];
        try { response = await transport(request); }
        catch (error) { logAuthDiagnostic(message => orca.log(message), 'request', error, secrets); throw error; }
        if (response.status < 200 || response.status >= 300) logAuthDiagnostic(message => orca.log(message), 'request', response, secrets);
        return response;
      },
      onUnauthorizedWithoutRefresh: ({ reason }) => { onSessionInvalid(manager, reason); }
    });
    manager.onRejected(({ reason }) => { onSessionInvalid(manager, reason); });
    active = { manager, client, marketUrl: session.marketUrl };
    armed = manager;
    manager.start();
  }

  /** 啟動後第一次：載入綁定目前網址的工作階段；網址已改變時撤銷並清除舊的。 */
  async function ensureLoaded() {
    if (loaded) return;
    const url = await configuredUrl();
    const raw = await store.readRaw();
    if (raw && raw.marketUrl !== url) {
      await clearSession({ notice: null, current: raw, marketUrl: raw.marketUrl, revoke, stopSession: stopActive, store });
      orca.log('市集網址已變更，已清除原市集的工作階段');
      loaded = true;
      return;
    }
    const session = await store.load(url);
    if (session) activate(session);
    else if (raw) await store.clear(); // 已過期：清掉
    // 只有主機設定與秘密儲存都讀取成功才完成載入；啟動暫時失敗可由排程重試。
    loaded = true;
  }

  function view(marketUrl, extra = {}) {
    if (active) return { marketUrl, signedIn: true, account: active.manager.account, ...extra };
    return { marketUrl, signedIn: false, ...(notice ? { notice } : {}) };
  }

  return {
    async getState({ secretsProtection } = {}) {
      return serial(async () => {
        if (secretsProtection === 'unavailable') return view(await configuredUrl());
        await ensureLoaded();
        const url = await configuredUrl();
        if (!active) return view(url);
        // 不做權限探測（對照既有行為）：工作階段是否有效、帳號有無權限，等實際的市集請求才知道。
        // 補送待送的安裝回報（附帶作業，不影響狀態回應）。
        notifyConnected();
        return view(url);
      });
    },

    async signIn({ marketUrl: rawUrl, username, password }) {
      if (!rawUrl.trim() || !username.trim() || !password) throw badParams('請填寫市集網址、帳號與密碼');
      const url = normalizeMarketUrl(rawUrl);
      return serial(async () => {
        await ensureLoaded();
        notice = null;
        const account = username.trim();
        const session = await login({ marketUrl: url, username: account, password, transport, now, timeoutMs: requestTimeoutMs, log: message => orca.log(message) });

        // 原本的工作階段（可能是另一個市集）先登出。
        if (active) {
          const prev = active;
          await clearSession({ notice: null, current: prev.manager.current, marketUrl: prev.marketUrl, revoke, stopSession: stopActive, store });
        }
        await store.save(session);
        await orca.settings.set('marketUrl', url);
        activate(session);
        orca.log('已登入市集');
        notifyConnected();
        return view(url);
      });
    },

    async signOut() {
      return serial(async () => {
        await ensureLoaded();
        const current = active ?? null;
        const raw = current ? null : await store.readRaw();
        await clearSession({
          notice: null,
          current: current?.manager.current ?? raw,
          marketUrl: current?.marketUrl ?? raw?.marketUrl,
          revoke,
          stopSession: stopActive,
          store
        });
        notice = null;
        orca.log('已登出市集');
        return view(await configuredUrl());
      });
    },

    /** 已續期但最終仍收到 401：只清除發出該請求的工作階段。 */
    async rejectClient(client) {
      if (active?.client === client) await onSessionInvalid(armed, RejectionReason.sessionExpired);
      throw new RcError(ErrorCode.sessionExpired, notice || SESSION_EXPIRED_NOTICE);
    },

    /** 供後續工項使用：取得帶工作階段的市集用戶端；未登入時擲 signed_out。 */
    async requireClient() {
      await serial(ensureLoaded);
      if (!active) {
        if (notice) throw new RcError(ErrorCode.sessionExpired, notice);
        throw new RcError(ErrorCode.signedOut, '請先登入市集');
      }
      return active.client;
    },

    /**
     * 目前工作階段的來源（市集網址與帳號）；未登入或設定中的網址與工作階段綁定的網址不一致時為 null。
     * 部署計畫記下產生它時的來源，套用前以此核對。
     */
    async identity() {
      await serial(ensureLoaded);
      if (!active || (await configuredUrl()) !== active.marketUrl) return null;
      return { marketUrl: active.marketUrl, account: active.manager.account };
    },

    /** 目前登入的市集帳號（未登入為 null）。 */
    async currentAccount() {
      await serial(ensureLoaded);
      return active?.manager.account ?? null;
    },

    dispose() {
      stopActive();
    }
  };
}
