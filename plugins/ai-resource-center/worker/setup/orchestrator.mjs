// 生命週期編排（對照 Deployment/DeploymentOperationOrchestrator.cs 與 DeploymentOperationContracts.cs 的 Apply 路徑）。
// 把設定命令放到既有 Plan／Apply 外層的「薄」編排層，順序不可改變：
//   1. 建立 operation——在任何副作用之前，中斷後才能被接手；
//   2. 前置檢查（授權 digest、blocking problem、動作與規劃意圖、實際狀態是否 stale）——零命令、零 target 寫入；
//   3. 依宣告順序執行設定命令；任何一個沒有成功就停在那裡，target 完全不被呼叫；
//   4. 寫出受管 MCP 啟動描述；
//   5. 命令全部成功後才呼叫既有的逐 target 套用，維持既有 partial 語意。
// 這裡不重算 skip 規則、不重算 target 交易、不重新解讀 manifest：計畫的命令揭露、planner.apply 與完成狀態才是權威答案。
// 秘密與子行程輸出永遠只進已遮罩的 operation log；進度事件只帶結構化里程碑。
import fs from 'node:fs';
import { openCanonicalPackage, CanonicalPackageError } from '../deploy/canonical-package.mjs';
import { ProblemCodes, blocking } from '../deploy/problems.mjs';
import { withCanApply } from '../deploy/planner.mjs';
import { SetupCommandCompletionStore, SetupIntent } from './completions.mjs';
import { createExecutionContext } from './execution-context.mjs';
import { createOperationStore, OperationState } from './operations.mjs';
import { createSecretMasker } from './masker.mjs';
import { openOperationLog } from './operation-log.mjs';
import { openSecretChannel } from './secret-channel.mjs';
import { SetupSecretStoreError, SecretUsages } from './secrets.mjs';
import { resolveSetupIdentityRoot } from './planning.mjs';
import { runSetupCommand } from './command-runner.mjs';

/** operation checkpoint 名稱：中斷後接手只看這個值決定從哪裡接，因此是產品契約而不是自由文字。 */
export const Checkpoints = Object.freeze({
  created: 'created', rejected: 'rejected', stale: 'rejected-stale', setupCommands: 'setup-commands', managedMcp: 'managed-mcp', targets: 'targets',
  completed: 'completed', targetsIncomplete: 'targets-incomplete', setupCommand: commandId => `setup-command:${commandId}`
});

/** 動作到既有 setup 語彙的唯一映射；入口不得自己重算。 */
export const Actions = Object.freeze({
  install: { intent: SetupIntent.install, kind: 'install' }, reinstall: { intent: SetupIntent.reinstall, kind: 'install' }, update: { intent: SetupIntent.update, kind: 'update' },
  reconfigure: { intent: SetupIntent.reconfigure, kind: 'reconfigure' }, repair: { intent: SetupIntent.repair, kind: 'install' }
});

/**
 * 從（已遮罩的）operation log 取出某個命令最近一次執行的 stdout／stderr 尾端，供結果明細顯示。
 * 內容來自 log，因此與 log 一樣只含遮罩後的文字；log 不存在或沒有該命令時回傳空陣列。
 */
export function readCommandOutput(logPath, commandId, limit = 30) {
  let text;
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return []; }
  const lines = text.split('\n');
  const start = lines.findLastIndex(line => line.includes(`] [command-start] ${commandId} `));
  if (start < 0) return [];
  const output = [];
  for (const line of lines.slice(start + 1)) {
    if (/\] \[(command-end|cancelled|timed-out)\] /.test(line)) break;
    const match = /^\[[^\]]+\] \[(stdout|stderr)\] (.*)$/.exec(line);
    if (match) output.push(`[${match[1]}] ${match[2]}`);
  }
  return output.slice(-limit);
}

const TARGET_WIRE = { Succeeded: 'succeeded', Failed: 'failed', RolledBack: 'rolled-back', RollbackIncomplete: 'rollback-incomplete', Stale: 'stale', Skipped: 'skipped' };
const canResume = state => [OperationState.incomplete, OperationState.failed, OperationState.cancelled, OperationState.timedOut].includes(state);

/**
 * @param {object} options
 * @param {object} options.planner   createDeploymentPlanner 的結果；target 交易邊界仍然只在它裡面
 * @param {{run(request: object): Promise<object>}} [options.executor]  設定命令執行器；產品路徑一律是 runSetupCommand，替身只讓順序保證能在不啟動真實子行程時被鎖定
 * @param {() => Date} [options.now]
 * @param {number} [options.commandTimeoutMs]  逾時覆寫；產品路徑永遠留空，timeout 完全由已審核計畫決定
 */
export function createOperationOrchestrator({ planner, executor, now = () => new Date(), commandTimeoutMs = null }) {
  const config = planner.config;
  const store = createOperationStore({ home: config.home, now, rules: planner.rules });
  const run = executor?.run ?? (request => runSetupCommand(request));

  function resolveOperation(reviewed, action, resumeOperationId) {
    if (resumeOperationId) {
      return store.get(store.ensureValidId(resumeOperationId)) ?? (() => { throw new Error(`找不到要繼續的 operation：${resumeOperationId}`); })();
    }
    const intent = reviewed.intent;
    return store.create({ kind: Actions[action].kind, packageKey: reviewed.package.key, packageVersion: reviewed.package.version, scope: intent.scope,
      projectRoot: intent.scope === 'project' ? intent.projectRoot : null, checkpoint: Checkpoints.created });
  }

  /**
   * 執行一次 install／update／reinstall／repair／reconfigure 操作。
   * @param {object} request
   * @param {object} request.reviewedPlan    使用者剛審核的那一份計畫；orchestrator 不重新規劃使用者沒看過的內容
   * @param {{planDigest: string, replaceUnmanagedFiles?: boolean}} request.authorization  必須綁定該計畫的 digest
   * @param {string} [request.action]        必須與產生計畫時的 setup 意圖一致
   * @param {string} [request.resumeOperationId]  沿用既有 operation 繼續或重試：log 追加新的 session header，成功且無需重跑的命令不會再跑
   * @param {AbortSignal} [request.signal]   使用者取消
   * @param {(event: object) => void} [request.onProgress]  選填的純觀察出口：回報永遠不得影響安裝正確性
   */
  async function apply({ reviewedPlan: reviewed, authorization, action = 'install', resumeOperationId, signal, onProgress }) {
    if (!Actions[action]) throw new RangeError(`未知的生命週期動作：${action}`);
    const intent = reviewed.intent;
    const record = resolveOperation(reviewed, action, resumeOperationId);
    const session = store.beginSession(record.operationId);
    const masker = createSecretMasker();
    const log = openOperationLog({ logPath: record.logPath, masker, sessionNumber: session, reason: session === 1 ? 'first-run' : 'retry', now });
    const base = { operationId: record.operationId, logPath: record.logPath };
    // 回報永遠不得影響安裝正確性：進度出口由呼叫端提供，丟例外只是它自己的錯誤。
    const report = event => { if (!onProgress) return; try { onProgress({ ...event, ...base }); } catch { /* 觀察面壞掉不是停止一個已經有副作用的安裝的理由 */ } };
    const reportCompleted = (state, checkpoint) => report({ kind: 'completed', checkpoint, state, succeeded: state === OperationState.succeeded });
    const commands = [];

    const finishWith = (state, checkpoint, problems, status, apply = null, summary = null) => {
      store.transition(record.operationId, state, checkpoint, summary, masker);
      reportCompleted(state, checkpoint);
      return { operationId: record.operationId, state, checkpoint, status, commands, apply, problems, logPath: record.logPath, canResume: canResume(state) };
    };
    const reject = (checkpoint, problem, status = 'Rejected') => {
      log.writeNote(`operation rejected at ${checkpoint}: ${problem.summary}`);
      return finishWith(OperationState.failed, checkpoint, [problem], status, null, problem.summary);
    };
    const cancelled = checkpoint => {
      log.writeNote(`operation cancelled at ${checkpoint}`);
      return finishWith(OperationState.cancelled, checkpoint, [blocking(ProblemCodes.setupCancelled, '操作已取消', '使用者在收斂前取消；可沿用同一 operation 重試。')], 'Failed', null, '使用者取消');
    };

    try {
      // 進度出口的第一則：log 檔已經存在才回報，呼叫端一收到就能開始尾隨。
      report({ kind: 'operation-started', checkpoint: record.checkpoint });

      // 2. 前置檢查。任何一項不通過都是零命令、零 target 寫入。
      if (reviewed.planDigest !== authorization?.planDigest) {
        return reject(Checkpoints.rejected, blocking(ProblemCodes.planStale, 'Apply 授權與已審核 Plan 的 digest 不符', 'Apply 必須綁定使用者剛審核的 PlanDigest；請重新 Plan 並重新確認。'));
      }
      if (!withCanApply(reviewed).canApply) {
        return reject(Checkpoints.rejected, blocking(ProblemCodes.applyFailed, 'Plan 含 blocking problem，無法 Apply', 'blocking problem 不能被 --yes、force 或風險確認忽略。'));
      }
      // 動作與規劃時的 setup 意圖必須一致，否則重建的 Plan 會因為「要不要跑」不同而假性 stale，使用者只會看到看不懂的 stale 訊息。
      if (reviewed.setup?.hasSetup && config.setupIntent !== Actions[action].intent) {
        return reject(Checkpoints.rejected, blocking(ProblemCodes.setupIntentMismatch, '生命週期動作與規劃時的設定意圖不一致',
          `Plan 以 '${config.setupIntent}' 規劃，操作卻是 '${Actions[action].intent}'。請以相同意圖重新 Plan 並重新確認，否則使用者審核的略過理由不成立。`));
      }
      if (signal?.aborted) return cancelled(Checkpoints.rejected);

      // 3. Apply 前重建 observations 與 digest。stale 一律在啟動任何子行程之前就被拒。
      const fresh = planner.plan(intent);
      if (fresh.planDigest !== reviewed.planDigest) {
        return reject(Checkpoints.stale, blocking(ProblemCodes.planStale, '實際狀態已與審核時不同', '檔案、設定、receipt 或安裝設定在審核後改變；零命令、零寫入。請重新 Plan 並重新確認。'), 'Stale');
      }

      // 4. 設定命令。宣告順序即執行順序；第一個沒有成功的命令就是終點。
      let pkg;
      try { pkg = openCanonicalPackage(intent.package); } catch (e) {
        if (e instanceof CanonicalPackageError) return reject(Checkpoints.rejected, e.toProblem());
        throw e;
      }
      function finishCommandFailure({ command, result }) {
        const state = result.outcome === 'Cancelled' ? OperationState.cancelled : result.outcome === 'TimedOut' ? OperationState.timedOut : OperationState.failed;
        const checkpoint = Checkpoints.setupCommand(command.commandId);
        log.writeNote(`operation ${state} at ${checkpoint}`);
        const problem = { ...blocking(ProblemCodes.setupCommandFailed, `設定命令 '${masker.mask(command.name)}' 未成功`, result.failureSummary ?? '詳細輸出只儲存在 operation log。標準內容尚未寫入任何目標。'),
          scope: fresh.setup.scope, contentId: fresh.setup.packageKey,
          commandName: masker.mask(command.name), failureSummary: masker.mask(
            result.outcome === 'TimedOut' ? '執行超過時間限制' : result.outcome === 'Cancelled' ? '已取消執行'
              : result.outcome === 'StartFailed' ? '無法啟動執行程式，請確認已安裝並允許執行'
                : result.exitCode != null ? `結束代碼 ${result.exitCode}` : result.failureSummary ?? '請展開詳細紀錄查看原因') };
        return finishWith(state, checkpoint, [problem], 'Failed', null, result.failureSummary ?? `設定命令 ${command.commandId} 未成功`);
      }

      if (fresh.setup?.hasSetup) {
        // setup 身分根與「裝進哪一個用戶端根」無關；Global 多根時用 Targets[0] 會讓執行端建立的 setup root 與計畫揭露的不是同一個目錄。
        const canonicalRoot = resolveSetupIdentityRoot(fresh.setup.scope, intent.projectRoot, config.userHome, planner.rules);
        const context = createExecutionContext({ home: config.home, packageKey: fresh.setup.packageKey, packageVersion: fresh.setup.packageVersion, scope: fresh.setup.scope, canonicalRoot,
          projectRoot: fresh.setup.scope === 'project' ? intent.projectRoot : null, rules: planner.rules });
        try {
          const failure = await runCommands({ record, setup: fresh.setup, pkg, context, log, masker, commands, report, signal, intent });
          if (failure) return finishCommandFailure(failure);
          const managed = planner.managedMcpContents(pkg, fresh.setup);
          if (managed.length) {
            store.transition(record.operationId, OperationState.running, Checkpoints.managedMcp);
            planner.writeManagedMcpDescriptors(pkg, fresh.setup);
            for (const content of managed) log.writeNote(`managed mcp launch descriptor written: ${content.id}`);
          }
        } catch (e) {
          if (e instanceof SetupSecretStoreError) {
            const problem = blocking(ProblemCodes.secretUnresolved, '無法取得設定命令所需的秘密', e.message);
            log.writeNote(`operation failed at ${Checkpoints.setupCommands}: ${problem.summary}`);
            return finishWith(OperationState.failed, Checkpoints.setupCommands, [problem], 'Failed', null, problem.summary);
          }
          throw e;
        }
      }

      // 5. 命令全部成功後才進 target 交易；每個 target 仍是獨立交易，partial 語意不變。
      store.transition(record.operationId, OperationState.running, Checkpoints.targets);
      report({ kind: 'targets-started', checkpoint: Checkpoints.targets });
      // operationId 告訴 planner：設定階段已在本 operation 內完成並記錄，設定層的 stale 比對不得重做，否則命令一跑完就會假性 stale。
      const applied = planner.apply(reviewed, { ...authorization, operationId: record.operationId });
      for (const target of applied.targets) {
        const result = TARGET_WIRE[target.status] ?? String(target.status).toLowerCase();
        store.recordTarget(record.operationId, { targetKey: target.targetKey, result, detail: target.diagnosticId ?? null });
        log.writeTargetResult(target.targetKey, result, target.diagnosticId);
        report({ kind: 'target-finished', checkpoint: Checkpoints.targets, targetKey: target.targetKey, targetResult: result, succeeded: target.status === 'Succeeded' });
      }
      const [state, checkpoint] = { Succeeded: [OperationState.succeeded, Checkpoints.completed], Partial: [OperationState.incomplete, Checkpoints.targetsIncomplete],
        Stale: [OperationState.failed, Checkpoints.stale] }[applied.status] ?? [OperationState.failed, Checkpoints.targets];
      const summary = state === OperationState.succeeded ? null
        : [...applied.targets.flatMap(t => t.problems ?? []), ...(applied.problems ?? [])].find(p => p.severity === 'Blocking')?.summary ?? null;
      log.writeNote(`operation ${state} at ${checkpoint}`);
      return finishWith(state, checkpoint, applied.problems ?? [], applied.status, applied, summary);
    } catch (e) {
      // 非預期錯誤：把 operation 標成失敗再重新擲出，避免留下永遠 running 的紀錄。
      try { store.transition(record.operationId, OperationState.failed, undefined, e?.message ?? String(e), masker); } catch { /* 狀態檔本身也壞了 */ }
      throw e;
    } finally {
      log.close();
    }
  }

  /** 依宣告順序執行設定命令；回傳非 null 表示已經停在某個命令，呼叫端必須立即返回——target executor 不得被呼叫。 */
  async function runCommands({ record, setup, pkg, context, log, masker, commands, report, signal, intent }) {
    const declared = pkg.manifest.setup?.commands ?? [];
    // 受管 MCP 描述也需要 setup root，因此即使本次沒有命令要跑也要備好目錄。
    context.ensureDirectories();
    const skipped = command => {
      log.writeNote(`setup command skipped: ${command.commandId} (${command.reason})`);
      commands.push({ commandId: command.commandId, name: masker.mask(command.name), executed: false, reason: command.reason, outcome: null, exitCode: null, failureSummary: null, succeeded: true });
    };
    if (!setup.commands.some(c => c.willExecute)) { setup.commands.forEach(skipped); return null; }

    store.transition(record.operationId, OperationState.running, Checkpoints.setupCommands);
    // payload 只在真的要執行時才落地，且每次重建，不可能殘留上一版檔案。
    context.materializePayload(pkg, declared);
    const declarations = setup.parameters.filter(p => p.isSecret && p.secretUsage).map(p => ({ parameterId: p.parameterId, usage: p.secretUsage, required: p.required }));
    const channel = openSecretChannel({ manager: config.secrets(), packageKey: setup.packageKey, scope: setup.scope, canonicalRoot: context.canonicalRoot, declarations,
      usage: SecretUsages.setupTime, rules: planner.rules });
    try {
      // 遮罩必須在任何輸出寫入之前就備妥。
      channel.registerRedaction(secret => masker.register(secret));
      const completions = SetupCommandCompletionStore.forScope({ scope: setup.scope, projectRoot: setup.scope === 'project' ? intent.projectRoot : null, home: config.home });
      for (const command of setup.commands) {
        // 使用者在命令之間取消：下一個命令不啟動。
        if (signal?.aborted) return { command, result: { commandId: command.commandId, outcome: 'Cancelled', exitCode: null, durationMs: 0, failureSummary: '使用者在設定命令啟動前取消；命令尚未執行。', succeeded: false } };
        if (!command.willExecute) { skipped(command); continue; }
        // 理由必須同時出現在 Plan、log 與 result；三者都來自同一個權威判斷。
        log.writeNote(`setup command run: ${command.commandId} (${command.reason})`);
        // 顯示名稱來自 manifest 的自由文字，因此走與 log 相同的 masker，不另開未遮罩路徑。
        const displayName = masker.mask(command.name);
        report({ kind: 'setup-command-started', checkpoint: Checkpoints.setupCommands, commandId: command.commandId, commandName: displayName });
        const result = await run({ command, context, operatingSystem: config.operatingSystem, log, secrets: channel, operationId: record.operationId, signal, timeoutMs: commandTimeoutMs, registry: config.runners });
        completions.record(setup.packageKey, command.commandId, setup.packageVersion, command.scriptSha256, result.succeeded, record.operationId, now());
        commands.push({ commandId: command.commandId, name: displayName, executed: true, reason: command.reason, outcome: result.outcome, exitCode: result.exitCode, failureSummary: result.failureSummary, succeeded: result.succeeded });
        // 只回報結構化結局：失敗摘要與子行程輸出一律只留在已遮罩的 operation log。
        report({ kind: 'setup-command-finished', checkpoint: Checkpoints.setupCommands, commandId: command.commandId, commandName: displayName, succeeded: result.succeeded, exitCode: result.exitCode, durationMs: result.durationMs });
        if (!result.succeeded) return { command, result };
      }
      return null;
    } finally {
      channel.dispose();
    }
  }

  return { apply, store };
}
