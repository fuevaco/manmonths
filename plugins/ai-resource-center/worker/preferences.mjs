import { badParams } from './contract.mjs';

const key = 'resource-center.preferences';
export const defaultDirection = field => ['installCount', 'uploadedAt'].includes(field) ? 'desc' : 'asc';
const validators = {
  sortField: v => ['installCount', 'name', 'owner', 'uploadedAt'].includes(v),
  sortDirection: v => ['asc', 'desc'].includes(v),
  showPreview: v => typeof v === 'boolean',
  checkIntervalMinutes: v => [15, 60, 240, 1440, 0].includes(v)
};
export function validatePreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.entries(input).some(([k, v]) => !Object.hasOwn(validators, k) || !validators[k](v))) throw badParams('偏好設定格式或值不正確');
}
export function createPreferences(router, storage) {
  const listeners = new Set();
  // 序列化讀改寫，避免同時調整不同欄位時互相覆蓋。
  let pending = Promise.resolve();
  async function read() {
    const saved = await storage.get(key);
    const result = { sortField: 'installCount', sortDirection: 'desc', showPreview: false, checkIntervalMinutes: 15 };
    for (const k of Object.keys(result)) if (validators[k](saved?.[k])) result[k] = saved[k];
    if (!validators.sortDirection(saved?.sortDirection)) result.sortDirection = defaultDirection(result.sortField);
    return result;
  }
  const get = async () => { await pending; return read(); };
  router.handle('rc.preferences.get', get);
  router.handle('rc.preferences.set', input => {
    validatePreferences(input);
    const update = pending.then(async () => {
      const previous = await read();
      const result = { ...previous, ...input };
      if (input.sortField && input.sortField !== previous.sortField && input.sortDirection === undefined) result.sortDirection = defaultDirection(input.sortField);
      await storage.set(key, result);
      for (const listener of listeners) listener(result);
      return result;
    });
    pending = update.catch(() => {});
    return update;
  });
  return { get, onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}
