// LC-AI-Pack VersionVisibility / VersionSelection：先過濾，再按通道及版號排序。
import { RcError, ErrorCode, badParams } from './contract.mjs';
import { statusError, unreachableError } from './auth.mjs';
import { HttpError, parseJson } from './http.mjs';

const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function semver(value) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!m || m.slice(1, 4).some(v => BigInt(v) > 2147483647n)) return null;
  return { core: m.slice(1, 4).map(BigInt), pre: m[4]?.split('.') };
}
export function compareVersions(a, b) {
  const x = semver(a), y = semver(b);
  if (!!x !== !!y) return x ? 1 : -1;
  if (x && y) {
    for (let i = 0; i < 3; i++) { const c = ordinal(x.core[i], y.core[i]); if (c) return c; }
    if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
      const l = x.pre[i], r = y.pre[i];
      if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
      const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
      const c = ln && rn ? ordinal(BigInt(l), BigInt(r)) : ln !== rn ? (ln ? -1 : 1) : ordinal(l, r);
      if (c) return c;
    }
    return 0;
  }
  const l = a.match(/\d+|\D+/g) || [], r = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined || r[i] === undefined) return l[i] === undefined ? -1 : 1;
    const c = /^\d+$/.test(l[i]) && /^\d+$/.test(r[i]) ? ordinal(BigInt(l[i]), BigInt(r[i])) : ordinal(l[i].toLowerCase(), r[i].toLowerCase());
    if (c) return c;
  }
  return 0;
}

export function packageInput(input, requireVersion = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.packageKey !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(input.packageKey) ||
      (input.version !== undefined && (typeof input.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.version))) ||
      (requireVersion && !input.version) || (input.previewMode !== undefined && typeof input.previewMode !== 'boolean')) {
    throw badParams('資源包、版本或 Preview 條件格式錯誤');
  }
}

export function createPackageService(session, installed) {
  async function request(client, path, options = {}) {
    let res;
    try { res = await client.request({ path, ...options }); }
    catch (e) {
      if (e instanceof RcError) throw e;
      if (e instanceof HttpError && e.kind === 'too_large') throw new RcError(ErrorCode.invalidPackage, '資源包超過大小上限，已中止下載');
      throw unreachableError(e, client.marketUrl);
    }
    if (res.status === 401) await session.rejectClient(client);
    if (res.status < 200 || res.status >= 300) throw statusError(res.status, res.text, '資源包讀取失敗');
    return res;
  }
  async function details(client, input) {
    const suffix = input.previewMode ? '?channel=preview' : '';
    const body = parseJson((await request(client, `api/market/packages/${encodeURIComponent(input.packageKey)}${suffix}`)).text);
    if (!body || body.packageKey !== input.packageKey || !Array.isArray(body.versions) || body.versions.some(v => !v || typeof v.version !== 'string')) {
      throw new RcError(ErrorCode.marketError, '市集資源包格式錯誤，請重試');
    }
    const versions = body.versions.filter(v => v.isEnabled === true && (v.channel === 'release' || input.previewMode === true))
      .sort((a, b) => (a.channel === 'release' ? 0 : 1) - (b.channel === 'release' ? 0 : 1) || compareVersions(b.version, a.version));
    const selected = input.version ? versions.find(v => v.version === input.version) : versions.find(v => v.version === body.recommendedVersion) || versions[0];
    if (!selected) throw new RcError(ErrorCode.versionUnavailable, '此版本不可見或已停用，請重新選擇版本');
    // 僅投影顯示所需欄位，避免將管理資訊或未知欄位帶到面板。
    return { packageKey: body.packageKey, name: body.name, type: body.type, description: body.description,
      selectedVersion: selected.version, recommendedVersion: (versions.find(v => v.version === body.recommendedVersion) || versions[0]).version, versions: versions.map(v => ({ version: v.version, channel: v.channel,
        hosts: v.hosts || v.platforms || [], changelog: v.changelog, sha256: v.sha256, hasFullGuide: v.hasFullGuide === true })) };
  }
  return { request, details, async getDetails(input) {
    packageInput(input);
    const client = await session.requireClient();
    const detail = await details(client, input);
    const suffix = input.previewMode ? '?channel=preview' : '';
    const readme = parseJson((await request(client, `api/market/packages/${encodeURIComponent(input.packageKey)}/versions/${encodeURIComponent(detail.selectedVersion)}/readme${suffix}`)).text);
    if (!readme || (readme.readme !== null && typeof readme.readme !== 'string')) throw new RcError(ErrorCode.marketError, '市集說明格式錯誤');
    // 收據損壞時詳情仍可讀取，只是不附已安裝狀態而改附錯誤。
    const { records, error } = installed ? installed.tryReceipts() : {};
    const installation = !installed ? {} : error ? { installedError: error } : installed.project(detail.packageKey, detail.recommendedVersion, records, detail.versions);
    return { ...detail, ...installation, readme: readme.readme || '' };
  } };
}
