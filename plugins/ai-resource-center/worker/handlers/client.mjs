// Orca 只顯示自己的外掛版本，不查詢其他用戶端的發行資料。
import { pluginVersion } from '../plugin-version.mjs';

export function registerClientHandlers(router) {
  const version = pluginVersion();
  router.handle('rc.client.getVersions', async () => ({ orca: { version, source: 'plugin' } }));
}
