// 打包上傳與本機安裝共用的資料夾操作。
export function registerDevHandlers(router, { folders }) {
  router.handle('rc.dev.pickFolder', (input, context) => folders.pickFolder(input, context));
  router.handle('rc.dev.checkFolder', input => folders.checkFolder(input));
}
