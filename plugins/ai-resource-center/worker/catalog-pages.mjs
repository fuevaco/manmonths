// 市集目錄的有界分頁、格式驗證與去重；呼叫端保留自己的投影及錯誤文字。
import { parseJson } from './http.mjs';
import { RcError, ErrorCode } from './contract.mjs';
export async function readCatalogPages({ request, query, fields = ['packageKey', 'name', 'type'], invalidMessage = '市集目錄格式錯誤，請重試', overflowMessage = null }) {
  const data = [], seen = new Set();
  const params = new URLSearchParams(query);
  params.set('pageSize', '50');
  for (let page = 1; page <= 200; page++) {
    params.set('page', String(page));
    const body = parseJson((await request(`api/market/packages?${params}`)).text);
    if (!Array.isArray(body?.data) || !Number.isSafeInteger(body.meta?.total) || body.meta.total < 0 ||
      body.data.some(p => !p || fields.some(k => typeof p[k] !== 'string'))) throw new RcError(ErrorCode.marketError, invalidMessage);
    for (const p of body.data) if (!seen.has(p.packageKey)) { seen.add(p.packageKey); data.push(p); }
    if (page * 50 >= body.meta.total || !body.data.length) break;
    if (page === 200 && overflowMessage) throw new RcError(ErrorCode.marketError, overflowMessage);
  }
  return data;
}
