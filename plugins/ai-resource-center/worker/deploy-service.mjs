// 部署（安裝與更新共用）的 worker 服務：偵測部署目標、下載並驗證確切 ZIP、產生部署計畫摘要，
// 並在使用者確認後只套用那一份計畫。規劃與套用核心在 worker/deploy/（對照 Deployment）。
import os from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { validatePackage } from './package-validator.mjs';
import { hostLabel } from './host-labels.mjs';
import { pluginVersion } from './plugin-version.mjs';
import { resolveInstallAction } from './install-reports.mjs';
import path from 'node:path';
import { badParams, RcError, ErrorCode } from './contract.mjs';
import { packageInput } from './package-service.mjs';
import { resolveLcAiPackHome } from './paths.mjs';
import { createDeploymentPlanner, deployableTargets, blockedTargets } from './deploy/planner.mjs';
import { resolveOrcaAppData } from './deploy/orca-claude-mcp-cleanup.mjs';
import { locateClaudeCodeRoots } from './deploy/claude-code-roots.mjs';
import { createPathRules } from './deploy/canonical-root.mjs';
import { locateCodexRoots } from './deploy/codex-roots.mjs';
import { locateClaudeDesktop } from './deploy/claude-desktop-roots.mjs';
import { HostIds, HostProfiles, SurfaceIds, Scope } from './deploy/host-profiles.mjs';
import { getDriver } from './deploy/resource-drivers.mjs';
import { ReceiptFileError } from './deploy/receipts.mjs';
import { createSetupInputService } from './setup/input-service.mjs';
import { backupReasonOf, describeLoadPrecedence, presentExplanation } from './deploy/conflict-summary.mjs';
import { createOperationOrchestrator, Actions, readCommandOutput } from './setup/orchestrator.mjs';

const codexHost = Object.freeze({ hostId: HostIds.codex, surfaceId: SurfaceIds.codexCli });
const desktopHost = Object.freeze({ hostId: HostIds.claudeCode, surfaceId: SurfaceIds.claudeDesktop });
const installHosts = [codexHost, Object.freeze({ hostId: HostIds.claudeCode, surfaceId: SurfaceIds.claudeCodeCli }), desktopHost];
const sameHost = (a, b) => a.hostId === b.hostId && a.surfaceId === b.surfaceId;
const CHANGE_LABELS = { Create: '新增', Replace: '取代', Merge: '合併', NoOp: '無變更' };
const camel = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const PLAN_ORIGIN_CHANGED = '登入狀態或市集已改變，這份部署計畫已失效，請重新產生部署摘要並確認。';
const STALE_MESSAGE ='本機狀態已在確認前改變，舊計畫未套用。已依目前狀態重新產生部署摘要，請重新確認。';

const loadPrecedenceOf = (target, version) => { const loadPrecedence = describeLoadPrecedence(target, version); return loadPrecedence.length ? { loadPrecedence } : {}; };

const projectProblem = (p) => ({ code: p.code, severity: p.severity, summary: p.summary, explanation: presentExplanation(p),
  ...(p.existingOwner ? { existingOwner: p.existingOwner } : {}),
  ...(p.configPath ? { configPath: p.configPath } : {}),
  ...(p.failureStage ? { failureStage: p.failureStage } : {}),
  ...(p.commandName ? { commandName: p.commandName, failureSummary: p.failureSummary } : {}),
  ...(p.contentId ? { contentId: p.contentId } : {}), ...(p.path ? { path: p.path } : {}) });

/**
 * @param {object} deps
 * @param {object} deps.downloads  createDownloadService 的結果（共用 ZIP 驗證）
 * @param {{identity(): Promise<{marketUrl: string, account: string}|null>}} [deps.session]  計畫的來源核對；規劃時記下目前市集與帳號，套用前必須仍相同
 * @param {string} [deps.lcaipackHome]  共用資料目錄（預設依 LCAIPACK_HOME／~/.lcaipack）
 * @param {string} [deps.userHome]
 * @param {object} [deps.env]   偵測 CODEX_HOME／CLAUDE_CONFIG_DIR 用的環境變數
 * @param {{report(input: object): Promise<void>}} [deps.installReports]  安裝回報入口（工項 12）；成功部署至少一個目標後呼叫
 * @param {object} [deps.secretStore]  秘密的安全儲存區（測試注入）；預設為作業系統的 Credential Manager／Keychain
 * @param {string|(() => string|null)} [deps.mcpLauncherPath]  外掛自帶 MCP launcher 腳本路徑或延遲解析函式
 * @param {object} [deps.runners]  設定命令的 runner registry（測試注入）；預設為固定的 PowerShell／bash
 * @param {{operatingSystem: string, architecture: string}} [deps.setupEnvironment]  設定命令相容性判斷用的本機環境（測試注入）
 * @param {{run(request: object): Promise<object>}} [deps.commandExecutor]  設定命令執行器（測試注入）；產品路徑永遠是真實子行程
 * @param {number} [deps.commandTimeoutMs]  設定命令逾時覆寫（測試注入）；產品路徑由已審核計畫的 timeoutMinutes 決定
 */
export function createDeployService({ downloads, installed, session = null, lcaipackHome, userHome = os.homedir(), env = process.env, platform = process.platform, clientVersion = pluginVersion(),
  secretStore, mcpLauncherPath = null, installReports = null, runners, setupEnvironment, commandExecutor, commandTimeoutMs = null }) {
  const home = lcaipackHome ?? resolveLcAiPackHome({ env, homedir: userHome });
  const setupInput = createSetupInputService({ home, userHome, platform, secretStore });
  /** 同一時間只保留一份等待確認的計畫；新的規劃讓舊計畫失效。 */
  let pending = null;
  /** 正在套用的操作；取消只作用在它身上（設定命令最長可執行 120 分鐘）。 */
  let running = null;
  /** 目前工作階段的來源（市集網址與帳號）；沒有注入 session 時（單獨使用部署核心）不核對。 */
  const currentOrigin = async () => (session ? session.identity() : null);
  const sameOrigin = (a, b) => (a === null && b === null) || (!!a && !!b && a.marketUrl === b.marketUrl && a.account === b.account);

  const rules = createPathRules({ platform });

  /**
   * 規劃用的確切 ZIP：市集版本經受管下載驗證；從資料夾安裝（input.localSource）則讀暫存打包產物並以打包時的 SHA-256 驗證，
   * 不呼叫市集（對照 SideloadInstallViewModel：全程不呼叫 Registry API）。
   */
  async function artifactOf(input) {
    const local = input.localSource;
    if (!local) return downloads.fetchVerified(input);
    let bytes;
    try { bytes = await readFile(local.zipPath); }
    catch { throw new RcError(ErrorCode.invalidPackage, '暫存的資源包已不存在，請重新從資料夾安裝'); }
    const { sha256, manifest } = validatePackage(bytes, { packageKey: input.packageKey, version: input.version, sha256: local.sha256 });
    return { bytes, sha256, manifest, version: { version: input.version, channel: '' }, localSourcePath: local.folder };
  }
  // 收據的版本通道：本機來源為空字串（對照 SideloadInstallViewModel channel: ""），其餘依市集版本。
  const channelOf = fetched => fetched.localSourcePath != null ? '' : fetched.version.channel === 'preview' ? 'preview' : 'release';

  function detectTargets(input = {}) {
    if (input.scope !== undefined && input.scope !== Scope.global || input.projectRoot !== undefined) throw badParams('Orca 只支援全域部署');
    let config = {};
    try { config = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) ?? {}; }
    catch (e) {
      if (e.code !== 'ENOENT') throw new RcError(ErrorCode.invalidParams, '無法讀取 根目錄設定，請修正 config.json 後重試');
    }
    const targets = installHosts.flatMap(host => {
      if (host.surfaceId === SurfaceIds.claudeDesktop) {
        const d = locateClaudeDesktop({ userHome, env, platform });
        return d.isDetected ? [{ id: `${host.hostId}|${host.surfaceId}|${Scope.global}|${d.canonicalConfigDirectory}`, ...host, scope: Scope.global,
          label: 'Claude Desktop 全域', rootPath: d.configDirectory, canonicalRoot: d.canonicalConfigDirectory, isPrimary: true, origin: d.source, disclosures: d.disclosures }] : [];
      }
      const manualRoots = config.manualClientRoots?.[host.hostId] ?? [];
      const excludedRoots = config.excludedClientRoots?.[host.hostId] ?? [];
      if (![manualRoots, excludedRoots].every(roots => Array.isArray(roots) && roots.every(r => typeof r === 'string'))) throw badParams('根目錄設定格式錯誤');
      const locate = host.hostId === HostIds.codex ? locateCodexRoots : locateClaudeCodeRoots;
      return locate({ userHome, env, manualRoots, excludedRoots, platform }).map(root => ({
        id: `${host.hostId}|${host.surfaceId}|${Scope.global}|${root.canonicalRoot}`,
        ...host, scope: Scope.global,
        label: `${hostLabel(host)} 全域${root.isPrimary ? '' : `（${root.displayPath}）`}`, rootPath: root.displayPath, canonicalRoot: root.canonicalRoot,
        isPrimary: root.isPrimary, origin: root.origin
      }));
    });
    if (input.packageKey && installed) {
      for (const d of installed.project(input.packageKey, null).deployments) {
        if (d.scope !== Scope.global || !installHosts.some(h => h.hostId === d.hostId && h.surfaceId === d.surfaceId) || targets.some(t => t.id === d.id)) continue;
        const excluded = config.excludedClientRoots?.[d.hostId] ?? [];
        if (excluded.some(root => rules.normalize(root) === rules.normalize(d.rootPath))) continue;
        let exists = false;
        try { exists = statSync(d.rootPath).isDirectory(); } catch { /* missing roots remain visible in installed details */ }
        if (!exists) continue;
        targets.push({ id: d.id, hostId: d.hostId, surfaceId: d.surfaceId, scope: d.scope, label: `${hostLabel(d)} (${d.rootPath})`,
          rootPath: d.rootPath, canonicalRoot: d.rootPath, isPrimary: false, origin: 'Receipt' });
      }
    }
    return targets;
  }

  const canonicalHome = rules.normalize(userHome);

  function packageTargets(targets, contents, packageKey) {
    const codexRoots = targets.filter(t => sameHost(t, codexHost) && t.canonicalRoot !== canonicalHome);
    const receipts = (installed?.receipts({ globalOnly: true }) ?? []).filter(r =>
      r.packageKey === packageKey && r.scope === Scope.global && sameHost(r, codexHost));
    const hasRootContent = contents.some(c => c.kind !== 'skill');
    const visible = targets.filter(t => !sameHost(t, codexHost) || (t.canonicalRoot !== canonicalHome &&
      (hasRootContent || receipts.some(r => r.canonicalRoot === t.canonicalRoot && r.kind !== 'skill'))));
    // Keep prior managed destinations in an update that drops the last content of their kind.
    const hadSharedSkill = receipts.some(r => r.canonicalRoot === canonicalHome && r.kind === 'skill');
    const hasDetectedRoot = codexRoots.some(t => t.origin !== 'Receipt');
    if ((hasDetectedRoot && contents.some(c => c.kind === 'skill')) || (codexRoots.length && hadSharedSkill)) {
      visible.push({ ...codexHost, scope: Scope.global, id: [codexHost.hostId, codexHost.surfaceId, Scope.global, canonicalHome].join('|'),
        label: 'Codex 全域共用技能', rootPath: userHome, canonicalRoot: canonicalHome, isPrimary: true, origin: 'SharedSkills' });
    }
    return visible;
  }

  function summarize(plan, targetsById, state = null) {
    const deployments = installed?.project(plan.package.key, null).deployments ?? [];
    return {
      planDigest: plan.planDigest, canApply: plan.canApply,
      // ADR 0002：可部署與受阻的目標同時列出；確認一次只套用可部署的目標。
      deployableCount: deployableTargets(plan).length, blockedCount: blockedTargets(plan).length,
      package: { packageKey: plan.package.key, name: plan.package.name, version: plan.package.version, channel: pending?.channel ?? 'release' },
      targets: plan.targets.map(t => ({
        id: t.targetKey, label: targetsById.get(t.targetKey)?.label ?? t.targetKey, rootPath: targetsById.get(t.targetKey)?.rootPath ?? t.canonicalRoot,
        canApply: t.canApply,
        installedVersions: [...new Set(deployments.filter(d => d.id === t.targetKey).map(d => d.version))], nextVersion: plan.package.version,
        changes: t.mutations.map(m => ({ contentId: m.contentId, kind: m.kind, change: m.change, changeLabel: CHANGE_LABELS[m.change] ?? m.change, destinationPath: m.destinationPath, willBackup: m.willBackup,
          ...(m.willBackup ? { backupReason: backupReasonOf(m, t.problems) } : {}) })),
        ...(t.configuration.length ? { configuration: t.configuration } : {}),
        ...loadPrecedenceOf(t, plan.package.version),
        problems: t.problems.map(projectProblem)
      })),
      unchangedDeployments: deployments.filter(d => !plan.targets.some(t => t.targetKey === d.id) && d.scope === Scope.global),
      setup: setupInput.summarize(plan.setup),
      problems: plan.problems.map(projectProblem)
    };
  }

  /** 設定層與收據檔的錯誤轉成面板可顯示的錯誤；同步與非同步（套用）共用。 */
  const guard = (fn) => {
    const convert = e => {
      if (e?.unsupportedFormatVersion) throw e;
      if (e instanceof ReceiptFileError) throw new RcError(ErrorCode.receiptInvalid, `${e.message}。請修正或移除該檔案後重試。`);
      throw e;
    };
    try { const result = setupInput.guard(fn); return typeof result?.then === 'function' ? result.catch(convert) : result; } catch (e) { return convert(e); }
  };

  /** 共用專案清單（config.json 的 registeredProjects）：全域規劃時用來揭露各專案已有的同名資源。 */
  function registeredProjects() {
    let projects = [];
    try { projects = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8').replace(/^﻿/, '')).registeredProjects ?? []; }
    catch (e) { if (e.code !== 'ENOENT') throw new ReceiptFileError('無法讀取共用專案清單'); }
    if (!Array.isArray(projects) || projects.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new ReceiptFileError('共用專案清單格式錯誤');
    return projects;
  }

  function runPlan(state) {
    // 動作決定設定命令的判斷意圖（同版略過、更新重跑、重新設定）；規劃與套用必須使用同一個意圖。
    const planner = guard(() => createDeploymentPlanner({ home, userHome, clientVersion, channel: state.channel, operatingSystem: platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'windows',
      shadowingProjectRoots: registeredProjects(), secrets: setupInput.secrets, mcpLauncherPath,
      orcaAppDataDirectory: resolveOrcaAppData(platform, env, userHome),
      setupPlanning: { intent: Actions[state.action].intent, runners, environment: setupEnvironment } }));
    const plan = guard(() => planner.plan(state.intent));
    pending = { ...state, plan, planner };
    return summarize(plan, state.targetsById, state);
  }

  return {
    detectTargets,
    // 無目標的設定規劃：明細讀取／儲存沿用相同參數解析與共用儲存，不產生部署副作用。
    async packageSetup(input, save = false) {
      packageInput(input, true);
      const origin = await currentOrigin();
      const fetched = await artifactOf(input);
      if (!sameOrigin(origin, await currentOrigin())) throw new RcError(ErrorCode.planStale, PLAN_ORIGIN_CHANGED);
      const state = { intent: { package: { bytes: fetched.bytes, expectedSha256: fetched.sha256 }, scope: Scope.global,
        hosts: [], hostRoots: [], existingContent: 'BackupAndReplace', allowScopeShadowing: true },
        origin, action: 'reconfigure', channel: fetched.localSourcePath != null ? '' : fetched.version.channel, targetIds: [], targetsById: new Map() };
      let summary = runPlan(state);
      if (save) {
        guard(() => setupInput.save(pending.plan.setup, state.intent, input));
        summary = runPlan(state);
      }
      return summary.setup;
    },
    async listTargets(input) {
      if (input?.packageKey !== undefined) packageInput(input);
      const targets = detectTargets(input);
      // 不帶版本的呼叫沿用純本機偵測；面板以確切資源版本篩選可載入的選項。
      if (input?.version === undefined) return { targets };
      packageInput(input, true);
      const { manifest } = await artifactOf(input);
      return { contents: manifest.contents.map(({ kind, id }) => ({ kind, id })), targets: packageTargets(targets, manifest.contents, input.packageKey).filter(t => {
        const surface = HostProfiles.find(t.hostId)?.findSurface(t.surfaceId);
        const supported = c => getDriver(c.kind) && surface?.routes.get(c.kind)?.templateFor(t.scope);
        return surface?.scopes.includes(t.scope) && manifest.contents.some(supported) && manifest.contents.every(c =>
          supported(c) || surface.unsupportedRouteSeverity === 'Warning');
      }) };
    },

    async plan(input) {
      packageInput(input, true);
      if (!Array.isArray(input.targets) || !input.targets.length || input.targets.some(t => typeof t !== 'string') || new Set(input.targets).size !== input.targets.length) throw badParams('請選擇至少一個不重複的部署目標');
      if (input.action !== undefined && !Object.hasOwn(Actions, input.action)) throw badParams('部署動作格式錯誤');
      if (input.missingTargets !== undefined && (!Array.isArray(input.missingTargets) ||
        input.missingTargets.some(id => !input.targets.includes(id)))) throw badParams('補裝位置不在所選部署目標');
      pending = null;
      const origin = await currentOrigin();
      const fetched = await artifactOf(input);
      // 下載期間工作階段若換了（登出、換市集），這份下載不屬於目前的來源。
      if (!sameOrigin(origin, await currentOrigin())) throw new RcError(ErrorCode.planStale, PLAN_ORIGIN_CHANGED);
      const detected = new Map(packageTargets(detectTargets(input), fetched.manifest.contents, input.packageKey).map(t => [t.id, t]));
      const selected = input.targets.map(id => detected.get(id));
      if (selected.some(t => !t)) throw badParams('找不到所選的部署目標，請重新整理部署目標後再試');
      const codex = selected.filter(t => sameHost(t, codexHost));
      const wantsShared = codex.some(t => t.canonicalRoot === canonicalHome);
      const wantsRootContent = codex.some(t => t.canonicalRoot !== canonicalHome);
      const codexContent = !codex.length || (wantsShared && wantsRootContent) ? 'All' : wantsShared ? 'SharedSkills' : 'RootContent';
      const missingTargets = new Set(input.missingTargets ?? []);
      const intent = {
        codexContent, package: { bytes: fetched.bytes, expectedSha256: fetched.sha256 }, scope: Scope.global, hosts: installHosts.filter(h => selected.some(t => sameHost(t, h))),
        // ADR 0002：可解決的衝突自動處理。本機修改與未受管同名內容先備份再套用；全域／專案並存持續揭露；
        // 他包擁有、設定檔無法安全變更等不可繞過的阻擋仍由核心判定。
        existingContent: 'BackupAndReplace', allowScopeShadowing: true,
        // 從資料夾安裝：收據寫 source: "local"＋sourcePath（原樣），且不送安裝回報。
        ...(fetched.localSourcePath != null ? { localSourcePath: fetched.localSourcePath } : {}),
        hostRoots: installHosts.filter(h => selected.some(t => sameHost(t, h))).map(host => ({ host, canonicalRoots: selected.filter(t => sameHost(t, host)).map(t => t.rootPath),
          missingContentRoots: selected.filter(t => sameHost(t, host) && missingTargets.has(t.id)).map(t => t.rootPath),
          origins: Object.fromEntries(selected.filter(t => sameHost(t, host)).map(t => [t.rootPath, sameHost(t, codexHost) && t.canonicalRoot === canonicalHome ? 'SharedSkills' : t.origin])) }))
      };
      return runPlan({ intent, origin, action: input.action ?? 'install', channel: channelOf(fetched), targetIds: [...input.targets], targetsById: detected });
    },

    async apply(input) {
      if (typeof input.planDigest !== 'string' || !Array.isArray(input.targets) || input.targets.some(t => typeof t !== 'string')) throw badParams('部署確認格式錯誤');
      const current = pending;
      const sameTargets = current && new Set(input.targets).size === input.targets.length && input.targets.length === current.targetIds.length && current.targetIds.every(id => input.targets.includes(id));
      if (!current || current.plan.planDigest !== input.planDigest || !sameTargets) {
        throw new RcError(ErrorCode.planStale, '這份部署計畫已失效或與確認的部署目標不符，請重新產生部署摘要並確認。');
      }
      pending = null;
      // 計畫只對產生它的市集與登入帳號有效；工作階段結束時計畫已被丟棄，這裡再核對一次（例如設定中的網址被直接改掉）。
      if (!sameOrigin(current.origin, await currentOrigin())) throw new RcError(ErrorCode.planStale, PLAN_ORIGIN_CHANGED);
      // 安裝與更新共用的唯一套用入口：設定命令（若有）先於部署，且只依這份已確認的計畫執行一次。
      const controller = new AbortController();
      running = { controller };
      // 安裝回報需要 Apply 前的收據快照（Apply 之後同一目標只剩新版本）來判斷是安裝還是更新。
      let receiptsBeforeApply = [];
      try { receiptsBeforeApply = installed?.receipts() ?? []; } catch { /* 收據無法讀取時 Apply 本身會回報錯誤；回報只是附帶作業 */ }
      let operation;
      try {
        const orchestrator = createOperationOrchestrator({ planner: current.planner, executor: commandExecutor, commandTimeoutMs });
        operation = await guard(() => orchestrator.apply({ reviewedPlan: current.plan, authorization: { planDigest: input.planDigest, replaceUnmanagedFiles: true },
          action: current.action, signal: controller.signal }));
      } finally {
        running = null;
      }
      const result = operation.apply;
      // 對照 BrowseViewModel：只要任一目標過期（即使其他目標已成功），就以目前狀態重新產生摘要並要求重新確認，
      // 不把含 Stale 目標的結果當成 Partial 完成，也不為這次未完成的確認送出回報。
      const stale = operation.checkpoint === 'rejected-stale' || (result && (result.targets.some(t => t.status === 'Stale') ||
        (result.targets.every(t => t.status !== 'Succeeded') && result.problems.some(p => p.code === 'deployment.plan-stale'))));
      if (stale) return { status: 'stale', message: STALE_MESSAGE, plan: runPlan(current) };
      // 至少一個目標成功後才回報（builder 會再次確認）；失敗、受阻與復原的目標不計入。回報失敗不影響結果。
      if (result) {
        // 回報屬於計畫來源的市集與帳號，不是套用結束當下的工作階段（長時間的設定命令期間使用者可能已換市集）。
        await installReports?.report({ origin: current.origin, plan: current.plan, applied: result, packageKey: current.plan.package.key, version: current.plan.package.version,
          ...resolveInstallAction(receiptsBeforeApply, current.plan), channel: current.channel, operationId: operation.operationId });
      }
      const info = { operation: { id: operation.operationId, state: operation.state, checkpoint: operation.checkpoint, canResume: operation.canResume, logPath: operation.logPath },
        setup: { commands: operation.commands.map(c => ({ commandId: c.commandId, name: c.name, executed: c.executed, reason: c.reason, succeeded: c.succeeded, outcome: c.outcome, exitCode: c.exitCode,
          failureSummary: c.failureSummary, ...(c.executed ? { output: readCommandOutput(operation.logPath, c.commandId) } : {}) })) } };
      if (!result) {
        // 設定階段沒有收斂：依賴命令的部署目標完全沒被改動，逐一列出未部署的原因。
        const setupStage = operation.checkpoint.startsWith('setup-command') || operation.state === 'cancelled';
        const problems = operation.problems.map(projectProblem);
        return { status: operation.state === 'cancelled' ? 'cancelled' : camel(operation.status), ...info,
          // 設定命令只影響依賴它的（可部署的）目標；原本就因衝突受阻的目標維持自己的原因，不被誤標成命令失敗。
          targets: setupStage ? current.plan.targets.map(t => ({ id: t.targetKey, label: current.targetsById.get(t.targetKey)?.label ?? t.targetKey,
            status: t.canApply ? 'notDeployed' : 'skipped', writtenPaths: [], removedPaths: [], backupPaths: [], residualPaths: [], partiallyRestoredPaths: [],
            problems: t.canApply ? problems : t.problems.filter(p => p.severity === 'Blocking').map(projectProblem), diagnosticId: null })) : [],
          problems: setupStage ? [] : problems };
      }
      return {
        status: camel(result.status), ...info,
        targets: result.targets.map(t => ({ id: t.targetKey, label: current.targetsById.get(t.targetKey)?.label ?? t.targetKey, status: camel(t.status),
          writtenPaths: t.writtenPaths, removedPaths: t.removedPaths, backupPaths: t.backupPaths, residualPaths: t.residualPaths, partiallyRestoredPaths: t.partiallyRestoredPaths,
          problems: t.problems.map(projectProblem), diagnosticId: t.diagnosticId })),
        problems: result.problems.map(projectProblem)
      };
    },

    /** 丟棄等待確認的計畫（工作階段結束時由 session 通知）；正在套用的操作不受影響。 */
    discardPending() { pending = null; },

    /** 取消正在套用的操作：設定命令的整棵子行程樹會被終止，目標不被改動，operation 保留可繼續。 */
    cancel() {
      if (!running) return { cancelled: false };
      running.controller.abort();
      return { cancelled: true };
    }
  };
}
