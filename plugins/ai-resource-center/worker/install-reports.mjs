// 安裝回報（對照 Registry/InstallReportBuilder、InstallReportOutbox 與 GUI RegistryService.ReportInstallAsync）。
//
// 成功安裝或更新至少一個部署目標後，向市集回報 `POST api/market/packages/{key}/versions/{version}/installs`，供市集統計安裝數。
// 回報是安裝後的附帶作業：builder、enqueue、flush 的任何失敗都留在這個邊界內，不能把已成功的安裝變成失敗。
//
// 差異（工項 12）：原實作把待送回報存成 {home}/install-reports/{gui|cli}/{operationId}.json；
// 資源中心存在外掛自己的儲存（orca.storage 的 `install-reports.v1`），與桌面工具各自儲存、互不讀寫。
// 回報內容只有資源包、版本、動作、成功的 host／surface、範圍、通道與用戶端版本；不含任何路徑、秘密、登入憑證或本機帳戶，
// 儲存的項目另記市集登入帳號，只用來確保回報只用同一個帳號補送（不會送給市集）。

import { compareVersions } from './package-service.mjs';
import { targetKeyOf } from './deploy/receipts.mjs';

export const INSTALL_REPORTS_KEY = 'install-reports.v1';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LOG_LIMIT = 50;
const BODY_FIELDS = ['operationId', 'action', 'fromVersion', 'platforms', 'scope', 'channel', 'clientProduct', 'clientVersion', 'installedAt'];

const platformKey = (p) => `${p.hostId}\u0000${p.surfaceId}`;
const distinctPlatforms = (platforms) => [...new Map(platforms.map(p => [platformKey(p), { hostId: p.hostId, surfaceId: p.surfaceId }])).values()];

/**
 * 從已審核的部署計畫與實際套用結果建立待送回報；本機來源、沒有市集通道或沒有成功部署的目標時回傳 null。
 * 只有 Succeeded 的目標計入；失敗、已還原、受阻（Skipped）都不是安裝成功。
 */
export function buildInstallReport({ plan, applied, packageKey, version, action, fromVersion, channel, clientProduct, clientVersion, account, marketUrl, installedAt, operationId }) {
  if (plan?.intent?.localSourcePath != null || !channel || !applied?.targets) return null;
  const platforms = distinctPlatforms(applied.targets.filter(t => t.status === 'Succeeded').map(t => t.host));
  if (!platforms.length) return null;
  const at = new Date(installedAt).toISOString();
  return { packageKey, version, operationId, action, fromVersion: fromVersion ?? null, platforms, scope: plan.intent.scope, channel, clientProduct, clientVersion,
    installedAt: at, account: account ?? null, ...(marketUrl ? { marketUrl } : {}), createdAt: at };
}

const isFileNameOperationId = (id) => typeof id === 'string' && id.trim() !== '' && id.length <= 64 && id !== '.' && id !== '..' && !/[<>:"/\\|?*\u0000-\u001f]/.test(id);

/**
 * @param {object} options
 * @param {{get(key: string): Promise<any>, set(key: string, value: any): Promise<void>}} options.storage  orca.storage
 * @param {() => Promise<{request(req: object): Promise<{status: number}>}>} options.getClient  取得帶登入工作階段的市集用戶端；未登入時擲例外
 * @param {() => number} [options.now]
 * @param {string} [options.product]  gui（Orca 以桌面用戶端身分回報；市集只接受 gui 或 cli）
 */
export function createInstallReportOutbox({ storage, getClient, now = () => Date.now(), product = 'gui' }) {
  // 對儲存的讀改寫必須序列化，否則同時 enqueue 會互相覆蓋。送出網路請求不在序列內，避免慢連線拖住安裝結果。
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  let flushing = null;

  async function read() {
    const doc = await storage.get(INSTALL_REPORTS_KEY);
    return doc && typeof doc === 'object' && doc.entries && typeof doc.entries === 'object' ? doc : { entries: {} };
  }
  const write = (doc) => storage.set(INSTALL_REPORTS_KEY, doc);

  function appendLog(doc, operationId, reason) {
    // 不記錄例外訊息或伺服器內容；operationId 也設限且移除控制字元。
    const safeId = [...String(operationId).slice(0, 64)].map(c => /[\u0000-\u001f\u007f]/.test(c) ? ' ' : c).join('');
    doc.log = [...(doc.log ?? []), `${new Date(now()).toISOString()} ${safeId} ${reason}`].slice(-LOG_LIMIT);
  }

  /** 原子儲存回報；同 operationId 只聯集合併平台，保留最初的帳號與時間。 */
  function enqueue(report) {
    return serial(async () => {
      try {
        if (report?.clientProduct !== product || !isFileNameOperationId(report.operationId) || !Array.isArray(report.platforms)) return;
        const doc = await read();
        const existing = doc.entries[report.operationId];
        if (existing !== undefined && (!existing || typeof existing !== 'object' || !Array.isArray(existing.platforms))) return; // 壞項目保留，不當成新項目覆寫
        doc.entries[report.operationId] = existing
          ? { ...existing, platforms: distinctPlatforms([...existing.platforms, ...report.platforms]) }
          : { ...report, platforms: distinctPlatforms(report.platforms) };
        await write(doc);
      } catch { /* 儲存或序列化錯誤都不得破壞呼叫端的安裝結果 */ }
    });
  }

  /** 送出一筆；回傳 'sent'（刪除）、'discard'（永久錯誤，刪除並記錄）或 'keep'。 */
  async function deliver(entry, currentAccount) {
    if (now() - Date.parse(entry.createdAt) > RETENTION_MS) return { outcome: 'discard', reason: 'expired after 30 days' };
    if (product === 'gui' && (currentAccount == null || entry.account !== currentAccount)) return { outcome: 'keep' };
    let client;
    try { client = await getClient(); } catch { return { outcome: 'keep' }; } // 尚未登入或缺少市集設定：保留
    // 回報只送給計畫來源的市集；目前連線的是另一個市集（即使帳號名相同）時保留，等回到原市集。
    // 沒有記錄市集網址的舊項目沿用先前行為（以帳號判斷）。
    if (entry.marketUrl && client.marketUrl !== entry.marketUrl) return { outcome: 'keep' };
    let response;
    try {
      response = await client.request({ method: 'POST', path: `api/market/packages/${encodeURIComponent(entry.packageKey)}/versions/${encodeURIComponent(entry.version)}/installs`,
        json: Object.fromEntries(BODY_FIELDS.map(k => [k, entry[k] ?? null])) });
    } catch { return { outcome: 'keep' }; } // 網路、逾時與傳輸例外：保留待重試
    const status = response?.status;
    if (status >= 200 && status < 300) return { outcome: 'sent' };
    // 401 代表憑證暫時失效：保留回報，待重新登入或續期成功後補送；其他 4xx 是永久錯誤，不重送。
    if (status >= 400 && status <= 499 && status !== 401) return { outcome: 'discard', reason: `discarded after HTTP ${status}` };
    return { outcome: 'keep' };
  }

  async function flushOnce(currentAccount) {
    let doc;
    try { doc = await serial(read); } catch { return; }
    for (const operationId of Object.keys(doc.entries).sort()) {
      const sentEntry = doc.entries[operationId];
      try {
        if (!sentEntry || typeof sentEntry !== 'object') continue;
        const { outcome, reason } = await deliver(sentEntry, currentAccount);
        if (outcome === 'keep') continue;
        await serial(async () => {
          const latest = await read();
          const current = latest.entries[operationId];
          if (!current) return;
          // 送出期間新增的平台不能被這次刪除帶走：保留項目，下次連線連同新增的平台重送（市集依 operationId 合併）。
          if (outcome === 'sent' && JSON.stringify(current.platforms) !== JSON.stringify(sentEntry.platforms)) return;
          delete latest.entries[operationId];
          if (outcome === 'discard') appendLog(latest, operationId, reason);
          await write(latest);
        });
      } catch { /* 儲存錯誤保留尚未處理的項目，繼續其他筆 */ }
    }
  }

  /** 逐筆送出；成功或永久 4xx 才刪除，逾期項目不需連線即淘汰。永遠不拋出；同時只有一個 flush 在進行。 */
  function flush(currentAccount) {
    flushing ??= flushOnce(currentAccount).catch(() => {}).finally(() => { flushing = null; });
    return flushing;
  }

  return { enqueue, flush };
}

/**
 * 回報的動作與來源版本（對照 CliInstallReports.ResolveInstallAction，D7）：Apply 前本次部署目標上已有同一資源的其他市集版本收據時為 update，
 * fromVersion 取其中最高版本；否則為 install。收據必須是 Apply 前的快照（Apply 之後同一目標只剩新版本）。
 */
export function resolveInstallAction(receiptsBeforeApply, plan) {
  const targetKeys = new Set(plan.targets.map(t => t.targetKey));
  let fromVersion = null;
  for (const r of receiptsBeforeApply) {
    if (r.source === 'local' || r.packageKey !== plan.package.key || r.packageVersion === plan.package.version || !targetKeys.has(targetKeyOf(r))) continue;
    if (fromVersion === null || compareVersions(r.packageVersion, fromVersion) > 0) fromVersion = r.packageVersion;
  }
  return fromVersion === null ? { action: 'install', fromVersion: null } : { action: 'update', fromVersion };
}

/**
 * 外掛使用的回報入口：持久儲存（outbox）後以最佳努力補送；永遠不拋出，也不等待網路。
 * @param {object} options
 * @param {{get: Function, set: Function}} options.storage  orca.storage
 * @param {{requireClient(): Promise<object>, currentAccount(): Promise<string|null>}} options.session
 * @param {string} options.clientVersion  外掛版本
 */
export function createInstallReporting({ storage, session, clientVersion, now = () => Date.now() }) {
  const outbox = createInstallReportOutbox({ storage, getClient: () => session.requireClient(), now });
  async function flush() {
    try { await outbox.flush(await session.currentAccount()); } catch { /* 附帶作業 */ }
  }
  /** 安裝或更新至少一個目標成功後呼叫；沒有成功目標時不產生回報。 */
  async function report({ origin = null, plan, applied, packageKey, version, action, fromVersion, channel, operationId }) {
    try {
      // origin 是計畫產生當時的市集與帳號；沒有時（單獨使用）退回目前工作階段的帳號。
      const built = buildInstallReport({ plan, applied, packageKey, version, action, fromVersion, channel, clientProduct: 'gui', clientVersion,
        account: origin ? origin.account : await session.currentAccount(), marketUrl: origin?.marketUrl, installedAt: now(), operationId });
      if (!built) return;
      await outbox.enqueue(built);
      void flush(); // 只等持久儲存；網路送出是最佳努力，不延遲也不改變已成功的安裝
    } catch { /* 回報失敗絕不影響安裝結果 */ }
  }
  return { report, flush };
}
