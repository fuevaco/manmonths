// 登入工作階段的儲存（對照 SessionStore）。
//
// 差異（ADR 0001）：存在外掛自己的秘密儲存（orca.secrets），不寫共用資料目錄的 gui-session.json；
// 並記錄登入當時的市集網址，只有目前設定的市集網址相同時才續用。

export const SESSION_SECRET_KEY = 'session.v1';
const FIVE_MINUTES = 5 * 60 * 1000;

const time = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
};

export const hasRefreshToken = (s) => typeof s?.refreshToken === 'string' && s.refreshToken.length > 0;

/**
 * 載入規則（SessionStore.Load）：
 * - refresh token 仍有效：即使 access token 已過期也回傳，由續期處理。
 * - 無 refresh token 或 refresh 已過期：access token 須在 5 分鐘後才到期。
 */
export function isLoadable(session, nowMs) {
  if (!session || typeof session.token !== 'string' || !session.token) return false;
  const refreshExp = time(session.refreshExpiresAt);
  if (hasRefreshToken(session) && refreshExp !== null && refreshExp > nowMs) return true;
  const exp = time(session.expiresAt);
  return exp !== null && exp > nowMs + FIVE_MINUTES;
}

/**
 * @param {object} opts
 * @param {{get: Function, set: Function, delete: Function}} opts.secrets  orca.secrets
 * @param {() => number} opts.now
 */
export function createSessionStore({ secrets, now }) {
  async function readRaw() {
    const raw = await secrets.get(SESSION_SECRET_KEY);
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const s = JSON.parse(raw);
      return s && typeof s === 'object' ? s : null;
    } catch {
      return null;
    }
  }

  return {
    /** 不論綁定哪個市集，回傳儲存中的工作階段（供換網址時撤銷舊工作階段）。 */
    readRaw,

    /** 只回傳綁定 marketUrl、且仍可用的工作階段。 */
    async load(marketUrl) {
      const s = await readRaw();
      if (!s || !marketUrl || s.marketUrl !== marketUrl) return null;
      return isLoadable(s, now()) ? s : null;
    },

    async save(session) {
      const { marketUrl, account, token, expiresAt, refreshToken, refreshExpiresAt, lastRefreshedAt } = session;
      await secrets.set(
        SESSION_SECRET_KEY,
        JSON.stringify({ marketUrl, account, token, expiresAt, refreshToken, refreshExpiresAt, lastRefreshedAt })
      );
    },

    async clear() {
      await secrets.delete(SESSION_SECRET_KEY);
    }
  };
}
