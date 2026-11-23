import { isSharedSkillPath } from './codex-roots.mjs';
// 單一部署目標的寫入交易（對照 Deployment/TargetApplyExecutor.cs）：
// 快照 → 逐項寫入並驗證 → 原子替換收據；任一步失敗即還原該目標本次全部變更。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostIds, MutationKind, Scope } from './host-profiles.mjs';
import { resolveClaudeUserConfigDirectory } from './claude-code-roots.mjs';
import { isDirectory, isFile, listDirectories, listFiles, observe, observeTree, sameObservation, Missing } from './observer.mjs';
import { createTargetTransaction, createSkillBackup, resolveBackupPath, newBackupStamp, RollbackIncompleteError } from './target-transaction.mjs';
import { ownershipAddress, formatInstalledAt } from './receipts.mjs';
import { ProblemCodes, blocking } from './problems.mjs';
import { PlannedChange } from './resource-drivers.mjs';
import { getConfigAdapter } from './config-document-adapters.mjs';
import { ofText } from './digest.mjs';
import { createOrcaClaudeMcpCleanup } from './orca-claude-mcp-cleanup.mjs';

export const diagnosticId = () => 'LCAI-' + randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();

const targetResult = (target, status, extra = {}) => ({
  host: target.host, scope: target.scope, canonicalRoot: target.canonicalRoot, targetKey: target.targetKey, status,
  writtenPaths: [], removedPaths: [], backupPaths: [], problems: [], residualPaths: [], partiallyRestoredPaths: [], diagnosticId: diagnosticId(), ...extra
});

function observeFor(mutation, artifact) {
  if (mutation.mutationKind === MutationKind.syncTree) return observeTree(mutation.destinationPath);
  if (mutation.mutationKind === MutationKind.writeFile) return observe(mutation.destinationPath);
  if (!isFile(mutation.destinationPath)) return Missing;
  const node = getConfigAdapter(artifact.configAdapterId).readNodeJson(fs.readFileSync(mutation.destinationPath), mutation.ownedFieldPaths[0]);
  return node === null ? Missing : { state: 'ConfigNode', sha256: ofText(node), treeSha256: null };
}

function backupStep(run) {
  try { return run(); } catch (error) { error.failureStage = 'backup'; throw error; }
}

function syncTree(tx, mutation, artifact, stamp, backups, removed, options) {
  const dest = mutation.destinationPath;
  backupStep(() => tx.snapshotTree(dest));
  if (mutation.willBackup && isDirectory(dest)) backups.push(backupStep(() => createSkillBackup(dest, stamp, options)));
  const wanted = new Set(artifact.treeFiles.map(f => f.relativePath));
  if (isDirectory(dest)) {
    for (const existing of listFiles(dest)) {
      if (!wanted.has(path.relative(dest, existing).replaceAll('\\', '/'))) { fs.rmSync(existing); removed.push(existing); }
    }
  }
  for (const f of artifact.treeFiles) {
    const target = path.join(dest, ...f.relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
  tx.recordWrite(dest);
  if (isDirectory(dest)) {
    for (const d of listDirectories(dest).sort((a, b) => b.length - a.length)) if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  }
  if (observeTree(dest).treeSha256 !== mutation.renderedSha256) throw new Error(`同步後目錄 hash 驗證失敗：${dest}`);
}

/**
 * 收據是磁碟上的可竄改檔案，其路徑不能直接當作刪除對象（原實作沒有這層檢查；資源中心額外加上）：
 * 檔案與目錄只能在目標的 canonical root 內；設定檔節點另可在 Claude Code 的使用者設定目錄（家目錄的 .claude.json）。
 */
function assertOwnedPathContained(receipt, target, userHome, rules) {
  if (target.host.hostId === HostIds.codex && target.scope === Scope.global && target.canonicalRoot === rules.normalize(userHome) && receipt.kind === 'skill') {
    if (isSharedSkillPath(userHome, receipt.contentId, receipt.destinationPath, rules)) return;
    throw new Error(`收據路徑不符合共用技能目標根目錄與名稱：${receipt.destinationPath}`);
  }
  const bases = [target.canonicalRoot];
  if (receipt.mutationKind === MutationKind.patchConfig && target.host.hostId === HostIds.claudeCode && target.scope === Scope.global) {
    bases.push(resolveClaudeUserConfigDirectory(target.canonicalRoot, userHome, false, rules));
  }
  if (!bases.some(base => rules.isWithin(base, receipt.destinationPath))) {
    throw new Error(`收據記錄的路徑不在目標根目錄內，已拒絕移除：${receipt.destinationPath}`);
  }
}

function removeStaleOwnedContent(planned, pkg, tx, options, rules, orcaCleanup, { stamp, backups, rootMissing, uninstall, existingContent }) {
  if (planned.missingContentOnly) return [];
  const { userHome } = options;
  const { target, receiptStore } = planned;
  const keep = new Set(target.mutations.map(m => m.contentId));
  const stale = receiptStore.forTarget(target.host, target.scope, target.canonicalRoot)
    .filter(r => r.packageKey === pkg.identity.key && !keep.has(r.contentId))
    .filter(r => uninstall || (r.kind === 'skill' ? planned.handlesSkills : planned.handlesRootContent));
  const removed = [];
  for (const r of stale) assertOwnedPathContained(r, target, userHome, rules);
  for (const r of stale) {
    // 解除安裝消失的根只清收據，包括位於根外、合法的 Claude 使用者設定。
    if (rootMissing) continue;
    if (r.mutationKind === MutationKind.writeFile) {
      backupStep(() => tx.snapshotFile(r.destinationPath));
      if (uninstall && isFile(r.destinationPath) && observe(r.destinationPath).sha256?.toLowerCase() !== r.installedSha256.toLowerCase()) {
        const backup = backupStep(() => resolveBackupPath(r.destinationPath, stamp));
        backupStep(() => fs.copyFileSync(r.destinationPath, backup, fs.constants.COPYFILE_EXCL));
        backups.push(backup);
      }
      if (isFile(r.destinationPath)) { fs.rmSync(r.destinationPath); removed.push(r.destinationPath); }
    } else if (r.mutationKind === MutationKind.syncTree) {
      backupStep(() => tx.snapshotTree(r.destinationPath));
      if (isDirectory(r.destinationPath)) {
        const observation = observeTree(r.destinationPath);
        if ((uninstall || (r.kind === 'skill' && observation.length !== 0)) &&
            observation.treeSha256?.toLowerCase() !== r.installedSha256.toLowerCase()) {
          if (!uninstall && existingContent !== 'BackupAndReplace')
            throw new Error('技能已在本機修改，必須先備份：' + r.destinationPath);
          backups.push(backupStep(() => createSkillBackup(r.destinationPath, stamp, options)));
        }
        fs.rmSync(r.destinationPath, { recursive: true }); removed.push(r.destinationPath);
      }
    } else if (r.mutationKind === MutationKind.patchConfig) {
      if (isFile(r.destinationPath)) {
        const adapter = getConfigAdapter(r.destinationPath.toLowerCase().endsWith('.toml') ? 'mcp-toml' : 'mcp-json');
        const nodePath = r.ownedConfigFields[0] ?? r.contentId;
        const current = fs.readFileSync(r.destinationPath);
        if (uninstall && adapter.readNodeJson(current, nodePath) === null) continue;
        backupStep(() => tx.snapshotFile(r.destinationPath));
        const updated = adapter.removeNode(current, nodePath);
        if (uninstall && adapter.readNodeJson(updated, nodePath) !== null) throw new Error('設定節點無法安全移除');
        fs.writeFileSync(r.destinationPath, updated);
        orcaCleanup.recordRemoval(r.destinationPath, nodePath, current, updated);
        removed.push(`${r.destinationPath}#${r.contentId}`);
      }
    } else throw new Error(`不支援的移除類型：${r.mutationKind}`);
  }
  if (stale.length) receiptStore.removeAddresses(stale.map(r => r.normalizedAddress));
  return removed;
}

// 解除安裝與更新時清除舊內容使用同一個移除入口、包含檢查與目標交易。
export function executeRemovalTarget(planned, packageKey, options, rules) {
  const tx = createTargetTransaction(), backups = [];
  const orcaCleanup = createOrcaClaudeMcpCleanup(planned.target, options);
  // 一次請求內在目標鎖下規劃與套用；digest 綁定收據、目的地觀測與根目錄狀態。
  const digest = () => ofText(JSON.stringify({ packageKey, scope: 'global', policy: 'BackupAndRemove',
    rootMissing: !isDirectory(planned.target.canonicalRoot),
    receipts: planned.receiptStore.forTarget(planned.target.host, 'global', planned.target.canonicalRoot)
      .filter(r => r.packageKey === packageKey).map(r => ({ receipt: r, current: r.mutationKind === MutationKind.syncTree ? observeTree(r.destinationPath) : observe(r.destinationPath) })) }));
  try {
    let planDigest, removed;
    try {
      planDigest = digest();
      backupStep(() => tx.snapshotFile(planned.receiptStore.filePath));
      if (digest() !== planDigest) throw new Error('本機內容在解除安裝前已改變，請重試');
      removed = removeStaleOwnedContent(planned, { identity: { key: packageKey } }, tx, options, rules, orcaCleanup,
        { uninstall: true, rootMissing: !isDirectory(planned.target.canonicalRoot), stamp: newBackupStamp(), backups });
    } catch (error) { return rollback(planned.target, tx, error, backups, true); }
    return targetResult(planned.target, 'Succeeded', { removedPaths: removed, backupPaths: backups, planDigest, problems: orcaCleanup.run() });
  } finally { tx.dispose(); }
}

function buildReceipt(pkg, target, mutation, artifact, options, plan, rules, now) {
  const installed = mutation.mutationKind === MutationKind.writeFile ? observe(mutation.destinationPath).sha256
    : mutation.mutationKind === MutationKind.syncTree ? observeTree(mutation.destinationPath).treeSha256 ?? '' : mutation.renderedSha256 ?? '';
  const receipt = {
    packageKey: pkg.identity.key, packageVersion: pkg.identity.version, packageSha256: pkg.sha256, channel: options.channel,
    contentId: mutation.contentId, kind: mutation.kind, hostId: target.host.hostId, surfaceId: target.host.surfaceId, scope: target.scope,
    canonicalRoot: target.canonicalRoot,
    normalizedAddress: ownershipAddress(rules, target.host, target.scope, target.canonicalRoot, mutation.contentId,
      mutation.mutationKind === MutationKind.patchConfig ? mutation.destinationPath : null),
    destinationPath: mutation.destinationPath, mutationKind: mutation.mutationKind, sourceSha256: plan.sourceSha256, installedSha256: installed ?? '',
    ownedConfigFields: [...mutation.ownedFieldPaths], baseValueHashes: [...(artifact.configPatch?.baseValueHashes ?? [])],
    installedAt: formatInstalledAt(now()), clientVersion: options.clientVersion, hostProfileVersion: target.hostProfileVersion
  };
  if (plan.intent.localSourcePath != null) { receipt.source = 'local'; receipt.sourcePath = plan.intent.localSourcePath; }
  return receipt;
}

export function executeTarget(planned, pkg, plan, options, rules) {
  const { target } = planned;
  const stamp = newBackupStamp();
  const backups = [], removed = [], receipts = [];
  const tx = createTargetTransaction();
  const orcaCleanup = createOrcaClaudeMcpCleanup(target, options);
  const now = options.now ?? (() => new Date());
  try {
    try {
      backupStep(() => tx.snapshotFile(planned.receiptStore.filePath));
      for (const mutation of target.mutations) {
        const artifact = planned.artifacts.get(mutation.mutationId);
        if (!sameObservation(mutation.before, observeFor(mutation, artifact))) {
          tx.rollback();
          return targetResult(target, 'Stale', { problems: [blocking(ProblemCodes.planStale, `寫入前偵測到外部修改：${mutation.destinationPath}`,
            '目的地在審核後被其他程序改變；該 target 零寫入。請重新 Plan 並重新確認。', { host: target.host, scope: target.scope, path: mutation.destinationPath })] });
        }
        if (mutation.change === PlannedChange.noOp) { receipts.push(buildReceipt(pkg, target, mutation, artifact, options, plan, rules, now)); continue; }
        if (mutation.mutationKind === MutationKind.syncTree) syncTree(tx, mutation, artifact, stamp, backups, removed, options);
        else if (mutation.mutationKind === MutationKind.writeFile) {
          backupStep(() => tx.snapshotFile(mutation.destinationPath));
          if (mutation.willBackup && isFile(mutation.destinationPath)) {
            const backup = backupStep(() => resolveBackupPath(mutation.destinationPath, stamp));
            backupStep(() => fs.copyFileSync(mutation.destinationPath, backup, fs.constants.COPYFILE_EXCL));
            backups.push(backup);
          }
          fs.mkdirSync(path.dirname(mutation.destinationPath), { recursive: true });
          fs.writeFileSync(mutation.destinationPath, artifact.fileContent);
          tx.recordWrite(mutation.destinationPath);
          if (observe(mutation.destinationPath).sha256 !== mutation.renderedSha256) throw new Error('寫入後檔案 hash 驗證失敗');
        }
        else if (mutation.mutationKind === MutationKind.patchConfig) {
          const dest = mutation.destinationPath, adapter = getConfigAdapter(artifact.configAdapterId);
          backupStep(() => tx.snapshotFile(dest));
          if (mutation.willBackup && isFile(dest)) {
            const backup = backupStep(() => resolveBackupPath(dest, stamp)); backupStep(() => fs.copyFileSync(dest, backup, fs.constants.COPYFILE_EXCL)); backups.push(backup);
          }
          const exists = isFile(dest), current = exists ? fs.readFileSync(dest) : Buffer.alloc(0);
          const updated = adapter.applyPatch(current, exists, artifact.configPatch);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, updated); tx.recordWrite(dest);
          const owned = adapter.readOwnedNodeJson(fs.readFileSync(dest), artifact.configPatch.nodePath, mutation.ownedFieldPaths);
          if (ofText(owned) !== mutation.renderedSha256) throw new Error('寫入後 MCP 受管欄位 hash 驗證失敗');
        } else throw new Error(`${mutation.mutationKind} 尚未支援`);
        receipts.push(buildReceipt(pkg, target, mutation, artifact, options, plan, rules, now));
      }
      removed.push(...removeStaleOwnedContent(planned, pkg, tx, options, rules, orcaCleanup,
        { stamp, backups, existingContent: plan.intent.existingContent }));
      planned.receiptStore.upsert(receipts);
    } catch (failure) {
      return rollback(target, tx, failure, backups);
    }
    return targetResult(target, 'Succeeded', { writtenPaths: tx.writtenPaths, removedPaths: removed, backupPaths: backups, problems: orcaCleanup.run() });
  } finally {
    tx.dispose();
  }
}

function rollback(target, tx, failure, backups, uninstall = false) {
  const incomplete = (e, detail) => targetResult(target, 'RollbackIncomplete', {
    backupPaths: backups, residualPaths: e.residualPaths, partiallyRestoredPaths: e.partiallyRestoredPaths,
    problems: [blocking(ProblemCodes.rollbackFailed, uninstall ? '解除安裝失敗，部分內容無法還原' : `${target.host.hostId} 寫入失敗且 rollback 未完整還原`, detail,
      { host: target.host, scope: target.scope, resolutions: uninstall ? ['依殘留路徑還原內容後重新解除安裝'] : ['依殘留路徑人工還原', '還原後重新 Plan 與 Apply'] })]
  });
  if (failure instanceof RollbackIncompleteError) return incomplete(failure, uninstall ? `解除安裝後未完整還原：${failure.residualPaths.join('、')}` : failure.message);
  try { tx.rollback(); } catch (e) {
    if (e instanceof RollbackIncompleteError) return incomplete(e, uninstall ? `解除安裝失敗原因：${failure.message}；無法還原的路徑：${e.residualPaths.join('、')}` : `原始失敗：${failure.message}；rollback 失敗：${e.message}`);
    throw e;
  }
  return targetResult(target, 'RolledBack', {
    backupPaths: backups,
    problems: [blocking(ProblemCodes.applyFailed, uninstall ? '解除安裝失敗，這個位置已還原為原本的內容' : `${target.host.hostId} 寫入失敗，已完整還原該平台變更`, failure?.message ?? String(failure),
      { host: target.host, scope: target.scope, ...(failure?.failureStage ? { failureStage: failure.failureStage } : {}), resolutions: uninstall ? ['排除原因後重新解除安裝'] : ['排除原因後重新 Plan 與 Apply'] })]
  });
}
