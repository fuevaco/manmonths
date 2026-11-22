// 清單摘要加上相容工具；版本詳情以工作階段記憶體快取並限制並行。
import { badParams, RcError } from '../contract.mjs';
import { readCatalogPages } from '../catalog-pages.mjs';
import { statusError, unreachableError } from '../auth.mjs';
import { validatePreferences, defaultDirection } from '../preferences.mjs';
import { sortCatalog } from '../catalog-sort.mjs';
import { recommendedVersion } from '../package-service.mjs';
import { readSourceManifest } from '../local-source.mjs';

export function registerCatalogHandlers(router, { session, installed, preferences, enrich }) {
  router.handle('rc.catalog.list', async (input) => {
    if (typeof input !== 'object' || Array.isArray(input)) throw badParams('目錄查詢格式錯誤');
    for (const key of ['search', 'type', 'category']) {
      if (input[key] !== undefined && typeof input[key] !== 'string') throw badParams('搜尋與篩選條件必須是文字');
    }
    if (input.type && !['skill', 'agent', 'mcp', 'bundle'].includes(input.type)) throw badParams('資源類型不正確');
    if (input.previewMode !== undefined && typeof input.previewMode !== 'boolean') throw badParams('Preview 模式必須是布林值');
    if (input.installation !== undefined && !['', 'all', 'installed', 'updates'].includes(input.installation)) throw badParams('安裝狀態篩選不正確');
    validatePreferences(Object.fromEntries(['sortField', 'sortDirection'].filter(k => input[k] !== undefined).map(k => [k, input[k]])));
    const saved = await preferences.get();
    const sortField = input.sortField ?? saved.sortField;
    const sortDirection = input.sortDirection ?? (input.sortField && input.sortField !== saved.sortField ? defaultDirection(sortField) : saved.sortDirection);
    const sort = data => sortCatalog(data, sortField, sortDirection);
    const query = new URLSearchParams({ page: '1', pageSize: '50' });
    for (const key of ['search', 'type', 'category']) {
      if (typeof input[key] === 'string' && input[key].trim()) query.set(key, input[key].trim());
    }
    const previewMode = input.previewMode ?? saved.showPreview;
    if (previewMode) query.set('channel', 'preview');
    const client = await session.requireClient();
    const rows = await readCatalogPages({ query, request: async path => {
      let res;
      try { res = await client.request({ path }); }
      catch (e) { if (e instanceof RcError) throw e; throw unreachableError(e, client.marketUrl); }
      if (res.status === 401) await session.rejectClient(client);
      if (res.status < 200 || res.status >= 300) throw statusError(res.status, res.text, '目錄讀取失敗');
      return res;
    } });
    const seen = new Set(rows.map(p => p.packageKey));
    const data = rows.map(p => ({
      packageKey: p.packageKey, name: p.name, type: p.type, description: p.description, category: p.category ?? null,
      hasFullGuide: p.recommendedVersionHasFullGuide === true,
      latestVisibleVersion: recommendedVersion([{ version: p.latestReleaseVersion, channel: 'release' }, { version: p.latestPreviewVersion, channel: 'preview' }], previewMode),
      owner: p.ownerAdAccount ?? null, lastUploadedAt: Number.isFinite(Date.parse(p.lastUploadedAt)) ? new Date(p.lastUploadedAt).toISOString() : null,
      installCount: p.installCount ?? null, downloadCount: p.downloadCount ?? 0
    }));
    const { records, error: installedError } = installed.tryReceipts({ globalOnly: true });
    if (installedError) {
      // 收據損壞：「全部」檢視照常瀏覽（不附安裝狀態）；需要收據才有意義的篩選明確失敗，不假裝沒有安裝。
      if (input.installation === 'installed' || input.installation === 'updates') throw new RcError(installedError.code, installedError.message);
      return { data: sort(await enrich(client, data, previewMode)), installedError };
    }
    // 下架或本機來源仍可在已安裝清單檢視，不把新偵測根目錄當成部署。
    if (input.installation === 'installed') {
      for (const r of records) {
        if (seen.has(r.packageKey)) continue;
        // 市集沒有的開發中版本：名稱與類型讀來源資料夾的 lcpack.json（對照 RefreshLocalSourcePlatform），讀不到時用識別碼。
        const manifest = r.source === 'local' ? readSourceManifest(r.sourcePath) : null;
        const name = typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name : r.packageKey;
        const type = ['skill', 'agent', 'mcp', 'bundle'].includes(manifest?.type) ? manifest.type : r.kind;
        if (input.type && input.type !== type) continue;
        if (input.category) continue; // 收據沒有分類，不猜測市集分類。
        if (input.search?.trim() && ![r.packageKey, name].some(text => text.toLowerCase().includes(input.search.trim().toLowerCase()))) continue;
        seen.add(r.packageKey);
        data.push({ packageKey: r.packageKey, name, type, latestVisibleVersion: null, owner: null, category: null, lastUploadedAt: null, hasFullGuide: false, installCount: null, downloadCount: 0 });
      }
    }
    const projected = data.map(p => ({ ...p, ...installed.project(p.packageKey, p.latestVisibleVersion, records) })).filter(p =>
      input.installation === 'installed' ? p.deployments.length > 0 : input.installation === 'updates' ? p.installationStatus === 'updateAvailable' : true);
    return { data: sort(await enrich(client, projected, previewMode)) };
  });
}
