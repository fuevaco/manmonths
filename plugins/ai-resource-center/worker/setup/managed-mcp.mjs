// 受管 MCP 的 setup 接縫（對照 Deployment/SetupRenderContexts.cs、Setup/ManagedMcpLaunch.cs、McpNodeRenderer.BuildLaunchDescriptor）。
// 只有 definition.parameters 指向 runtime 秘密的 MCP 需要受管 launcher：Host 設定只寫 node、外掛自帶 launcher 腳本路徑與非秘密身分，
// 啟動描述寫在 {setupRoot}/mcp/{contentId}.json，只儲存秘密身分、不儲存秘密值。
import os from 'node:os';
import path from 'node:path';
import { createPathRules } from '../deploy/canonical-root.mjs';
import { writeTextAtomic } from '../deploy/receipts.mjs';
import { writeJsonValue } from './values.mjs';

export const LauncherVerb = 'mcp-launch';
export const LaunchFormatVersion = 1;

/** launcherPath 是腳本絕對路徑或延遲解析函式；沒有 setup 回傳 null，規劃與套用共用此建構點。 */
export function buildSetupRenderContext(pkg, setupPlan, launcherPath) {
  if (!setupPlan?.hasSetup) return null;
  const runtimeSecretParameterIds = new Set(setupPlan.parameters.filter(p => p.isSecret && p.secretUsage === 'runtime').map(p => p.parameterId));
  let launcherUnavailableReason;
  if (typeof launcherPath === 'function') {
    try {
      launcherPath = pkg.contents.some(content => runtimeSecretIds(content.definition, { runtimeSecretParameterIds }).length)
        ? launcherPath() : null;
    } catch (error) {
      if (error.code !== 'mcp_launcher_unavailable') throw error;
      launcherPath = null;
      launcherUnavailableReason = error.message;
    }
  }
  return Object.freeze({ packageKey: pkg.identity.key, packageVersion: pkg.identity.version, scope: setupPlan.scope, canonicalRoot: setupPlan.canonicalRoot,
    ...(launcherUnavailableReason ? { launcherUnavailableReason } : {}), setupRoot: setupPlan.setupRoot, launcherPath: launcherPath ?? null, runtimeSecretParameterIds });
}

export function runtimeSecretIds(definition, setup) {
  if (!setup || !Array.isArray(definition?.parameters)) return [];
  return definition.parameters.filter(p => p && typeof p === 'object' && typeof p.id === 'string' && p.id && setup.runtimeSecretParameterIds.has(p.id)).map(p => p.id);
}

export const managedLauncherArgs = (packageKey, contentId, scope, canonicalRoot, rules = createPathRules()) =>
  [LauncherVerb, '--package', packageKey, '--content', contentId, '--scope', scope, '--root', rules.normalize(canonicalRoot)];

/** 由已審核的 definition 產生啟動描述；欄位順序與 .NET ManagedMcpLaunchDescriptor 相同。 */
export function buildLaunchDescriptor(content, setup, operatingSystem, resolveLaunch, rules = createPathRules()) {
  const definition = content.definition;
  const { command, args } = resolveLaunch(definition, operatingSystem, setup);
  const resolve = text => String(text).replaceAll('{{setupRoot}}', setup.setupRoot);
  const env = {};
  for (const [k, v] of Object.entries(definition.env ?? {})) if (typeof v === 'string') env[k] = resolve(v);
  return { launchFormatVersion: LaunchFormatVersion, packageKey: setup.packageKey, packageVersion: setup.packageVersion, contentId: content.id,
    scope: setup.scope, canonicalRoot: rules.normalize(setup.canonicalRoot), setupRoot: setup.setupRoot, command, args,
    cwd: typeof definition.cwd === 'string' ? resolve(definition.cwd) : null, env,
    runtimeSecrets: runtimeSecretIds(definition, setup).map(id => ({ parameterId: id, required: true })) };
}

export function launchDescriptorPath(setupRoot, contentId) {
  if (!/^[A-Za-z0-9._-]+$/.test(contentId) || contentId === '.' || contentId === '..') throw new Error(`不是合法的 MCP contentId：${contentId}`);
  return path.join(setupRoot, 'mcp', `${contentId}.json`);
}

/** 原子寫入啟動描述（UTF-8 無 BOM、.NET 縮排格式）。 */
export function saveLaunchDescriptor(descriptor, newline = os.EOL) {
  writeTextAtomic(launchDescriptorPath(descriptor.setupRoot, descriptor.contentId), writeJsonValue(descriptor, '', newline));
}

