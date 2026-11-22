// Orca 資源中心 trusted worker 入口：建立共用的服務，並註冊各領域的面板請求。
import { createDeveloperService } from './developer-service.mjs';
import { createUploadService } from './upload-service.mjs';
import { registerUploadHandlers } from './handlers/upload.mjs';
import { registerDeveloperHandlers } from './handlers/developer.mjs';
import { createFolderPickerService } from './folder-picker.mjs';
import { registerDevHandlers } from './handlers/dev.mjs';
import { createInstalledService } from './installed-service.mjs';
import { registerClientHandlers } from './handlers/client.mjs';
import { createRouter } from './contract.mjs';
import { createSessionService } from './session-service.mjs';
import { registerSessionHandlers } from './handlers/session.mjs';
import { registerCatalogHandlers } from './handlers/catalog.mjs';
import { createPackageService } from './package-service.mjs';
import { registerPackageHandlers } from './handlers/package.mjs';
import { createDownloadService } from './download-service.mjs';
import { createDeployService } from './deploy-service.mjs';
import { createInstallReporting } from './install-reports.mjs';
import { pluginVersion } from './plugin-version.mjs';
import { createPreferences } from './preferences.mjs';
import { createCatalogTools } from './catalog-tools.mjs';
import { createInstallService } from './install-service.mjs';
import { createRemovalService } from './removal-service.mjs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createManagedDownloads } from './managed-downloads.mjs';
import { createFullGuideService } from './full-guide-service.mjs';
import { createUpdateService } from './update-service.mjs';
import { migrateCodexSkills } from './deploy/codex-skill-migration.mjs';
import { resolveLcAiPackHome } from './paths.mjs';
import { findMcpLauncher } from './setup/find-mcp-launcher.mjs';
import { registerSideloadHandlers } from './handlers/sideload.mjs';

/**
 * @param {object} orca  Orca 主機 API
 * @param {object} [deps] 測試注入：now()、delay(ms, signal)、requestTimeoutMs、transport
 */
export default function activate(orca, deps = {}) {
  orca.log('AI 資源中心 worker 已啟動');
  const router = createRouter(orca);
  registerDevHandlers(router, { folders: createFolderPickerService({ platform: deps.platform, spawn: deps.folderPickerSpawn }) });
  const preferences = createPreferences(router, orca.storage);
  // 安裝回報（工項 12）：成功連線時補送待送項目；回報需要登入工作階段，所以以延遲綁定接上 session。
  let reporting = null;
  // 部署計畫綁定產生它的工作階段：登出、被拒絕或換市集時丟棄等待確認的計畫（延遲綁定，deploy 在 session 之後才建立）。
  let deploy = null;
  let installation = null;
  let updates = null;
  let guides = null;
  let uploads = null;
  const session = createSessionService({ orca, ...deps,
    onConnected: () => { reporting?.flush(); void updates?.reschedule(); },
    onSessionEnded: () => { deploy?.discardPending(); installation?.discardPending(); updates?.stop(); guides?.stop(); void uploads?.clear().catch(() => orca.log('[upload] cleanup_failed')); } });
  reporting = createInstallReporting({ storage: orca.storage, session, clientVersion: deps.clientVersion ?? pluginVersion(), now: deps.now });

  registerSessionHandlers(router, { session, host: orca.host });
  const developer = createDeveloperService(session);
  registerDeveloperHandlers(router, { developer });
  uploads = createUploadService({ session, developer, temporaryRoot: deps.uploadTemporaryRoot });
  registerUploadHandlers(router, { uploads });
  const installed = createInstalledService({ ...deps, log: message => orca.log(message) });
  const packages = createPackageService(session, installed);
  registerPackageHandlers(router, { packages, preferences, getParameters: input => installation.setup(input), enrich: async (detail, input) =>
    (await enrich(await session.requireClient(), [{ ...detail, latestVisibleVersion: detail.selectedVersion }], input.previewMode ?? (await preferences.get()).showPreview))[0] });
  registerClientHandlers(router, { session, packages, installed });
  const downloads = createManagedDownloads({
    downloads: createDownloadService({ session, packages, maxDownloadBytes: deps.maxDownloadBytes }),
    session, packages, now: deps.now, log: message => orca.log(message),
    dataDirectory: deps.dataDirectory ?? path.join(deps.userHome ?? homedir(), '.orca', 'plugin-data', 'ai-resource-center') });
  const userHome = deps.userHome ?? homedir();
  const home = deps.lcaipackHome ?? resolveLcAiPackHome({ env: deps.env, homedir: userHome });
  const migration = migrateCodexSkills({ home, userHome, downloads }).catch(e => ({
    migrated: 0, blocked: [e.unsupportedFormatVersion ? '請更新 Orca 外掛後再開啟資源中心。' : '無法讀取部署收據。']
  }));
  let migrationAnnounced = false;
  router.handle('rc.client.migration', async () => {
    const result = await migration;
    if (migrationAnnounced || (!result.migrated && !result.blocked.length)) return {};
    migrationAnnounced = true;
    return { message: 'Codex 共用技能已遷移 ' + result.migrated + ' 項。' + result.blocked.join(' '), blocked: result.blocked.length > 0 };
  });
  guides = createFullGuideService({ downloads, packages, session, preferences, now: deps.now, log: message => orca.log(message),
    scheduler: deps.guideScheduler, makeServer: deps.guideCreateServer });
  router.handle('rc.guide.prepare', input => guides.prepare(input));
  updates = createUpdateService({ orca, session, installed, packages, preferences, now: deps.now, scheduler: deps.updateScheduler });
  router.handle('rc.updates.summary', () => updates.summary());
  router.handle('rc.updates.checkNow', () => updates.checkNow());
  void updates.reschedule();
  // 部署：lcaipackHome／userHome／env 可注入，測試以臨時使用者目錄隔離（預設依 LCAIPACK_HOME 與使用者家目錄）。
  let launcherPath;
  const resolveLauncher = () => launcherPath ??= findMcpLauncher({ env: deps.env, platform: deps.platform, userHome });
  const deployOptions = { downloads, installed, session, lcaipackHome: deps.lcaipackHome, userHome: deps.userHome, env: deps.env, platform: deps.platform,
    secretStore: deps.secretStore, mcpLauncherPath: deps.mcpLauncherPath === undefined ? resolveLauncher : deps.mcpLauncherPath,
    installReports: reporting, runners: deps.runners, setupEnvironment: deps.setupEnvironment, commandExecutor: deps.commandExecutor, commandTimeoutMs: deps.commandTimeoutMs };
  deploy = createDeployService(deployOptions);
  installation = createInstallService({ packages, session, preferences, installed, downloads, log: message => orca.log(message), tempRoot: deps.tempRoot, removal: createRemovalService({ ...deps, installed, detectTargets: () => deploy.detectTargets() }), storage: orca.storage, createDeploy: () => createDeployService(deployOptions) });
  router.handle('rc.install.run', async input => {
    await migration;
    const result = await installation.run(input);
    if (result.succeeded?.length) updates.refreshInstalledState();
    return result;
  });
  router.handle('rc.install.cancel', input => installation.cancel(input));
  router.handle('rc.install.saveSetup', async input => ({ parameters: await installation.setup(input, true) }));
  router.handle('rc.install.discard', input => installation.discard(input?.planId));
  registerSideloadHandlers(router, { installation, installed, storage: orca.storage, ready: () => migration });
  const enrich = createCatalogTools({ packages, downloads, detectTargets: () => deploy.detectTargets(), readReceipts: () => installed.tryReceipts({ globalOnly: true }).records ?? [],
    lastFailure: key => installation.lastFailure(key), lastSkipped: key => installation.lastSkipped(key), refreshSkipped: key => installation.refreshSkipped(key), backupsFor: key => installation.backupsFor(key), detachedFor: key => installation.detachedFor(key) });
  registerCatalogHandlers(router, { session, installed, preferences, enrich });

  return {
    session,
    dispose: () => { guides.dispose(); updates.dispose(); session.dispose(); return uploads.clear().catch(() => orca.log('[upload] cleanup_failed')); }
  };
}
