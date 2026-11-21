// 部署計畫摘要的 canonical serialization（對照 Deployment/PlanDigest.cs）。
// 涵蓋資源包 SHA、正規化意圖、契約與 Host Profile 版本、根目錄、ownership 快照、排序後的變更／命令／設定與觀測戳記；
// 不涵蓋時間、顯示文字與秘密值；安裝設定只以「有／無」涵蓋秘密（對照 PlanDigest.AppendSetup）。
import { ofText, ordinal } from './digest.mjs';
import { HostProfiles } from './host-profiles.mjs';
import { appendSetupDigest } from '../setup/planning.mjs';

export const ContractVersion = 'lcaipack-deployment/1';

const stamp = (s) => `${s.state}:${s.sha256 ?? '-'}:${s.treeSha256 ?? '-'}:${s.length ?? '-'}`;
const owner = (o) => (o.isManaged ? `managed:${o.ownerPackageKey}:${o.ownerContentId}:${o.installedSha256 ?? '-'}` : 'unmanaged');

function appendTarget(target, rules) {
  let b = `target=${target.targetKey}\n`;
  b += `target.hostProfileVersion=${target.hostProfileVersion}\n`;
  b += `target.ownershipSnapshot=${target.ownershipSnapshotSha256}\n`;
  for (const m of [...target.mutations].sort((x, y) => ordinal(x.mutationId, y.mutationId))) {
    b += `mutation=${[m.mutationId, m.contentId, m.kind, m.mutationKind, m.change, rules.normalize(m.destinationPath), m.sourceEntry ?? '-',
      m.renderedSha256 ?? '-', m.ownedFieldPaths.join(','), m.willBackup ? 'backup' : 'no-backup', stamp(m.before), owner(m.ownership)].join('|')}\n`;
  }
  for (const c of [...target.commands].sort((x, y) => ordinal(x.commandId, y.commandId))) {
    b += `command=${[c.commandId, c.contentId, c.executable, c.arguments.join('\u001f'), rules.normalize(c.workingDirectory), c.willExecute ? 'execute' : 'disclose-only'].join('|')}\n`;
  }
  for (const c of [...target.configuration].sort((x, y) => ordinal(x.path, y.path) || ordinal(x.contentId, y.contentId))) {
    b += `config=${[c.contentId, rules.normalize(c.path), c.format, c.ownedFields.join(',')].join('|')}\n`;
  }
  for (const p of [...target.problems].sort((x, y) => ordinal(x.code, y.code) || ordinal(x.contentId ?? '', y.contentId ?? '') || ordinal(x.path ?? '', y.path ?? ''))) {
    b += `problem=${[p.code, p.severity, p.contentId ?? '-', p.path == null ? '-' : rules.normalize(p.path)].join('|')}\n`;
  }
  return b;
}

export function computeTargetDigest(target, rules) {
  return ofText(appendTarget(target, rules));
}

export function computePlanDigest(identity, sourceSha256, intent, targets, rules, setup = null) {
  let b = `contract=${ContractVersion}\n`;
  b += `hostProfiles=${HostProfiles.matrixDigest}\n`;
  b += `package=${identity.key}@${identity.version}/${identity.type}\n`;
  b += `sourceSha256=${String(sourceSha256).toLowerCase()}\n`;
  b += `intent.scope=${intent.scope}\n`;
  b += `intent.projectRoot=${intent.projectRoot == null ? '-' : rules.normalize(intent.projectRoot)}\n`;
  b += `intent.existingContent=${intent.existingContent ?? 'Block'}\n`;
  b += `intent.allowScopeShadowing=${intent.allowScopeShadowing ? '1' : '0'}\n`;
  for (const h of [...intent.hosts].sort((x, y) => ordinal(x.hostId, y.hostId) || ordinal(x.surfaceId, y.surfaceId))) {
    b += `intent.host=${h.hostId}/${h.surfaceId}\n`;
  }
  for (const t of [...targets].sort((x, y) => ordinal(x.targetKey, y.targetKey))) b += appendTarget(t, rules);
  b += appendSetupDigest(setup, rules);
  return ofText(b);
}
