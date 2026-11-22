// Port of CanonicalManifestValidator：保持欄位白名單、內容身分及 MCP 定義規則。
import { ErrorCode, RcError } from './contract.mjs';
import { validateSetup } from './setup-validator.mjs';
const text = v => typeof v === 'string' && !!v.trim();
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const version = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
import { isUnsafeRelativePath as unsafe } from './path-safety.mjs';
export function parseManifest(source) {
  const stringsAndComments = /("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
  const clean = source.replace(/^\uFEFF/, '').replace(stringsAndComments, (match, string) => string || ' ');
  return JSON.parse(clean.replace(/("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g, (match, string) => string || ''));
}
// 預檢使用同一套規則收集逐項問題；原 validateManifest 仍以 RcError 拋錯。
export function collectManifestProblems(m) {
  const problems = [];
  validateManifest(m, { problems });
  return problems;
}
export function validateManifest(m, { problems } = {}) {
  const errors = [];
  let contextPath = 'lcpack.json', setupPhase = false;
  const check = (ok, message, code = setupPhase ? 'invalid-setup' : 'invalid-package', problemPath = contextPath) => {
    if (ok) return;
    errors.push(message);
    problems?.push({ code: `deployment.${code}`, message, path: problemPath });
  };
  const known = (value, keys, label) => {
    check(object(value), `${label} 必須是 object`);
    if (object(value)) for (const key of Object.keys(value)) check(keys.includes(key), `${label} 含不支援欄位 ${key}`, key === 'schemaVersion' ? 'unsupported-package-format' : setupPhase ? 'invalid-setup' : 'invalid-package');
  };
  known(m, ['packageFormatVersion', 'key', 'name', 'type', 'version', 'description', 'category', 'tags', 'contents', 'dependencies', 'minClientVersion', 'setup'], 'lcpack.json');
  if (!object(m)) { if (problems) return m; throw new RcError(ErrorCode.invalidPackage, '資源包格式錯誤：lcpack.json 必須是 object'); }
  check(m.packageFormatVersion === 1, 'packageFormatVersion 必須是 1', 'unsupported-package-format');
  check(typeof m.key === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(m.key), 'key 格式錯誤');
  for (const k of ['name', 'description']) check(text(m[k]), `${k} 為必填文字`);
  check(['skill', 'agent', 'mcp', 'bundle'].includes(m.type), 'type 不支援');
  check(version(m.version), 'version 格式錯誤');
  if (m.minClientVersion != null) check(version(m.minClientVersion), 'minClientVersion 格式錯誤');
  check(Array.isArray(m.contents) && m.contents.length > 0, 'contents 至少需要一項');
  const ids = new Set();
  for (const c of Array.isArray(m.contents) ? m.contents : []) {
    known(c, ['id', 'kind', 'name', 'description', 'path', 'definition', 'hosts'], 'contents');
    if (!object(c)) continue;
    contextPath = typeof c.path === 'string' ? c.path : 'lcpack.json';
    check(typeof c.id === 'string' && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(c.id), 'content.id 格式錯誤');
    check(!ids.has(c.id), 'content.id 不可重複', 'duplicate-content-id'); ids.add(c.id);
    check(['skill', 'agent', 'mcp', 'prompt', 'command'].includes(c.kind), 'content.kind 不支援', 'unsupported-content-kind');
    if (!['skill', 'agent'].includes(c.kind) || c.name != null) check(text(c.name), 'content.name 為必填');
    if (m.type !== 'bundle') check(m.type === c.kind, 'contents.kind 必須與 type 相同');
    if (c.hosts != null) {
      check(c.kind === 'agent' || Object.keys(c.hosts).length === 0, '只有 agent 可以使用 hosts');
      check(object(c.hosts), 'hosts 必須是 object');
      for (const [host, config] of Object.entries(c.hosts)) {
        check(['claude-code', 'codex', 'github-copilot'].includes(host), 'hosts 平台鍵不支援');
        known(config, ['tools', 'model'], 'hosts 平台指定');
        if (config?.tools != null) check(typeof config.tools === 'string' || (Array.isArray(config.tools) && config.tools.every(v => typeof v === 'string')), 'hosts.tools 必須是文字或文字陣列');
        if (config?.model != null) check(typeof config.model === 'string', 'hosts.model 必須是文字');
      }
    }
    if (c.kind === 'mcp') {
      check(!text(c.path), 'MCP 不使用 path');
      const d = c.definition;
      check(object(d), 'MCP definition 為必填 object');
      if (!object(d)) continue;
      check(d.transport == null || d.transport === 'stdio', 'MCP transport 只支援 stdio');
      check(text(d.command), 'MCP command 為必填');
      if (d.args != null) check(Array.isArray(d.args), 'MCP args 必須是 array');
      if (d.parameters != null) {
        check(Array.isArray(d.parameters), 'MCP parameters 必須是 array');
        const parameters = new Set();
        for (const p of Array.isArray(d.parameters) ? d.parameters : []) {
          check(text(p?.id) && !parameters.has(p.id), 'MCP parameter.id 為必填且不可重複'); parameters.add(p?.id);
        }
      }
      if (object(d.env)) for (const [key, value] of Object.entries(d.env)) check(!(typeof value === 'string' && /TOKEN|SECRET|PASSWORD|APIKEY|API_KEY/i.test(key)), 'MCP env 疑似內嵌秘密，請改用 parameters', 'secret-unresolved');
    } else {
      check(c.definition == null, '檔案類型不可使用 definition');
      check(text(c.path) && !unsafe(c.path), 'content.path 為必填且不可為絕對路徑或含 ..', text(c.path) && unsafe(c.path) ? 'path-escape' : 'invalid-package');
    }
  }
  if (m.dependencies != null) {
    check(object(m.dependencies), 'dependencies 必須是 object');
    check(m.dependencies?.cli == null || Array.isArray(m.dependencies.cli), 'dependencies.cli 必須是 array');
    for (const d of Array.isArray(m.dependencies?.cli) ? m.dependencies.cli : []) check(text(d?.name) && text(d?.checkCommand), 'CLI dependency 必須揭露 name 與 checkCommand');
  }
  contextPath = 'lcpack.json'; setupPhase = true;
  validateSetup(m, check, known);
  if (errors.length && !problems) throw new RcError(ErrorCode.invalidPackage, `資源包格式錯誤：${errors.join('；')}`);
  return m;
}
