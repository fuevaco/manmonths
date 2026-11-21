// Orca 資源中心 trusted worker 入口：建立共用的服務，並註冊各領域的面板請求。
import { createInstalledService } from './installed-service.mjs';
import { registerClientHandlers } from './handlers/client.mjs';
import { createRouter } from './contract.mjs';
import { createSessionService } from './session-service.mjs';
import { registerSessionHandlers } from './handlers/session.mjs';
import { registerCatalogHandlers } from './handlers/catalog.mjs';
import { createPackageService } from './package-service.mjs';
import { registerPackageHandlers } from './handlers/package.mjs';
import { createDownloadService } from './download-service.mjs';
import { registerDownloadHandlers } from './handlers/download.mjs';
import { createDeployService } from './deploy-service.mjs';
import { registerDeployHandlers } from './handlers/deploy.mjs';
import { createInstallReporting } from './install-reports.mjs';
import { pluginVersion } from './plugin-version.mjs';

/**
 * @param {object} orca  Orca 主機 API
 * @param {object} [deps] 測試注入：now()、delay(ms, signal)、requestTimeoutMs、transport
 */
export default function activate(orca, deps = {}) {
  orca.log('AI 資源中心 worker 已啟動');
  const router = createRouter(orca);
  // 安裝回報（工項 12）：成功連線時補送待送項目；回報需要登入工作階段，所以以延遲綁定接上 session。
  let reporting = null;
  // 部署計畫綁定產生它的工作階段：登出、被拒絕或換市集時丟棄等待確認的計畫（延遲綁定，deploy 在 session 之後才建立）。
  let deploy = null;
  const session = createSessionService({ orca, ...deps, onConnected: () => reporting?.flush(), onSessionEnded: () => deploy?.discardPending() });
  reporting = createInstallReporting({ storage: orca.storage, session, clientVersion: deps.clientVersion ?? pluginVersion(), now: deps.now });

  registerSessionHandlers(router, { session });
  const installed = createInstalledService(deps);
  registerCatalogHandlers(router, { session, installed });
  const packages = createPackageService(session, installed);
  registerPackageHandlers(router, { packages });
  registerClientHandlers(router, { session, packages, installed });
  const downloads = createDownloadService({ session, packages, downloadDirectory: deps.downloadDirectory, maxDownloadBytes: deps.maxDownloadBytes });
  registerDownloadHandlers(router, { downloads });
  // 部署：lcaipackHome／userHome／env 可注入，測試以臨時使用者目錄隔離（預設依 LCAIPACK_HOME 與使用者家目錄）。
  deploy = createDeployService({ downloads, installed, session, lcaipackHome: deps.lcaipackHome, userHome: deps.userHome, env: deps.env, platform: deps.platform,
    secretStore: deps.secretStore, mcpLauncherPath: deps.mcpLauncherPath,
    installReports: reporting, runners: deps.runners, setupEnvironment: deps.setupEnvironment, commandExecutor: deps.commandExecutor, commandTimeoutMs: deps.commandTimeoutMs });
  registerDeployHandlers(router, { deploy });

  return {
    session,
    dispose: () => session.dispose()
  };
}
