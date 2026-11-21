// 測試用的假 Orca 主機：設定、秘密、儲存都放記憶體，並記錄所有 log 與回傳給面板的結果，
// 讓測試從面板實際使用的 worker 請求契約進入。

import activate from '../worker/index.mjs';

/** 可在多個 worker 實例之間共用的主機狀態（模擬重開 Orca）。 */
export function createHostState({ settings = {} } = {}) {
  return {
    settings: new Map(Object.entries({ marketUrl: '', ...settings })),
    secrets: new Map(),
    storage: new Map(),
    logs: [],
    transcript: [] // 面板收到的所有結果與錯誤訊息
  };
}

/**
 * 啟動一個 worker。
 * @param {object} [opts]
 * @param {ReturnType<typeof createHostState>} [opts.state]
 * @param {object} [opts.deps]  注入給 worker 的測試相依（時鐘、等待函式、環境）
 */
export function startWorker({ state = createHostState(), deps } = {}) {
  const handlers = new Map();
  const orca = {
    log: (msg) => state.logs.push(String(msg)),
    settings: {
      get: async (k) => (k ? state.settings.get(k) : Object.fromEntries(state.settings)),
      set: async (k, v) => void state.settings.set(k, v)
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
      call: async (method) => { throw new Error(`unexpected host call ${method}`); }
    },
    panels: { handle: (name, fn) => handlers.set(name, fn), post() {} }
  };
  const worker = activate(orca, deps);

  async function call(method, input) {
    const fn = handlers.get(method);
    if (!fn) throw new Error(`沒有註冊的請求：${method}`);
    try {
      const result = await fn(input, { panel: { id: 'ai-resource-center' } });
      state.transcript.push(JSON.stringify(result ?? null));
      return result;
    } catch (e) {
      state.transcript.push(`${e?.code ?? ''} ${e?.message ?? e}`);
      throw e;
    }
  }

  return { call, handlers, state, orca, dispose: () => worker?.dispose?.() };
}

/** 斷言字串集合中沒有出現任何秘密值。 */
export function leakedSecrets(texts, secrets) {
  const hay = texts.join('\n');
  return secrets.filter((s) => s && hay.includes(s));
}
