// 只影響面板顯示；目標識別、收據與部署比對仍使用原本的 canonicalRoot。
export function displayPath(target, detected) {
  const root = target.canonicalRoot ?? target.rootPath;
  const match = detected.find(local =>
    (local.canonicalRoot ?? local.rootPath)?.toLowerCase() === root?.toLowerCase() &&
    (!target.surfaceId || local.surfaceId === target.surfaceId) &&
    (target.surfaceId ? local.hostId === target.hostId : local.hostId === target.hostId || local.surfaceId === target.hostId));
  return match?.rootPath ?? target.rootPath ?? target.canonicalRoot;
}
export const withDisplayPath = (target, detected) => ({ ...target, rootPath: displayPath(target, detected) });
