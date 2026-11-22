// CanonicalSetupValidator 的靜態驗證；這裡從不執行命令或讀取參數值。
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && !!v.trim();
const id = v => typeof v === 'string' && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
import { isUnsafeRelativePath as unsafe } from './path-safety.mjs';
const tokens = s => typeof s === 'string' ? [...s.matchAll(/\{\{([^{}]*)\}\}/g)].map(m => m[1]) : [];
export function validateSetup(m, check, known) {
  const setup = m.setup;
  let parameters = [], commands = [];
  const array = (v, label) => { check(v == null || Array.isArray(v), `${label} 必須是 array`); return Array.isArray(v) ? v : []; };
  const matches = (p, value) => p.type === 'boolean' ? typeof value === 'boolean' : p.type === 'choice' ? typeof value === 'string' && array(p.options, 'options').some(o => o?.value === value) : p.type === 'string' ? typeof value === 'string' : true;
  if (setup != null) {
    known(setup, ['parameters', 'commands'], 'setup');
    parameters = array(setup?.parameters, 'setup.parameters'); commands = array(setup?.commands, 'setup.commands');
    check(parameters.length + commands.length > 0, 'setup 至少需要一個 parameter 或 command');
  }
  const byId = new Map();
  for (const p of parameters) {
    known(p, ['parameterId', 'label', 'type', 'description', 'required', 'default', 'secretUsage', 'options', 'visibleWhen'], 'setup parameter');
    if (!object(p)) continue;
    check(id(p.parameterId), 'setup parameterId 為必填且必須是小寫 dot/dash/underscore 形式');
    check(!byId.has(p.parameterId), 'setup parameterId 不可重複', 'duplicate-setup-id'); byId.set(p.parameterId, p);
    check(text(p.label), 'setup parameter label 為必填');
    check(['string', 'boolean', 'choice', 'secret'].includes(p.type), 'setup parameter type 不支援');
    check(p.required == null || typeof p.required === 'boolean', 'setup required 必須是布林值');
    check(p.type === 'secret' ? ['runtime', 'setup-time'].includes(p.secretUsage) : p.secretUsage == null, 'secretUsage 與 type 不符');
    if (p.default !== undefined) check(p.type !== 'secret' && matches(p, p.default), 'setup default 與 type 不符或含秘密預設值', p.type === 'secret' ? 'setup-secret-exposure' : 'invalid-setup');
    const options = array(p.options, 'setup options');
    check(p.type === 'choice' ? options.length > 0 : options.length === 0, 'setup options 只適用於 choice 且不可為空');
    const seen = new Set();
    for (const option of options) {
      known(option, ['value', 'label'], 'setup option');
      check(text(option?.value) && text(option?.label) && !seen.has(option.value), 'setup option value、label 為必填且 value 不可重複'); seen.add(option?.value);
    }
  }
  for (const p of parameters.filter(object)) {
    if (p.visibleWhen != null) {
      const c = p.visibleWhen; known(c, ['parameterId', 'equals'], 'visibleWhen');
      const target = byId.get(c?.parameterId);
      check(!!target && target !== p && target.type !== 'secret' && c?.equals !== undefined && matches(target, c.equals), 'visibleWhen 引用或比對值無效', target?.type === 'secret' ? 'setup-secret-exposure' : 'invalid-setup-reference');
    }
    const visited = new Set(); let current = p;
    while (current) {
      if (visited.has(current)) { check(false, 'visibleWhen 形成循環', 'invalid-setup-reference'); break; }
      visited.add(current); current = byId.get(current.visibleWhen?.parameterId);
    }
  }
  const commandIds = new Set();
  for (const c of commands) {
    known(c, ['commandId', 'name', 'runner', 'script', 'payloads', 'arguments', 'operatingSystems', 'architectures', 'timeoutMinutes', 'runOnUpdate'], 'setup command');
    if (!object(c)) continue;
    check(id(c.commandId), 'setup commandId 為必填且必須是小寫 dot/dash/underscore 形式');
    check(!commandIds.has(c.commandId), 'setup commandId 不可重複', 'duplicate-setup-id'); commandIds.add(c.commandId);
    check(text(c.name), 'setup command name 為必填');
    check(['powershell', 'bash'].includes(c.runner), 'setup runner 不支援');
    check(text(c.script) && !unsafe(c.script) && !/\.(exe|dll|msi|bat|cmd|com|scr|ps1xml|zip|7z|rar)$/i.test(c.script), 'setup script 路徑或副檔名無效', text(c.script) && unsafe(c.script) ? 'path-escape' : 'invalid-setup', typeof c.script === 'string' ? c.script : 'lcpack.json');
    const payloads = array(c.payloads, 'payloads');
    check(new Set(payloads).size === payloads.length && payloads.every(p => text(p) && !unsafe(p)), 'setup payload 路徑無效或重複', payloads.some(p => text(p) && unsafe(p)) ? 'path-escape' : 'invalid-setup');
    for (const arg of array(c.arguments, 'arguments')) {
      check(typeof arg === 'string', 'setup arguments 必須是文字');
      for (const token of tokens(arg)) {
        const parameter = token.startsWith('parameter:') ? byId.get(token.slice(10)) : null;
        check(!!parameter && parameter.type !== 'secret', 'setup argument 引用無效或暴露秘密', parameter?.type === 'secret' ? 'setup-secret-exposure' : 'invalid-setup-reference');
      }
    }
    for (const [key, allowed] of [['operatingSystems', ['windows', 'macos']], ['architectures', ['x64', 'arm64']]]) {
      const values = array(c[key], key);
      check(new Set(values).size === values.length && values.every(v => allowed.includes(v)), `setup ${key} 值無效或重複`);
    }
    check(c.timeoutMinutes == null || (Number.isInteger(c.timeoutMinutes) && c.timeoutMinutes >= 1 && c.timeoutMinutes <= 120), 'setup timeoutMinutes 必須介於 1–120');
    check(c.runOnUpdate == null || typeof c.runOnUpdate === 'boolean', 'setup runOnUpdate 必須是布林值');
  }
  function walk(value, path = '') {
    if (typeof value === 'string') for (const token of tokens(value)) check(token === 'setupRoot' && /^(command|cwd|args\[\d+\])$/.test(path) && commands.length > 0, 'MCP definition token 位置或引用無效', 'invalid-setup-reference');
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (object(value)) for (const [key, v] of Object.entries(value)) walk(v, path ? `${path}.${key}` : key);
  }
  for (const c of Array.isArray(m.contents) ? m.contents : []) {
    if (c?.kind !== 'mcp' || !object(c.definition)) continue;
    walk(c.definition);
    if (setup != null) for (const p of array(c.definition.parameters, 'MCP parameters')) {
      const declared = byId.get(p?.id);
      check(!(declared?.type === 'secret' && declared.secretUsage === 'setup-time'), 'setup-time 秘密不得成為 MCP runtime 身分', 'setup-secret-exposure');
      if (p?.secret === true) check(declared?.type === 'secret' && declared.secretUsage === 'runtime', 'MCP secret parameter 必須對應 runtime setup parameter', 'invalid-setup-reference');
    }
  }
}
