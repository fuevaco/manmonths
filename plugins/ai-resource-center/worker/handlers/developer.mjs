// 面板契約：
// listMyPackages → { forbidden, packages: normalizedPackage[] }
// submitReview／withdrawReview { versionId, comment? }、setEnabled { versionId, isEnabled } → { version: normalizedVersion }
// submitReviewByVersion { packageKey, version, comment? } → { ok: true }
// history { versionId } → { history: [{ id, createdAt, timeText, action, actionLabel, actor, comment }] }
// deleteVersion { packageKey, version, comment, confirmationVersion } → { deleted: true }
// updatePackage { packageKey, name, description, category, tags: 逗號字串 } → { package: normalizedPackage }
// normalizedVersion.submittedBy 對應 DTO.submitter；uploadedAt 對應 DTO.submittedAt。
export function registerDeveloperHandlers(router, { developer }) {
  for (const method of ['listMyPackages', 'submitReview', 'submitReviewByVersion', 'withdrawReview', 'setEnabled', 'history', 'deleteVersion', 'updatePackage']) {
    router.handle(`rc.dev.${method}`, input => developer[method](input));
  }
}
