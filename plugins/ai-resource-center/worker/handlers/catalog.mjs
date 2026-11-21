// 清單沿用 MarketApiClient / BrowseViewModel：摘要讀取，不逐包載入詳情。
import { badParams, ErrorCode, RcError } from '../contract.mjs';
import { parseJson } from '../http.mjs';
import { statusError, unreachableError } from '../auth.mjs';

export function registerCatalogHandlers(router, { session, installed }) {
  router.handle('rc.catalog.list', async (input) => {
    if (typeof input !== 'object' || Array.isArray(input)) throw badParams('目錄查詢格式錯誤');
    for (const key of ['search', 'type', 'category']) {
      if (input[key] !== undefined && typeof input[key] !== 'string') throw badParams('搜尋與篩選條件必須是文字');
    }
    if (input.type && !['skill', 'agent', 'mcp', 'bundle'].includes(input.type)) throw badParams('資源類型不正確');
    if (input.previewMode !== undefined && typeof input.previewMode !== 'boolean') throw badParams('Preview 模式必須是布林值');
    if (input.installation !== undefined && !['', 'all', 'installed', 'updates'].includes(input.installation)) throw badParams('安裝狀態篩選不正確');
    const query = new URLSearchParams({ page: '1', pageSize: '50' });
    for (const key of ['search', 'type', 'category']) {
      if (typeof input[key] === 'string' && input[key].trim()) query.set(key, input[key].trim());
    }
    const previewMode = input.previewMode === true;
    if (previewMode) query.set('channel', 'preview');
    const client = await session.requireClient();
    const data = [];
    const seen = new Set();
    for (let page = 1; page <= 200; page += 1) {
      query.set('page', String(page));
      let res;
      try { res = await client.request({ path: `api/market/packages?${query}` }); }
      catch (e) {
        if (e instanceof RcError) throw e;
        throw unreachableError(e, client.marketUrl);
      }
      if (res.status === 401) await session.rejectClient(client);
      if (res.status < 200 || res.status >= 300) throw statusError(res.status, res.text, '目錄讀取失敗');
      const body = parseJson(res.text);
      if (!Array.isArray(body?.data) || !Number.isSafeInteger(body.meta?.total) || body.meta.total < 0 ||
          body.data.some((p) => !p || ['packageKey', 'name', 'type'].some((k) => typeof p[k] !== 'string'))) {
        throw new RcError(ErrorCode.marketError, '市集目錄格式錯誤，請重試');
      }
      data.push(...body.data.filter((p) => {
        if (seen.has(p.packageKey)) return false;
        seen.add(p.packageKey);
        return true;
      }).map((p) => ({
        packageKey: p.packageKey, name: p.name, type: p.type, description: p.description, category: p.category,
        latestVisibleVersion: p.latestReleaseVersion || (previewMode ? p.latestPreviewVersion : null) || null,
        installCount: p.installCount ?? 0, downloadCount: p.downloadCount ?? 0
      })));
      if (page * 50 >= body.meta?.total || body.data.length === 0) break;
    }
    const { records, error: installedError } = installed.tryReceipts();
    if (installedError) {
      // 收據損壞：「全部」檢視照常瀏覽（不附安裝狀態）；需要收據才有意義的篩選明確失敗，不假裝沒有安裝。
      if (input.installation === 'installed' || input.installation === 'updates') throw new RcError(installedError.code, installedError.message);
      return { data, installedError };
    }
    // 下架或本機來源仍可在已安裝清單檢視，不把新偵測根目錄當成部署。
    if (input.installation === 'installed') {
      for (const r of records) {
        if (seen.has(r.packageKey)) continue;
        if (input.type && input.type !== r.kind) continue;
        if (input.category) continue; // 收據沒有分類，不猜測市集分類。
        if (input.search?.trim() && !r.packageKey.toLowerCase().includes(input.search.trim().toLowerCase())) continue;
        seen.add(r.packageKey);
        data.push({ packageKey: r.packageKey, name: r.packageKey, type: r.kind, latestVisibleVersion: null, installCount: 0, downloadCount: 0 });
      }
    }
    return { data: data.map(p => ({ ...p, ...installed.project(p.packageKey, p.latestVisibleVersion, records) })).filter(p =>
      input.installation === 'installed' ? p.deployments.length > 0 : input.installation === 'updates' ? p.installationStatus === 'updateAvailable' : true) };
  });
}
