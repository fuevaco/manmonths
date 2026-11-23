// McpNodeRenderer（對照 Deployment/McpNodeRenderer.cs）：canonical definition 永不改寫。
// 沒有 setup 的 MCP 直接啟動；宣告 setup 時解析 {{setupRoot}}；definition.parameters 指向 runtime 秘密時，
// 節點只寫受管 launcher 路徑與非秘密身分，原始啟動資訊移到啟動描述（worker/setup/managed-mcp.mjs）。
import { managedLauncherArgs, runtimeSecretIds } from '../setup/managed-mcp.mjs';

const SETUP_ROOT_TOKEN = '{{setupRoot}}';
const resolve = (text, setup) => (setup ? String(text).replaceAll(SETUP_ROOT_TOKEN, setup.setupRoot) : text);

/** command／args 的 Windows cmd shim 與 {{setupRoot}} 解析；啟動描述共用同一規則。 */
export function resolveLaunch(definition, operatingSystem, setup) {
  let command = resolve(definition.command, setup);
  let args = (definition.args ?? []).map(a => resolve(a ?? '', setup));
  if (operatingSystem === 'windows' && ['npx', 'npm', 'pnpm', 'yarn', 'bunx'].includes(command)) {
    args = ['/c', command, ...args]; command = 'cmd';
  }
  return { command, args };
}

function withFlavor(node, flavor) {
  if (flavor !== 'toml') node.type = flavor === 'copilot' ? 'local' : 'stdio';
  if (flavor === 'copilot') node.tools = ['*'];
  return node;
}

export function renderMcpNode(content, flavor, operatingSystem, setup = null) {
  const definition = content.definition;
  if (setup && runtimeSecretIds(definition, setup).length) {
    return withFlavor({ command: 'node', args: [setup.launcherPath, ...managedLauncherArgs(setup.packageKey, content.id, setup.scope, setup.canonicalRoot)] }, flavor);
  }
  const node = resolveLaunch(definition, operatingSystem, setup);
  if (definition.env && typeof definition.env === 'object') {
    node.env = Object.fromEntries(Object.entries(definition.env).map(([k, v]) => [k, typeof v === 'string' ? resolve(v, setup) : structuredClone(v)]));
  }
  if (typeof definition.cwd === 'string') node.cwd = resolve(definition.cwd, setup);
  return withFlavor(node, flavor);
}
