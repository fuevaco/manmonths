// 測試用的記憶體安全儲存區：介面與 worker/setup/secrets.mjs 的 OS 實作相同，不碰使用者真正的 Credential Manager／Keychain。
export function memoryStore({ fail = false } = {}) {
  const values = new Map();
  const guard = fn => { if (fail) throw new Error('keychain locked'); return fn(); };
  return { values,
    existsMany: keys => guard(() => keys.map(k => values.has(k))),
    get: key => guard(() => values.get(key) ?? null),
    set: (key, value) => guard(() => void values.set(key, value)),
    delete: key => guard(() => void values.delete(key)) };
}
