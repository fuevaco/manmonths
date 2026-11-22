// 單一部署目標的 ownership index（對照 Deployment/OwnershipIndex.cs）：
// identity ownership（contentId）與 physical ownership（實際路徑）任一由別的資源包擁有都必須阻擋。
import { ofText, ordinal } from './digest.mjs';

export const Unmanaged = Object.freeze({ isManaged: false, ownerPackageKey: null, ownerPackageVersion: null, ownerContentId: null, isSameOwner: false, installedSha256: null, normalizedAddress: null });

export function buildOwnershipIndex({ packageKey, host, scope, canonicalRoot, targetStore, otherScopeStores = [], rules }) {
  const targetReceipts = targetStore.forTarget(host, scope, canonicalRoot);
  const root = rules.normalize(canonicalRoot);
  const sameRootReceipts = targetStore.load().receipts.filter(r => r.canonicalRoot === root);
  const otherScopeReceipts = otherScopeStores
    .filter(s => s.filePath.toLowerCase() !== targetStore.filePath.toLowerCase())
    .flatMap(s => s.load().receipts)
    .filter(r => r.hostId === host.hostId && r.surfaceId === host.surfaceId)
    .sort((a, b) => ordinal(a.normalizedAddress, b.normalizedAddress));
  const byContentId = new Map(), byPath = new Map();
  for (const r of targetReceipts) {
    if (!byContentId.has(r.contentId)) byContentId.set(r.contentId, r);
    const p = rules.normalize(r.destinationPath);
    if (!byPath.has(p)) byPath.set(p, r);
  }
  const disclose = (r, contentId) => Object.freeze({
    isManaged: true, ownerPackageKey: r.packageKey, ownerPackageVersion: r.packageVersion, ownerContentId: r.contentId,
    isSameOwner: r.packageKey === packageKey && r.contentId === contentId, installedSha256: r.installedSha256, normalizedAddress: r.normalizedAddress
  });

  return Object.freeze({
    targetReceipts, otherScopeReceipts, sameRootReceipts,
    configSnapshot(configPath) {
      const seen = new Set();
      return sameRootReceipts.filter(r => r.mutationKind === 'PatchConfig' && rules.normalize(r.destinationPath) === rules.normalize(configPath))
        .filter(r => { if (seen.has(r.contentId)) return false; seen.add(r.contentId); return true; })
        .map(r => ({ contentId: r.contentId, ownerPackageKey: r.packageKey, ownerPackageVersion: r.packageVersion,
          ownedFields: r.ownedConfigFields, baseValueHashes: r.baseValueHashes, installedSha256: r.installedSha256 }));
    },
    resolveFile(contentId, destination) {
      if (byContentId.has(contentId)) return disclose(byContentId.get(contentId), contentId);
      const p = rules.normalize(destination);
      if (byPath.has(p)) return disclose(byPath.get(p), contentId);
      return Unmanaged;
    },
    findShadowing(contentIds) {
      const ids = new Set(contentIds);
      return otherScopeReceipts.filter(r => ids.has(r.contentId));
    },
    /** ownership 快照 digest；收據變動時計畫一定失效。 */
    snapshotSha256() {
      const text = [...targetReceipts].sort((a, b) => ordinal(a.normalizedAddress, b.normalizedAddress))
        .map(r => [r.normalizedAddress, r.packageKey, r.packageVersion, r.contentId, r.mutationKind, r.installedSha256,
          r.ownedConfigFields.join(','), r.baseValueHashes.join(',')].join('|') + '\n').join('');
      return ofText(text);
    }
  });
}
