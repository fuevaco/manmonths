// 只讀取市集及全域收據；這個服務不持有任何部署／套用 API。
import { readCatalogPages } from './catalog-pages.mjs';
import { compareVersions, recommendedVersion } from './package-service.mjs';

const storageKey = 'resource-center.update-notifications';
const empty = () => ({ count: 0, packages: [], checkedAt: null });
export function createUpdateService({ orca, session, installed, packages, preferences, now = Date.now,
  scheduler = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) } }) {
  let summary = empty(), flight = null, timer = null, disposed = false, generation = 0, scheduleRevision = 0;
  let scheduledIdentity = null, scheduledMinutes = null, firstCheckPending = false;
  let retryTimer = null, retryAttempt = 0;
  const safeCode = error => ['STORAGE_NOT_READY', 'SESSION_NOT_READY', 'API_NOT_READY', 'EACCES', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'signed_out', 'session_expired', 'market_unreachable'].includes(error?.code) ? error.code : 'unexpected_error';
  const log = () => orca.log('[updates] 無法檢查資源包更新');
  function cancelRetry() { if (retryTimer !== null) scheduler.clearTimeout(retryTimer); retryTimer = null; }
  function cancelTimer() { if (timer !== null) scheduler.clearTimeout(timer); timer = null; }
  function stop() {
    generation++; scheduleRevision++; cancelTimer(); cancelRetry(); retryAttempt = 0; scheduledIdentity = null; scheduledMinutes = null; firstCheckPending = false; summary = empty();
  }
  function arm(minutes) {
    cancelTimer();
    if (disposed || !minutes || !scheduledIdentity) return;
    const revision = scheduleRevision;
    timer = scheduler.setTimeout(async () => {
      if (disposed || revision !== scheduleRevision) return;
      timer = null;
      try { await checkNow(); } catch { log(); }
      if (!disposed && revision === scheduleRevision) await reschedule();
    }, firstCheckPending ? 30000 : minutes * 60000);
    timer?.unref?.();
  }
  async function reschedule() {
    const revision = ++scheduleRevision;
    cancelRetry();
    let phase = '工作階段讀取';
    try {
      const identity = await session.identity();
      phase = '偏好設定讀取';
      const saved = await preferences.get();
      if (disposed || revision !== scheduleRevision) return;
      const key = identity ? JSON.stringify(identity) : null;
      if (key !== scheduledIdentity) { generation++; summary = empty(); }
      // 排程剛啟用時先檢查一次；計時器建立失敗則保留首次檢查，交由既有重試恢復。
      if (!key || !saved.checkIntervalMinutes) firstCheckPending = false;
      else if (key !== scheduledIdentity || !scheduledMinutes) firstCheckPending = true;
      else if (saved.checkIntervalMinutes !== scheduledMinutes) firstCheckPending = false;
      scheduledIdentity = key; scheduledMinutes = saved.checkIntervalMinutes;
      phase = '計時器建立';
      arm(saved.checkIntervalMinutes);
      retryAttempt = 0;
    } catch (error) {
      if (disposed || revision !== scheduleRevision) return;
      cancelTimer();
      const delay = Math.min(1000 * 2 ** Math.min(retryAttempt++, 6), 60000);
      orca.log(`[updates] 無法排程更新檢查 code=${safeCode(error)} reason=${phase}暫時失敗；${delay / 1000} 秒後重試`);
      retryTimer = scheduler.setTimeout(async () => {
        if (disposed || revision !== scheduleRevision) return;
        retryTimer = null;
        await reschedule();
      }, delay);
      retryTimer?.unref?.();
    }
  }
  async function run() {
    firstCheckPending = false;
    await reschedule();
    const identity = await session.identity();
    if (!identity || disposed) { summary = empty(); return summary; }
    const epoch = generation;
    const stillCurrent = async () => !disposed && epoch === generation && JSON.stringify(await session.identity()) === JSON.stringify(identity);
    const saved = await preferences.get();
    const client = await session.requireClient();
    const records = installed.receipts({ globalOnly: true });
    const query = new URLSearchParams({ pageSize: '50' });
    if (saved.showPreview) query.set('channel', 'preview');
    const found = new Map();
    const rows = await readCatalogPages({ query, request: path => packages.request(client, path), fields: ['packageKey', 'name'],
      invalidMessage: '市集目錄格式錯誤，無法檢查更新', overflowMessage: '市集目錄過大，無法完成更新檢查' });
      for (const p of rows) {
        if (found.has(p.packageKey)) continue;
        const latest = recommendedVersion([{ version: p.latestReleaseVersion, channel: 'release' }, { version: p.latestPreviewVersion, channel: 'preview' }], saved.showPreview);
        const state = installed.project(p.packageKey, latest, records);
        if (state.installationStatus !== 'updateAvailable') continue;
        const older = state.deployments.filter(d => d.updateVersion).map(d => d.version).sort(compareVersions);
        found.set(p.packageKey, { packageKey: p.packageKey, name: p.name, installedVersion: older[0], updateVersion: latest });
      }
    if (!await stillCurrent()) return summary;
    const items = [...found.values()];
    summary = { count: items.length, packages: items, checkedAt: new Date(Number(now())).toISOString() };
    const owner = JSON.stringify(identity);
    let stored;
    try { stored = await orca.storage.get(storageKey); }
    catch { orca.log('[updates] 無法讀取更新通知紀錄'); return summary; }
    const notified = new Set(stored?.owner === owner && Array.isArray(stored.pairs) ? stored.pairs : []);
    const pair = p => JSON.stringify([p.packageKey, p.updateVersion]);
    const fresh = items.filter(p => !notified.has(pair(p)));
    if (!await stillCurrent()) return summary;
    if (fresh.length) {
      try {
        await orca.host.call('notifications.show', { title: '資源中心', body: fresh.length === 1
          ? `${fresh[0].name} 有新版本 ${fresh[0].updateVersion} 可更新` : `有 ${fresh.length} 個資源包可更新` });
        for (const p of fresh) notified.add(pair(p));
      } catch { orca.log('[updates] 無法顯示資源包更新通知'); }
    }
    if (await stillCurrent() && (stored || items.length)) {
      try { await orca.storage.set(storageKey, { owner, pairs: items.map(pair).filter(p => notified.has(p)) }); }
      catch { orca.log('[updates] 無法儲存更新通知紀錄'); }
    }
    return summary;
  }
  function checkNow() {
    if (!flight) { flight = run().finally(() => { flight = null; }); }
    return flight;
  }
  const unsubscribe = preferences.onChange(() => { void reschedule(); });
  // 摘要是快取，但收據可能被解除安裝或另一個用戶端改變；讀取時重核本機狀態。
  function currentSummary() {
    const { records, error } = installed.tryReceipts({ globalOnly: true });
    if (error) return structuredClone(summary);
    const packages = summary.packages.filter(p => installed.project(p.packageKey, p.updateVersion, records).installationStatus === 'updateAvailable');
    return structuredClone({ ...summary, count: packages.length, packages });
  }
  return { checkNow, summary: currentSummary, reschedule,
    refreshInstalledState() { generation++; summary = currentSummary(); },
    stop, dispose() { disposed = true; stop(); unsubscribe(); } };
}
