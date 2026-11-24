// AI 助手的資源清單；每次重讀目錄，避免沿用已下架或不可見的版本。
import { readCatalogPages } from './catalog-pages.mjs';
import { recommendedVersion } from './package-service.mjs';
import { parseJson } from './http.mjs';
import { RcError, ErrorCode } from './contract.mjs';

const README_CONCURRENCY = 4; // README 與明細共用的並行上限
const README_MAX_CHARACTERS = 6000;
const CONTENT_DESCRIPTION_MAX_CHARACTERS = 120;

export function createAiCatalog({ session, preferences, packages }) {
  const cache = new Map();
  let generation = 0;
  function ensureCurrent(expected) {
    if (generation !== expected) throw new RcError(ErrorCode.signedOut, '工作階段已變更，請重新讀取資源清單');
  }
  let active = 0;
  const waiting = [];
  async function limited(action) {
    if (active >= README_CONCURRENCY) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await action(); }
    finally {
      if (waiting.length) waiting.shift()();
      else active--;
    }
  }
  function readme(client, p, preview, expected) {
    ensureCurrent(expected);
    const key = JSON.stringify([p.packageKey, p.version]);
    if (cache.has(key)) return cache.get(key);
    const pending = limited(async () => {
      ensureCurrent(expected);
      const suffix = preview ? '?channel=preview' : '';
      const body = parseJson((await packages.request(client,
        `api/market/packages/${encodeURIComponent(p.packageKey)}/versions/${encodeURIComponent(p.version)}/readme${suffix}`)).text);
      return typeof body?.readme === 'string' && body.readme.trim() ? Array.from(body.readme).slice(0, README_MAX_CHARACTERS).join('') : '';
    }).catch(error => { if (cache.get(key) === pending) cache.delete(key); throw error; });
    // 連進行中的請求也共用，避免同時組成清單時重複抓取。
    cache.set(key, pending);
    return pending;
  }
  /**
   * 該版本內容清單（Skill 等）的「識別碼：說明」，讓第一階段在資源包說明寫得簡略時也找得到。
   * 說明來自資源包清單檔，作者常未填，此時只有識別碼。依識別碼與版本快取；失敗時回傳空陣列。
   */
  function contents(client, p, preview, expected) {
    ensureCurrent(expected);
    const key = JSON.stringify(['contents', p.packageKey, p.version]);
    if (cache.has(key)) return cache.get(key);
    const pending = limited(async () => {
      ensureCurrent(expected);
      const suffix = preview ? '?channel=preview' : '';
      const body = parseJson((await packages.request(client, `api/market/packages/${encodeURIComponent(p.packageKey)}${suffix}`)).text);
      const version = Array.isArray(body?.versions) ? body.versions.find(v => v?.version === p.version) : null;
      return (Array.isArray(version?.contents) ? version.contents : []).filter(c => typeof c?.id === 'string' && c.id.trim()).map(c => {
        const description = typeof c.description === 'string' ? Array.from(c.description.trim()).slice(0, CONTENT_DESCRIPTION_MAX_CHARACTERS).join('') : '';
        return description ? `${c.id}：${description}` : c.id;
      });
    }).catch(error => {
      if (cache.get(key) === pending) cache.delete(key);
      if ([ErrorCode.signedOut, ErrorCode.sessionExpired, ErrorCode.accountUnavailable].includes(error.code)) throw error;
      return [];
    });
    cache.set(key, pending);
    return pending;
  }
  async function build() {
    const expected = generation;
    const client = await session.requireClient();
    const { showPreview } = await preferences.get();
    const rows = await readCatalogPages({ query: showPreview ? { channel: 'preview' } : {},
      request: path => { ensureCurrent(expected); return packages.request(client, path); }, overflowMessage: '資源清單過大，請稍後再試' });
    ensureCurrent(expected);
    const data = rows.map(p => ({ packageKey: p.packageKey, name: p.name, description: p.description ?? '',
      category: p.category ?? null, tags: p.tags ?? [],
      version: recommendedVersion([{ version: p.latestReleaseVersion, channel: 'release' },
        { version: p.latestPreviewVersion, channel: 'preview' }], showPreview) })).filter(p => p.version);
    await Promise.all(data.map(async p => {
      const list = await contents(client, p, showPreview, expected);
      if (list.length) p.contents = list;
    }));
    ensureCurrent(expected);
    return { packages: data, packageCount: data.length, packageKeys: data.map(p => p.packageKey) };
  }
  async function withReadmes(list, keys) {
    const expected = generation;
    const client = await session.requireClient();
    const { showPreview } = await preferences.get();
    const data = [...new Set(keys)].map(key => list.packages.find(p => p.packageKey === key)).filter(Boolean).map(p => ({ ...p }));
    await Promise.all(data.map(async p => {
      let text;
      try { text = await readme(client, p, showPreview, expected); }
      catch (error) {
        if ([ErrorCode.signedOut, ErrorCode.sessionExpired, ErrorCode.accountUnavailable].includes(error.code)) throw error;
        text = '';
      }
      if (text) p.readme = text;
    }));
    ensureCurrent(expected);
    return data;
  }
  return { build, withReadmes, clear: () => { generation++; cache.clear(); } };
}
