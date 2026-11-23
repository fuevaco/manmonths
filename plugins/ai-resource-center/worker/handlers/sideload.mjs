// 從資料夾安裝（開發中版本）與「我的資源包」的本機開發中區塊。
// 面板契約：
// rc.dev.install.prepare { folder }  folder 為來源資料夾的絕對路徑
//   → 預檢有阻擋項：{ precheckFailed: true, blocking: [{ code, message, path? }], disclosures, summary }
//   → 預檢通過：與 rc.install.run 的例外確認相同（needsConfirmation、reasons、allBlocked、plan、planId），另加
//     { packageKey, version, sourcePath, summary, disclosures, tools: [{ hostId, label }], replacesMarketVersion: string|null }。
//     一律先回傳摘要；按「安裝」後以 rc.install.run { packageKey, action: 'install', confirmedPlanId: planId } 套用，
//     設定參數以 rc.install.saveSetup { packageKey, planId, values, secrets } 儲存，關閉時以 rc.install.discard { planId } 丟棄。
// rc.dev.install.lastFolder → { folder: string|null }  上次從資料夾安裝用過的資料夾（與打包上傳分開記）
// rc.dev.listLocal → { packages: [{ packageKey, name, version, sourcePath, sourceExists, tools: [{ hostId, label }] }] }
// rc.dev.reinstallLocal { packageKey } → 同 rc.dev.install.prepare（來源資料夾為收據記錄的 sourcePath；不存在時錯誤碼 source_missing）
import path from 'node:path';
import { badParams } from '../contract.mjs';
import { packageInput } from '../package-service.mjs';
import { listLocalPackages, sourceExists, sourceMissingError } from '../local-source.mjs';

const lastFolderKey = 'resource-center.lastFolder.install';

export function registerSideloadHandlers(router, { installation, installed, storage, ready = async () => {} }) {
  async function prepare(folder) {
    await ready();
    return installation.installFromFolder(folder);
  }
  router.handle('rc.dev.install.prepare', async input => {
    const folder = input?.folder;
    if (typeof folder !== 'string' || !folder.trim() || !path.isAbsolute(folder)) throw badParams('請輸入資源包資料夾的完整路徑');
    if (sourceExists(folder)) await storage.set(lastFolderKey, folder);
    return prepare(folder);
  });
  router.handle('rc.dev.install.lastFolder', async () => {
    const folder = await storage.get(lastFolderKey);
    return { folder: typeof folder === 'string' ? folder : null };
  });
  router.handle('rc.dev.listLocal', () => ({ packages: listLocalPackages(installed.receipts({ globalOnly: true })) }));
  router.handle('rc.dev.reinstallLocal', async input => {
    packageInput(input);
    const local = listLocalPackages(installed.receipts({ globalOnly: true })).find(p => p.packageKey === input.packageKey);
    if (!local) throw badParams('找不到這個資源包的開發中版本安裝紀錄');
    if (!local.sourceExists) throw sourceMissingError(local.sourcePath);
    return prepare(local.sourcePath);
  });
}
