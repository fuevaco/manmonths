// 對照 LC-AI-Pack InstalledViewModel 的未涵蓋根目錄判斷。
import { HostIds, HostProfiles } from './host-profiles.mjs';
import { getDriver } from './resource-drivers.mjs';
import { targetKeyOf } from './receipts.mjs';

export function pendingRoots({ targets, contents, receipts, excluded = [] }) {
  if (!receipts.length) return [];
  const deployed = new Map();
  for (const receipt of receipts) {
    const target = targetKeyOf(receipt);
    if (!deployed.has(target)) deployed.set(target, new Set());
    deployed.get(target).add(`${receipt.kind}|${receipt.contentId}`);
  }
  return targets.filter(target => {
    if (target.origin === 'SharedSkills' || target.origin === 'Receipt' || excluded.includes(target.id)) return false;
    const surface = HostProfiles.find(target.hostId)?.findSurface(target.surfaceId);
    return contents.some(content => !(target.hostId === HostIds.codex && content.kind === 'skill') && getDriver(content.kind) &&
      surface?.routes.get(content.kind)?.templateFor(target.scope) && !deployed.get(target.id)?.has(`${content.kind}|${content.id}`));
  });
}
