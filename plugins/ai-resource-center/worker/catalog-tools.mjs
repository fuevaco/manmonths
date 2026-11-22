// 詳情快取僅留在工作階段的記憶體，不跨市集／帳號共用。
import { withDisplayPath } from './display-path.mjs';
import { targetSummary, toolId, supportedTools } from './host-labels.mjs';
import { HostIds, SurfaceIds } from './deploy/host-profiles.mjs';
import { pendingRoots } from './deploy/root-coverage.mjs';
import { currentReceipt, readSourceManifest, manifestContents, sourceExists, sourceMissingMessage } from './local-source.mjs';
export function createCatalogTools({ packages, downloads, detectTargets, readReceipts = () => [], lastFailure = async () => null, lastSkipped = async () => null, refreshSkipped = async () => {}, backupsFor = async () => [], detachedFor = async () => [], platform = process.platform }) {
  const caches = new WeakMap();
  let active = 0;
  const waiters = [];
  async function limited(fn) {
    if (active >= 4) await new Promise(resolve => waiters.push(resolve));
    else active++;
    try { return await fn(); }
    finally { const next = waiters.shift(); if (next) next(); else active--; }
  }
  async function metadata(client, p, previewMode) {
    if (!p.latestVisibleVersion) return null;
    if (!caches.has(client)) caches.set(client, new Map());
    const cache = caches.get(client), key = `${p.packageKey}@${p.latestVisibleVersion}`;
    if (!cache.has(key)) {
      const pending = limited(async () => {
        const input = { packageKey: p.packageKey, version: p.latestVisibleVersion, previewMode };
        const detail = await packages.details(client, input);
        const hosts = detail.versions.find(v => v.version === input.version)?.hosts;
        if (!Array.isArray(hosts) || hosts.some(h => typeof h !== 'string')) return null;
        let containsMcp = p.type === 'mcp';
        if (p.type === 'bundle') {
          try { containsMcp = (await downloads.fetchVerified(input)).manifest.contents.some(c => c.kind === 'mcp'); }
          catch { /* ZIP 不可讀時無法確認 bundle 含 MCP，不猜測 Desktop 相容性。 */ }
        }
        return { hosts: [...new Set(hosts)], containsMcp };
      }).catch(() => null);
      cache.set(key, pending);
      pending.then(result => { if (!result && cache.get(key) === pending) cache.delete(key); });
    }
    return cache.get(key);
  }
  const coverageCache = new WeakMap();
  function deployedContents(client, packageKey, version) {
    if (!coverageCache.has(client)) coverageCache.set(client, new Map());
    const cache = coverageCache.get(client), key = `${packageKey}@${version}`;
    if (!cache.has(key)) {
      const pending = limited(async () => (await downloads.fetchVerified({ packageKey, version, previewMode: true })).manifest.contents).catch(() => null);
      cache.set(key, pending);
      pending.then(result => { if (!result && cache.get(key) === pending) cache.delete(key); });
    }
    return cache.get(key);
  }
  return async function enrich(client, data, previewMode) {
    const local = detectTargets();
    const receiptsByPackage = new Map();
    for (const receipt of readReceipts()) {
      if (!receiptsByPackage.has(receipt.packageKey)) receiptsByPackage.set(receipt.packageKey, []);
      receiptsByPackage.get(receipt.packageKey).push(receipt);
    }
    // 同一讀取請求依序重查；只有存在略過紀錄的資源包才會進行部署規劃。
    for (const p of data) await refreshSkipped(p.packageKey);
    return Promise.all(data.map(async p => {
      const receipts = receiptsByPackage.get(p.packageKey) ?? [];
      const current = receipts.length ? currentReceipt(receipts) : null;
      // 開發中版本（對照 InstalledViewModel.RootContent）：各根目錄需要的內容讀來源資料夾的 lcpack.json，讀不到時退回同版本收據。
      // 相容工具與從資料夾安裝相同：所有支援的 AI 工具，Claude Desktop 只在含 MCP 時列入。
      const devSource = current?.source === 'local';
      const devContents = devSource ? manifestContents(readSourceManifest(current.sourcePath)) : [];
      const meta = devSource ? null : await metadata(client, p, previewMode);
      const hosts = devSource ? [HostIds.codex, HostIds.claudeCode] : meta?.hosts ?? null;
      const containsMcp = devSource ? (devContents.length ? devContents : receipts.filter(r => r.packageVersion === current.packageVersion)).some(c => c.kind === 'mcp')
        : meta?.containsMcp ?? p.type === 'mcp';
      const tools = supportedTools.filter(tool => {
        // Linux 沒有官方 Claude Desktop（ADR-0005），不列為相容工具。
        if (tool.hostId === SurfaceIds.claudeDesktop && (!containsMcp || platform === 'linux')) return false;
        return hosts === null ? local.some(tool.matches)
          : hosts.includes(tool.hostId) || (tool.hostId === SurfaceIds.claudeDesktop && hosts.includes(HostIds.claudeCode));
      }).map(({ hostId, label, matches }) => ({ hostId, label, deployed: (p.deployments ?? []).some(matches) }));
      const rawFailure = await lastFailure(p.packageKey);
      const failure = rawFailure ? { ...rawFailure, targets: rawFailure.targets.map(t => withDisplayPath(t, local)) } : null;
      const rawSkipped = await lastSkipped(p.packageKey);
      const detached = await detachedFor(p.packageKey);
      const skipped = rawSkipped ? { ...rawSkipped, targets: rawSkipped.targets.map(t => withDisplayPath(t, local)) } : null;
      let pending = [];
      if (receipts.length && hosts !== null && failure?.action !== 'uninstall') {
        const contents = (devSource ? devContents.length ? devContents : null : await deployedContents(client, p.packageKey, current.packageVersion))
          ?? receipts.filter(r => r.packageVersion === current.packageVersion).map(r => ({ kind: r.kind, id: r.contentId }));
        pending = pendingRoots({ contents, receipts, targets: local.filter(t => tools.some(tool => tool.hostId === toolId(t))),
          excluded: [...(failure?.targets ?? []).map(t => t.targetId), ...(skipped?.targets ?? []).map(t => t.targetId), ...detached] }).map(targetSummary);
      }
      const backups = (await backupsFor(p.packageKey)).map(t => withDisplayPath(t, local));
      return { ...p, ...(p.deployments ? { deployments: p.deployments.map(d => ({ ...withDisplayPath(d, local), label: targetSummary(d).label,
        backupPaths: backups.filter(b => b.targetId === d.id).map(b => b.backupPath) })) } : {}),
        hosts, tools, pendingTargets: { count: pending.length, targets: pending },
        // 補裝開發中版本要從來源資料夾重新打包；來源已不存在時停用「補裝」並說明原因。
        fillUnavailableReason: pending.length && devSource && !sourceExists(current.sourcePath) ? sourceMissingMessage(current.sourcePath) : null,
        lastFailure: failure, lastSkipped: skipped, backups };
    }));
  };
}
