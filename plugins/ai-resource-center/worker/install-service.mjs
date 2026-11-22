// 一鍵操作只選擇目標與整理結果；部署規則仍由既有 deploy service 負責。
import { describeInstallProblems } from './install-problems.mjs';
import { randomUUID } from 'node:crypto';
import { compareVersions, packageInput } from './package-service.mjs';
import { badParams, RcError, ErrorCode } from './contract.mjs';

import { targetSummary } from './host-labels.mjs';
import { HostIds, SurfaceIds } from './deploy/host-profiles.mjs';
import { pendingRoots } from './deploy/root-coverage.mjs';
const parameters = setup => (setup?.parameters ?? []).map(({ secretProvided, value, ...p }) => p.isSecret ? { ...p, isSet: secretProvided === true } : { ...p, value });

export function createInstallService({ packages, session, preferences, installed, storage, createDeploy, removal, log = () => {} }) {
  const pending = new Map();
  const running = new Set();
  const failureKey = packageKey => `resource-center.lastFailure.${packageKey}`;
  const backupKey = packageKey => `resource-center.backups.${packageKey}`;
  const detachedKey = packageKey => `resource-center.detached.${packageKey}`;
  const detachedFor = async packageKey => (await storage.get(detachedKey(packageKey))) ?? [];
  const backupsFor = async packageKey => (await storage.get(backupKey(packageKey))) ?? [];
  async function lastFailure(packageKey) {
    const saved = await storage.get(failureKey(packageKey));
    return saved?.targets?.length ? { count: saved.targets.length, ...(saved.action === 'uninstall' ? { action: 'uninstall' } : {}), targets: saved.targets.map(({ version, deployAction, ...t }) => t) } : null;
  }
  const skippedKey = packageKey => `resource-center.lastSkipped.${packageKey}`;
  async function lastSkipped(packageKey) {
    const saved = await storage.get(skippedKey(packageKey));
    return saved?.targets?.length ? { count: saved.targets.length, targets: saved.targets.map(({ version, ...t }) => t) } : null;
  }
  async function refreshSkipped(packageKey) {
    try {
      const saved = await storage.get(skippedKey(packageKey));
      if (!saved?.targets?.length) return;
      const deployments = installed.project(packageKey, null, installed.receipts({ globalOnly: true })).deployments;
      const version = deployments.map(d => d.version).sort((a, b) => compareVersions(b, a))[0];
      if (!version) return;
      // 與補裝相同版本／意圖；使用獨立規劃器，不影響等待確認中的操作，也絕不呼叫 apply。
      const deploy = createDeploy();
      const exact = { packageKey, version, previewMode: true, scope: 'global' };
      const { targets } = await deploy.listTargets(exact);
      const selected = targets.filter(t => saved.targets.some(old => old.targetId === t.id));
      if (!selected.length) return;
      const plan = await deploy.plan({ ...exact, action: 'install', targets: selected.map(t => t.id) });
      const blocked = confirmation({ groups: [{ selected, plan }] }).plan.blockedTargets;
      const remaining = saved.targets.flatMap(old => {
        // 消失或不再相容的位置無法確認，保留原紀錄。
        if (!selected.some(t => t.id === old.targetId)) return [old];
        const current = blocked.find(t => t.targetId === old.targetId);
        return current ? [{ ...old, ...current, version }] : [];
      });
      if (remaining.length) await storage.set(skippedKey(packageKey), { ...saved, targets: remaining });
      else await storage.delete(skippedKey(packageKey));
    } catch {
      // 不輸出可能含設定值的原始例外；失敗時不修改原略過紀錄、不阻止瀏覽。
      log(`[skipped-targets] 無法重新檢查 ${packageKey} 的略過目標，保留原紀錄`);
    }
  }
  async function selection(packageKey) {
    const previewMode = (await preferences.get()).showPreview;
    const detail = await packages.details(await session.requireClient(), { packageKey, previewMode });
    const version = detail.recommendedVersion;
    return { detail, version, previewMode };
  }
  async function prepare(input) {
    const origin = await session.identity();
    const { detail, version, previewMode } = await selection(input.packageKey);
    const receipts = installed.receipts({ globalOnly: true }).filter(receipt => receipt.packageKey === input.packageKey);
    const deployments = installed.project(input.packageKey, version, receipts).deployments;
    const newest = deployments.map(d => d.version).sort((a, b) => compareVersions(b, a))[0];
    const groups = [];
    const unavailable = [];
    const previous = await storage.get(failureKey(input.packageKey));
    const skippedBefore = (await storage.get(skippedKey(input.packageKey)))?.targets ?? [];
    if (input.action === 'retry' && (!previous?.targets?.length || input.targetIds.some(id => !previous.targets.some(t => t.targetId === id)))) throw badParams('只能重試上次失敗的位置');
    const strategies = {
      install: { versions: () => [version], action: () => 'install', select: c => c.compatible },
      update: { versions: () => [version], action: () => 'update', select: c => {
        const older = deployments.filter(d => d.source !== 'local' && compareVersions(d.version, c.nextVersion) < 0);
        const upgradesCodex = older.some(d => d.hostId === HostIds.codex);
        return c.targets.filter(t => older.some(d => d.id === t.id) || (older.length && c.pendingTargets.includes(t)) ||
          (upgradesCodex && t.origin === 'SharedSkills' && c.compatible.includes(t) && !deployments.some(d => d.id === t.id)));
      } },
      fillPending: { versions: () => newest ? [newest] : [], action: () => 'install', select: c => c.pendingTargets },
      reapply: { versions: () => [...new Set([...deployments.map(d => d.version), ...skippedBefore.map(t => t.version ?? newest)].filter(Boolean))], action: () => 'reconfigure',
        select: c => c.targets.filter(t => deployments.some(d => d.id === t.id && d.version === c.nextVersion)) },
      retry: { versions: () => [...new Set(previous.targets.filter(t => input.targetIds.includes(t.targetId)).map(t => t.version))],
        action: nextVersion => previous.targets.find(t => t.version === nextVersion && input.targetIds.includes(t.targetId)).deployAction,
        select: c => previous.targets.filter(t => input.targetIds.includes(t.targetId) && t.version === c.nextVersion)
          .map(t => c.targets.find(local => local.id === t.targetId)).filter(Boolean) }
    };
    const strategy = strategies[input.action];
    const versions = strategy.versions();
    for (const nextVersion of versions) {
      const deploy = createDeploy();
      const exact = { packageKey: input.packageKey, version: nextVersion, previewMode: true, scope: 'global' };
      const { targets, contents } = await deploy.listTargets(exact);
      if (input.action === 'retry') {
        unavailable.push(...previous.targets.filter(t => input.targetIds.includes(t.targetId) && t.version === nextVersion && !targets.some(local => local.id === t.targetId))
          .map(t => ({ ...t, reason: '找不到原本的部署位置，請確認工具與根目錄仍然存在' })));
      }
      const hosts = detail.versions.find(v => v.version === nextVersion)?.hosts
        ?? (await packages.details(await session.requireClient(), exact)).versions.find(v => v.version === nextVersion).hosts;
      const containsMcp = contents.some(c => c.kind === 'mcp');
      const compatible = targets.filter(t => hosts.includes(t.hostId) && (t.surfaceId !== SurfaceIds.claudeDesktop || containsMcp));
      const detached = await detachedFor(input.packageKey);
      const pendingTargets = pendingRoots({ targets: compatible, contents, receipts,
        excluded: [...(previous?.targets ?? []).map(target => target.targetId), ...detached] });
      const selected = strategy.select({ targets, compatible, pendingTargets, nextVersion });
      if (input.action !== 'retry') for (const old of skippedBefore) {
        if (input.action === 'reapply' && (old.version ?? newest) !== nextVersion) continue;
        const local = compatible.find(t => t.id === old.targetId);
        if (local && !selected.some(t => t.id === local.id)) selected.push(local);
      }
      if (!selected.length) continue;
      const missingTargets = selected.filter(t => input.action === 'fillPending' && t.origin !== 'SharedSkills' ||
        input.action === 'update' && pendingTargets.includes(t) && !deployments.some(d => d.id === t.id && compareVersions(d.version, nextVersion) < 0) ||
        input.action === 'retry' && previous.targets.some(f => f.targetId === t.id && f.missingContentOnly)).map(t => t.id);
      const planInput = { ...exact, action: strategy.action(nextVersion), targets: selected.map(t => t.id), missingTargets };
      const plan = await deploy.plan(planInput);
      const plannedTargets = plan.targets.map(t => targets.find(local => local.id === t.id)).filter(Boolean);
      groups.push({ deploy, selected: plannedTargets.length ? plannedTargets : selected, plan, version: nextVersion, planInput });
    }
    const current = await session.identity();
    if (origin?.marketUrl !== current?.marketUrl || origin?.account !== current?.account) throw new RcError(ErrorCode.planStale, '登入狀態或市集已改變，請重新執行安裝');
    return { input, groups, unavailable, origin };
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
  async function finish(state, authorized = false) {
    const review = confirmation(state);
    if (review.reasons.length && (!authorized || review.allBlocked || review.reasons.includes('missingParameters'))) {
      const planId = review.allBlocked ? null : randomUUID();
      if (planId) pending.set(planId, state);
      return { needsConfirmation: !review.allBlocked, ...review, planId };
    }
    const { succeeded, failed, skipped, backups, warnings } = state.output ??= { succeeded: [], skipped: [], failed: (state.unavailable ?? []).map(({ version, deployAction, ...t }) => t), backups: [], warnings: [] };
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
        return finish(state, false);
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
      return { ...t, version: group?.version ?? missing.version, deployAction: group?.planInput.action ?? missing.deployAction,
        ...(group?.planInput.missingTargets.includes(t.targetId) || missing?.missingContentOnly ? { missingContentOnly: true } : {}) };
    });
    const attempted = new Set([...succeeded, ...failed, ...skipped].map(t => t.targetId));
    targets.push(...(previous?.targets ?? []).filter(t => !attempted.has(t.targetId)));
    if (targets.length) await storage.set(failureKey(state.input.packageKey), { action: state.input.action === 'retry' ? previous.action : state.input.action, targets, backups });
    else await storage.delete(failureKey(state.input.packageKey));
    const skippedTargets = skipped.map(t => ({ ...t,
      version: state.groups.find(g => g.selected.some(s => s.id === t.targetId))?.version }));
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
      let changed = false;
      for (const g of state.groups.filter(g => !g.completed)) {
        const fresh = await g.deploy.plan(g.planInput);
        changed ||= fresh.planDigest !== g.plan.planDigest;
        g.plan = fresh;
      }
      return finish(state, !changed);
    }
    return finish(await prepare(input));
  }
  async function setup(input, save = false) {
    packageInput(input);
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
  return { run, cancel, setup, lastFailure, lastSkipped, refreshSkipped, backupsFor, detachedFor, discardPending() { pending.clear(); } };
}
