// AI 端點的本機設定；PAT 永不回傳面板或寫入一般儲存。
import { randomUUID } from 'node:crypto';
import { badParams, RcError, ErrorCode } from './contract.mjs';
import { send, parseJson } from './http.mjs';
import { isLocalToolPlatform, platformLabel, platformNames } from './ai-local-tool-platforms.mjs';

const isLocal = endpoint => endpoint.type === 'local-tool';
const localStatus = platform => ({ platform, platformLabel: platformLabel(platform), account: '', version: '', versionWarning: '', reasonCode: '' });
const storageKey = 'resource-center.ai-settings';
export const aiEndpointSecretKey = id => `resource-center.ai-pat.${id}`;

// 只有換了使用中的端點，或它的類型、平台改變時才開新對話。名稱、模型、Base URL、PAT 的修改保留對話。
function activeConversationKey(settings) {
  const endpoint = settings.endpoints.find(e => e.id === settings.activeEndpointId);
  return endpoint ? JSON.stringify([endpoint.id, endpoint.type ?? 'openai', endpoint.platform ?? '']) : '';
}

export function normalizeAiBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw badParams('請輸入有效的 Base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw badParams('Base URL 只接受 http/https，且不可包含帳密、查詢或片段');
  const pathname = url.pathname.replace(/\/+$/, '');
  return url.origin + (pathname || '/v1');
}

export function createAiEndpointService({ orca, session, localTools, onActiveEndpointChanged, timeoutMs = 5000, now = Date.now,
  scheduler = { setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; }, clearTimeout: id => clearTimeout(id) } }) {
  const loaded = orca.storage.get(storageKey).then(value => value ?? { enabled: true, activeEndpointId: null, endpoints: [] });
  const statuses = new Map();
  let timer = null, revision = 0, disposed = false;
  const controllers = new Set();
  const empty = () => ({ state: 'unset', reason: '', model: '', name: '', checkedAt: null });
  async function get() {
    const settings = await loaded;
    const endpoints = await Promise.all(settings.endpoints.map(async e => ({
      ...e, type: e.type ?? 'openai', status: statusOf(e), ...(isLocal(e) ? { defaultModel: e.defaultModel ?? '' } : {}),
      hasPat: !isLocal(e) && Boolean(await orca.secrets.get(aiEndpointSecretKey(e.id)))
    })));
    // 平台名稱隨設定回傳，面板不另外維護對照。
    return { ...settings, endpoints, platforms: platformNames() };
  }
  function statusOf(endpoint) {
    return statuses.get(endpoint.id) ?? { ...empty(), ...(isLocal(endpoint) ? localStatus(endpoint.platform) : {}) };
  }
  async function save(input) {
    if (!await session.identity()) throw new RcError(ErrorCode.signedOut, '請先登入市集');
    const stored = await loaded;
    const settings = { ...stored, endpoints: stored.endpoints.map(e => ({ ...e })) };
    const patChanges = new Map();
    let checked = null;
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw badParams('啟用 AI 助手必須是布林值');
    if (input.activeEndpointId !== undefined && input.activeEndpointId !== null && !settings.endpoints.some(e => e.id === input.activeEndpointId)) throw badParams('找不到 AI 端點');
    if (input.deleteId !== undefined && (typeof input.deleteId !== 'string' || !settings.endpoints.some(e => e.id === input.deleteId))) throw badParams('找不到 AI 端點');
    const e = input.endpoint;
    if (e) {
      const old = settings.endpoints.find(old => old.id === e.id);
      if (e.id !== undefined && (typeof e.id !== 'string' || !old)) throw badParams('找不到 AI 端點');
      if (e.type !== undefined && e.type !== 'openai' && !isLocal(e)) throw badParams('請選擇 AI 端點類型');
      let item;
      if (isLocal(e)) {
        if (typeof e.name !== 'string' || !e.name.trim()) throw badParams('請填寫名稱');
        if (!isLocalToolPlatform(e.platform)) throw badParams('請選擇平台');
        // 預設模型名稱：Codex 取 model/list 標記的預設，Claude Code 由回答更新。同平台時沿用原值。
        const defaultModel = old && isLocal(old) && old.platform === e.platform ? old.defaultModel ?? '' : '';
        item = { id: e.id ?? randomUUID(), name: e.name.trim(), type: 'local-tool', platform: e.platform, model: typeof e.model === 'string' ? e.model : '', defaultModel };
        if (old && !isLocal(old)) patChanges.set(item.id, null);
      } else {
        if (typeof e.name !== 'string' || !e.name.trim() || typeof e.baseUrl !== 'string' || typeof e.model !== 'string' || (e.pat !== undefined && typeof e.pat !== 'string')) throw badParams('請填寫名稱、Base URL 與模型');
        item = { id: e.id ?? randomUUID(), name: e.name.trim(), type: 'openai', baseUrl: normalizeAiBaseUrl(e.baseUrl), model: e.model };
        if (e.pat) patChanges.set(item.id, e.pat);
      }
      settings.endpoints = [...settings.endpoints.filter(old => old.id !== item.id), item];
      const result = await test(isLocal(item) ? item : { ...item, pat: e.pat }, { listModels: isLocal(item) });
      if (isLocal(item)) item.defaultModel = result.defaultModel || item.defaultModel;
      else {
        if (!item.model && result.models.length === 1) item.model = result.model;
        if (result.state === 'ok' && !result.models.includes(item.model)) Object.assign(result, { state: 'error', reason: '請選擇模型' });
      }
      checked = [item.id, result];
    }
    if (input.deleteId) {
      if (!isLocal(stored.endpoints.find(e => e.id === input.deleteId))) patChanges.set(input.deleteId, null);
      settings.endpoints = settings.endpoints.filter(e => e.id !== input.deleteId);
      if (settings.activeEndpointId === input.deleteId) settings.activeEndpointId = null;
    }
    if (input.activeEndpointId !== undefined) settings.activeEndpointId = input.activeEndpointId;
    if (input.enabled !== undefined) settings.enabled = input.enabled;
    const previousPat = new Map();
    try {
      for (const [id, value] of patChanges) {
        const key = aiEndpointSecretKey(id);
        const previous = await orca.secrets.get(key);
        if (value === previous) continue;
        if (value == null) await orca.secrets.delete(key);
        else await orca.secrets.set(key, value);
        previousPat.set(key, previous);
      }
      await orca.storage.set(storageKey, settings);
    } catch (error) {
      for (const [key, value] of previousPat) {
        if (value == null) await orca.secrets.delete(key);
        else await orca.secrets.set(key, value);
      }
      throw error;
    }
    const changedEndpoint = activeConversationKey(stored) !== activeConversationKey(settings);
    Object.assign(stored, settings);
    if (changedEndpoint) onActiveEndpointChanged?.();
    if (checked) statuses.set(...checked);
    if (input.deleteId) statuses.delete(input.deleteId);
    await reschedule();
    return get();
  }
  /** listModels 只在使用者按「測試連線」時為 true，定期檢查與儲存不取 Codex 模型清單。 */
  async function test(input, { listModels = false } = {}) {
    if (isLocal(input)) {
      if (!isLocalToolPlatform(input.platform)) throw badParams('請選擇平台');
      const { models = [], defaultModel = '', ...result } = await withLocalSignal(signal => localTools.check(input.platform, signal, { listModels }));
      return { ...result, models, defaultModel, model: typeof input.model === 'string' ? input.model : '', name: typeof input.name === 'string' ? input.name : '', checkedAt: now() };
    }
    if (typeof input.baseUrl !== 'string' || (input.pat !== undefined && typeof input.pat !== 'string')) throw badParams('請輸入有效的 AI 端點');
    const baseUrl = normalizeAiBaseUrl(input.baseUrl);
    const saved = input.id && (await loaded).endpoints.find(e => e.id === input.id);
    const pat = input.pat || (saved && !isLocal(saved) ? await orca.secrets.get(aiEndpointSecretKey(saved.id)) : '');
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let models = [], reason = '';
    try {
      const response = await send({ method: 'GET', url: `${baseUrl}/models`, headers: pat ? { Authorization: `Bearer ${pat}` } : {}, timeoutMs, signal: controller.signal });
      if (response.status < 200 || response.status >= 300) reason = `連線失敗（HTTP ${response.status}）`;
      else {
        const body = parseJson(response.text);
        if (!Array.isArray(body?.data) || !body.data.every(item => typeof item?.id === 'string' && item.id.trim())) reason = '模型清單回應格式錯誤';
        else models = [...new Set(body.data.map(item => item.id))];
      }
    } catch (e) {
      reason = controller.signal.aborted || e.kind === 'timeout' ? `連線逾時（${timeoutMs / 1000} 秒）` : '無法連線到 AI 端點';
    } finally { clearTimeout(timer); controllers.delete(controller); }
    const model = input.model || (models.length === 1 ? models[0] : '');
    const state = reason || (input.model && !models.includes(input.model)) ? 'error' : 'ok';
    return { state, reason: reason || (state === 'error' ? '選用的模型不在清單中' : ''), models, model, name: input.name || '', checkedAt: now() };
  }
  async function status() {
    const settings = await loaded;
    if (!settings.enabled || !await session.identity()) return empty();
    const e = settings.endpoints.find(e => e.id === settings.activeEndpointId);
    return e ? { ...statusOf(e), name: e.name, model: e.model, ...(isLocal(e) ? { defaultModel: e.defaultModel ?? '' } : {}) } : empty();
  }
  async function check() {
    const current = revision;
    const settings = await loaded;
    const e = settings.endpoints.find(e => e.id === settings.activeEndpointId);
    if (!disposed && settings.enabled && e && await session.identity()) {
      const result = await test(e);
      if (!isLocal(e) && !result.models.includes(e.model) && result.state === 'ok') Object.assign(result, { state: 'error', reason: '選用的模型不在清單中' });
      if (!disposed && current === revision && settings.endpoints.includes(e)) statuses.set(e.id, result);
    }
    return status();
  }
  function stop() {
    revision++;
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    for (const controller of controllers) controller.abort();
  }
  async function reschedule() {
    stop();
    const current = revision;
    await check();
    const settings = await loaded;
    if (!disposed && current === revision && settings.enabled && settings.endpoints.some(e => e.id === settings.activeEndpointId) && await session.identity()) {
      timer = scheduler.setTimeout(() => { timer = null; return reschedule(); }, 5 * 60 * 1000);
    }
  }
  async function testEndpoint(input) {
    if (!await session.identity()) throw new RcError(ErrorCode.signedOut, '請先登入市集');
    const current = revision;
    const result = await test(input, { listModels: true });
    const settings = await loaded;
    const endpoint = settings.endpoints.find(e => e.id === input.id && (isLocal(input)
      ? isLocal(e) && e.platform === input.platform
      : !isLocal(e) && e.model === input.model && e.baseUrl === normalizeAiBaseUrl(input.baseUrl)));
    if (!disposed && current === revision && endpoint) {
      statuses.set(endpoint.id, isLocal(endpoint) ? { ...result, name: endpoint.name, model: endpoint.model } : result);
      if (isLocal(endpoint) && result.defaultModel) await rememberDefaultModel(endpoint.id, result.defaultModel);
    }
    return result;
  }
  /** 更新已儲存端點的預設模型名稱，與儲存排隊執行，避免覆寫彼此的寫入。 */
  function rememberDefaultModel(id, model) {
    const result = saving.then(async () => {
      const stored = await loaded;
      const endpoint = stored.endpoints.find(e => e.id === id);
      if (!endpoint || !isLocal(endpoint) || endpoint.defaultModel === model) return;
      await orca.storage.set(storageKey, { ...stored, endpoints: stored.endpoints.map(e => e === endpoint ? { ...e, defaultModel: model } : e) });
      endpoint.defaultModel = model;
    });
    saving = result.catch(() => {});
    return result;
  }
  /** Claude Code 選「預設」時，用 CLI 回報的實際回答模型更新預設模型名稱。 */
  async function rememberAnswerModel(id, model) {
    const endpoint = (await loaded).endpoints.find(e => e.id === id);
    if (model && endpoint && isLocal(endpoint) && endpoint.platform === 'claude-code' && !endpoint.model) await rememberDefaultModel(id, model);
  }
  async function detect() {
    if (!await session.identity()) throw new RcError(ErrorCode.signedOut, '請先登入市集');
    return withLocalSignal(signal => localTools.detect(signal));
  }
  async function models(input) {
    if (!isLocalToolPlatform(input?.platform)) throw badParams('請選擇平台');
    if (!await session.identity()) throw new RcError(ErrorCode.signedOut, '請先登入市集');
    return withLocalSignal(signal => localTools.listModels(input.platform, signal));
  }
  async function withLocalSignal(run) {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try { return await run(controller.signal); }
    finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  let saving = Promise.resolve();
  return { get, save: input => { const result = saving.then(() => save(input)); saving = result.catch(() => {}); return result; }, test: testEndpoint, detect, models, status, check, reschedule, stop, rememberAnswerModel, dispose: () => { disposed = true; stop(); } };
}
