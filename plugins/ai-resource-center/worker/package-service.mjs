// VersionVisibility / VersionSelection：先過濾，再按通道及版號排序。
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

// 所有顯示與安裝入口共用：Preview 只擴大候選範圍，仍選版本較新者。
export function recommendedVersion(versions, previewMode = false) {
  return versions.filter(v => v.version && (v.channel === 'release' || (previewMode && v.channel === 'preview')))
    .sort((a, b) => compareVersions(b.version, a.version))[0]?.version ?? null;
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
    if (res.status < 200 || res.status >= 300) {
      const error = statusError(res.status, res.text, '資源包讀取失敗');
      error.status = res.status;
      throw error;
    }
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
    const recommended = recommendedVersion(versions, input.previewMode);
    const selected = versions.find(v => v.version === (input.version ?? recommended));
    if (!selected) {
      const error = new RcError(ErrorCode.versionUnavailable, '此版本不可見或已停用，請重新選擇版本');
      // 擁有者或管理者仍讀得到主檔，但所有版本都已停用：與 403／404 一樣視為已下架
      if (input.version === undefined && !body.versions.some(v => v.isEnabled === true)) error.noVisibleVersion = true;
      throw error;
    }
    // 僅投影顯示所需欄位，避免將管理資訊或未知欄位帶到面板。
    return { packageKey: body.packageKey, name: body.name, type: body.type, description: body.description,
      selectedVersion: selected.version, recommendedVersion: recommended, versions: versions.map(v => ({ version: v.version, channel: v.channel,
        hosts: v.hosts || v.platforms || [], changelog: v.changelog, sha256: v.sha256, hasFullGuide: v.hasFullGuide === true })) };
  }
  return { request, details, async getDetails(input) {
    packageInput(input);
    const client = await session.requireClient();
    let detail;
    try { detail = await details(client, input); }
    catch (error) {
      // 只有明確下架／無權限（或主檔仍在但所有版本都已停用）且有全域收據，才以本機資料提供解除安裝入口。
      if (!([403, 404].includes(error.status) || error.noVisibleVersion === true) || !installed) throw error;
      const records = installed.receipts({ globalOnly: true }).filter(r => r.packageKey === input.packageKey);
      if (!records.length) throw error;
      return { packageKey: input.packageKey, name: input.packageKey, type: records[0].kind, description: '',
        selectedVersion: null, recommendedVersion: null, versions: [], readme: '', ...installed.project(input.packageKey, null, records) };
    }
    const suffix = input.previewMode ? '?channel=preview' : '';
    const readme = parseJson((await request(client, `api/market/packages/${encodeURIComponent(input.packageKey)}/versions/${encodeURIComponent(detail.selectedVersion)}/readme${suffix}`)).text);
    if (!readme || (readme.readme !== null && typeof readme.readme !== 'string')) throw new RcError(ErrorCode.marketError, '市集說明格式錯誤');
    // 收據損壞時詳情仍可讀取，只是不附已安裝狀態而改附錯誤。
    const { records, error } = installed ? installed.tryReceipts({ globalOnly: true }) : {};
    const installation = !installed ? {} : error ? { installedError: error } : installed.project(detail.packageKey, detail.recommendedVersion, records, detail.versions);
    return { ...detail, ...installation, readme: readme.readme || '' };
  } };
}
