// 可控的假市集（只供自動測試）：以真的本機 HTTP 伺服器模擬 Platform.Api 的登入、續期、登出與市集讀取契約。
// 帳號、權杖與網址都是合成資料。

import http from 'node:http';

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
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
      requests.push({ method: req.method, path: url.pathname, route, authorization: req.headers.authorization || null, body });

      const override = route && overrides.get(`${req.method} ${route}`);
      if (override) {
        const r = override(req, body);
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
