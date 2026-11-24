// AI 端點的本機設定；PAT 永不回傳面板或寫入一般儲存。
import { randomUUID } from 'node:crypto';
import { badParams, RcError, ErrorCode } from './contract.mjs';
import { send, parseJson } from './http.mjs';

const storageKey = 'resource-center.ai-settings';
export const aiEndpointSecretKey = id => `resource-center.ai-pat.${id}`;

export function normalizeAiBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw badParams('請輸入有效的 Base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw badParams('Base URL 只接受 http/https，且不可包含帳密、查詢或片段');
  const pathname = url.pathname.replace(/\/+$/, '');
  return url.origin + (pathname || '/v1');
}

export function createAiEndpointService({ orca, session, timeoutMs = 5000, now = Date.now,
  scheduler = { setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; }, clearTimeout: id => clearTimeout(id) } }) {
  const loaded = orca.storage.get(storageKey).then(value => value ?? { enabled: true, activeEndpointId: null, endpoints: [] });
  const statuses = new Map();
  let timer = null, revision = 0, disposed = false;
  const controllers = new Set();
  const empty = () => ({ state: 'unset', reason: '', model: '', name: '', checkedAt: null });
  async function get() {
    const settings = await loaded;
    return { ...settings, endpoints: await Promise.all(settings.endpoints.map(async e => ({ ...e, status: statuses.get(e.id) ?? empty(), hasPat: Boolean(await orca.secrets.get(aiEndpointSecretKey(e.id))) }))) };
  }
  async function save(input) {
    if (!await session.identity()) throw new RcError(ErrorCode.signedOut, '請先登入市集');
    const stored = await loaded;
    const settings = { ...stored, endpoints: stored.endpoints.map(e => ({ ...e })) };
    let newSecretId = null;
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw badParams('啟用 AI 助手必須是布林值');
    if (input.activeEndpointId !== undefined && input.activeEndpointId !== null && !settings.endpoints.some(e => e.id === input.activeEndpointId)) throw badParams('找不到 AI 端點');
    if (input.deleteId !== undefined && (typeof input.deleteId !== 'string' || !settings.endpoints.some(e => e.id === input.deleteId))) throw badParams('找不到 AI 端點');
    const e = input.endpoint;
    if (e) {
      if (e.id !== undefined && (typeof e.id !== 'string' || !settings.endpoints.some(old => old.id === e.id))) throw badParams('找不到 AI 端點');
      if (typeof e.name !== 'string' || !e.name.trim() || typeof e.baseUrl !== 'string' || typeof e.model !== 'string' || (e.pat !== undefined && typeof e.pat !== 'string')) throw badParams('請填寫名稱、Base URL 與模型');
      const item = { id: e.id || randomUUID(), name: e.name.trim(), baseUrl: normalizeAiBaseUrl(e.baseUrl), model: e.model };
      if (e.pat) {
        await orca.secrets.set(aiEndpointSecretKey(item.id), e.pat);
        if (!e.id) newSecretId = item.id;
      }
      settings.endpoints = [...settings.endpoints.filter(old => old.id !== item.id), item];
      const result = await test(item);
      if (!item.model && result.models.length === 1) item.model = result.model;
      if (result.state === 'ok' && !result.models.includes(item.model)) Object.assign(result, { state: 'error', reason: '請選擇模型' });
      statuses.set(item.id, result);
    }
    if (input.deleteId) {
      await orca.secrets.delete(aiEndpointSecretKey(input.deleteId));
      settings.endpoints = settings.endpoints.filter(e => e.id !== input.deleteId);
      statuses.delete(input.deleteId);
      if (settings.activeEndpointId === input.deleteId) settings.activeEndpointId = null;
    }
    if (input.activeEndpointId !== undefined) settings.activeEndpointId = input.activeEndpointId;
    if (input.enabled !== undefined) settings.enabled = input.enabled;
    try { await orca.storage.set(storageKey, settings); }
    catch (error) {
      if (newSecretId) {
        await orca.secrets.delete(aiEndpointSecretKey(newSecretId));
        statuses.delete(newSecretId);
      }
      throw error;
    }
    Object.assign(stored, settings);
    await reschedule();
    return get();
  }
  async function test(input) {
    if (typeof input.baseUrl !== 'string' || (input.pat !== undefined && typeof input.pat !== 'string')) throw badParams('請輸入有效的 AI 端點');
    const baseUrl = normalizeAiBaseUrl(input.baseUrl);
    const pat = input.pat || (input.id ? await orca.secrets.get(aiEndpointSecretKey(input.id)) : '');
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
    return e ? { ...(statuses.get(e.id) ?? empty()), name: e.name, model: e.model } : empty();
  }
  async function check() {
    const current = revision;
    const settings = await loaded;
    const e = settings.endpoints.find(e => e.id === settings.activeEndpointId);
    if (!disposed && settings.enabled && e && await session.identity()) {
      const result = await test(e);
      if (!result.models.includes(e.model) && result.state === 'ok') Object.assign(result, { state: 'error', reason: '選用的模型不在清單中' });
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
    const result = await test(input);
    const settings = await loaded;
    const endpoint = settings.endpoints.find(e => e.id === input.id && e.baseUrl === normalizeAiBaseUrl(input.baseUrl) && e.model === input.model);
    if (!disposed && current === revision && endpoint) statuses.set(endpoint.id, result);
    return result;
  }
  let saving = Promise.resolve();
  return { get, save: input => { const result = saving.then(() => save(input)); saving = result.catch(() => {}); return result; }, test: testEndpoint, status, check, reschedule, stop, dispose: () => { disposed = true; stop(); } };
}
