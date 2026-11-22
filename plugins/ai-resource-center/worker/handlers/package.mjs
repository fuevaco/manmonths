import { RcError, ErrorCode } from '../contract.mjs';
import { packageInput } from '../package-service.mjs';

export function registerPackageHandlers(router, { packages, preferences, getParameters, enrich }) {
  router.handle('rc.package.getDetails', async input => {
    packageInput(input);
    input = { ...input, previewMode: input.previewMode ?? (await preferences?.get())?.showPreview ?? false };
    const detail = await packages.getDetails(input);
    const result = enrich ? await enrich(detail, input) : detail;
    if (detail.installationStatus === 'unavailable' && !detail.selectedVersion) return { ...result, parameters: [] };
    try {
      return { ...result, parameters: getParameters ? await getParameters({ ...input, version: detail.selectedVersion }) : [] };
    } catch (e) {
      // ZIP／共用設定暫時不可讀時仍可閱讀市集說明；不能假裝參數讀取成功。
      if (!(e instanceof RcError) || [ErrorCode.signedOut, ErrorCode.sessionExpired, ErrorCode.forbidden, ErrorCode.accountUnavailable].includes(e.code)) throw e;
      return { ...result, parameters: [], parametersError: { code: e.code, message: e.message } };
    }
  });
}
