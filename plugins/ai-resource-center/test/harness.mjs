// 測試用的假 Orca 主機：設定、秘密、儲存都放記憶體，並記錄所有 log 與回傳給面板的結果，
// 讓測試從面板實際使用的 worker 請求契約進入。

import activate from '../worker/index.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 可在多個 worker 實例之間共用的主機狀態（模擬重開 Orca）。 */
export function createHostState({ settings = {} } = {}) {
  return {
    settings: new Map(Object.entries({ marketUrl: '', ...settings })),
    secrets: new Map(),
    storage: new Map(),
    logs: [],
    hostCalls: [], // Orca 主機能力呼叫（含通知）
    transcript: [] // 面板收到的所有結果與錯誤訊息
  };
}

/**
 * 啟動一個 worker。
 * @param {object} [opts]
 * @param {ReturnType<typeof createHostState>} [opts.state]
 * @param {object} [opts.deps]  注入給 worker 的測試相依（時鐘、等待函式、環境）
 * @param {Function} [opts.hostCall]  替換主機能力；呼叫仍記錄於 state.hostCalls
 */
export function startWorker({ state = createHostState(), deps, hostCall } = {}) {
  // 未指定家目錄的契約測試也不能掃描／清理真實外掛下載快取。
  const cacheDirectory = deps?.userHome ? null : mkdtempSync(path.join(tmpdir(), 'rc-worker-cache-'));
  const handlers = new Map();
  const settingsListeners = new Set();
  const orca = {
    log: (msg) => state.logs.push(String(msg)),
    settings: {
      get: async (k) => (k ? state.settings.get(k) : Object.fromEntries(state.settings)),
      set: async (k, v) => {
        if (state.settings.get(k) === v) return;
        state.settings.set(k, v);
        for (const listener of settingsListeners) listener({ key: k });
      },
      onDidChange: listener => {
        settingsListeners.add(listener);
        return { dispose: () => settingsListeners.delete(listener) };
      }
    },
    secrets: {
      get: async (k) => state.secrets.get(k) ?? null,
      set: async (k, v) => {
        if (typeof v !== 'string') throw new Error('secrets 只接受字串');
        state.secrets.set(k, v);
      },
      delete: async (k) => void state.secrets.delete(k)
    },
    storage: {
      get: async (k) => state.storage.get(k) ?? null,
      set: async (k, v) => void state.storage.set(k, JSON.parse(JSON.stringify(v))),
      delete: async (k) => void state.storage.delete(k)
    },
    host: {
      call: async (method, input) => {
        state.hostCalls.push({ method, input: input === undefined ? undefined : structuredClone(input) });
        if (hostCall) return hostCall(method, input);
        if (method === 'notifications.show' || method === 'statusBar.update') return;
        throw new Error(`unexpected host call ${method}`);
      }
    },
    panels: { handle: (name, fn) => handlers.set(name, fn), post() {} }
  };
  const worker = activate(orca, { ...(cacheDirectory ? { userHome: cacheDirectory, dataDirectory: cacheDirectory,
    lcaipackHome: deps?.env?.LCAIPACK_HOME ?? path.join(cacheDirectory, '.lcaipack') } : {}), ...deps });

  async function call(method, input) {
    const fn = handlers.get(method);
    if (!fn) throw new Error(`沒有註冊的請求：${method}`);
    try {
      const result = await fn(input, { panel: { id: 'ai-resource-center' } });
      // 與 Orca 相同：回應必須是合法 JSON，物件或陣列內出現 undefined 會被拒絕（answered with a non-JSON value）
      const nonJson = findNonJson(result);
      if (nonJson) throw new Error(`${method} answered with a non-JSON value（${nonJson}）`);
      state.transcript.push(JSON.stringify(result ?? null));
      return result;
    } catch (e) {
      state.transcript.push(`${e?.code ?? ''} ${e?.message ?? e}`);
      throw e;
    }
  }

  return { call, handlers, state, orca, dispose: () => {
    worker?.dispose?.();
    if (cacheDirectory) rmSync(cacheDirectory, { recursive: true, force: true });
  } };
}

/** 最後一次送給 Orca 的狀態列內容。 */
export const status = worker => worker.state.hostCalls.filter(c => c.method === 'statusBar.update').at(-1)?.input;

/** 斷言字串集合中沒有出現任何秘密值。 */
export function leakedSecrets(texts, secrets) {
  const hay = texts.join('\n');
  return secrets.filter((s) => s && hay.includes(s));
}

/** 回傳第一個不是合法 JSON 的位置（例如 `updates[0].reference`）；整體為 undefined（沒有回應）視為合法。 */
export function findNonJson(value, at = '') {
  if (value === undefined) return at || null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : at || '(root)';
  if (typeof value !== 'object') return at || '(root)';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { const hit = findNonJson(value[i], `${at}[${i}]`); if (hit) return hit; }
    return null;
  }
  for (const [key, item] of Object.entries(value)) { const hit = findNonJson(item, at ? `${at}.${key}` : key); if (hit) return hit; }
  return null;
}
