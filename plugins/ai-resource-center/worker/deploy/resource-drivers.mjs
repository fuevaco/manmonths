// Resource Drivers（對照 Deployment/ResourceDrivers.cs）：依 canonical kind 把內容展開成變更，不寫入目標。
// Skill 整棵目錄同步；Agent／Prompt／Command render 成原生檔案。MCP 由工項 08 加入。
import { ofBytes, ofText, ofTree } from './digest.mjs';
import { renderArtifact } from './artifact-dialects.mjs';
import { HostRootBaseIds, MutationKind, isSafeTemplate } from './host-profiles.mjs';
import { isSharedSkillPath, resolveCodexBase } from './codex-roots.mjs';
import { observe, observeTree, PathState } from './observer.mjs';
import { ProblemCodes, blocking } from './problems.mjs';
import fs from 'node:fs';
import { getConfigAdapter } from './config-document-adapters.mjs';
import { CanonicalPackageError } from './canonical-package.mjs';
import { Missing } from './observer.mjs';
import { resolveClaudeUserConfigDirectory } from './claude-code-roots.mjs';

export const PlannedChange = Object.freeze({ create: 'Create', replace: 'Replace', merge: 'Merge', noOp: 'NoOp' });
const backupExplanation = kind => kind === 'skill'
  ? '已授權備份後覆蓋。技能資料夾會先備份至共用資料目錄下的 backups。'
  : '已授權備份後覆蓋。原檔案會先備份至原位置旁，檔名加上 .bak-lcaipack-<時間戳>。';

/** 同一 target 內穩定且可排序的 mutation id。 */
export const mutationId = (ctx, contentId, destination) =>
  ofText(`${ctx.host.hostId}|${ctx.host.surfaceId}|${ctx.scope}|${ctx.canonicalRoot}|${contentId}|${ctx.rules.normalize(destination)}`).slice(0, 16);

function resolveRootBase(route, ctx) {
  const base = route.rootBaseFor(ctx.scope);
  if (base === HostRootBaseIds.claudeCodeUserConfigFile) return resolveClaudeUserConfigDirectory(ctx.canonicalRoot, ctx.userHome, ctx.rootOrigin === 'ConfigDirEnvironment', ctx.rules);
  return resolveCodexBase(ctx.canonicalRoot, ctx.userHome, base, ctx.rules);
}

/** 解析 route 目的地；只接受 {root} 與 {id}，展開後必須落在 base 底下。 */
export function resolveDestination(route, ctx, contentId) {
  const template = route.templateFor(ctx.scope);
  if (template == null) {
    return { problem: blocking(ProblemCodes.unsupportedRoute, `${ctx.host.hostId}／${ctx.host.surfaceId} 的 ${ctx.scope} 範圍不支援此內容`,
      'Host Profile 未定義該 Host／Surface／Scope 的目的地；請改用支援的 scope 或 surface。',
      { host: ctx.host, scope: ctx.scope, contentId, resolutions: ['改用另一個 scope', '改用另一個 surface'] }) };
  }
  if (!isSafeTemplate(template)) throw new Error(`Host Profile template 不安全：${template}`);
  const rootBase = resolveRootBase(route, ctx);
  const api = ctx.rules.path;
  const expanded = template.replaceAll('{root}', rootBase).replaceAll('{id}', contentId).replaceAll('/', api.sep);
  const full = api.resolve(expanded);
  const contained = route.rootBaseFor(ctx.scope) === HostRootBaseIds.codexSkillsRoot
    ? isSharedSkillPath(ctx.userHome, contentId, full, ctx.rules) : ctx.rules.isWithin(rootBase, full);
  if (!contained) {
    return { problem: blocking(ProblemCodes.pathEscape, `目的地逃出 canonical root：${full}`, `canonical root 為 ${rootBase}；不接受逃出 root 的目的地。`,
      { host: ctx.host, scope: ctx.scope, contentId, path: full }) };
  }
  return { destination: full };
}

/** 既有內容政策；不可跨資源包搶奪 ownership。回傳是否需要備份。 */
export function evaluateConflict(content, ctx, destination, before, ownership, problems) {
  if (ownership.isManaged && !ownership.isSameOwner) {
    problems.push(blocking(ProblemCodes.ownershipCollision, `目的地已由資源包 '${ownership.ownerPackageKey}' 的 '${ownership.ownerContentId}' 擁有`,
      '同一部署目標內，相同 contentId 或目的地不得由不同 package 擁有。force、風險確認與 shadowing 同意都不能搶奪 ownership。',
      { host: ctx.host, scope: ctx.scope, contentId: content.id, path: destination, existingOwner: ownership,
        resolutions: ['到已安裝資源明確解除安裝原擁有者', '解除安裝後重新 Plan 與 Apply'] }));
    return false;
  }
  if (before.state === PathState.missing) return false;
  if (!ownership.isManaged) {
    const p = blocking(ProblemCodes.unmanagedCollision, `目的地已存在但沒有部署管理紀錄：${destination}`,
      '為避免覆蓋使用者自有內容，預設阻擋。重新以「備份後覆蓋」規劃後才會揭露備份並可 Apply。',
      { host: ctx.host, scope: ctx.scope, contentId: content.id, path: destination, existingOwner: ownership,
        resolutions: ['以 BackupAndReplace 重新 Plan', '先手動移除或改名既有內容'] });
    if (!ctx.allowBackupAndReplace) { problems.push(p); return false; }
    problems.push({ ...p, severity: 'Warning', explanation: backupExplanation(content.kind) });
    return true;
  }
  return evaluateLocalModification(content, ctx, destination, before, ownership, problems);
}

export function evaluateLocalModification(content, ctx, destination, before, ownership, problems) {
  if (before.state === PathState.missing) return false;
  const installed = ownership.installedSha256;
  const current = before.state === PathState.directory ? before.treeSha256 : before.sha256;
  const modified = installed != null && installed !== '' && current != null && installed.toLowerCase() !== current.toLowerCase();
  if (!modified) return false;
  if (before.length === 0) return false; // 受管內容已被清空 = 損毀，補回不會覆蓋使用者內容
  const p = blocking(ProblemCodes.localModification, `受管內容安裝後已被本機修改：${destination}`,
    '不靜默覆寫本機修改。重新以「備份後覆蓋」規劃後才會揭露備份並可 Apply。',
    { host: ctx.host, scope: ctx.scope, contentId: content.id, path: destination, existingOwner: ownership,
      resolutions: ['以 BackupAndReplace 重新 Plan', '手動還原本機修改後重新 Plan'] });
  if (!ctx.allowBackupAndReplace) { problems.push(p); return false; }
  problems.push({ ...p, severity: 'Warning', explanation: backupExplanation(content.kind) });
  return true;
}

/** Skill 目錄：整棵同步，內容不改寫。 */
const skillDriver = Object.freeze({
  kind: 'skill',
  expand(content, route, ctx) {
    const resolved = resolveDestination(route, ctx, content.id);
    if (resolved.problem) return { mutations: [], problems: [resolved.problem], configuration: [], artifacts: [] };
    const destination = resolved.destination;
    const files = ctx.package.readTree(content.sourcePath);
    const renderedSha = ofTree(files);
    const before = observeTree(destination);
    const ownership = ctx.ownership.resolveFile(content.id, destination);
    const problems = [];
    const change = before.state === PathState.missing ? PlannedChange.create
      : (before.treeSha256 ?? '').toLowerCase() === renderedSha && ownership.isSameOwner ? PlannedChange.noOp : PlannedChange.replace;
    const willBackup = evaluateConflict(content, ctx, destination, before, ownership, problems);
    const id = mutationId(ctx, content.id, destination);
    return {
      mutations: [Object.freeze({ mutationId: id, contentId: content.id, kind: 'skill', mutationKind: MutationKind.syncTree, change,
        destinationPath: destination, sourceEntry: content.sourcePath, renderedSha256: renderedSha, ownedFieldPaths: [], redactedDiff: null,
        before, ownership, willBackup })],
      problems, configuration: [],
      artifacts: [{ mutationId: id, kind: MutationKind.syncTree, destinationPath: destination, fileContent: null, treeFiles: files, configPatch: null }]
    };
  }
});

function fileDriver(kind) {
  return Object.freeze({ kind, expand(content, route, ctx) {
    const resolved = resolveDestination(route, ctx, content.id);
    if (resolved.problem) return { mutations: [], problems: [resolved.problem], configuration: [], artifacts: [] };
    const destination = resolved.destination;
    const rendered = renderArtifact(content, ctx.package.readFile(content.sourcePath), route.artifactDialectId);
    const renderedSha = ofBytes(rendered);
    const before = observe(destination);
    const ownership = ctx.ownership.resolveFile(content.id, destination);
    const problems = [];
    const change = before.state === PathState.missing ? PlannedChange.create
      : before.sha256 === renderedSha && ownership.isSameOwner ? PlannedChange.noOp : PlannedChange.replace;
    const willBackup = evaluateConflict(content, ctx, destination, before, ownership, problems);
    const id = mutationId(ctx, content.id, destination);
    return {
      mutations: [Object.freeze({ mutationId: id, contentId: content.id, kind, mutationKind: MutationKind.writeFile, change,
        destinationPath: destination, sourceEntry: content.sourcePath, renderedSha256: renderedSha, ownedFieldPaths: [], redactedDiff: null,
        before, ownership, willBackup })],
      problems, configuration: [],
      artifacts: [{ mutationId: id, kind: MutationKind.writeFile, destinationPath: destination, fileContent: rendered, treeFiles: null, configPatch: null }]
    };
  } });
}

const mcpDriver = Object.freeze({ kind: 'mcp', expand(content, route, ctx) {
  const resolved = resolveDestination(route, ctx, content.id);
  if (resolved.problem) return { mutations: [], problems: [resolved.problem], configuration: [], artifacts: [] };
  const destination = resolved.destination;
  const adapter = getConfigAdapter(route.configAdapterFor(ctx.scope));
  let exists, local, patch;
  try {
    exists = fs.existsSync(destination);
    if (exists) { if (!fs.statSync(destination).isFile()) throw new Error('設定檔路徑不是檔案'); fs.accessSync(destination, fs.constants.R_OK | fs.constants.W_OK); }
    else {
      let parent = ctx.rules.path.dirname(destination);
      while (!fs.existsSync(parent)) { const next = ctx.rules.path.dirname(parent); if (next === parent) break; parent = next; }
      fs.accessSync(parent, fs.constants.W_OK);
    }
    local = exists ? fs.readFileSync(destination) : Buffer.alloc(0);
    patch = adapter.planPatch(local, exists, content, ctx.ownership.configSnapshot(destination), {
      host: ctx.host, scope: ctx.scope, operatingSystem: ctx.operatingSystem, packageKey: ctx.package.identity.key, configPath: destination, setup: ctx.setup ?? null
    });
    adapter.applyPatch(local, exists, patch); // 在規劃時確認可安全 render；不寫檔。
  } catch {
    return { mutations: [], configuration: [], artifacts: [], problems: [blocking(ProblemCodes.configConflict,
      `目標設定檔無法安全解析或寫入：${destination}`, '請修正設定檔後重試。',
      { host: ctx.host, scope: ctx.scope, contentId: content.id, path: destination, configPath: destination })] };
  }
  const current = exists ? adapter.readNodeJson(local, patch.nodePath) : null;
  const stamp = json => json === null ? Missing : { state: PathState.configNode, sha256: ofText(json), treeSha256: null, length: Object.keys(JSON.parse(json)).length, lastWriteUtc: null };
  const before = stamp(current), problems = [...patch.problems];
  let willBackup = false;
  if (patch.ownership.isManaged && patch.ownership.isSameOwner) willBackup = evaluateLocalModification(content, ctx, `${destination}#${patch.nodePath}`,
    stamp(exists ? adapter.readComparableNodeJson(local, patch.nodePath) : null), patch.ownership, problems);
  if (ctx.allowBackupAndReplace) for (let i = 0; i < problems.length; i++) if (problems[i].code === ProblemCodes.unmanagedCollision) {
    problems[i] = { ...problems[i], severity: 'Warning' }; willBackup = true;
  }
  const id = mutationId(ctx, content.id, destination);
  return { mutations: [{ mutationId: id, contentId: content.id, kind: 'mcp', mutationKind: MutationKind.patchConfig, change: patch.change,
    destinationPath: destination, sourceEntry: null, renderedSha256: ofText(patch.renderedNodeJson), ownedFieldPaths: patch.ownedFieldPaths,
    redactedDiff: `- ${patch.redactedBefore}\n+ ${patch.redactedAfter}`, before, ownership: patch.ownership, willBackup }], problems,
    configuration: [{ contentId: content.id, path: destination, format: adapter.format, ownedFields: patch.ownedFieldPaths, redactedBefore: patch.redactedBefore, redactedAfter: patch.redactedAfter }],
    artifacts: [{ mutationId: id, kind: MutationKind.patchConfig, destinationPath: destination, configPatch: patch, configAdapterId: adapter.id }] };
} });

const registry = new Map([skillDriver, fileDriver('agent'), fileDriver('prompt'), fileDriver('command'), mcpDriver].map(driver => [driver.kind, driver]));

/** 取得 driver；尚未在 Orca 實作的內容類型回傳 null，由 planner 揭露為阻擋問題。 */
export const getDriver = (kind) => registry.get(kind) ?? null;

