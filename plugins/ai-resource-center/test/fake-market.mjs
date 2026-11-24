// 可控的假市集（只供自動測試）：以真的本機 HTTP 伺服器模擬 Platform.Api 的登入、續期、登出與市集讀取契約。
// 帳號、權杖與網址都是合成資料。

import http from 'node:http';
import { inflateRawSync } from 'node:zlib';

function multipartFile(bytes, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? '');
  if (!boundary) return null;
  const split = bytes.indexOf('\r\n\r\n');
  if (split < 0) return null;
  const headers = bytes.subarray(0, split).toString();
  if (!/name="file"/.test(headers) || !/Content-Type: application\/zip/i.test(headers)) return null;
  const end = bytes.indexOf(Buffer.from(`\r\n--${boundary[1] ?? boundary[2]}`), split + 4);
  if (end < 0) return null;
  return { filename: /filename="([^"]+)"/.exec(headers)?.[1], bytes: bytes.subarray(split + 4, end) };
}
function zipManifest(bytes) {
  for (let offset = 0; offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50;) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + length + extra;
    if (bytes.subarray(offset + 30, offset + 30 + length).toString() === 'lcpack.json') {
      return JSON.parse(inflateRawSync(bytes.subarray(start, start + size)).toString().replace(/^\uFEFF/, ''));
    }
    offset = start + size;
  }
  throw new Error('missing manifest');
}

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

let nextInstance = 0;

const problem = (res, status, title, extra = {}) =>
  json(res, status, { type: 'https://tools.ietf.org/html/rfc9457', title, status, ...extra });

/**
 * @param {object} [opts]
 * @param {Record<string, {password: string, permissions?: string[]}>} [opts.users]
 * @param {string} [opts.prefix]          路徑前綴（模擬部署在子路徑的市集）
 * @param {() => Date} [opts.now]
 * @param {number} [opts.accessLifetimeMs]
 * @param {number} [opts.refreshLifetimeMs]
 */
export async function startFakeMarket(opts = {}) {
  const users = opts.users ?? { alice: { password: 'pw-alice', permissions: ['market:read'] } };
  const prefix = opts.prefix ?? '';
  const now = opts.now ?? (() => new Date());
  const accessLifetimeMs = opts.accessLifetimeMs ?? 60 * 60 * 1000;
  const refreshLifetimeMs = opts.refreshLifetimeMs ?? 7 * 24 * 60 * 60 * 1000;

  // 開發端點使用獨立、可變的合成資料；不影響既有公開目錄 fixture。
  const myPackages = structuredClone(opts.myPackages ?? []);
  const histories = new Map(Object.entries(opts.histories ?? {}).map(([id, rows]) => [Number(id), structuredClone(rows)]));
  let historyId = 1000;
  function addHistory(version, action, actor, comment = null) {
    const rows = histories.get(version.id) ?? [];
    rows.push({ id: ++historyId, action, actorAdAccount: actor, comment, createdAt: now().toISOString() });
    histories.set(version.id, rows);
  }
  let seq = 0;
  const instance = (nextInstance += 1);
  const access = new Map(); // token → { account, expiresAt }
  const refresh = new Map(); // refreshToken → { account, expiresAt, revoked }
  const requests = [];
  /** 依路徑覆寫回應：(req, body) => {status, body} | undefined */
  const overrides = new Map();

  function issue(account) {
    seq += 1;
    const t = now().getTime();
    const token = `fake-access-${instance}-${seq}`;
    const refreshToken = `fake-refresh-${instance}-${seq}`;
    access.set(token, { account, expiresAt: t + accessLifetimeMs });
    refresh.set(refreshToken, { account, expiresAt: t + refreshLifetimeMs, revoked: false });
    return {
      token,
      expiresAt: new Date(t + accessLifetimeMs).toISOString(),
      refreshToken,
      refreshExpiresAt: new Date(t + refreshLifetimeMs).toISOString()
    };
  }

  function bearer(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const entry = access.get(m[1]);
    if (!entry || entry.expiresAt <= now().getTime()) return null;
    return entry;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const bytes = Buffer.concat(chunks);
      const raw = bytes.toString('utf8');
      const file = multipartFile(bytes, req.headers['content-type']);
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
      requests.push({ method: req.method, path: url.pathname, route, authorization: req.headers.authorization || null, body, ...(file ? { file } : {}) });

      const override = route && overrides.get(`${req.method} ${route}`);
      if (override) {
        const r = await override(req, body);
        if (r) {
          if (r.disconnect) {
            res.writeHead(200, { 'content-length': 1000 });
            res.write('partial');
            return setImmediate(() => res.destroy());
          }
          if (r.raw !== undefined) {
            res.writeHead(r.status, { 'content-type': r.contentType || 'text/html', ...r.headers });
            return res.end(r.raw);
          }
          if (r.hold) return;
          return json(res, r.status, r.body ?? {});
        }
      }

      if (req.method === 'POST' && route === '/api/auth/login') {
        if (!body?.username || !body?.password) {
          return json(res, 422, { type: 'https://httpstatuses.io/422', title: '驗證失敗', status: 422, errors: {} });
        }
        const user = users[body.username];
        if (!user || user.password !== body.password) return problem(res, 401, '帳號或密碼錯誤');
        if (String(body.client).toLowerCase() !== 'gui') {
          const legacy = issue(body.username);
          return json(res, 200, { token: legacy.token, expiresAt: legacy.expiresAt });
        }
        return json(res, 200, issue(body.username));
      }

      if (req.method === 'POST' && route === '/api/auth/refresh') {
        const entry = body?.refreshToken && refresh.get(body.refreshToken);
        if (!entry || entry.revoked || entry.expiresAt <= now().getTime()) {
          return problem(res, 401, '登入已過期，請重新登入', { code: 'auth.session-invalid' });
        }
        entry.revoked = true;
        return json(res, 200, issue(entry.account));
      }

      if (req.method === 'POST' && route === '/api/auth/logout') {
        const who = bearer(req);
        if (!who) return problem(res, 401, 'Unauthorized');
        const entry = body?.refreshToken && refresh.get(body.refreshToken);
        if (entry && entry.account === who.account) entry.revoked = true;
        return json(res, 200, { message: '登出成功' });
      }

      if (req.method === 'GET' && route === '/api/market/categories') {
        const who = bearer(req);
        if (!who) return problem(res, 401, 'Unauthorized');
        const perms = users[who.account]?.permissions ?? [];
        if (!perms.includes('market:read')) {
          return json(res, 403, { type: 'https://httpstatuses.io/403', title: '權限不足', status: 403, detail: '缺少權限 market:read' });
        }
        return json(res, 200, { data: [], meta: { total: 0 } });
      }

      const versionRoute = /^\/api\/market\/versions\/(\d+)\/(submit-review|withdraw-review|enabled|history)$/.exec(route ?? '');
      const packageRoute = /^\/api\/market\/packages\/([^/]+)(?:\/versions\/([^/]+))?$/.exec(route ?? '');
      const publishRoute = /^\/api\/market\/packages\/([^/]+)\/(publish-context|versions)$/.exec(route ?? '');
      if (publishRoute || route === '/api/market/packages' && req.method === 'POST' || packageRoute && req.method === 'GET') {
        const who = bearer(req);
        if (!who) return problem(res, 401, 'Unauthorized');
        const key = decodeURIComponent(publishRoute?.[1] ?? packageRoute?.[1] ?? body?.packageKey ?? '');
        let pack = myPackages.find(p => p.packageKey === key);
        if (req.method === 'GET' && !publishRoute) {
          if (!pack || pack.hidden) return problem(res, 404, '找不到資源包');
          return json(res, 200, pack);
        }
        if (!users[who.account]?.permissions?.includes('market:write')) return problem(res, 403, '權限不足', { detail: '缺少資源包上傳權限' });
        if (pack?.owner && pack.owner !== who.account) return problem(res, 403, '權限不足', { detail: `此識別碼屬於 ${pack.owner}，請改用其他識別碼` });
        if (publishRoute?.[2] === 'publish-context') return pack ? json(res, 200, { packageKey: key }) : problem(res, 404, '找不到資源包');
        if (!publishRoute) {
          if (pack) return problem(res, 409, '識別碼已存在');
          pack = { ...body, tags: body.tags?.split(',') ?? [], versions: [], owner: who.account };
          myPackages.push(pack);
          return json(res, 201, pack);
        }
        if (!pack) return problem(res, 404, '找不到資源包');
        let manifest;
        try { manifest = zipManifest(file.bytes); } catch { return problem(res, 422, 'ZIP 格式錯誤'); }
        if (pack.versions.some(v => v.version === manifest.version)) return problem(res, 409, '版本重複', { detail: `版本 ${manifest.version} 已存在，請改用新的版本號` });
        const id = Math.max(0, ...myPackages.flatMap(p => p.versions.map(v => v.id))) + 1;
        const version = { id, version: manifest.version, channel: 'preview', status: 'active', isEnabled: true, submittedBy: who.account, submittedAt: now().toISOString() };
        pack.versions.push(version);
        return json(res, 201, version);
      }
      if (route === '/api/market/my/packages' || versionRoute || (packageRoute && ['PUT', 'POST'].includes(req.method))) {
        const who = bearer(req);
        if (!who) return problem(res, 401, 'Unauthorized');
        if (!users[who.account]?.permissions?.includes('market:write')) return problem(res, 403, '權限不足', { detail: '缺少資源包上傳權限' });
        if (req.method === 'GET' && route === '/api/market/my/packages') return json(res, 200, { data: myPackages, meta: { total: myPackages.length } });
        if (versionRoute) {
          const [, id, action] = versionRoute;
          const pack = myPackages.find(p => p.versions.some(v => v.id === Number(id)));
          const version = pack?.versions.find(v => v.id === Number(id));
          if (!version) return problem(res, 404, '找不到此版本');
          if (req.method === 'GET' && action === 'history') return json(res, 200, { data: histories.get(version.id) ?? [], meta: {} });
          if (req.method === 'POST' && action === 'submit-review') {
            if (version.channel === 'release' && version.status === 'active' || !['active', 'rejected'].includes(version.status)) {
              return problem(res, 409, '衝突', { detail: '資源版本狀態已變更，請重新整理後再試' });
            }
            version.submitter = who.account;
            addHistory(version, 'submit_review', who.account, body?.comment);
            if (pack.autoApprovalEnabled) {
              version.channel = 'release'; version.status = 'active'; version.isEnabled = true;
              version.reviewedAt = now().toISOString(); version.reviewedBy = '系統'; version.rejectReason = null;
              addHistory(version, 'approve', '系統', '自動審核通過');
            } else {
              version.channel = 'preview'; version.status = 'pending_review'; version.reviewedAt = null; version.reviewedBy = null;
            }
            return json(res, 200, version);
          }
          if (req.method === 'POST' && action === 'withdraw-review') {
            if (version.status !== 'pending_review') return problem(res, 409, '衝突', { detail: '目前版本並非送審中' });
            version.status = 'active'; version.channel = 'preview';
            addHistory(version, 'withdraw_review', who.account, body?.comment);
            return json(res, 200, version);
          }
          if (req.method === 'PUT' && action === 'enabled') {
            version.isEnabled = body.isEnabled;
            addHistory(version, body.isEnabled ? 'enable' : 'disable', who.account);
            return json(res, 200, version);
          }
        }
        if (packageRoute) {
          const key = decodeURIComponent(packageRoute[1]);
          const pack = myPackages.find(p => p.packageKey === key);
          if (!pack) return problem(res, 404, '找不到資源包');
          if (req.method === 'PUT' && !packageRoute[2]) {
            pack.name = body.name;
            for (const key of ['description', 'category']) if (body[key] !== null) pack[key] = body[key];
            if (body.tags !== null) pack.tags = body.tags.split(',');
            return json(res, 200, pack);
          }
          if (req.method === 'POST' && packageRoute[2]) {
            const value = decodeURIComponent(packageRoute[2]);
            const version = pack.versions.find(v => v.version === value);
            if (!version) return problem(res, 404, '找不到此版本');
            if (!body?.comment?.trim() || body.comment.trim().length > 500 || body.confirmationVersion !== value) return problem(res, 422, '刪除資料格式錯誤');
            if (version.channel !== 'preview') return problem(res, 403, '只有市集管理員才能刪除正式發行版本');
            pack.versions = pack.versions.filter(v => v !== version);
            res.writeHead(204); return res.end();
          }
        }
        return problem(res, 405, 'Method Not Allowed');
      }

      if (req.method === 'GET' && route === '/api/market/packages') {
        const who = bearer(req);
        if (!who) return problem(res, 401, 'Unauthorized');
        if (!users[who.account]?.permissions?.includes('market:read')) return problem(res, 403, '權限不足');
        const q = url.searchParams;
        const filtered = (opts.packages ?? []).filter((p) =>
          (!q.get('type') || p.type === q.get('type')) &&
          (!q.get('category') || (p.category || '未分類') === q.get('category')) &&
          (!q.get('search') || [p.name, p.packageKey, p.description].some((v) => String(v).toLowerCase().includes(q.get('search').toLowerCase())))
        ).sort((a, b) => a.packageKey.localeCompare(b.packageKey));
        const page = Number(q.get('page') || 1), pageSize = Math.min(50, Number(q.get('pageSize') || 20));
        return json(res, 200, { data: filtered.slice((page - 1) * pageSize, page * pageSize), meta: { total: filtered.length, page, pageSize } });
      }

      return problem(res, 404, 'Not Found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: origin + prefix,
    origin,
    requests,
    /** 以 `${method} ${route}` 覆寫回應 */
    override(key, fn) { overrides.set(key, fn); },
    clearOverrides() { overrides.clear(); },
    /** 讓 access token 立刻失效（模擬過期），refresh token 不變 */
    expireAccessTokens() { access.clear(); },
    revokeAllSessions() { for (const e of refresh.values()) e.revoked = true; access.clear(); },
    isRefreshRevoked(token) { return Boolean(refresh.get(token)?.revoked); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}
