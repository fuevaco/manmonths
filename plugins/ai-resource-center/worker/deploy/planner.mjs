// 安裝與更新共用的規劃／套用入口（對照 Deployment/DeploymentPlanner.cs）。
// - plan：對目標零寫入、不建立目錄、不執行外部命令、不變更收據；
// - apply：只接受使用者剛審核的那份計畫（摘要綁定），逐部署目標在鎖定內重新規劃並比對，
//   一致才在獨立交易中寫入，允許部分成功。
//
// intent 形狀（對照 DeploymentIntent）：
//   { package: {bytes, expectedSha256}, scope: 'global', hosts: [{hostId, surfaceId}],
//     existingContent: 'Block'|'BackupAndReplace', allowScopeShadowing, hostRoots: [{host, canonicalRoots: []}], localSourcePath }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPathRules } from './canonical-root.mjs';
import { HostProfiles, HostIds, HostLocatorIds, Scope, MutationKind, Severity } from './host-profiles.mjs';
import { openCanonicalPackage, CanonicalPackageError } from './canonical-package.mjs';
import { ReceiptStore } from './receipts.mjs';
import { buildOwnershipIndex } from './ownership-index.mjs';
import { computePlanDigest, computeTargetDigest, ContractVersion } from './plan-digest.mjs';
import { checkSharedSkillsDirectory } from './codex-roots.mjs';
import { getDriver } from './resource-drivers.mjs';
import { ProblemCodes, blocking, warning, problem as makeProblem } from './problems.mjs';
import { ofBytes, ofText, ordinal } from './digest.mjs';
import { tryAcquireTargetLock } from './target-lock.mjs';
import { executeTarget, diagnosticId } from './apply-executor.mjs';
import { createSharedConfigLedger } from './shared-config-ledger.mjs';
import { planSetup, computeSetupDigest, SetupIntent } from '../setup/planning.mjs';
import { createRunnerRegistry, detectSetupEnvironment } from '../setup/runners.mjs';
import { createSecretManager, createDefaultSecretStore, SetupSecretStoreError } from '../setup/secrets.mjs';
import { buildSetupRenderContext, runtimeSecretIds, buildLaunchDescriptor, saveLaunchDescriptor } from '../setup/managed-mcp.mjs';
import { resolveLaunch } from './mcp-node-renderer.mjs';

const isBlocking = (p) => p.severity === Severity.blocking;
const sameHost = (a, b) => a.hostId === b.hostId && a.surfaceId === b.surfaceId;
const targetKeyOf = (host, scope, root) => `${host.hostId}|${host.surfaceId}|${scope}|${root}`;

/** 把宣告的 shell 命令拆成 executable 與 arguments；只用於顯示，不執行。 */
export function splitShellCommand(command) {
  const parts = []; let current = ''; let inQuotes = false;
  for (const ch of command.trim()) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ' ' && !inQuotes) { if (current) { parts.push(current); current = ''; } }
    else current += ch;
  }
  if (current) parts.push(current);
  return parts.length ? { executable: parts[0], arguments: parts.slice(1) } : { executable: '', arguments: [] };
}

/**
 * 差異（ADR 0002）：LC-AI-Pack 的計畫只要有一個目標受阻就整份不可套用。資源中心改為「至少有一個可部署的目標、
 * 且沒有計畫層級的阻擋（資源包格式、設定參數與設定命令前置條件）」即可確認；受阻的目標維持原狀並列出原因。
 */
export function withCanApply(plan) {
  return { ...plan, canApply: plan.problems.every(p => !isBlocking(p)) && plan.targets.some(t => t.canApply) };
}

/** 計畫中可部署與受阻的目標；套用只作用在可部署的目標。 */
export const deployableTargets = (plan) => plan.targets.filter(t => t.canApply);
export const blockedTargets = (plan) => plan.targets.filter(t => !t.canApply);

/**
 * @param {object} options
 * @param {string} options.home        LC-AI-Pack 資料目錄（收據、鎖定）
 * @param {string} [options.userHome]  使用者家目錄（全域收據的正規化根目錄）
 * @param {string} options.clientVersion  寫入收據的用戶端版本（Orca 外掛版本）
 * @param {string} [options.channel]   寫入收據的版本通道
 * @param {string[]} [options.shadowingProjectRoots]
 * @param {number} [options.lockTimeoutMs]
 * @param {object} [options.secrets]  秘密存取層（createSecretManager）；預設為作業系統安全儲存區，只在資源包宣告秘密時建立
 * @param {string} [options.mcpLauncherPath]  受管 MCP launcher 可執行檔；未提供時需要執行期秘密的 MCP 受阻
 * @param {{intent?: string, runners?: object, environment?: {operatingSystem: string, architecture: string}}} [options.setupPlanning]
 *        設定命令規劃選項（對照 SetupPlanningOptions）：意圖（決定同版略過、更新重跑與重新設定）、固定 runner registry、權威本機環境；測試可注入替身。
 */
export function createDeploymentPlanner(options) {
  const rules = options.rules ?? createPathRules();
  const userHome = options.userHome ?? os.homedir();
  const channel = options.channel ?? 'release';
  const opts = { ...options, channel, userHome };
  const operatingSystem = opts.operatingSystem ?? (process.platform === 'darwin' ? 'macos' : 'windows');
  const setupIntent = opts.setupPlanning?.intent ?? SetupIntent.install;
  const setupRunners = opts.setupPlanning?.runners ?? createRunnerRegistry();
  const setupEnvironment = opts.setupPlanning?.environment ?? { operatingSystem, architecture: detectSetupEnvironment().architecture };
  let defaultSecrets = null;
  // 只有真的查詢秘密時才建立平台安全儲存區（對照 SetupSecretStores.CreateNone 的用意）。
  const secrets = () => opts.secrets ?? (defaultSecrets ??= createSecretManager({
    existsMany: keys => createDefaultSecretStore().existsMany(keys), get: key => createDefaultSecretStore().get(key),
    set: (key, value) => createDefaultSecretStore().set(key, value), delete: key => createDefaultSecretStore().delete(key) }, rules));

  /** 規劃安裝設定；沒有 setup 的資源包回傳 null。安全儲存區無法查詢時回傳阻擋問題（對照 PlanSetup）。 */
  function planSetupFor(pkg, intent) {
    const setup = pkg.manifest.setup;
    if (!setup || ((setup.parameters?.length ?? 0) + (setup.commands?.length ?? 0)) === 0) return { setupPlan: null };
    try {
      return { setupPlan: planSetup({ setup, packageKey: pkg.identity.key, packageVersion: pkg.identity.version, scope: intent.scope,
        projectRoot: null, home: opts.home, userHome, secrets: secrets(), rules,
        intent: setupIntent, runners: setupRunners, environment: setupEnvironment, scriptSha256: script => ofBytes(pkg.readFile(script)) }) };
    } catch (e) {
      if (e instanceof CanonicalPackageError) return { problem: { ...e.toProblem(), explanation: `設定命令的腳本不在資源包內：${e.message}` } };
      if (!(e instanceof SetupSecretStoreError)) throw e;
      return { problem: blocking(ProblemCodes.secretUnresolved, '無法查詢作業系統安全儲存區', e.message) };
    }
  }

  function rejected(intent, p, pkg = null) {
    const identity = pkg?.identity ?? { key: '(unknown)', version: '(unknown)', type: '(unknown)', name: '(unknown)' };
    const sha = pkg?.sha256 ?? intent.package?.expectedSha256 ?? '';
    return withCanApply({ contractVersion: ContractVersion, planDigest: computePlanDigest(identity, sha, intent, [], rules),
      package: identity, sourceSha256: sha, intent, targets: [], problems: [p] });
  }

  function resolveCanonicalRoots(intent, host) {
    if (intent.scope === Scope.global) {
      const requested = (intent.hostRoots ?? []).filter(s => sameHost(s.host, host)).flatMap(s => s.canonicalRoots);
      let roots = requested;
      if (roots.length === 0) {
        const locator = HostProfiles.find(host.hostId)?.findSurface(host.surfaceId)?.locatorFor(Scope.global);
        if (locator !== HostLocatorIds.userHome) {
          return { problem: blocking(ProblemCodes.unsupportedHost, `${host.hostId}／${host.surfaceId} 的安裝位置必須由偵測取得，本次沒有偵測結果`,
            '請確認該用戶端已安裝並重新偵測部署目標後重試。', { host, scope: Scope.global }) };
        }
        roots = [userHome];
      }
      return { roots: [...new Set(roots.map(r => rules.normalize(r)))].sort(ordinal) };
    }
    return { problem: blocking(ProblemCodes.unsupportedRoute, 'Orca 只支援全域部署', '專案範圍請使用 LC-AI-Pack。') };
  }

  const storeFor = () => ReceiptStore.forGlobal({ home: opts.home, userProfile: userHome, rules });
  // 只讀其他範圍的收據，以揭露載入優先順序；不將它們當作部署目標。
  const shadowingStores = () => (opts.shadowingProjectRoots ?? []).map(root => ReceiptStore.forProject({ projectRoot: root, rules }));

  function destinationsOverlap(mutation, otherPath, otherContentId, otherIsConfigPatch) {
    return rules.normalize(mutation.destinationPath) === rules.normalize(otherPath) &&
      (mutation.mutationKind !== MutationKind.patchConfig || !otherIsConfigPatch || mutation.contentId === otherContentId);
  }

  function deploymentRoots(pkg, intent, host, requested) {
    if (host.hostId !== HostIds.codex || intent.scope !== Scope.global) return requested;
    const home = rules.normalize(userHome);
    const receipts = storeFor().load().receipts.filter(r => r.packageKey === pkg.identity.key &&
      r.hostId === host.hostId && r.surfaceId === host.surfaceId && r.scope === Scope.global);
    const hasRootContent = pkg.contents.some(c => c.kind !== 'skill');
    const roots = requested.filter(root => intent.codexContent !== 'SharedSkills' && (hasRootContent || receipts.some(r => r.canonicalRoot === root && r.kind !== 'skill')));
    if (intent.codexContent !== 'RootContent' && (pkg.contents.some(c => c.kind === 'skill') || receipts.some(r => r.canonicalRoot === home && r.kind === 'skill'))) roots.push(home);
    return [...new Set(roots)];
  }

  function planTarget(pkg, intent, host, canonicalRoot, setupPlan = null) {
    const profile = HostProfiles.find(host.hostId);
    if (!profile) return { problem: blocking(ProblemCodes.unsupportedHost, `不支援的 AI 工具：${host.hostId}`, `可用 Host：${Object.values(HostIds).join(', ')}`, { host, scope: intent.scope }) };
    const surface = profile.findSurface(host.surfaceId);
    if (!surface) return { problem: blocking(ProblemCodes.unsupportedHost, `${host.hostId} 不支援 surface：${host.surfaceId}`, `可用 surface：${profile.surfaces.map(s => s.surfaceId).join(', ')}`, { host, scope: intent.scope }) };
    if (!surface.scopes.includes(intent.scope)) return { problem: blocking(ProblemCodes.unsupportedRoute, `${host.hostId}／${host.surfaceId} 不支援 ${intent.scope} 安裝`, '請改用支援的 scope 或 surface。', { host, scope: intent.scope }) };

    const receiptStore = storeFor(intent);
    const ownership = buildOwnershipIndex({ packageKey: pkg.identity.key, host, scope: intent.scope, canonicalRoot, targetStore: receiptStore, otherScopeStores: shadowingStores(intent), rules });
    const origins = (intent.hostRoots ?? []).find(r => sameHost(r.host, host))?.origins ?? {};
    const rootOrigin = Object.entries(origins).find(([root]) => rules.normalize(root) === canonicalRoot)?.[1];
    const ctx = { package: pkg, intent, host, profile, surface, scope: intent.scope, canonicalRoot, ownership, rules,
      rootOrigin,
      userHome: rules.normalize(userHome), operatingSystem, setup: buildSetupRenderContext(pkg, setupPlan, canonicalRoot, opts.mcpLauncherPath),
      allowBackupAndReplace: intent.existingContent === 'BackupAndReplace' };

    const mutations = [], problems = [], configuration = [], artifacts = new Map();
    const codexGlobal = host.hostId === HostIds.codex && intent.scope === Scope.global;
    const missingContentOnly = (intent.hostRoots ?? []).some(s => sameHost(s.host, host) &&
      s.missingContentRoots?.some(root => rules.normalize(root) === canonicalRoot));
    const handlesSkills = !codexGlobal || (intent.codexContent !== 'RootContent' && canonicalRoot === ctx.userHome);
    const handlesRootContent = !codexGlobal || (intent.codexContent !== 'SharedSkills' && (canonicalRoot !== ctx.userHome || (ctx.rootOrigin !== 'SharedSkills' && intent.hostRoots
      .some(s => sameHost(s.host, host) && s.canonicalRoots.some(r => rules.normalize(r) === canonicalRoot)))));
    const unavailable = codexGlobal && !missingContentOnly && intent.codexContent !== 'RootContent' && pkg.contents.some(c => c.kind === 'skill')
      ? checkSharedSkillsDirectory(userHome) : null;
    if (unavailable) problems.push(blocking(ProblemCodes.sharedSkillsUnavailable, `無法使用 Codex 共用技能目錄：${unavailable.directory}`,
      unavailable.reason, { host, scope: intent.scope, path: unavailable.path }));
    const installedIds = new Set(missingContentOnly ? receiptStore.forTarget(host, intent.scope, canonicalRoot)
      .filter(r => r.packageKey === pkg.identity.key).map(r => `${r.kind}|${r.contentId}`) : []);
    const targetContents = pkg.contents.filter(c => c.kind === 'skill' ? handlesSkills : handlesRootContent)
      .filter(c => !missingContentOnly || (!(codexGlobal && c.kind === 'skill') && !installedIds.has(`${c.kind}|${c.id}`)));
    for (const content of targetContents) {
      if (unavailable) break;
      const route = HostProfiles.findRoute(surface, content.kind);
      if (!route) {
        const severity = surface.unsupportedRouteSeverity;
        problems.push(makeProblem(ProblemCodes.unsupportedRoute, severity, `${host.hostId}／${host.surfaceId} 無法安裝 ${content.kind} '${content.id}'`,
          severity === Severity.warning ? '此 surface 不接收這種內容；已揭露並略過，其他支援內容仍會照計畫安裝。' : 'Host Profile 沒有此 canonical kind 的 route；不會靜默略過。',
          { host, scope: intent.scope, contentId: content.id, resolutions: ['改用支援此內容的 Host／Surface', '改用 bundle 中支援的內容'] }));
        continue;
      }
      if (content.kind === 'mcp' && ctx.setup && !ctx.setup.launcherPath && runtimeSecretIds(content.definition, ctx.setup).length) {
        // LC-AI-Pack 由自身可執行檔擔任受管 launcher；Orca 尚無對應的 launcher，不寫出無法啟動的設定。
        problems.push(blocking(ProblemCodes.unsupportedContentKind, `資源中心目前尚不支援需要執行期秘密的 MCP '${content.id}'`,
          '此 MCP 需要受管 launcher 在啟動時交付秘密；Orca 尚未提供 launcher，本次不會寫入任何檔案。設定參數與秘密已可儲存，供桌面工具沿用。',
          { host, scope: intent.scope, contentId: content.id }));
        continue;
      }
      const driver = getDriver(content.kind);
      if (!driver) {
        // Orca 首版尚未實作此內容類型的落地方式（工項 07、08）；揭露為阻擋問題，不靜默略過。
        problems.push(blocking(ProblemCodes.unsupportedContentKind, `資源中心目前尚不支援安裝 ${content.kind} '${content.id}'`,
          '此內容類型將於後續版本支援；本次不會寫入任何檔案。', { host, scope: intent.scope, contentId: content.id }));
        continue;
      }
      let result;
      try { result = driver.expand(content, route, ctx); } catch (e) {
        if (!(e instanceof CanonicalPackageError)) throw e;
        problems.push({ ...e.toProblem(), host, scope: intent.scope, contentId: content.id });
        continue;
      }
      mutations.push(...result.mutations); problems.push(...result.problems); configuration.push(...result.configuration);
      for (const a of result.artifacts) artifacts.set(a.mutationId, a);
    }

    problems.push(...detectIncomingCollisions(mutations, ctx));
    if (host.hostId === HostIds.codex && intent.scope === Scope.global) {
      const otherRoots = receiptStore.load().receipts.filter(r => r.hostId === host.hostId && r.scope === intent.scope && r.canonicalRoot !== canonicalRoot);
      for (const m of mutations) {
        const overlap = otherRoots.find(r => destinationsOverlap(m, r.destinationPath, r.contentId, r.mutationKind === MutationKind.patchConfig));
        if (overlap) problems.push(blocking(ProblemCodes.ownershipCollision, `此內容已由另一個 Codex 部署目標管理：${overlap.canonicalRoot}`,
          '請從原部署分佈更新或移除，再安裝到新的根目錄；備份覆寫不能繞過既有收據。', { host, scope: intent.scope, contentId: m.contentId, path: m.destinationPath }));
      }
    }
    const shadowed = ownership.findShadowing(targetContents.map(c => c.id));
    if (shadowed.length) {
      const allow = intent.allowScopeShadowing === true;
      problems.push(makeProblem(ProblemCodes.scopeShadowing, allow ? Severity.warning : Severity.blocking, `${host.hostId} 已在其他安裝範圍管理相同內容`,
        'Global 與 Project 同時管理同一 contentId 可能互相遮蔽。' + (allow ? ' 已明確允許，並持續揭露。' : ' 請確認後以「允許 scope shadowing」重新 Plan。'),
        { host, scope: intent.scope, contentId: [...new Set(shadowed.map(r => r.contentId))].sort(ordinal).join(', '),
          path: [...new Set(shadowed.map(r => r.destinationPath))].sort(ordinal).join(', '), resolutions: ['允許 scope shadowing 後重新 Plan', '改為只在單一 scope 安裝'],
          // Orca 擴充（工項 11）：逐筆揭露另一範圍已管理的位置，供明細顯示載入優先順序；不參與計畫摘要。
          shadowed: shadowed.map(r => ({ contentId: r.contentId, kind: r.kind, scope: r.scope, destinationPath: r.destinationPath, canonicalRoot: r.canonicalRoot,
            packageKey: r.packageKey, packageVersion: r.packageVersion })) }));
    }
    for (const c of targetContents.filter(c => c.kind === 'agent')) {
      const ignored = c.ignoredFrontmatterKeys.map(key => `frontmatter '${key}'`);
      if (host.hostId === HostIds.codex && c.hostOverrides.codex?.tools != null) ignored.push('hosts.codex.tools');
      if (ignored.length) problems.push(warning(ProblemCodes.ignoredContentFields, `Agent '${c.id}' 有 ${ignored.length} 個宣告欄位不會寫入 ${host.hostId}`,
        `不落地的欄位：${ignored.join('、')}。內容檔 frontmatter 只有 name 與 description 會成為 native 顯示 metadata，且 native 的 name 一律由 contents[].id 決定；該平台不接受的欄位不會寫入，維持平台預設。`,
        { host, scope: intent.scope, contentId: c.id }));
    }
    for (const c of targetContents.filter(c => c.kind === 'skill' && c.nonStandardFrontmatterKeys.length)) {
      problems.push(warning(ProblemCodes.nonStandardContentFields, `Skill '${c.id}' 使用 ${c.nonStandardFrontmatterKeys.length} 個非標準 frontmatter 欄位`,
        `非標準欄位：${c.nonStandardFrontmatterKeys.join('、')}。Agent Skills 開放標準只定義 name、description、license、compatibility、metadata、allowed-tools、disable-model-invocation、argument-hint；其餘欄位原樣寫入落地檔案，不改寫也不映射，不認得的平台會忽略。`,
        { host, scope: intent.scope, contentId: c.id }));
    }

    const commands = (pkg.manifest.dependencies?.cli ?? []).filter(d => d?.checkCommand && String(d.checkCommand).trim()).map(d => {
      const { executable, arguments: args } = splitShellCommand(d.checkCommand);
      return { commandId: ofText(`${pkg.identity.key}|${d.name}|${d.checkCommand}`).slice(0, 16), contentId: pkg.identity.key,
        purpose: d.purpose ?? `檢查相依工具 '${d.name}' 是否已安裝`, executable, arguments: args, workingDirectory: canonicalRoot,
        willExecute: false, installSuggestions: Array.isArray(d.installCommands) ? d.installCommands : [] };
    }).sort((a, b) => ordinal(a.commandId, b.commandId));

    const sortedProblems = problems.sort((a, b) => ordinal(a.code, b.code) || ordinal(a.contentId ?? '', b.contentId ?? '') || ordinal(a.path ?? '', b.path ?? ''));
    const target = {
      host, scope: intent.scope, canonicalRoot, hostProfileVersion: profile.version, ownershipSnapshotSha256: ownership.snapshotSha256(),
      targetKey: targetKeyOf(host, intent.scope, canonicalRoot),
      mutations: mutations.sort((a, b) => ordinal(a.mutationId, b.mutationId)), commands,
      configuration: configuration.sort((a, b) => ordinal(a.path, b.path) || ordinal(a.contentId, b.contentId)),
      problems: sortedProblems, canApply: sortedProblems.every(p => !isBlocking(p))
    };
    return { planned: { target, artifacts, receiptStore, handlesSkills, handlesRootContent, missingContentOnly } };
  }

  function detectIncomingCollisions(mutations, ctx) {
    const out = [];
    const group = (items, keyOf) => { const m = new Map(); for (const i of items) { const k = keyOf(i); m.set(k, [...(m.get(k) ?? []), i]); } return m; };
    for (const [key, items] of group(mutations.filter(m => m.mutationKind !== MutationKind.patchConfig), m => rules.normalize(m.destinationPath))) {
      if (items.length > 1) out.push(blocking(ProblemCodes.destinationCollision, `本次多個內容解析到同一目的地：${key}`,
        `衝突的 contentId：${items.map(i => i.contentId).sort(ordinal).join(', ')}`, { host: ctx.host, scope: ctx.scope, path: key, resolutions: ['修正 package 內的 contents[].id', '拆成不同 package'] }));
    }
    for (const [key, items] of group(mutations.filter(m => m.mutationKind === MutationKind.patchConfig), m => rules.normalize(m.destinationPath) + '#' + m.ownedFieldPaths.join(','))) {
      if (items.length > 1) out.push(blocking(ProblemCodes.configConflict, `本次多個內容要寫入同一組 config 欄位：${key}`,
        `衝突的 contentId：${items.map(i => i.contentId).sort(ordinal).join(', ')}`, { host: ctx.host, scope: ctx.scope, path: key }));
    }
    return out;
  }

  function plan(intent) {
    let pkg;
    try { pkg = openCanonicalPackage(intent.package); } catch (e) {
      if (e instanceof CanonicalPackageError) return rejected(intent, e.toProblem());
      throw e;
    }
    const planProblems = [];
    if (!intent.hosts?.length) planProblems.push(blocking(ProblemCodes.unsupportedHost, '未選擇任何 AI 工具', '請至少選擇一個 Host／Surface。'));
    if (intent.scope !== Scope.global) return rejected(intent, blocking(ProblemCodes.unsupportedRoute, 'Orca 只支援全域部署', '專案範圍請使用 LC-AI-Pack。'), pkg);
    const { setupPlan = null, problem: setupProblem } = planSetupFor(pkg, intent);
    if (setupProblem) planProblems.push(setupProblem);
    if (setupPlan) planProblems.push(...setupPlan.problems);

    const targets = [];
    const hosts = [...new Map((intent.hosts ?? []).map(h => [`${h.hostId}|${h.surfaceId}`, h])).values()]
      .sort((a, b) => ordinal(a.hostId, b.hostId) || ordinal(a.surfaceId, b.surfaceId));
    for (const host of hosts) {
      const r = resolveCanonicalRoots(intent, host);
      if (r.problem) return rejected(intent, r.problem, pkg);
      for (const root of deploymentRoots(pkg, intent, host, r.roots)) {
        const t = planTarget(pkg, intent, host, root, setupPlan);
        if (t.problem) planProblems.push(t.problem); else targets.push(t.planned.target);
      }
    }
    // 同一次安裝選了多個 Codex 根時，舊家目錄與設定根不可雙重認領同一目的地。
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t.host.hostId !== HostIds.codex || t.scope !== Scope.global) continue;
      const collisions = t.mutations.filter(m => targets.some(o => sameHost(o.host, t.host) && o.scope === t.scope && o.canonicalRoot !== t.canonicalRoot &&
        o.mutations.some(c => destinationsOverlap(m, c.destinationPath, c.contentId, c.mutationKind === MutationKind.patchConfig))))
        .map(m => blocking(ProblemCodes.ownershipCollision, '選取的 Codex 根目錄會認領同一份內容', '請只選取一個對應的部署目標；舊家目錄與設定根不可雙重認領同一目的地。',
          { host: t.host, scope: t.scope, contentId: m.contentId, path: m.destinationPath }));
      if (collisions.length) {
        const problems = [...t.problems, ...collisions];
        targets[i] = { ...t, problems, canApply: problems.every(p => !isBlocking(p)) };
      }
    }
    const ordered = targets.sort((a, b) => ordinal(a.targetKey, b.targetKey));
    return withCanApply({ contractVersion: ContractVersion, planDigest: computePlanDigest(pkg.identity, pkg.sha256, intent, ordered, rules, setupPlan),
      package: pkg.identity, sourceSha256: pkg.sha256, intent, targets: ordered, problems: planProblems, setup: setupPlan });
  }

  const rejectedApply = (plan, p) => ({ status: 'Rejected', planDigest: plan.planDigest, targets: [], problems: [p] });
  const failedTarget = (target, status, p) => ({ host: target.host, scope: target.scope, canonicalRoot: target.canonicalRoot, targetKey: target.targetKey, status,
    writtenPaths: [], removedPaths: [], backupPaths: [], problems: [p], residualPaths: [], partiallyRestoredPaths: [], diagnosticId: diagnosticId() });

  /** 受阻目標在套用結果中的樣子：未部署、零寫入，原因沿用審核時的阻擋問題。 */
  const blockedResult = (target) => ({ host: target.host, scope: target.scope, canonicalRoot: target.canonicalRoot, targetKey: target.targetKey, status: 'Skipped',
    writtenPaths: [], removedPaths: [], backupPaths: [], problems: target.problems.filter(isBlocking), residualPaths: [], partiallyRestoredPaths: [], diagnosticId: diagnosticId() });

  function applyTarget(pkg, reviewedPlan, reviewedTarget, ledger, setupPlan) {
    const lock = tryAcquireTargetLock(path.join(opts.home, 'locks'), reviewedTarget.targetKey, opts.lockTimeoutMs ?? 15000);
    if (!lock) return failedTarget(reviewedTarget, 'Failed', blocking(ProblemCodes.lockUnavailable, `無法取得 ${reviewedTarget.host.hostId} 的部署 lock`, '另一個程序正在部署同一個 target；請稍後重試。'));
    try {
      const fresh = planTarget(pkg, reviewedPlan.intent, reviewedTarget.host, reviewedTarget.canonicalRoot, setupPlan);
      if (fresh.problem) return failedTarget(reviewedTarget, 'Failed', fresh.problem);
      if (computeTargetDigest(fresh.planned.target, rules) !== computeTargetDigest(reviewedTarget, rules) && !ledger.explainsDifference(reviewedTarget, fresh.planned.target)) {
        return failedTarget(reviewedTarget, 'Stale', blocking(ProblemCodes.planStale, `${reviewedTarget.host.hostId} 的實際狀態已與審核時不同`,
          '檔案、設定或 receipt 在審核後改變；該 target 零寫入。請重新 Plan 並重新確認。', { host: reviewedTarget.host, scope: reviewedTarget.scope }));
      }
      if (!fresh.planned.target.canApply) return failedTarget(reviewedTarget, 'Failed', fresh.planned.target.problems.find(isBlocking));
      const result = executeTarget(fresh.planned, pkg, reviewedPlan, opts, rules);
      if (result.status === 'Succeeded') ledger.record(fresh.planned.target);
      return result;
    } finally {
      lock.release();
    }
  }

  function apply(reviewedPlan, authorization) {
    if (reviewedPlan.planDigest !== authorization?.planDigest) {
      return rejectedApply(reviewedPlan, blocking(ProblemCodes.planStale, 'Apply 授權與已審核 Plan 的 digest 不符', 'Apply 必須綁定使用者剛審核的 PlanDigest；請重新 Plan 並重新確認。'));
    }
    if (!withCanApply(reviewedPlan).canApply) {
      return rejectedApply(reviewedPlan, blocking(ProblemCodes.applyFailed, 'Plan 含 blocking problem 或沒有可部署的目標，無法 Apply', 'blocking problem 不能被 --yes、force 或風險確認忽略。'));
    }
    if (deployableTargets(reviewedPlan).some(t => t.mutations.some(m => m.willBackup)) && !authorization.replaceUnmanagedFiles) {
      return rejectedApply(reviewedPlan, blocking(ProblemCodes.consentRequired, 'Plan 會備份後覆蓋既有內容，需明確同意', '請以 ReplaceUnmanagedFiles 授權確認備份後覆蓋，或改回 Block 政策重新 Plan。'));
    }
    let pkg;
    try { pkg = openCanonicalPackage(reviewedPlan.intent.package); } catch (e) {
      if (e instanceof CanonicalPackageError) return rejectedApply(reviewedPlan, e.toProblem());
      throw e;
    }
    if (pkg.sha256 !== String(reviewedPlan.sourceSha256).toLowerCase()) {
      return rejectedApply(reviewedPlan, blocking(ProblemCodes.sourceChanged, '資源包內容在審核後改變', 'Apply 前重新驗證 package SHA 失敗；請重新下載並重新 Plan。'));
    }
    for (const t of reviewedPlan.targets) {
      const r = resolveCanonicalRoots(reviewedPlan.intent, t.host);
      if (r.problem) return rejectedApply(reviewedPlan, r.problem);
      if (!deploymentRoots(pkg, reviewedPlan.intent, t.host, r.roots).includes(t.canonicalRoot)) {
        return rejectedApply(reviewedPlan, blocking(ProblemCodes.planStale, 'Plan target 不屬於已審核的 Host 根目錄集合', 'DeploymentIntent 與 target 的 Host／canonical root 不一致；請重新 Plan 並重新確認。'));
      }
    }
    // 設定輸入在審核後改變（值、秘密有無）一律視為過期，在任何寫入之前拒絕。
    const { setupPlan = null, problem: setupProblem } = planSetupFor(pkg, reviewedPlan.intent);
    if (setupProblem) return rejectedApply(reviewedPlan, setupProblem);
    // 有 operationId 代表設定階段已在該 operation 內完成並記錄（DeploymentOperationOrchestrator）：設定層的 stale 比對已在啟動任何子行程之前做過，
    // 而命令執行本身會改變完成狀態（同一命令從「要跑」變成「已成功」），此時重做只會讓合法的安裝假性 stale；target 級檢查完全不受影響。
    if (!authorization.operationId && (reviewedPlan.setup ? computeSetupDigest(reviewedPlan.setup, rules) : null) !== (setupPlan ? computeSetupDigest(setupPlan, rules) : null)) {
      return rejectedApply(reviewedPlan, blocking(ProblemCodes.planStale, '安裝設定在審核後改變', '設定值、秘密狀態或環境相容性與審核時不同；零寫入。請重新規劃並重新確認。'));
    }
    // 直接套用才在這裡寫啟動描述；經由 orchestrator 時它在設定命令之後、target 之前的 managed-mcp checkpoint 寫入。
    if (!authorization.operationId) writeManagedMcpDescriptors(pkg, setupPlan);
    const ledger = createSharedConfigLedger(rules);
    // 每個可部署目標各自是一個交易邊界（executeTarget）：一個失敗不影響已成功的目標。受阻的目標不被觸碰，結果以 Skipped 列出原因。
    const results = [...reviewedPlan.targets].sort((a, b) => ordinal(a.targetKey, b.targetKey))
      .map(t => t.canApply ? applyTarget(pkg, reviewedPlan, t, ledger, setupPlan) : blockedResult(t));
    return { status: aggregate(results), planDigest: reviewedPlan.planDigest, targets: results, problems: [] };
  }

  /** 需要受管 launcher 啟動描述的 MCP 內容（對照 ManagedMcpLaunchPlanner.RequiresManagedLauncher）。 */
  function managedMcpContents(pkg, setupPlan) {
    const context = buildSetupRenderContext(pkg, setupPlan, setupPlan?.canonicalRoot, opts.mcpLauncherPath);
    if (!context?.launcherPath) return [];
    return pkg.contents.filter(c => c.kind === 'mcp' && runtimeSecretIds(c.definition, context).length);
  }

  /** 對照 WriteManagedMcpDescriptors：啟動描述以 setup 身分根建構，寫在 setup root。 */
  function writeManagedMcpDescriptors(pkg, setupPlan) {
    const context = buildSetupRenderContext(pkg, setupPlan, setupPlan?.canonicalRoot, opts.mcpLauncherPath);
    for (const content of managedMcpContents(pkg, setupPlan)) {
      saveLaunchDescriptor(buildLaunchDescriptor(content, context, operatingSystem, resolveLaunch, rules));
    }
  }

  /** orchestrator 需要的設定：與規劃用的是同一份，避免計畫與執行端各算各的。 */
  const config = { home: opts.home, userHome, operatingSystem, setupIntent, runners: setupRunners, environment: setupEnvironment, secrets, mcpLauncherPath: opts.mcpLauncherPath ?? null };

  return { plan, apply, rules, config, managedMcpContents, writeManagedMcpDescriptors };
}

/** 彙總只看實際嘗試套用的目標；受阻（Skipped）的目標讓成功的結果成為 Partial，因為使用者要的目標沒有全數完成。 */
function aggregate(results) {
  if (!results.length) return 'Rejected';
  const attempted = results.filter(r => r.status !== 'Skipped');
  const ok = attempted.filter(r => r.status === 'Succeeded').length;
  if (ok === 0) return attempted.length && attempted.every(r => r.status === 'Stale') ? 'Stale' : 'Failed';
  return ok === results.length ? 'Succeeded' : 'Partial';
}
