// 自動處理衝突的摘要呈現（ADR 0002）：把核心規劃出的衝突說明整理成面板可展開的明細。
// 核心（planner／resource-drivers）決定「能不能處理」；這裡只決定「如何說明」，不改變任何部署行為。
import { ProblemCodes } from './problems.mjs';
import { HostIds, SurfaceIds, Scope } from './host-profiles.mjs';

/** 先備份再套用的原因；只有計畫實際會備份的變更才有。 */
export function backupReasonOf(mutation, problems) {
  if (!mutation.willBackup) return null;
  const match = (code) => problems.some(p => p.code === code && p.severity === 'Warning' && p.contentId === mutation.contentId);
  if (match(ProblemCodes.unmanagedCollision)) return 'unmanaged';
  if (match(ProblemCodes.localModification)) return 'localModification';
  return null;
}

const AUTOMATIC_EXPLANATIONS = {
  [ProblemCodes.unmanagedCollision]: '目的地已有未受管的同名內容；套用時會自動先備份（原名稱加 .bak-lcaipack-<時間戳>）再部署，不需額外確認。',
  [ProblemCodes.localModification]: '受管內容安裝後被本機修改；套用時會自動先備份（原名稱加 .bak-lcaipack-<時間戳>）再部署，不需額外確認。'
};

/** 可自動處理（警告等級）的衝突，用資源中心的自動處理語氣說明；其餘問題維持核心的說明。 */
export const presentExplanation = (p) => p.severity === 'Warning' && AUTOMATIC_EXPLANATIONS[p.code] ? AUTOMATIC_EXPLANATIONS[p.code] : p.explanation;

const GLOBAL_FIRST ='globalFirst', PROJECT_FIRST = 'projectFirst', BOTH = 'bothLoaded', UNDOCUMENTED = 'undocumented';

/**
 * 同名資源同時存在於全域與專案時，各 AI 工具載入哪一份（依官方文件；文件沒有明訂的組合如實標示「未明訂」，不自行推測）。
 * Claude Code：Skill 個人（全域）優先於專案；Agent 與 MCP 專案優先於使用者。
 * Codex：Skill 兩份都會列出、不合併；專案 .codex/config.toml 優先於使用者設定（僅信任的專案）。
 */
const RULES = Object.freeze({
  [`${HostIds.claudeCode}|${SurfaceIds.claudeCodeCli}`]: Object.freeze({ skill: GLOBAL_FIRST, agent: PROJECT_FIRST, mcp: PROJECT_FIRST }),
  [`${HostIds.codex}|${SurfaceIds.codexCli}`]: Object.freeze({ skill: BOTH, mcp: PROJECT_FIRST })
});

export const loadRuleFor = (host, kind) => RULES[`${host.hostId}|${host.surfaceId}`]?.[kind] ?? UNDOCUMENTED;

const KIND_LABELS = { skill: 'Skill', agent: 'Agent', mcp: 'MCP', prompt: 'Prompt', command: 'Command' };
const SCOPE_LABELS = { [Scope.global]: '全域', [Scope.project]: '專案' };

function explain(rule, kind, versions) {
  const k = KIND_LABELS[kind] ?? kind;
  const { global: g, project: p } = versions;
  switch (rule) {
    case GLOBAL_FIRST: return `${k} 同名時全域優先於專案：專案內實際使用全域版本 ${g}，專案版本 ${p} 被遮蔽。`;
    case PROJECT_FIRST: return `${k} 同名時專案優先於全域：專案內實際使用專案版本 ${p}，全域版本 ${g} 被遮蔽。`;
    case BOTH: return `${k} 同名時兩份都會載入、不會合併：全域版本 ${g} 與專案版本 ${p} 可能同時出現在選單。`;
    default: return `官方文件沒有明訂同名 ${k} 的載入優先順序：全域版本 ${g} 與專案版本 ${p} 都已寫入，請以工具實際行為為準。`;
  }
}

/**
 * 載入優先順序明細。來源是核心 scope-shadowing 問題附帶的 `shadowed`（另一範圍已管理的同 contentId 收據）。
 * @returns {Array<{contentId, kind, rule, winner, text, locations: Array<{scope, scopeLabel, path, version, current}>}>}
 */
export function describeLoadPrecedence(target, packageVersion) {
  const out = [];
  for (const problem of target.problems.filter(p => p.code === ProblemCodes.scopeShadowing)) {
    for (const other of problem.shadowed ?? []) {
      const mutation = target.mutations.find(m => m.contentId === other.contentId);
      const kind = mutation?.kind ?? other.kind;
      const rule = loadRuleFor(target.host, kind);
      const versions = { [target.scope]: packageVersion, [other.scope]: other.packageVersion };
      out.push({
        contentId: other.contentId, kind, rule,
        winner: rule === GLOBAL_FIRST ? Scope.global : rule === PROJECT_FIRST ? Scope.project : rule === BOTH ? 'both' : 'unknown',
        text: explain(rule, kind, versions),
        locations: [
          { scope: target.scope, scopeLabel: SCOPE_LABELS[target.scope], path: mutation?.destinationPath ?? target.canonicalRoot, version: packageVersion, current: true },
          { scope: other.scope, scopeLabel: SCOPE_LABELS[other.scope] ?? other.scope, path: other.destinationPath, version: other.packageVersion, current: false }
        ].sort((a, b) => (a.scope === Scope.global ? 0 : 1) - (b.scope === Scope.global ? 0 : 1))
      });
    }
  }
  return out;
}
