// inspect { folder, mode } → 預檢結果（不含 files）；upload.start { folder } → { jobId }
// upload.status { jobId } → { state, packageKey, version, name, createdPackage, versionId?, error? }
// upload.cancel／dispose { jobId } → { ok: true }；upload.retry { jobId } → { jobId }
export function registerUploadHandlers(router, { uploads }) {
  router.handle('rc.dev.inspect', input => uploads.inspect(input));
  for (const method of ['start', 'status', 'cancel', 'retry', 'dispose']) {
    router.handle(`rc.dev.upload.${method}`, input => uploads[method](input));
  }
}
