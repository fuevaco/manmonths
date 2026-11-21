// 單一部署目標的寫入交易（對照 Deployment/TargetApplyExecutor.cs）：
// 快照 → 逐項寫入並驗證 → 原子替換收據；任一步失敗即還原該目標本次全部變更。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostIds, MutationKind, Scope } from './host-profiles.mjs';
import { resolveClaudeUserConfigDirectory } from './claude-code-roots.mjs';
import { isDirectory, isFile, listDirectories, listFiles, observe, observeTree, sameObservation, Missing } from './observer.mjs';
import { createTargetTransaction, createDirectoryBackup, resolveBackupPath, newBackupStamp, RollbackIncompleteError } from './target-transaction.mjs';
import { ownershipAddress, formatInstalledAt } from './receipts.mjs';
import { ProblemCodes, blocking } from './problems.mjs';
import { PlannedChange } from './resource-drivers.mjs';
import { getConfigAdapter } from './config-document-adapters.mjs';
import { ofText } from './digest.mjs';

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

function syncTree(tx, mutation, artifact, stamp, backups, removed) {
  const dest = mutation.destinationPath;
  tx.snapshotTree(dest);
  if (mutation.willBackup && isDirectory(dest)) backups.push(createDirectoryBackup(dest, stamp));
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
 * 收據是磁碟上的可竄改檔案，其路徑不能直接當作刪除對象（LC-AI-Pack 沒有這層檢查；資源中心額外加上）：
 * 檔案與目錄只能在目標的 canonical root 內；設定檔節點另可在 Claude Code 的使用者設定目錄（家目錄的 .claude.json）。
 */
function assertOwnedPathContained(receipt, target, userHome, rules) {
  const bases = [target.canonicalRoot];
  if (receipt.mutationKind === MutationKind.patchConfig && target.host.hostId === HostIds.claudeCode && target.scope === Scope.global) {
    bases.push(resolveClaudeUserConfigDirectory(target.canonicalRoot, userHome, false, rules));
  }
  if (!bases.some(base => rules.isWithin(base, receipt.destinationPath))) {
    throw new Error(`收據記錄的路徑不在目標根目錄內，已拒絕移除：${receipt.destinationPath}`);
  }
}

function removeStaleOwnedContent(planned, pkg, tx, userHome, rules) {
  const { target, receiptStore } = planned;
  const keep = new Set(target.mutations.map(m => m.contentId));
  const stale = receiptStore.forTarget(target.host, target.scope, target.canonicalRoot)
    .filter(r => r.packageKey === pkg.identity.key && !keep.has(r.contentId));
  const removed = [];
  for (const r of stale) assertOwnedPathContained(r, target, userHome, rules);
  for (const r of stale) {
    if (r.mutationKind === MutationKind.writeFile) {
      tx.snapshotFile(r.destinationPath);
      if (isFile(r.destinationPath)) { fs.rmSync(r.destinationPath); removed.push(r.destinationPath); }
    } else if (r.mutationKind === MutationKind.syncTree) {
      tx.snapshotTree(r.destinationPath);
      if (isDirectory(r.destinationPath)) { fs.rmSync(r.destinationPath, { recursive: true }); removed.push(r.destinationPath); }
    } else if (r.mutationKind === MutationKind.patchConfig) {
      if (isFile(r.destinationPath)) {
        tx.snapshotFile(r.destinationPath);
        const adapter = getConfigAdapter(r.destinationPath.toLowerCase().endsWith('.toml') ? 'mcp-toml' : 'mcp-json');
        fs.writeFileSync(r.destinationPath, adapter.removeNode(fs.readFileSync(r.destinationPath), r.ownedConfigFields[0] ?? r.contentId));
        removed.push(`${r.destinationPath}#${r.contentId}`);
      }
    }
  }
  if (stale.length) receiptStore.removeAddresses(stale.map(r => r.normalizedAddress));
  return removed;
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
  const now = options.now ?? (() => new Date());
  try {
    tx.snapshotFile(planned.receiptStore.filePath);
    try {
      for (const mutation of target.mutations) {
        const artifact = planned.artifacts.get(mutation.mutationId);
        if (!sameObservation(mutation.before, observeFor(mutation, artifact))) {
          tx.rollback();
          return targetResult(target, 'Stale', { problems: [blocking(ProblemCodes.planStale, `寫入前偵測到外部修改：${mutation.destinationPath}`,
            '目的地在審核後被其他程序改變；該 target 零寫入。請重新 Plan 並重新確認。', { host: target.host, scope: target.scope, path: mutation.destinationPath })] });
        }
        if (mutation.change === PlannedChange.noOp) { receipts.push(buildReceipt(pkg, target, mutation, artifact, options, plan, rules, now)); continue; }
        if (mutation.mutationKind === MutationKind.syncTree) syncTree(tx, mutation, artifact, stamp, backups, removed);
        else if (mutation.mutationKind === MutationKind.writeFile) {
          tx.snapshotFile(mutation.destinationPath);
          if (mutation.willBackup && isFile(mutation.destinationPath)) {
            const backup = resolveBackupPath(mutation.destinationPath, stamp);
            fs.copyFileSync(mutation.destinationPath, backup, fs.constants.COPYFILE_EXCL);
            backups.push(backup);
          }
          fs.mkdirSync(path.dirname(mutation.destinationPath), { recursive: true });
          fs.writeFileSync(mutation.destinationPath, artifact.fileContent);
          tx.recordWrite(mutation.destinationPath);
          if (observe(mutation.destinationPath).sha256 !== mutation.renderedSha256) throw new Error('寫入後檔案 hash 驗證失敗');
        }
        else if (mutation.mutationKind === MutationKind.patchConfig) {
          const dest = mutation.destinationPath, adapter = getConfigAdapter(artifact.configAdapterId);
          tx.snapshotFile(dest);
          if (mutation.willBackup && isFile(dest)) {
            const backup = resolveBackupPath(dest, stamp); fs.copyFileSync(dest, backup, fs.constants.COPYFILE_EXCL); backups.push(backup);
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
      removed.push(...removeStaleOwnedContent(planned, pkg, tx, options.userHome, rules));
      planned.receiptStore.upsert(receipts);
    } catch (failure) {
      return rollback(target, tx, failure, backups);
    }
    return targetResult(target, 'Succeeded', { writtenPaths: tx.writtenPaths, removedPaths: removed, backupPaths: backups });
  } finally {
    tx.dispose();
  }
}

function rollback(target, tx, failure, backups) {
  const incomplete = (e, detail) => targetResult(target, 'RollbackIncomplete', {
    backupPaths: backups, residualPaths: e.residualPaths, partiallyRestoredPaths: e.partiallyRestoredPaths,
    problems: [blocking(ProblemCodes.rollbackFailed, `${target.host.hostId} 寫入失敗且 rollback 未完整還原`, detail,
      { host: target.host, scope: target.scope, resolutions: ['依殘留路徑人工還原', '還原後重新 Plan 與 Apply'] })]
  });
  if (failure instanceof RollbackIncompleteError) return incomplete(failure, failure.message);
  try { tx.rollback(); } catch (e) {
    if (e instanceof RollbackIncompleteError) return incomplete(e, `原始失敗：${failure.message}；rollback 失敗：${e.message}`);
    throw e;
  }
  return targetResult(target, 'RolledBack', {
    backupPaths: backups,
    problems: [blocking(ProblemCodes.applyFailed, `${target.host.hostId} 寫入失敗，已完整還原該平台變更`, failure?.message ?? String(failure),
      { host: target.host, scope: target.scope, resolutions: ['排除原因後重新 Plan 與 Apply'] })]
  });
}
