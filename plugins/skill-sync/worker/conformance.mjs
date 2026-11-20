// Skills Registry API 一致性驗證：對一個真實執行中的 API 逐項檢查是否符合標準。
// 面板的「驗證 API」按鈕與 tools/verify-api.mjs 都呼叫這支，網店開發者可用同一套標準自我檢查。
//
// status：pass 通過 / fail 不符合標準（MUST） / warn 建議改善（SHOULD） / skip 略過

import { httpGet, ApiError } from './http.mjs';
import { createClient, resolveIndexUrl } from './api-client.mjs';
import { LIMITS, validateIndex, listRunnableFiles } from './spec.mjs';

const ok = (id, title, detail = '') => ({ id, title, status: 'pass', detail });
const fail = (id, title, detail = '') => ({ id, title, status: 'fail', detail });
const warn = (id, title, detail = '') => ({ id, title, status: 'warn', detail });
const skip = (id, title, detail = '') => ({ id, title, status: 'skip', detail });

function jsonErrorShape(body) {
  try {
    const j = JSON.parse(body.toString('utf8'));
    return typeof j?.error?.code === 'string' && typeof j?.error?.message === 'string';
  } catch {
    return false;
  }
}

export async function verifyApi(cfg, { requireAuth = false, maxSkills = 50, onProgress } = {}) {
  const checks = [];
  const push = (c) => {
    checks.push(c);
    onProgress?.(c);
    return c;
  };
  const finish = (extra = {}) => ({
    ok: !checks.some((c) => c.status === 'fail'),
    checks,
    summary: {
      pass: checks.filter((c) => c.status === 'pass').length,
      fail: checks.filter((c) => c.status === 'fail').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      skip: checks.filter((c) => c.status === 'skip').length
    },
    ...extra
  });

  let indexUrl;
  try {
    indexUrl = resolveIndexUrl(cfg.baseUrl);
  } catch (e) {
    push(fail('url', 'API 網址', e.message));
    return finish();
  }
  const opts = {
    token: cfg.token || undefined,
    authOrigin: new URL(indexUrl).origin,
    allowHttp: Boolean(cfg.allowHttp),
    insecureTls: Boolean(cfg.insecureTls),
    timeoutMs: cfg.timeoutMs || 20000
  };

  // 1. 索引可讀取
  let res;
  try {
    res = await httpGet(indexUrl, { ...opts, maxBytes: LIMITS.maxIndexBytes });
  } catch (e) {
    push(fail('index.reachable', '索引可連線', e.message));
    return finish({ indexUrl });
  }
  if (res.status !== 200) {
    const why = res.status === 401 || res.status === 403 ? '（Token 錯誤或沒有權限）' : '';
    push(fail('index.reachable', '索引可連線', `GET ${indexUrl} 回應 ${res.status}${why}`));
    return finish({ indexUrl });
  }
  push(ok('index.reachable', '索引可連線', `GET ${indexUrl} → 200`));

  const ctype = String(res.headers['content-type'] || '');
  push(
    /application\/(.+\+)?json/i.test(ctype)
      ? ok('index.content-type', 'Content-Type 為 application/json', ctype)
      : warn('index.content-type', 'Content-Type 應為 application/json', ctype || '(未提供)')
  );

  // 2. 索引格式
  let json;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch (e) {
    push(fail('index.json', '索引是合法 JSON', e.message));
    return finish({ indexUrl });
  }
  const v = validateIndex(json);
  const errs = v.issues.filter((i) => i.level === 'error');
  const warns = v.issues.filter((i) => i.level === 'warning');
  if (errs.length) {
    push(fail('index.schema', '索引符合標準格式', errs.slice(0, 8).map((i) => `${i.path}：${i.message}`).join('\n')));
    return finish({ indexUrl });
  }
  push(ok('index.schema', '索引符合標準格式', `${json.skills.length} 個 skill`));
  for (const w of warns.slice(0, 5)) push(warn('index.schema.warn', `索引建議：${w.path}`, w.message));

  // 3. 驗證機制（只有提供 Token 時才有意義）
  if (opts.token || requireAuth) {
    const bare = await httpGet(indexUrl, { ...opts, token: undefined }).catch((e) => e);
    if (bare instanceof Error) {
      push(fail('auth.no-token', '未帶 Token 的請求', bare.message));
    } else if (bare.status === 401 || bare.status === 403) {
      push(ok('auth.no-token', '未帶 Token 會被拒絕', `→ ${bare.status}`));
      push(
        jsonErrorShape(bare.body)
          ? ok('auth.error-shape', '拒絕時回傳標準錯誤格式', '{"error":{"code","message"}}')
          : warn('auth.error-shape', '拒絕時建議回傳 {"error":{"code","message"}}', bare.body.toString('utf8').slice(0, 80))
      );
      const bad = await httpGet(indexUrl, { ...opts, token: `invalid-${Date.now().toString(36)}` }).catch((e) => e);
      if (bad instanceof Error) push(fail('auth.bad-token', '錯誤 Token 的請求', bad.message));
      else if (bad.status === 401 || bad.status === 403) push(ok('auth.bad-token', '錯誤的 Token 會被拒絕', `→ ${bad.status}`));
      else push(fail('auth.bad-token', '錯誤的 Token 必須被拒絕', `回應 ${bad.status}：伺服器沒有真正檢查 Token`));
    } else if (requireAuth) {
      push(fail('auth.no-token', '必須要求驗證', `未帶 Token 仍回應 ${bare.status}`));
    } else {
      push(warn('auth.no-token', 'API 未要求驗證（公開存取）', '若這是私有的技能庫，請在伺服器端檢查 Authorization: Bearer'));
    }
  } else {
    push(skip('auth.no-token', '驗證機制', '未提供 Token，略過；加上 --token 可驗證驗證機制'));
  }

  // 4. 快取（ETag 為選用）
  if (res.headers.etag) {
    const cond = await httpGet(indexUrl, { ...opts, headers: { 'If-None-Match': res.headers.etag } }).catch((e) => e);
    push(
      !(cond instanceof Error) && cond.status === 304
        ? ok('index.etag', 'ETag 條件請求', 'If-None-Match → 304')
        : fail('index.etag', '有提供 ETag 就必須支援 If-None-Match', cond instanceof Error ? cond.message : `回應 ${cond.status}，應為 304`)
    );
  } else {
    push(warn('index.etag', '建議提供 ETag 以節省流量', '選用功能'));
  }

  // 5. 不存在的資源要回 404（避免單頁應用程式對任何路徑都回 200）
  const missingUrl = new URL('skills/__verify-nonexistent__/0.0.0/manifest.json', indexUrl).toString();
  const miss = await httpGet(missingUrl, opts).catch((e) => e);
  if (miss instanceof Error) push(warn('notfound', '不存在的資源回 404', miss.message));
  else if (miss.status === 404) {
    push(ok('notfound', '不存在的資源回 404'));
    if (!jsonErrorShape(miss.body)) push(warn('notfound.shape', '404 建議回傳標準錯誤格式', ''));
  } else push(fail('notfound', '不存在的資源必須回 404', `回應 ${miss.status}`));

  // 6. 逐一驗證 skill：清單、檔案雜湊、摘要
  const client = createClient({ ...cfg, timeoutMs: opts.timeoutMs });
  const sample = json.skills.slice(0, maxSkills);
  let totalBytes = 0;
  for (const entry of sample) {
    const id = `skill:${entry.name}`;
    const title = `${entry.name}@${entry.version}`;
    try {
      const { manifest, manifestUrl } = await client.getManifest(entry);
      const { files, warnings } = await client.downloadSkill(manifest, manifestUrl);
      const size = files.reduce((n, f) => n + f.bytes.length, 0);
      totalBytes += size;
      const notes = [...warnings];
      const runnable = listRunnableFiles(manifest.files);
      if (entry.hasScripts === false && runnable.length) {
        notes.push(`索引宣告 hasScripts=false，但含可執行檔：${runnable.join(', ')}`);
      }
      if (entry.size !== undefined && entry.size !== size) {
        notes.push(`索引 size=${entry.size} 與實際總大小 ${size} 不符`);
      }
      push(
        notes.length
          ? warn(id, title, notes.join('\n'))
          : ok(id, title, `${files.length} 個檔案，${size} 位元組，雜湊與摘要皆正確`)
      );
    } catch (e) {
      push(fail(id, title, e instanceof ApiError ? e.message : String(e?.message || e)));
    }
  }
  if (json.skills.length > sample.length) {
    push(skip('skills.sampled', '其餘 skill', `僅檢查前 ${sample.length} 個，共 ${json.skills.length} 個`));
  }
  return finish({ indexUrl, stats: { skills: json.skills.length, checked: sample.length, bytes: totalBytes } });
}
