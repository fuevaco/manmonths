// Skills Registry API 的用戶端：取得索引、取得清單、下載並驗證檔案內容。
// 每一個下載下來的位元組都會對照清單的 sha256，整體再對照索引的 digest；
// 任何一項不符就整包拒絕，不會寫入磁碟。

import { httpGet, ApiError } from './http.mjs';
import {
  LIMITS,
  validateIndex,
  validateManifest,
  formatIssues,
  sha256Hex,
  computeDigest,
  parseSkillFrontmatter
} from './spec.mjs';

export { ApiError };

// 設定的 API 網址可以是根網址（會接上 index.json），或直接指向 .json 檔
export function resolveIndexUrl(baseUrl) {
  let u;
  try {
    u = new URL(String(baseUrl || '').trim());
  } catch {
    throw new ApiError('bad_url', '請先在設定填入 API 網址（例如 https://skills.example.com/api/v1/）');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ApiError('bad_url', 'API 網址必須是 http 或 https');
  }
  if (!u.pathname.toLowerCase().endsWith('.json')) {
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return new URL('index.json', u).toString();
  }
  return u.toString();
}

function errorFromResponse(res, what) {
  let detail = '';
  try {
    const j = JSON.parse(res.body.toString('utf8'));
    detail = j?.error?.message ? `：${j.error.message}` : '';
  } catch {
    /* 非 JSON 錯誤內容，忽略 */
  }
  const s = res.status;
  if (s === 401) return new ApiError('unauthorized', `${what}：Token 無效或未提供（401）${detail}`, { status: s });
  if (s === 403) return new ApiError('forbidden', `${what}：這個 Token 沒有權限（403）${detail}`, { status: s });
  if (s === 404) return new ApiError('not_found', `${what}：找不到（404）${detail}`, { status: s });
  if (s === 429) return new ApiError('rate_limited', `${what}：請求太頻繁（429），稍後再試${detail}`, { status: s });
  return new ApiError('http_error', `${what}：伺服器回應 ${s}${detail}`, { status: s });
}

function parseJson(buf, what) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new ApiError('invalid_json', `${what}不是合法的 JSON：${e.message}`);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createClient(cfg) {
  const indexUrl = resolveIndexUrl(cfg.baseUrl);
  const apiOrigin = new URL(indexUrl).origin;
  const common = {
    token: cfg.token || undefined,
    authOrigin: apiOrigin,
    allowHttp: Boolean(cfg.allowHttp),
    insecureTls: Boolean(cfg.insecureTls),
    timeoutMs: cfg.timeoutMs || 20000,
    signal: cfg.signal
  };

  async function getIndex({ etag } = {}) {
    const res = await httpGet(indexUrl, {
      ...common,
      maxBytes: LIMITS.maxIndexBytes,
      headers: etag ? { 'If-None-Match': etag } : {}
    });
    if (res.status === 304) return { notModified: true, etag, indexUrl };
    if (res.status !== 200) throw errorFromResponse(res, '讀取技能清單');
    const json = parseJson(res.body, '技能索引');
    const v = validateIndex(json);
    if (!v.ok) {
      throw new ApiError('invalid_index', `技能索引不符合標準：\n${formatIssues(v.issues.filter((i) => i.level === 'error')).slice(0, 1500)}`);
    }
    return {
      index: v.index,
      etag: res.headers.etag || null,
      warnings: v.issues.filter((i) => i.level === 'warning'),
      indexUrl
    };
  }

  function resolveManifestUrl(entry) {
    let u;
    try {
      u = new URL(entry.manifestUrl, indexUrl);
    } catch {
      throw new ApiError('bad_url', `「${entry.name}」的 manifestUrl 不正確`);
    }
    if (u.origin !== apiOrigin) {
      throw new ApiError('cross_origin', `「${entry.name}」的清單網址不在 API 同一來源，已拒絕（避免 Token 外洩）`);
    }
    return u.toString();
  }

  async function getManifest(entry) {
    const url = resolveManifestUrl(entry);
    const res = await httpGet(url, { ...common, maxBytes: LIMITS.maxManifestBytes });
    if (res.status !== 200) throw errorFromResponse(res, `讀取「${entry.name}」清單`);
    const json = parseJson(res.body, `「${entry.name}」清單`);
    const v = validateManifest(json, { name: entry.name, version: entry.version, digest: entry.digest });
    if (!v.ok) {
      throw new ApiError('invalid_manifest', `「${entry.name}」清單不符合標準：\n${formatIssues(v.issues.filter((i) => i.level === 'error')).slice(0, 1500)}`);
    }
    return { manifest: v.manifest, manifestUrl: url };
  }

  // 下載整個 skill 並逐檔驗證；回傳 { files: [{path, bytes, executable}], warnings }
  async function downloadSkill(manifest, manifestUrl, { onFile } = {}) {
    const warnings = [];
    const files = await mapLimit(manifest.files, 4, async (f) => {
      const fileUrl = new URL(f.url, manifestUrl).toString();
      const res = await httpGet(fileUrl, {
        ...common,
        maxBytes: f.size,
        headers: { Accept: '*/*' }
      });
      if (res.status !== 200) throw errorFromResponse(res, `下載 ${manifest.name}/${f.path}`);
      if (res.body.length !== f.size) {
        throw new ApiError('integrity', `${manifest.name}/${f.path} 大小不符（清單 ${f.size}，實際 ${res.body.length}）`);
      }
      if (sha256Hex(res.body) !== f.sha256) {
        throw new ApiError('integrity', `${manifest.name}/${f.path} 內容雜湊不符，檔案可能被竄改或傳輸損毀`);
      }
      onFile?.(f.path);
      return { path: f.path, bytes: res.body, executable: Boolean(f.executable) };
    });
    if (computeDigest(manifest.files) !== manifest.digest) {
      throw new ApiError('integrity', `${manifest.name} 整體摘要不符`);
    }
    const skillMd = files.find((f) => f.path === 'SKILL.md');
    const fm = parseSkillFrontmatter(skillMd?.bytes.toString('utf8'));
    if (!fm) warnings.push('SKILL.md 沒有 frontmatter（--- 區塊）');
    else {
      if (fm.name && fm.name !== manifest.name) {
        warnings.push(`SKILL.md 的 name「${fm.name}」與 skill 名稱「${manifest.name}」不同`);
      }
      if (!fm.description) warnings.push('SKILL.md frontmatter 缺少 description');
    }
    return { files, warnings };
  }

  return { indexUrl, apiOrigin, getIndex, getManifest, downloadSkill };
}
