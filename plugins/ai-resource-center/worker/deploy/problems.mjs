// 部署問題碼（對照 LcAiPack.Contract ProblemCodes；字串值必須一致）。
export const ProblemCodes = Object.freeze({
  invalidPackage: 'deployment.invalid-package',
  unsupportedContentKind: 'deployment.unsupported-content-kind',
  nonStandardContentFields: 'deployment.non-standard-content-fields',
  ignoredContentFields: 'deployment.ignored-content-fields',
  unsupportedHost: 'deployment.unsupported-host',
  unsupportedRoute: 'deployment.unsupported-route',
  sharedSkillsUnavailable: 'deployment.shared-skills-unavailable',
  pathEscape: 'deployment.path-escape',
  destinationCollision: 'deployment.destination-collision',
  ownershipCollision: 'deployment.ownership-collision',
  unmanagedCollision: 'deployment.unmanaged-collision',
  localModification: 'deployment.local-modification',
  scopeShadowing: 'deployment.scope-shadowing',
  configConflict: 'deployment.config-conflict',
  invalidSetup: 'deployment.invalid-setup',
  setupParameterMissing: 'deployment.setup-parameter-missing',
  setupUnsupportedEnvironment: 'deployment.setup-unsupported-environment',
  setupRunnerUnavailable: 'deployment.setup-runner-unavailable',
  setupCommandFailed: 'deployment.setup-command-failed',
  setupIntentMismatch: 'deployment.setup-intent-mismatch',
  setupCancelled: 'deployment.setup-cancelled',
  secretUnresolved: 'deployment.secret-unresolved',
  consentRequired: 'deployment.consent-required',
  sourceChanged: 'deployment.source-changed',
  planStale: 'deployment.plan-stale',
  lockUnavailable: 'deployment.lock-unavailable',
  applyFailed: 'deployment.apply-failed',
  rollbackFailed: 'deployment.rollback-failed',
  orcaClaudeMcpCleanupSkipped: 'deployment.orca-claude-mcp-cleanup-skipped'
});

/** 建立結構化問題；面板不需要解析例外訊息。 */
export const problem = (code, severity, summary, explanation, extra = {}) =>
  ({ code, severity, summary, explanation, resolutions: [], ...extra });
export const blocking = (code, summary, explanation, extra) => problem(code, 'Blocking', summary, explanation, extra);
export const warning = (code, summary, explanation, extra) => problem(code, 'Warning', summary, explanation, extra);
