export function registerPackageHandlers(router, { packages }) {
  router.handle('rc.package.getDetails', input => packages.getDetails(input));
}
