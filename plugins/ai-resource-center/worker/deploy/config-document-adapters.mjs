// ConfigDocumentAdapters：只管理 MCP 的直接欄位，雜湊格式與既有格式相同。
import { jsonString } from './receipts.mjs';
import { ofText, ordinal } from './digest.mjs';
import { renderMcpNode } from './mcp-node-renderer.mjs';
import { CanonicalPackageError } from './canonical-package.mjs';
import { ProblemCodes, blocking } from './problems.mjs';
import { Unmanaged } from './ownership-index.mjs';
import toml from '../vendor/smol-toml/index.cjs';
import { patchToml } from './toml-mcp-text-patcher.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function nodeJson(value, sorted = true) {
  if (typeof value === 'string') return jsonString(value);
  if (Array.isArray(value)) return '[' + value.map(v => nodeJson(v, sorted)).join(',') + ']';
  if (object(value)) return '{' + (sorted ? Object.keys(value).sort(ordinal) : Object.keys(value)).map(k => jsonString(k) + ':' + nodeJson(value[k], sorted)).join(',') + '}';
  return JSON.stringify(value ?? null);
}
// 欄位值依鍵排序後雜湊：設定檔一律以排序後的節點寫入，讀回時才會與收據一致。
const hashValue = value => ofText(value == null ? '<missing>' : nodeJson(value));
const idOf = path => path.includes('.') ? path.slice(path.indexOf('.') + 1) : path;
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /token|secret|password|passwd|apikey|api_key|credential|bearer|cookie|session/i.test(k) && !object(v) && !Array.isArray(v) ? '***' : redact(v)]));
}
function parseJson(bytes) {
  const text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '');
  const value = text.trim() ? JSON.parse(text) : {};
  if (!object(value)) throw new Error('設定檔根節點必須是 JSON object');
  return value;
}

function makeAdapter(id, format, rootProperty, flavor, parse, write, remove) {
  const read = (bytes, contentId) => {
    const root = parse(bytes);
    return object(root[rootProperty]) && object(root[rootProperty][contentId]) ? root[rootProperty][contentId] : null;
  };
  const comparable = node => { const copy = structuredClone(node); if (format === 'toml') delete copy.tools; return copy; };
  return Object.freeze({ id, format,
    planPatch(local, localExists, incoming, entries, context) {
      const nodePath = `${rootProperty}.${incoming.id}`;
      const rendered = renderMcpNode(incoming, flavor, context.operatingSystem, context.setup ?? null);
      const renderedNodeJson = nodeJson(rendered);
      const existing = localExists ? read(local, incoming.id) : null;
      const owner = entries.find(e => e.contentId === incoming.id);
      const ownership = !owner ? Unmanaged : { isManaged: true, ownerPackageKey: owner.ownerPackageKey, ownerPackageVersion: owner.ownerPackageVersion,
        ownerContentId: owner.contentId, isSameOwner: owner.ownerPackageKey === context.packageKey, installedSha256: owner.installedSha256, normalizedAddress: null };
      const ownedFieldPaths = [nodePath, ...Object.keys(rendered).sort(ordinal).map(k => `${nodePath}.${k}`)];
      const baseValueHashes = [ofText(renderedNodeJson), ...Object.keys(rendered).sort(ordinal).map(k => hashValue(rendered[k]))];
      const problems = [];
      const problem = (code, path, summary) => blocking(code, summary, '請還原本機修改或重新規劃；不會靜默覆寫設定欄位。',
        { host: context.host, scope: context.scope, contentId: incoming.id, path: `${context.configPath}#${path}`, existingOwner: ownership, configPath: context.configPath });
      let change;
      if (existing === null) change = 'Create';
      else if (!owner) { change = 'Replace'; problems.push(problem(ProblemCodes.unmanagedCollision, nodePath, `已有非本工具管理的 MCP server '${incoming.id}'`)); }
      else if (!ownership.isSameOwner) { change = 'Merge'; problems.push(problem(ProblemCodes.ownershipCollision, nodePath, `MCP server '${incoming.id}' 已由資源包 '${owner.ownerPackageKey}' 擁有`)); }
      else if (nodeJson(comparable(existing)) === renderedNodeJson) change = 'NoOp';
      // 整個節點仍與上次安裝相同（baseValueHashes[0] 為排序後的完整節點）：本機沒有修改，直接套用新版。
      // 舊版外掛的欄位雜湊未排序，鍵順序不同就會誤判為本機修改；以完整節點比對可相容這些收據。
      else if (ofText(nodeJson(comparable(existing))) === owner.baseValueHashes?.[0]) change = 'Merge';
      else {
        change = 'Merge';
        for (const field of new Set([...Object.keys(existing), ...Object.keys(rendered)])) {
          const fieldPath = `${nodePath}.${field}`, index = owner.ownedFields.indexOf(fieldPath);
          const base = index < 0 ? null : owner.baseValueHashes[index];
          const localHash = hashValue(existing[field]), incomingHash = hashValue(rendered[field]);
          if (base != null && localHash !== base && incomingHash !== base && localHash !== incomingHash)
            problems.push(problem(ProblemCodes.configConflict, fieldPath, `MCP 欄位 ${fieldPath} 同時被本機與新版修改`));
        }
      }
      return { contentId: incoming.id, nodePath, ownedFieldPaths, baseValueHashes, renderedNodeJson, change, ownership, problems,
        redactedBefore: existing === null ? '(不存在)' : nodeJson(redact(existing)), redactedAfter: nodeJson(redact(rendered)) };
    },
    applyPatch(current, exists, patch) { return write(exists ? current : Buffer.alloc(0), patch.contentId, JSON.parse(patch.renderedNodeJson)); },
    removeNode(current, nodePath) { return remove(current, idOf(nodePath)); },
    readNodeJson(current, nodePath) { const node = read(current, idOf(nodePath)); return node === null ? null : nodeJson(node); },
    readComparableNodeJson(current, nodePath) { const node = read(current, idOf(nodePath)); return node === null ? null : nodeJson(comparable(node)); },
    readOwnedNodeJson(current, nodePath, fields) {
      const node = read(current, idOf(nodePath));
      return node === null ? null : nodeJson(Object.fromEntries(fields.filter(p => p !== nodePath).map(p => p.startsWith(nodePath + '.') ? p.slice(nodePath.length + 1) : p)
        .filter(k => Object.hasOwn(node, k)).map(k => [k, node[k]])));
    }
  });
}
function writeJson(bytes, id, node) {
  const root = parseJson(bytes);
  if (!object(root.mcpServers)) root.mcpServers = {};
  root.mcpServers[id] = { ...(object(root.mcpServers[id]) ? root.mcpServers[id] : {}), ...node };
  return Buffer.from(JSON.stringify(root, null, 2));
}
const registry = new Map(['mcp-json', 'mcp-json-copilot'].map(id => [id, makeAdapter(id, 'json', 'mcpServers', id.endsWith('copilot') ? 'copilot' : 'shared', parseJson, writeJson,
  (bytes, id) => { const root = parseJson(bytes); if (object(root.mcpServers)) delete root.mcpServers[id]; return Buffer.from(JSON.stringify(root, null, 2)); })]));
export const parseToml = bytes => toml.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
registry.set('mcp-toml', makeAdapter('mcp-toml', 'toml', 'mcp_servers', 'toml', parseToml, (bytes, id, node) => {
  const existing = parseToml(bytes).mcp_servers?.[id];
  for (const [k, v] of Object.entries(existing ?? {})) if (k !== 'tools' && !Object.hasOwn(node, k)) node[k] = v;
  const updated = patchToml(bytes, id, node);
  parseToml(updated); // 文字 patch 不得產生無法解析的 TOML。
  return updated;
}, (bytes, id) => patchToml(bytes, id, null)));
export const getConfigAdapter = id => {
  const adapter = registry.get(id);
  if (!adapter) throw new CanonicalPackageError(ProblemCodes.configConflict, `未註冊的設定檔 adapter：${id}`);
  return adapter;
};
