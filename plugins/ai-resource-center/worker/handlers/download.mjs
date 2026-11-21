export function registerDownloadHandlers(router, { downloads }) {
  router.handle('rc.download.save', input => downloads.save(input));
}
