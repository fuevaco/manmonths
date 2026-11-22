// 面板 ↔ trusted worker 的請求契約。
//
// - 方法名稱：`rc.<領域>.<動作>`，例如 rc.session.signIn。後續工項新增 rc.catalog.*、rc.install.* 時，
//   各自在 worker/handlers/ 下新增一個模組並在 index.mjs 註冊，共用這裡的錯誤格式與輸入驗證。
// - 輸入：面板送來的 JSON（可能是 undefined）；每個欄位都要檢查型別。
// - 成功：回傳可 JSON 序列化的物件，絕不包含憑證或秘密值。
// - 失敗：擲出 RcError。面板拿到的是 Error，帶有 `code`（穩定、供程式判斷）與 `message`（繁體中文、給使用者看）。
//   非預期錯誤一律轉成 code `internal`，只留通用訊息，避免把底層例外（可能含路徑或回應內容）原樣傳給面板。

export const ErrorCode = Object.freeze({
  invalidParams: 'invalid_params',
  /** 網址格式錯誤，或該網址不是市集（找不到登入服務） */
  invalidUrl: 'invalid_url',
  /** 無法連線：DNS、拒絕連線、逾時、憑證錯誤 */
  unreachable: 'unreachable',
  /** 伺服器暫時無法服務（5xx） */
  serviceUnavailable: 'service_unavailable',
  /** 帳號或密碼錯誤 */
  invalidCredentials: 'invalid_credentials',
  /** 已登入但沒有市集讀取權限 */
  forbidden: 'forbidden',
  /** 尚未登入 */
  signedOut: 'signed_out',
  /** 工作階段失效（續期被拒、相容模式 401），需重新登入 */
  sessionExpired: 'session_expired',
  /** 帳號停用／鎖定／不存在 */
  accountUnavailable: 'account_unavailable',
  /** 暫時無法向伺服器驗證，將自動重試（不登出） */
  sessionUnavailable: 'session_unavailable',
  /** 其他市集錯誤回應 */
  marketError: 'market_error',
  /** 市集並行操作衝突，面板應重新讀取清單 */
  conflict: 'conflict',
  versionUnavailable: 'version_unavailable',
  checksumMismatch: 'checksum_mismatch',
  guideUnavailable: 'guide_unavailable',
  guideIndexMissing: 'guide_index_missing',
  guideTooLarge: 'guide_too_large',
  invalidPackage: 'invalid_package',
  unsafePath: 'unsafe_path',
  saveFailed: 'save_failed',
  /** 部署計畫已失效（本機狀態改變、未審核或目標集合不符），需重新規劃並確認 */
  planStale: 'plan_stale',
  /** LC-AI-Pack 共用的部署收據檔無法讀取 */
  receiptInvalid: 'receipt_invalid',
  /** LC-AI-Pack 共用的設定值檔（setup.json）無法讀取 */
  setupInvalid: 'setup_invalid',
  sharedDataTooNew: 'sharedDataTooNew',
  /** 作業系統安全儲存區無法存取秘密；不會改用明文 */
  secretStoreFailed: 'secret_store_failed',
  /** 開發中版本的來源資料夾已不存在，無法重新打包（重新安裝、補裝） */
  sourceMissing: 'source_missing',
  internal: 'internal'
});

export class RcError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'RcError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const badParams = (message) => new RcError(ErrorCode.invalidParams, message);
export const sharedDataError = () => new RcError(ErrorCode.sharedDataTooNew, '共用資料由較新的 LC-AI-Pack 寫入，請更新 Orca 外掛');

/** 取字串欄位；不是字串時回傳空字串。 */
export const str = (input, key) => (typeof input?.[key] === 'string' ? input[key] : '');

/**
 * 包裝 orca.panels.handle：統一錯誤格式並記錄（只記方法與錯誤代碼，不記輸入與訊息內容以外的資料）。
 * @param {object} orca
 */
export function createRouter(orca) {
  const methods = new Set();
  return {
    methods,
    handle(method, fn) {
      if (methods.has(method)) throw new Error(`重複註冊 ${method}`);
      methods.add(method);
      orca.panels.handle(method, async (input = {}, ctx) => {
        try {
          return await fn(input ?? {}, ctx);
        } catch (e) {
          if (e?.unsupportedFormatVersion) {
            orca.log(`[${method}] sharedDataTooNew ${e.message}`);
            throw sharedDataError();
          }
          if (e instanceof RcError) {
            orca.log(`[${method}] ${e.code}`);
            throw e;
          }
          orca.log(`[${method}] internal ${e?.name || 'Error'}`);
          throw new RcError(ErrorCode.internal, '發生非預期的錯誤，請稍後再試');
        }
      });
    }
  };
}
