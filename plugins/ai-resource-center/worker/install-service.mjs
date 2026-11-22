// 一鍵操作只選擇目標與整理結果；部署規則仍由既有 deploy service 負責。
import { describeInstallProblems } from './install-problems.mjs';
import { randomUUID } from 'node:crypto';
import { compareVersions, packageInput } from './package-service.mjs';
import { badParams, RcError, ErrorCode } from './contract.mjs';

import { targetSummary, supportedTools } from './host-labels.mjs';
import { HostIds, SurfaceIds } from './deploy/host-profiles.mjs';
import { pendingRoots } from './deploy/root-coverage.mjs';
import { resolveSourceFolder, disposeArtifact, sourceExists, sourceMissingError, currentReceipt } from './local-source.mjs';
const parameters = setup => (setup?.parameters ?? []).map(({ secretProvided, value, ...p }) => p.isSecret ? { ...p, isSet: secretProvided === true } : { ...p, value });

// 部署來源鍵：市集版本為 market:<版號>；從資料夾安裝的開發中版本一律從記錄的來源資料夾重新打包，為 local:<來源資料夾>
// （對照 InstalledViewModel 的重裝／補裝：IsLocalSource 時以 SourceFolderArtifactResolver 解析 SourcePath）。
const marketKey = version => `market:${version}`;
const localKey = folder => `local:${folder}`;
const keyOfDeployment = d => d.source === 'local' ? localKey(d.sourcePath ?? '') : marketKey(d.version);
const keyOfRecord = (t, fallback = null) => t.sourcePath ? localKey(t.sourcePath) : t.version ? marketKey(t.version) : fallback;
const localFolderOf = key => key?.startsWith('local:') ? key.slice(6) : null;

export function createInstallService({ packages, session, preferences, installed, storage, createDeploy, removal, log = () => {}, tempRoot }) {
  const pending = new Map();
  const running = new Set();
  const failureKey = packageKey => `resource-center.lastFailure.${packageKey}`;
  const backupKey = packageKey => `resource-center.backups.${packageKey}`;
  const detachedKey = packageKey => `resource-center.detached.${packageKey}`;
  const detachedFor = async packageKey => (await storage.get(detachedKey(packageKey))) ?? [];
  const backupsFor = async packageKey => (await storage.get(backupKey(packageKey))) ?? [];
  async function lastFailure(packageKey) {
    const saved = await storage.get(failureKey(packageKey));
    return saved?.targets?.length ? { count: saved.targets.length, ...(saved.action === 'uninstall' ? { action: 'uninstall' } : {}), targets: saved.targets.map(({ version, deployAction, sourcePath, ...t }) => t) } : null;
  }
  const skippedKey = packageKey => `resource-center.lastSkipped.${packageKey}`;
  async function lastSkipped(packageKey) {
    const saved = await storage.get(skippedKey(packageKey));
    return saved?.targets?.length ? { count: saved.targets.length, targets: saved.targets.map(({ version, sourcePath, ...t }) => t) } : null;
  }
  async function refreshSkipped(packageKey) {
    const scratch = { artifacts: new Map() };
    try {
      const saved = await storage.get(skippedKey(packageKey));
      if (!saved?.targets?.length) return;
      const deployments = installed.project(packageKey, null, installed.receipts({ globalOnly: true })).deployments;
      const key = newestKey(deployments);
      if (!key) return;
      // 與補裝相同版本／意圖；使用獨立規劃器，不影響等待確認中的操作，也絕不呼叫 apply。
      const deploy = createDeploy();
      const exact = await exactFor(scratch, packageKey, key);
      const { targets } = await deploy.listTargets(exact);
      const selected = targets.filter(t => saved.targets.some(old => old.targetId === t.id));
      if (!selected.length) return;
      const plan = await deploy.plan({ ...exact, action: 'install', targets: selected.map(t => t.id) });
      const blocked = confirmation({ groups: [{ selected, plan }] }).plan.blockedTargets;
      const remaining = saved.targets.flatMap(old => {
        // 消失或不再相容的位置無法確認，保留原紀錄。
        if (!selected.some(t => t.id === old.targetId)) return [old];
        const current = blocked.find(t => t.targetId === old.targetId);
        return current ? [{ ...old, ...current, version: exact.version, ...(exact.localSource ? { sourcePath: exact.localSource.folder } : {}) }] : [];
      });
      if (remaining.length) await storage.set(skippedKey(packageKey), { ...saved, targets: remaining });
      else await storage.delete(skippedKey(packageKey));
    } catch {
      // 不輸出可能含設定值的原始例外；失敗時不修改原略過紀錄、不阻止瀏覽。
      log(`[skipped-targets] 無法重新檢查 ${packageKey} 的略過目標，保留原紀錄`);
    } finally { await disposeState(scratch); }
  }
  /** 目前版本的部署來源鍵（對照 CurrentReceipt）：版號最高；同版號時本機來源優先。 */
  function newestKey(deployments) {
    const newest = currentReceipt(deployments.map(d => ({ ...d, packageVersion: d.version })));
    return newest ? keyOfDeployment(newest) : null;
  }
  async function disposeState(state) {
    const artifacts = [...(state.artifacts?.values() ?? [])];
    state.artifacts?.clear();
    await Promise.all(artifacts.map(disposeArtifact));
  }
  /** 本機來源：同一次操作內同一來源資料夾只打包一次；來源不存在、預檢不過或識別碼已改變時回錯誤。 */
  async function localArtifact(state, packageKey, folder) {
    if (!state.artifacts.has(folder)) {
      if (!sourceExists(folder)) throw sourceMissingError(folder);
      const { inspection, artifact } = await resolveSourceFolder(folder, { tempRoot });
      if (!artifact) throw new RcError(ErrorCode.invalidPackage, `來源資料夾未通過預檢：${inspection.blocking[0]?.message ?? '請修正後重試'}`);
      state.artifacts.set(folder, artifact);
    }
    const artifact = state.artifacts.get(folder);
    if (artifact.key !== packageKey) throw badParams(`來源資料夾的 lcpack.json 識別碼已改為 ${artifact.key}，與已安裝的 ${packageKey} 不同`);
    return artifact;
  }
  async function exactFor(state, packageKey, key) {
    const folder = localFolderOf(key);
    if (folder === null) return { packageKey, version: key.slice(7), previewMode: true, scope: 'global' };
    const artifact = await localArtifact(state, packageKey, folder);
    return { packageKey, version: artifact.version, previewMode: true, scope: 'global',
      localSource: { folder: artifact.folder, zipPath: artifact.zipPath, sha256: artifact.sha256 } };
  }
  async function selection(packageKey) {
    const previewMode = (await preferences.get()).showPreview;
    const detail = await packages.details(await session.requireClient(), { packageKey, previewMode });
    const version = detail.recommendedVersion;
    return { detail, version, previewMode };
  }
  async function prepare(input, sideload = null) {
    const state = { input, groups: [], unavailable: [], artifacts: new Map(), ...(sideload ? { sideload: true } : {}) };
    try {
      state.origin = await session.identity();
      // 市集推薦版本只在安裝與更新需要；開發中版本的補裝、重新套用與重試不呼叫市集（市集可能沒有此資源包）。
      let market = null;
      const marketSelection = async () => market ??= await selection(input.packageKey);
      if (sideload) state.artifacts.set(sideload.folder, sideload);
      const version = !sideload && ['install', 'update'].includes(input.action) ? (await marketSelection()).version : null;
      const receipts = installed.receipts({ globalOnly: true }).filter(receipt => receipt.packageKey === input.packageKey);
      const deployments = installed.project(input.packageKey, version, receipts).deployments;
      const newest = newestKey(deployments);
      const previous = await storage.get(failureKey(input.packageKey));
      const skippedBefore = (await storage.get(skippedKey(input.packageKey)))?.targets ?? [];
      if (input.action === 'retry' && (!previous?.targets?.length || input.targetIds.some(id => !previous.targets.some(t => t.targetId === id)))) throw badParams('只能重試上次失敗的位置');
      const retried = t => input.targetIds.includes(t.targetId);
      const strategies = {
        install: { keys: () => [sideload ? localKey(sideload.folder) : marketKey(version)], action: () => 'install', select: c => c.compatible },
        update: { keys: () => [marketKey(version)], action: () => 'update', select: c => {
          const older = deployments.filter(d => d.source !== 'local' && compareVersions(d.version, c.nextVersion) < 0);
          const upgradesCodex = older.some(d => d.hostId === HostIds.codex);
          return c.targets.filter(t => older.some(d => d.id === t.id) || (older.length && c.pendingTargets.includes(t)) ||
            (upgradesCodex && t.origin === 'SharedSkills' && c.compatible.includes(t) && !deployments.some(d => d.id === t.id)));
        } },
        fillPending: { keys: () => newest ? [newest] : [], action: () => 'install', select: c => c.pendingTargets },
        reapply: { keys: () => [...new Set([...deployments.map(keyOfDeployment), ...skippedBefore.map(t => keyOfRecord(t, newest))].filter(Boolean))], action: () => 'reconfigure',
          select: c => c.targets.filter(t => deployments.some(d => d.id === t.id && keyOfDeployment(d) === c.key)) },
        retry: { keys: () => [...new Set(previous.targets.filter(retried).map(t => keyOfRecord(t)))],
          action: key => previous.targets.find(t => keyOfRecord(t) === key && retried(t)).deployAction,
          select: c => previous.targets.filter(t => retried(t) && keyOfRecord(t) === c.key)
            .map(t => c.targets.find(local => local.id === t.targetId)).filter(Boolean) }
      };
      const strategy = strategies[input.action];
      for (const key of strategy.keys()) {
        const deploy = createDeploy();
        const exact = await exactFor(state, input.packageKey, key);
        const nextVersion = exact.version;
        const { targets, contents } = await deploy.listTargets(exact);
        if (input.action === 'retry') {
          state.unavailable.push(...previous.targets.filter(t => retried(t) && keyOfRecord(t) === key && !targets.some(local => local.id === t.targetId))
            .map(t => ({ ...t, reason: '找不到原本的部署位置，請確認工具與根目錄仍然存在' })));
        }
        // 開發中版本沒有市集的相容工具清單：與 LC-AI-Pack 從資料夾安裝相同，列出所有支援的 AI 工具（Claude Desktop 仍只在含 MCP 時列入）。
        const hosts = exact.localSource ? null : (await marketSelection()).detail.versions.find(v => v.version === nextVersion)?.hosts
          ?? (await packages.details(await session.requireClient(), exact)).versions.find(v => v.version === nextVersion).hosts;
        const containsMcp = contents.some(c => c.kind === 'mcp');
        const compatible = targets.filter(t => (hosts === null || hosts.includes(t.hostId)) && (t.surfaceId !== SurfaceIds.claudeDesktop || containsMcp));
        const detached = await detachedFor(input.packageKey);
        const pendingTargets = pendingRoots({ targets: compatible, contents, receipts,
          excluded: [...(previous?.targets ?? []).map(target => target.targetId), ...detached] });
        const selected = strategy.select({ targets, compatible, pendingTargets, nextVersion, key });
        if (input.action !== 'retry') for (const old of skippedBefore) {
          if (input.action === 'reapply' && keyOfRecord(old, newest) !== key) continue;
          const local = compatible.find(t => t.id === old.targetId);
          if (local && !selected.some(t => t.id === local.id)) selected.push(local);
        }
        if (!selected.length) continue;
        const missingTargets = selected.filter(t => input.action === 'fillPending' && t.origin !== 'SharedSkills' ||
          input.action === 'update' && pendingTargets.includes(t) && !deployments.some(d => d.id === t.id && compareVersions(d.version, nextVersion) < 0) ||
          input.action === 'retry' && previous.targets.some(f => f.targetId === t.id && f.missingContentOnly)).map(t => t.id);
        const planInput = { ...exact, action: strategy.action(key), targets: selected.map(t => t.id), missingTargets };
        const plan = await deploy.plan(planInput);
        const plannedTargets = plan.targets.map(t => targets.find(local => local.id === t.id)).filter(Boolean);
        state.groups.push({ deploy, selected: plannedTargets.length ? plannedTargets : selected, plan, version: nextVersion, key,
          ...(exact.localSource ? { sourcePath: exact.localSource.folder } : {}), planInput });
      }
      const current = await session.identity();
      if (state.origin?.marketUrl !== current?.marketUrl || state.origin?.account !== current?.account) throw new RcError(ErrorCode.planStale, '登入狀態或市集已改變，請重新執行安裝');
      return state;
    } catch (e) {
      await disposeState(state);
      throw e;
    }
  }
  function confirmation(state) {
    const missingParameters = [], setupCommands = [], blocked = [];
    let deployableCount = 0;
    for (const g of state.groups.filter(g => !g.completed)) {
      deployableCount += g.plan.deployableCount;
      missingParameters.push(...parameters(g.plan.setup).filter(p => p.required && p.needsInput));
      setupCommands.push(...(g.plan.setup?.commands ?? []));
      for (const t of g.plan.targets.filter(t => !t.canApply)) {
        blocked.push({ ...targetSummary(g.selected.find(s => s.id === t.id)), ...describeInstallProblems(t.problems.filter(p => p.severity === 'Blocking')) });
      }
      const globalProblems = g.plan.problems.filter(p => p.severity === 'Blocking' && p.code !== 'deployment.setup-parameter-missing');
      if (globalProblems.length) {
        for (const t of g.selected.filter(t => !blocked.some(b => b.targetId === t.id))) blocked.push({ ...targetSummary(t), ...describeInstallProblems(globalProblems) });
        deployableCount -= g.plan.deployableCount;
      }
    }
    const reasons = [...(missingParameters.length ? ['missingParameters'] : []), ...(setupCommands.some(c => c.willExecute) ? ['setupCommands'] : []), ...(blocked.length ? ['blockedTargets'] : [])];
    const allBlocked = deployableCount === 0 && blocked.length > 0;
    return { reasons, allBlocked, plan: { deployableCount, blockedTargets: blocked, setupCommands, missingParameters } };
  }
  /** 從資料夾安裝的摘要：將安裝到的 AI 工具（可部署的目標，依工具去重）。 */
  function toolsOf(state) {
    const deployable = state.groups.flatMap(g => g.plan.targets.filter(t => t.canApply).map(t => g.selected.find(s => s.id === t.id)).filter(Boolean));
    return supportedTools.filter(tool => deployable.some(tool.matches)).map(({ hostId, label }) => ({ hostId, label }));
  }
  /** 等待確認的計畫只保留一份含暫存打包產物的狀態（同一資源包）；被取代的狀態立即刪除暫存 ZIP。 */
  async function supersede(state) {
    if (!state.artifacts?.size) return;
    for (const [planId, other] of [...pending]) {
      if (other === state || other.input.packageKey !== state.input.packageKey || !other.artifacts?.size) continue;
      pending.delete(planId);
      await disposeState(other);
    }
  }
  // 暫存打包產物在完成、取消或失敗後刪除；只有仍在等待確認的計畫保留。
  async function finish(state, authorized = false) {
    let response;
    try { response = await finishCore(state, authorized); }
    catch (e) { await disposeState(state); throw e; }
    if (!response.planId) await disposeState(state);
    return response;
  }
  async function finishCore(state, authorized) {
    const review = confirmation(state);
    // 規格 §5：從資料夾安裝一律先顯示摘要，使用者按「安裝」後才套用（之後只在例外時再確認）。
    const reviewRequired = state.sideload === true && !state.reviewed;
    if ((review.reasons.length || reviewRequired) && (!authorized || review.allBlocked || review.reasons.includes('missingParameters'))) {
      const planId = review.allBlocked ? null : randomUUID();
      if (planId) { await supersede(state); pending.set(planId, state); }
      return { needsConfirmation: !review.allBlocked, ...review, planId, ...(state.sideload ? { ...state.review, tools: toolsOf(state) } : {}) };
    }
    const { succeeded, failed, skipped, backups, warnings } = state.output ??= { succeeded: [], skipped: [], failed: (state.unavailable ?? []).map(({ version, deployAction, sourcePath, ...t }) => t), backups: [], warnings: [] };
    for (const g of state.groups.filter(g => !g.completed)) {
      let result;
      if (state.cancelled) {
        result = { targets: g.selected.map(t => {
          const planned = g.plan.targets.find(p => p.id === t.id);
          return { id: t.id, status: planned.canApply ? 'notDeployed' : 'skipped', backupPaths: [], problems: planned.canApply ? [
            { code: 'deployment.setup-cancelled', severity: 'Blocking', summary: '已取消設定，尚未完成安裝' }
          ] : planned.problems.filter(p => p.severity === 'Blocking') };
        }) };
      } else {
        const operation = { state, deploy: g.deploy };
        running.add(operation);
        try { result = await g.deploy.apply({ planDigest: g.plan.planDigest, targets: g.planInput.targets }); }
        finally { running.delete(operation); }
      }
      if (result.status === 'stale') {
        g.plan = result.plan;
        if ((state.staleCount = (state.staleCount ?? 0) + 1) > 5) throw new RcError(ErrorCode.planStale, '本機狀態持續變動，請稍後重試');
        return finishCore(state, false);
      }
      for (const local of g.selected) {
        const target = result.targets.find(t => t.id === local.id) ?? { status: 'failed', backupPaths: [],
          problems: result.problems?.length ? result.problems : g.plan.problems.filter(p => p.severity === 'Blocking') };
        const summary = targetSummary(local);
        if (target.status === 'succeeded') {
          succeeded.push(summary);
          warnings.push(...target.problems.filter(p => p.severity === 'Warning'));
        }
        else if (review.plan.blockedTargets.some(t => t.targetId === local.id)) skipped.push(review.plan.blockedTargets.find(t => t.targetId === local.id));
        else {
          const cancelled = result.status === 'cancelled' && target.status === 'notDeployed';
          const problems = cancelled ? [{ code: 'deployment.setup-cancelled', severity: 'Blocking', summary: '已取消設定，尚未完成安裝' }, ...target.problems] : target.problems;
          failed.push({ ...summary, ...describeInstallProblems(problems), ...(cancelled ? { reason: '已取消設定，尚未完成安裝' } : {}), backupPaths: target.backupPaths });
        }
        backups.push(...target.backupPaths.map(backupPath => ({ ...summary, backupPath })));
      }
      g.completed = true;
    }
    const previous = await storage.get(failureKey(state.input.packageKey));
    const targets = failed.map(t => {
      const group = state.groups.find(g => g.selected.some(s => s.id === t.targetId));
      const missing = state.unavailable?.find(s => s.targetId === t.targetId);
      const sourcePath = group ? group.sourcePath : missing.sourcePath;
      return { ...t, version: group?.version ?? missing.version, deployAction: group?.planInput.action ?? missing.deployAction, ...(sourcePath ? { sourcePath } : {}),
        ...(group?.planInput.missingTargets.includes(t.targetId) || missing?.missingContentOnly ? { missingContentOnly: true } : {}) };
    });
    const attempted = new Set([...succeeded, ...failed, ...skipped].map(t => t.targetId));
    targets.push(...(previous?.targets ?? []).filter(t => !attempted.has(t.targetId)));
    if (targets.length) await storage.set(failureKey(state.input.packageKey), { action: state.input.action === 'retry' ? previous.action : state.input.action, targets, backups });
    else await storage.delete(failureKey(state.input.packageKey));
    const skippedTargets = skipped.map(t => {
      const group = state.groups.find(g => g.selected.some(s => s.id === t.targetId));
      return { ...t, version: group?.version, ...(group?.sourcePath ? { sourcePath: group.sourcePath } : {}) };
    });
    if (state.input.action === 'retry') skippedTargets.push(...((await storage.get(skippedKey(state.input.packageKey)))?.targets ?? []).filter(t => !attempted.has(t.targetId)));
    if (skippedTargets.length) await storage.set(skippedKey(state.input.packageKey), { targets: skippedTargets });
    else await storage.delete(skippedKey(state.input.packageKey));
    if (backups.length) {
      const all = [...await backupsFor(state.input.packageKey), ...backups];
      await storage.set(backupKey(state.input.packageKey), [...new Map(all.map(b => [b.backupPath, b])).values()]);
    }
    if (state.input.action === 'install' && succeeded.length) await storage.delete(detachedKey(state.input.packageKey));
    return { ok: !failed.length, succeeded, failed, skipped, backups, ...(warnings.length ? { warnings } : {}) };
  }
  async function run(input) {
    packageInput(input);
    if (!['install', 'update', 'fillPending', 'reapply', 'retry', 'uninstall', 'detach'].includes(input.action) || (input.confirmedPlanId !== undefined && typeof input.confirmedPlanId !== 'string') ||
      input.scope !== undefined || input.projectRoot !== undefined || input.version !== undefined || input.targets !== undefined) throw badParams('安裝動作格式錯誤');
    if (['retry', 'detach'].includes(input.action) ? !Array.isArray(input.targetIds) || !input.targetIds.length || input.targetIds.some(t => typeof t !== 'string' || !t.length) || new Set(input.targetIds).size !== input.targetIds.length : input.targetIds !== undefined) throw badParams('重試或停止管理的位置格式錯誤');
    const previous = await storage.get(failureKey(input.packageKey));
    if (input.action === 'detach') {
      if (input.confirmedPlanId !== undefined || previous?.action !== 'uninstall' ||
        input.targetIds.some(id => !previous.targets?.some(t => t.targetId === id))) throw badParams('只能停止管理上一次解除安裝失敗的位置');
      const records = installed.receipts({ globalOnly: true });
      if (input.targetIds.some(id => !records.some(r => r.packageKey === input.packageKey && `${r.hostId}|${r.surfaceId}|${r.scope}|${r.canonicalRoot}` === id))) throw badParams('找不到指定位置的全域部署收據');
      const result = removal.run(input.packageKey, input.targetIds, true);
      const completed = new Set(result.detached.map(t => t.targetId));
      if (completed.size) await storage.set(detachedKey(input.packageKey), [...new Set([...await detachedFor(input.packageKey), ...completed])]);
      const targets = previous.targets.filter(t => !completed.has(t.targetId));
      if (targets.length) await storage.set(failureKey(input.packageKey), { ...previous, targets });
      else await storage.delete(failureKey(input.packageKey));
      return { ...result, skipped: [] };
    }
    if (input.action === 'uninstall' || (input.action === 'retry' && previous?.action === 'uninstall')) {
      if (input.confirmedPlanId !== undefined) throw badParams('解除安裝不使用部署確認識別碼');
      if (input.action === 'retry' && input.targetIds.some(id => !previous.targets.some(t => t.targetId === id))) throw badParams('只能重試上次失敗的位置');
      const result = removal.run(input.packageKey, input.action === 'retry' ? input.targetIds : null);
      const attempted = new Set([...result.succeeded, ...result.failed].map(t => t.targetId));
      const targets = [...result.failed, ...(input.action === 'retry' ? previous.targets.filter(t => !attempted.has(t.targetId)) : [])];
      if (targets.length) await storage.set(failureKey(input.packageKey), { action: 'uninstall', targets, backups: result.backups });
      else await storage.delete(failureKey(input.packageKey));
      if (result.backups.length) await storage.set(backupKey(input.packageKey), [...new Map([...await backupsFor(input.packageKey), ...result.backups].map(b => [b.backupPath, b])).values()]);
      await storage.delete(skippedKey(input.packageKey));
      return { ...result, skipped: [] };
    }
    if (input.confirmedPlanId) {
      const state = pending.get(input.confirmedPlanId);
      const origin = await session.identity();
      if (!state || state.input.packageKey !== input.packageKey || state.input.action !== input.action ||
        JSON.stringify(state.input.targetIds) !== JSON.stringify(input.targetIds) || state.origin?.marketUrl !== origin?.marketUrl || state.origin?.account !== origin?.account) throw new RcError(ErrorCode.planStale, '確認已失效，請重新執行安裝');
      pending.delete(input.confirmedPlanId);
      state.reviewed = true;
      let changed = false;
      try {
        for (const g of state.groups.filter(g => !g.completed)) {
          const fresh = await g.deploy.plan(g.planInput);
          changed ||= fresh.planDigest !== g.plan.planDigest;
          g.plan = fresh;
        }
      } catch (e) { await disposeState(state); throw e; }
      return finish(state, !changed);
    }
    return finish(await prepare(input));
  }
  async function setup(input, save = false) {
    packageInput(input);
    if (input.planId !== undefined) {
      // 從資料夾安裝的確認畫面：設定參數依暫存打包的確切資源包解析與儲存，不呼叫市集。
      const state = typeof input.planId === 'string' ? pending.get(input.planId) : null;
      if (!state || state.input.packageKey !== input.packageKey) throw new RcError(ErrorCode.planStale, '確認已失效，請重新執行安裝');
      const local = state.groups.find(g => g.planInput.localSource);
      if (local) {
        const { planId, ...rest } = input;
        return parameters(await createDeploy().packageSetup({ ...rest, version: local.version, previewMode: true, localSource: local.planInput.localSource }, save));
      }
    }
    if (input.version === undefined) {
      // 目前安裝的是開發中版本：設定參數依來源資料夾重新打包的確切內容解析（市集可能沒有此資源包）。
      const current = currentReceipt((installed.tryReceipts({ globalOnly: true }).records ?? []).filter(r => r.packageKey === input.packageKey));
      if (current?.source === 'local') {
        const scratch = { artifacts: new Map() };
        try {
          const { planId, ...rest } = input;
          return parameters(await createDeploy().packageSetup({ ...rest, ...await exactFor(scratch, input.packageKey, localKey(current.sourcePath)) }, save));
        } finally { await disposeState(scratch); }
      }
    }
    const { version, previewMode } = await selection(input.packageKey);
    const result = await createDeploy().packageSetup({ ...input, version: input.version ?? version, previewMode: input.version ? true : previewMode }, save);
    return parameters(result);
  }
  function cancel(input) {
    packageInput(input);
    let cancelled = false;
    for (const operation of running) {
      if (operation.state.input.packageKey !== input.packageKey) continue;
      if (operation.deploy.cancel().cancelled) { operation.state.cancelled = true; cancelled = true; }
    }
    return { cancelled };
  }
  /**
   * 從資料夾安裝（開發中版本）：本機打包規則預檢 → 打包到暫存目錄 → 以 channel ''、localSourcePath 規劃到所有偵測到的相容 AI 工具全域根目錄
   * （目標選擇與一鍵安裝相同）。預檢有阻擋項時不規劃；通過時一律回傳摘要等待使用者按「安裝」（以 rc.install.run 的 confirmedPlanId 套用）。
   */
  async function installFromFolder(folder) {
    const { inspection, artifact } = await resolveSourceFolder(folder, { tempRoot });
    const { summary, disclosures } = inspection;
    if (!artifact) return { precheckFailed: true, blocking: inspection.blocking, disclosures, summary };
    let state;
    try {
      // 本機已裝市集版時提示將被取代；同一個開發中版本重裝（只有本機來源收據）不提示。
      const replacesMarketVersion = installed.receipts({ globalOnly: true }).filter(r => r.packageKey === artifact.key && r.source !== 'local')
        .map(r => r.packageVersion).sort((a, b) => compareVersions(b, a))[0] ?? null;
      state = await prepare({ packageKey: artifact.key, action: 'install' }, artifact);
      state.review = { packageKey: artifact.key, version: artifact.version, sourcePath: folder, summary, disclosures, replacesMarketVersion };
    } catch (e) { await disposeArtifact(artifact); throw e; }
    return finish(state);
  }
  /** 關閉尚未套用的確認畫面：丟棄等待確認的計畫並刪除暫存打包產物。 */
  async function discard(planId) {
    const state = typeof planId === 'string' ? pending.get(planId) : null;
    if (!state) return { discarded: false };
    pending.delete(planId);
    await disposeState(state);
    return { discarded: true };
  }
  return { run, cancel, setup, installFromFolder, discard, lastFailure, lastSkipped, refreshSkipped, backupsFor, detachedFor,
    discardPending() { for (const state of pending.values()) void disposeState(state); pending.clear(); } };
}
