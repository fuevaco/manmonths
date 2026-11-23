// 安裝設定的參數規劃（對照 Setup/SetupPlanning.cs 的參數部分、SetupRoot.cs、PlanDigest.AppendSetup）。
// 規劃零寫入：只讀已儲存值、查詢秘密有無；秘密的有效值永遠是 null。
// 設定命令（setup.commands，對照 SetupPlanner.PlanCommands）：揭露身分、runner、腳本雜湊、已插值參數、相容性與「這次要不要跑」；
// 規劃階段不啟動任何子行程。
import { createPathRules } from '../deploy/canonical-root.mjs';
import { ofText, ordinal } from '../deploy/digest.mjs';
import { ProblemCodes, blocking } from '../deploy/problems.mjs';
import { SetupValueStore, resolveSetupValues } from './values.mjs';
import { SecretUsages } from './secrets.mjs';
import { SetupCommandCompletionStore, SetupIntent } from './completions.mjs';
import { SetupRunners, SetupCommandLimits, createRunnerRegistry, detectSetupEnvironment } from './runners.mjs';

export { SetupIntent };
const shortHash = (value) => ofText(value).slice(0, 16);
const slug = key => [...key].map(ch => /[A-Za-z0-9._-]/.test(ch) ? ch.toLowerCase() : '_').join('');

/** {home}/setup-roots/{packageKeySlug}/{scope}-{shortHash(正規化根目錄)}；純計算。 */
export function resolveSetupRoot(home, packageKey, scope, canonicalRoot, rules = createPathRules()) {
  return rules.path.resolve(home, 'setup-roots', slug(packageKey), `${scope}-${shortHash(rules.normalize(canonicalRoot))}`);
}

/** setup 身分根：Global 固定使用者家目錄、Project 固定專案根，與部署到哪個用戶端根無關。 */
export function resolveSetupIdentityRoot(scope, projectRoot, userHome, rules = createPathRules()) {
  if (scope === 'project') {
    if (!projectRoot) throw new TypeError('Project scope 必須提供 project root');
    return rules.normalize(projectRoot);
  }
  return rules.normalize(userHome);
}

const declaredSetup = setup => setup && ((setup.parameters?.length ?? 0) + (setup.commands?.length ?? 0)) > 0;

/** JSON 純量轉成儲存與插值用的字串；布林一律小寫。 */
function scalarText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * @param {object} request
 * @param {object|null} request.setup  manifest 的 setup 區塊
 * @param {object} request.secrets     createSecretManager 的結果（只查有無）
 * @param {Record<string,string>} [request.pendingValues]  本次尚未儲存的非秘密輸入
 */
export function planSetup({ setup, packageKey, packageVersion, scope, projectRoot, home, userHome, secrets, pendingValues, intent = SetupIntent.install, rules = createPathRules(),
  runners, environment, scriptSha256 }) {
  const canonicalRoot = resolveSetupIdentityRoot(scope, projectRoot, userHome, rules);
  const setupRoot = resolveSetupRoot(home, packageKey, scope, canonicalRoot, rules);
  const base = { packageKey, packageVersion, scope, canonicalRoot, setupRoot, intent, parameters: [], commands: [], problems: [] };
  if (!declaredSetup(setup)) return finish(base);

  const globalStore = SetupValueStore.forGlobal({ home, userProfile: userHome, rules });
  const projectStore = scope === 'project' && projectRoot ? SetupValueStore.forProject({ projectRoot, rules }) : null;
  const resolution = resolveSetupValues(globalStore, projectStore, packageKey);
  const declarations = (setup.parameters ?? []).filter(p => typeof p?.parameterId === 'string' && p.parameterId);
  const secretStatus = new Map(secrets.describe(packageKey, scope, canonicalRoot, declarations.filter(p => p.type === 'secret')
    .map(p => ({ parameterId: p.parameterId, usage: p.secretUsage ?? SecretUsages.setupTime, required: p.required === true }))).map(s => [s.parameterId, s]));

  const values = new Map();
  for (const p of declarations) {
    const id = p.parameterId;
    if (p.type === 'secret') values.set(id, { value: null, source: 'Unset' });
    else if (pendingValues && Object.hasOwn(pendingValues, id)) values.set(id, { value: pendingValues[id], source: 'PendingInput' });
    else if (resolution[id]) values.set(id, { value: resolution[id].value, source: resolution[id].origin === 'ProjectOverride' ? 'ProjectOverride' : 'Global' });
    else if (p.default !== undefined && scalarText(p.default) !== null) values.set(id, { value: scalarText(p.default), source: 'ManifestDefault' });
    else values.set(id, { value: null, source: 'Unset' });
  }
  const byId = new Map(declarations.map(p => [p.parameterId, p]));
  const memo = new Map();
  const isVisible = (id, visiting = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return false;
    visiting.add(id);
    let visible = true;
    const condition = byId.get(id)?.visibleWhen;
    if (condition && typeof condition.parameterId === 'string' && condition.parameterId) {
      const expected = condition.equals === undefined ? null : scalarText(condition.equals);
      const actual = values.get(condition.parameterId)?.value ?? null;
      visible = expected !== null && expected === actual && isVisible(condition.parameterId, visiting);
    }
    visiting.delete(id);
    memo.set(id, visible);
    return visible;
  };

  base.parameters = declarations.map(p => {
    const id = p.parameterId, isSecret = p.type === 'secret', required = p.required === true;
    const visible = isVisible(id);
    const secretProvided = isSecret && secretStatus.get(id)?.exists === true;
    const { value, source } = values.get(id);
    return { parameterId: id, label: p.label ?? id, type: p.type ?? 'string', description: p.description ?? null, required, visible, isSecret,
      secretUsage: isSecret ? (p.secretUsage ?? null) : null, effectiveValue: isSecret ? null : value, source: isSecret ? 'Unset' : source,
      secretProvided, needsInput: visible && required && (isSecret ? !secretProvided : !value),
      options: !isSecret && p.type === 'choice' ? (p.options ?? []).filter(o => o?.value && o?.label).map(o => ({ value: o.value, label: o.label })) : [] };
  });

  const effective = new Map([...values].filter(([, v]) => v.value !== null).map(([id, v]) => [id, v.value]));
  base.commands = planCommands({ setup, packageKey, packageVersion, scope, projectRoot, home, intent, effective, problems: base.problems,
    runners: runners ?? createRunnerRegistry(), environment: environment ?? detectSetupEnvironment(), scriptSha256: scriptSha256 ?? (() => '') });

  // 對照 ReportMissingParameters：沒有命令時，參數只為 MCP runtime 存在，缺值仍阻擋；有命令時只有真的會執行或 runtime 秘密才阻擋。
  const requiresValues = base.commands.length === 0 || base.commands.some(c => c.willExecute);
  for (const p of base.parameters.filter(p => p.needsInput)) {
    if (!requiresValues && !(p.isSecret && p.secretUsage === SecretUsages.runtime)) continue;
    base.problems.push(blocking(ProblemCodes.setupParameterMissing, `設定參數 '${p.parameterId}' 尚未提供值`,
      p.isSecret ? `'${p.label}' 是必填秘密，必須先存入作業系統安全儲存區才能繼續；秘密不會出現在 Plan、log 或設定檔。`
        : `'${p.label}' 是必填參數，請提供值後重新規劃。`,
      { scope, resolutions: ['在部署摘要填入設定參數後重新產生摘要'] }));
  }
  return finish(base);
}

const SETUP_TOKEN = /\{\{parameter:([^{}]*)\}\}/g;
/** 插值 {{parameter:<id>}}；契約層已保證不可能引用秘密參數，結果可安全進入 argv、揭露與摘要。 */
const interpolate = (args, values) => (args ?? []).map(a => String(a ?? '').replace(SETUP_TOKEN, (_, id) => values.get(id) ?? ''));

function evaluateEligibility(command, environment) {
  if (command.operatingSystems?.length && !command.operatingSystems.includes(environment.operatingSystem)) return 'UnsupportedOperatingSystem';
  return command.architectures?.length && !command.architectures.includes(environment.architecture) ? 'UnsupportedArchitecture' : 'Eligible';
}

function planCommands({ setup, packageKey, packageVersion, scope, projectRoot, home, intent, effective, problems, runners, environment, scriptSha256 }) {
  const declared = setup.commands ?? [];
  if (!declared.length) return [];
  const completions = SetupCommandCompletionStore.forScope({ scope, projectRoot, home });
  // 作者可以「一個 OS 一條命令」宣告；不適用的手足命令只是「本機用不到」，只有整包在此環境完全沒有設定路徑時才阻擋。
  const linux = environment.operatingSystem === 'linux';
  const nativeLinux = linux && declared.some(c => c.operatingSystems?.includes('linux') && evaluateEligibility(c, environment) === 'Eligible');
  const borrowed = c => linux && !nativeLinux && c.operatingSystems?.includes('macos') && c.runner === SetupRunners.bash &&
    (!c.architectures?.length || c.architectures.includes(environment.architecture));
  const eligibilityOf = c => borrowed(c) ? 'Eligible' : evaluateEligibility(c, environment);
  const anyEligible = declared.some(c => eligibilityOf(c) === 'Eligible' && !(linux && c.runner === SetupRunners.powershell));
  return declared.map(command => {
    const commandId = command.commandId ?? '', script = command.script ?? '', runner = command.runner ?? '';
    const sha = script.length ? scriptSha256(script) : '';
    const timeout = command.timeoutMinutes ?? SetupCommandLimits.defaultTimeoutMinutes;
    const runOnUpdate = command.runOnUpdate ?? SetupCommandLimits.defaultRunOnUpdate;
    const eligibility = eligibilityOf(command);
    const resolved = linux && runner === SetupRunners.powershell ? null : runners.resolve(runner, environment.operatingSystem);
    const decision = completions.decide({ packageKey, commandId, packageVersion, scriptSha256: sha, intent, runOnUpdate });
    const willExecute = decision.shouldRun && eligibility === 'Eligible' && resolved != null;
    if (timeout < SetupCommandLimits.minTimeoutMinutes || timeout > SetupCommandLimits.maxTimeoutMinutes) {
      problems.push(blocking(ProblemCodes.invalidSetup, `設定命令 '${commandId}' 的 timeoutMinutes ${timeout} 超出允許範圍`,
        `允許範圍為 ${SetupCommandLimits.minTimeoutMinutes}–${SetupCommandLimits.maxTimeoutMinutes} 分鐘。`, { scope }));
    }
    if (eligibility !== 'Eligible' && !anyEligible) {
      problems.push(blocking(ProblemCodes.setupUnsupportedEnvironment, `設定命令 '${commandId}' 不支援目前環境`,
        `目前環境為 ${environment.operatingSystem}／${environment.architecture}；作者宣告 operatingSystems=[${(command.operatingSystems ?? []).join(', ')}]、` +
        `architectures=[${(command.architectures ?? []).join(', ')}]。必要設定命令不相容時整包阻擋，不會只略過該命令。`,
        { scope, resolutions: ['改用受支援的作業系統或架構安裝', '請資源作者補上此環境的設定命令'] }));
    } else if (eligibility === 'Eligible' && !resolved) {
      problems.push(blocking(ProblemCodes.setupRunnerUnavailable, `找不到設定命令 '${commandId}' 需要的 runner：${runner}`,
        `目前環境為 ${environment.operatingSystem}；平台只支援固定 runner（${SetupRunners.all.join(', ')}），且不接受完整 shell command string。`,
        { scope, resolutions: [`在本機安裝 ${runner}`, '改用支援此 runner 的環境'] }));
    }
    return { commandId, name: command.name ?? commandId, runner, script, scriptSha256: sha, arguments: interpolate(command.arguments, effective),
      operatingSystems: [...(command.operatingSystems ?? [])], architectures: [...(command.architectures ?? [])], timeoutMinutes: timeout, runOnUpdate,
      ...(borrowed(command) ? { borrowedFromOs: 'macos' } : {}),
      eligibility, runnerExecutable: resolved?.executable ?? null, willExecute, reason: decision.reason };
  });
}

/** 本次真的會執行的命令，維持宣告順序。 */
export const executableCommands = plan => (plan?.commands ?? []).filter(c => c.willExecute);

function finish(plan) {
  return { ...plan, hasSetup: plan.parameters.length > 0 || plan.commands.length > 0, canApply: plan.problems.every(p => p.severity !== 'Blocking') };
}

/** 對照 PlanDigest.AppendSetup；沒有 setup 時不寫任何一行。 */
export function appendSetupDigest(plan, rules = createPathRules()) {
  if (!plan?.hasSetup) return '';
  let b = `setup.scope=${plan.scope}\n`;
  b += `setup.root=${rules.normalize(plan.setupRoot)}\n`;
  b += `setup.intent=${plan.intent}\n`;
  for (const p of [...plan.parameters].sort((x, y) => ordinal(x.parameterId, y.parameterId))) {
    b += `setup.parameter=${[p.parameterId, p.type, p.required ? 'required' : 'optional', p.visible ? 'visible' : 'hidden', p.secretUsage ?? '-',
      p.isSecret ? (p.secretProvided ? 'secret:present' : 'secret:absent') : '-', p.isSecret ? '-' : p.effectiveValue ?? '-', p.source].join('|')}\n`;
  }
  for (const c of [...plan.commands].sort((x, y) => ordinal(x.commandId, y.commandId))) {
    b += `setup.command=${[c.commandId, c.runner, c.script, c.scriptSha256, c.arguments.join('\u001f'), c.operatingSystems.join(','), c.architectures.join(','), c.timeoutMinutes,
      c.runOnUpdate ? 'run-on-update' : 'no-run-on-update', c.eligibility, c.willExecute ? 'execute' : 'skip', c.reason].join('|')}\n`;
    if (c.borrowedFromOs) b += `setup.command.borrowed=${c.commandId}|${c.borrowedFromOs}\n`;
  }
  for (const p of [...plan.problems].sort((x, y) => ordinal(x.code, y.code) || ordinal(x.summary, y.summary))) b += `setup.problem=${p.code}|${p.severity}\n`;
  return b;
}

export const computeSetupDigest = (plan, rules) => ofText(appendSetupDigest(plan, rules));
