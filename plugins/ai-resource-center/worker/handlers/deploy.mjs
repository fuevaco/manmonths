// 部署規劃與套用：安裝與更新共用 rc.deploy.plan → rc.deploy.apply，套用只接受使用者剛確認的那份計畫。
export function registerDeployHandlers(router, { deploy }) {
  router.handle('rc.deploy.listTargets', input => deploy.listTargets(input));
  router.handle('rc.deploy.plan', input => deploy.plan(input));
  router.handle('rc.deploy.saveSetup', input => deploy.saveSetup(input));
  router.handle('rc.deploy.apply', input => deploy.apply(input));
  router.handle('rc.deploy.cancel', () => deploy.cancel());
}
