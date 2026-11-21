// 程式版本與部署收據中的資源版本是不同資訊。LC-AI-Pack 是可攜程式，沒有共用的本機程式位置；
// 這裡顯示：Orca 外掛版本（取自 manifest）、共用收據記錄的最後部署用戶端版本，以及市集針對目前平台發布的 GUI 最新版本。
import { ErrorCode } from '../contract.mjs';
import { parseJson } from '../http.mjs';
import { pluginVersion } from '../plugin-version.mjs';

export function registerClientHandlers(router, { session, packages, installed = null, platform = process.platform, arch = process.arch }) {
  const version = pluginVersion();
  router.handle('rc.client.getVersions', async () => {
    const client = await session.requireClient();
    const result = { orca: { version, source: 'plugin' },
      lcAiPack: { version: null, source: 'marketRelease', receiptVersion: installed?.lastDeployingClientVersion(version) ?? null } };
    const os = { win32: 'win', darwin: 'osx', linux: 'linux' }[platform];
    if (!os) return result;
    try {
      const res = await packages.request(client, `api/market/client/latest?product=gui&rid=${os}-${arch}`);
      const body = parseJson(res.text);
      if (typeof body?.version === 'string') result.lcAiPack.version = body.version;
    } catch (e) {
      if ([ErrorCode.signedOut, ErrorCode.sessionExpired, ErrorCode.accountUnavailable].includes(e.code)) throw e;
      // 舊市集或未發布此平台時不阻擋資源目錄，明確回報未知版本。
    }
    return result;
  });
}
