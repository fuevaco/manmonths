// 已安裝資源以部署收據為準；讀取與版本提示沒有寫入副作用。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createPathRules } from './deploy/canonical-root.mjs';
import { resolveLcAiPackHome } from './paths.mjs';
import { ReceiptStore, ReceiptFileError, targetKeyOf } from './deploy/receipts.mjs';
import { RcError, ErrorCode, sharedDataError } from './contract.mjs';
import { hostLabel } from './host-labels.mjs';
import { compareVersions } from './package-service.mjs';

export function createInstalledService({ lcaipackHome, userHome = os.homedir(), env = process.env, log = () => {} } = {}) {
  const home = lcaipackHome ?? resolveLcAiPackHome({ env, homedir: userHome });
  function receipts({ globalOnly = false } = {}) {
    try {
      if (globalOnly) return ReceiptStore.forGlobal({ home, userProfile: userHome }).load().receipts.filter(r => r.scope === 'global');
      let projects = [];
      try { projects = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).registeredProjects ?? []; }
      catch (e) { if (e.code !== 'ENOENT') throw new ReceiptFileError('無法讀取共用專案清單'); }
      if (!Array.isArray(projects) || projects.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new ReceiptFileError('共用專案清單格式錯誤');
      const rules = createPathRules();
      const stores = [ReceiptStore.forGlobal({ home, userProfile: userHome }),
        ...[...new Set(projects.map(p => rules.normalize(p)))].map(projectRoot => ReceiptStore.forProject({ projectRoot }))];
      return stores.flatMap(store => store.load().receipts);
    }
    catch (e) {
      if (e?.unsupportedFormatVersion) { log(`[sharedDataTooNew] ${e.message}`); throw sharedDataError(); }
      if (e instanceof ReceiptFileError) throw new RcError(ErrorCode.receiptInvalid, e.message);
      throw e;
    }
  }
  function project(packageKey, latestVersion, records = receipts(), versions = null) {
    const groups = new Map();
    for (const r of records.filter(r => r.packageKey === packageKey)) {
      const key = JSON.stringify([targetKeyOf(r), r.packageVersion, r.source === 'local' ? 'local' : 'market']);
      if (!groups.has(key)) groups.set(key, r);
    }
    const deployments = [...groups.values()].map(r => {
      const updateVersion = r.source !== 'local' && latestVersion && compareVersions(latestVersion, r.packageVersion) > 0 ? latestVersion : null;
      const market = r.source !== 'local' ? versions?.find(v => v.version === r.packageVersion) : null;
      const comparable = !!(market?.sha256?.trim() && r.packageSha256?.trim());
      const sameContent = comparable && market.sha256.toLowerCase() === r.packageSha256.toLowerCase();
      return { id: targetKeyOf(r), label: hostLabel(r), hostId: r.hostId, surfaceId: r.surfaceId, scope: r.scope, rootPath: r.canonicalRoot,
        version: r.packageVersion, channel: sameContent ? market.channel : r.channel, contentDiffersFromMarket: comparable && !sameContent, source: r.source === 'local' ? 'local' : 'market',
        status: updateVersion ? 'updateAvailable' : r.source !== 'local' && latestVersion && compareVersions(r.packageVersion, latestVersion) > 0 ? 'newer'
          : (!latestVersion || (versions && !market)) && r.source !== 'local' ? 'unavailable' : 'current', updateVersion };
    });
    const installationStatus = !deployments.length ? 'notInstalled' : deployments.some(d => d.updateVersion) ? 'updateAvailable'
      : deployments.some(d => d.status === 'unavailable') ? 'unavailable' : deployments.some(d => d.status === 'newer') ? 'newer' : 'current';
    return { installationStatus, deployments, ...(installationStatus === 'unavailable'
      ? { statusHint: '已自市集下架或你已無權限查看；本機仍可繼續使用與解除安裝' } : {}) };
  }
  /** 收據無法讀取時不擲錯：回傳 { error }，讓目錄與詳情照常瀏覽、只有已安裝狀態標示錯誤。 */
  function tryReceipts(options) {
    try { return { records: receipts(options) }; }
    catch (e) {
      if (e instanceof RcError && [ErrorCode.receiptInvalid, ErrorCode.sharedDataTooNew].includes(e.code)) return { error: { code: e.code, message: e.message } };
      throw e;
    }
  }
  /**
   * 共用收據記錄的「最後執行部署的用戶端版本」（installedAt 最新的一筆）。收據由 LC-AI-Pack 與 Orca 外掛共用，
   * 版本字串無法分辨來源，所以排除與 excludeVersion（Orca 外掛目前版本）相同者；收據讀不到或沒有符合的收據時為 null。
   */
  function lastDeployingClientVersion(excludeVersion = null) {
    const { records } = tryReceipts();
    let best = null;
    for (const r of records ?? []) {
      if (!r.clientVersion || r.clientVersion === excludeVersion) continue;
      const at = Date.parse(r.installedAt);
      if (!Number.isFinite(at)) continue;
      if (!best || at > best.at) best = { at, version: r.clientVersion };
    }
    return best?.version ?? null;
  }
  return { receipts, tryReceipts, lastDeployingClientVersion, project };
}

