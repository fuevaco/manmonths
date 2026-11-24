// rc.ai.*：端點設定、連線狀態、資源清單與記憶體對話。
import { badParams } from '../contract.mjs';

export function registerAiHandlers(router, { endpoints, catalog, chat }) {
  router.handle('rc.ai.settings.get', () => endpoints.get());
  router.handle('rc.ai.settings.save', input => endpoints.save(input));
  router.handle('rc.ai.endpoints.test', input => endpoints.test(input));
  router.handle('rc.ai.status.get', () => endpoints.status());
  router.handle('rc.ai.status.check', () => endpoints.check());
  router.handle('rc.ai.catalog.get', async (input = {}) => {
    if (input.keys !== undefined && (!Array.isArray(input.keys) || input.keys.some(key => typeof key !== 'string'))) throw badParams('資源包識別碼格式錯誤');
    const list = await catalog.build();
    return input.keys ? { ...list, packages: await catalog.withReadmes(list, input.keys) } : list;
  });
  for (const action of ['send', 'poll', 'stop', 'clear']) {
    router.handle(`rc.ai.chat.${action}`, input => chat[action](input));
  }
}
