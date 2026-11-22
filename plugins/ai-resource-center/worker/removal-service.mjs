// LC-AI-Pack RemovalIntent：全部全域根、BackupAndRemove、保留 setup 與秘密（不 purge）。
import { displayPath } from './display-path.mjs';
import os from 'node:os';
import path from 'node:path';
import { resolveLcAiPackHome } from './paths.mjs';
import { badParams } from './contract.mjs';
import { createPathRules } from './deploy/canonical-root.mjs';
import { ReceiptStore, targetKeyOf } from './deploy/receipts.mjs';
import { tryAcquireTargetLock } from './deploy/target-lock.mjs';
import { executeRemovalTarget } from './deploy/apply-executor.mjs';
import { resolveOrcaAppData } from './deploy/orca-claude-mcp-cleanup.mjs';
import { blocking, ProblemCodes } from './deploy/problems.mjs';
import { createOperationStore } from './setup/operations.mjs';
import { openOperationLog } from './setup/operation-log.mjs';
import { createSecretMasker } from './setup/masker.mjs';
import { targetSummary } from './host-labels.mjs';
import { describeInstallProblems } from './install-problems.mjs';

export function createRemovalService({ installed, userHome = os.homedir(), lcaipackHome, env = process.env, platform = process.platform, detectTargets = () => [] }) {
  const home = lcaipackHome ?? resolveLcAiPackHome({ env, homedir: userHome });
  const rules = createPathRules();
  return {
    run(packageKey, targetIds = null, keepAndDetach = false) {
      // installed 的讀取入口統一處理損壞／新版收據；不載入專案 store 或市集。
      const records = installed.receipts({ globalOnly: true }).filter(r => r.packageKey === packageKey);
      if (!records.length) throw badParams('找不到這個資源包的安裝紀錄');
      const targets = [...new Map(records.map(r => [targetKeyOf(r), r])).entries()]
        .filter(([id]) => targetIds === null || targetIds.includes(id)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const operations = createOperationStore({ home });
      const operation = operations.create({ kind: 'remove', packageKey, packageVersion: records[0].packageVersion, scope: 'global' });
      const sessionNumber = operations.beginSession(operation.operationId);
      const log = openOperationLog({ logPath: operation.logPath, masker: createSecretMasker(), sessionNumber, reason: 'first-run' });
      try {
        if (keepAndDetach) log.writeNote('removal policy: keep-and-detach');
        log.writeNote('removal retained: setup-values,secrets,command-completions,setup-root');
        log.writeNote('removal purge: none');
        operations.transition(operation.operationId, 'running', 'removing');
        const succeeded = [], failed = [], backups = [], detached = [], warnings = [];
        let detected = [];
        try { detected = detectTargets(); } catch { /* 顯示路徑無法偵測時退回收據，不阻止解除安裝。 */ }
        for (const [id, receipt] of targets) {
          const target = { host: { hostId: receipt.hostId, surfaceId: receipt.surfaceId }, scope: 'global', canonicalRoot: receipt.canonicalRoot, targetKey: id, mutations: [] };
          const summary = targetSummary({ id, ...target.host, rootPath: displayPath(receipt, detected) });
          let lock = null, result;
          try {
            lock = tryAcquireTargetLock(path.join(home, 'locks'), id);
            if (lock && keepAndDetach) {
              const store = ReceiptStore.forGlobal({ home, userProfile: userHome, rules });
              const file = store.load();
              const kept = file.receipts.filter(r => r.scope === 'global' && r.packageKey === packageKey && targetKeyOf(r) === id);
              // 收據存的是正規化（小寫）路徑；顯示時把根目錄前綴換成偵測到的原大小寫，與其他面板路徑一致。
              const shown = p => typeof p === 'string' && p.toLowerCase().startsWith(String(receipt.canonicalRoot).toLowerCase())
                ? summary.rootPath + p.slice(String(receipt.canonicalRoot).length) : p;
              // 每個檔案或資料夾只列一行；MCP 設定檔只標示伺服器名稱，不逐一列出欄位。
              const byPath = new Map();
              for (const r of kept) {
                const where = shown(r.destinationPath);
                if (!byPath.has(where)) byPath.set(where, new Set());
                if (r.mutationKind === 'PatchConfig') {
                  const node = (r.ownedConfigFields?.[0] ?? '').replace(/^(?:mcpServers|mcp_servers)\./, '').split('.')[0];
                  byPath.get(where).add(node || r.contentId);
                }
              }
              const keptPaths = [...byPath].map(([where, servers]) => servers.size ? `${where}（MCP：${[...servers].join('、')}）` : where);
              file.receipts = file.receipts.filter(r => !kept.includes(r));
              store.save(file);
              detached.push({ ...summary, keptPaths });
              result = { status: 'Succeeded', backupPaths: [], problems: [] };
            } else result = lock ? executeRemovalTarget({ target, receiptStore: ReceiptStore.forGlobal({ home, userProfile: userHome, rules }) }, packageKey,
              { home, userHome, orcaAppDataDirectory: resolveOrcaAppData(platform, env, userHome) }, rules)
              : { status: 'Failed', backupPaths: [], problems: [blocking(ProblemCodes.lockUnavailable, '無法取得部署目標鎖定', '另一個程序正在操作這個位置，請稍後重試')] };
          } catch (error) {
            result = { status: 'Failed', backupPaths: [], problems: [blocking(ProblemCodes.applyFailed, '解除安裝失敗', error.message)] };
          } finally { lock?.release(); }
          if (result.status === 'Succeeded') {
            succeeded.push(summary);
            warnings.push(...result.problems.filter(p => p.severity === 'Warning'));
          }
          else failed.push({ ...summary, ...describeInstallProblems(result.problems.map(p => ({ ...p, action: 'uninstall',
            ...(result.residualPaths?.length ? { residualPaths: result.residualPaths, partiallyRestoredPaths: result.partiallyRestoredPaths } : {}) }))), backupPaths: result.backupPaths });
          backups.push(...result.backupPaths.map(backupPath => ({ ...summary, backupPath })));
          const outcome = result.status.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase());
          operations.recordTarget(operation.operationId, { targetKey: id, result: outcome, detail: failed.find(t => t.targetId === id)?.reason ?? null });
          log.writeTargetResult(id, outcome, result.planDigest ?? null);
        }
        operations.transition(operation.operationId, failed.length ? succeeded.length ? 'incomplete' : 'failed' : 'succeeded', failed.length ? succeeded.length ? 'remove-incomplete' : 'removing' : 'removed', failed[0]?.reason);
        return { ok: !failed.length, succeeded, failed, backups, ...(keepAndDetach ? { detached } : {}), ...(warnings.length ? { warnings } : {}) };
      } finally { log.close(); }
    }
  };
}
