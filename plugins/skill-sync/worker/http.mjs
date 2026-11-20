// 受控的 HTTP GET：大小上限、逾時、手動處理轉址，並確保 Token 只送給 API 所在的來源。
// 不使用 fetch：需要「允許內網自簽憑證」選項，也要在下載中途就能中止超大回應。

import http from 'node:http';
import https from 'node:https';

export class ApiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(hostname) {
  return LOOPBACK.has(String(hostname).toLowerCase());
}

function parseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError('bad_url', `網址格式不正確：${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ApiError('bad_url', `只支援 http / https：${raw}`);
  }
  return u;
}

function once(url, { headers, timeoutMs, maxBytes, insecureTls, signal }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers,
        ...(url.protocol === 'https:' && insecureTls ? { rejectUnauthorized: false } : {})
      },
      (res) => {
        const declared = Number(res.headers['content-length']);
        if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          reject(new ApiError('too_large', `回應大小 ${declared} 位元組超過上限 ${maxBytes}`));
          return;
        }
        const chunks = [];
        let received = 0;
        res.on('data', (c) => {
          received += c.length;
          if (maxBytes && received > maxBytes) {
            res.destroy();
            reject(new ApiError('too_large', `回應超過上限 ${maxBytes} 位元組`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', (e) => reject(new ApiError('network', `連線中斷：${e.message}`)));
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new ApiError('timeout', `逾時（${Math.round(timeoutMs / 1000)} 秒）：${url.origin}`));
    });
    req.on('error', (e) => {
      if (e instanceof ApiError) return reject(e);
      const tls = /certificate|self.signed|SSL|TLS/i.test(e.message);
      reject(
        new ApiError(
          tls ? 'tls' : 'network',
          tls ? `憑證不受信任（內網自簽憑證請開啟「允許自簽憑證」）：${e.message}` : `無法連線 ${url.origin}：${e.message}`
        )
      );
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(new ApiError('cancelled', '已取消'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          req.destroy();
          reject(new ApiError('cancelled', '已取消'));
        },
        { once: true }
      );
    }
    req.end();
  });
}

/**
 * @param {string} rawUrl
 * @param {object} opts
 * @param {string} [opts.token]        Bearer Token
 * @param {string} [opts.authOrigin]   只有這個來源的請求才會帶 Token（預設：第一個網址的來源）
 * @param {boolean} [opts.allowHttp]   允許對非本機使用未加密 HTTP（有 Token 時才需要）
 * @param {Record<string,string>} [opts.headers]
 */
export async function httpGet(rawUrl, opts = {}) {
  const {
    token,
    allowHttp = false,
    insecureTls = false,
    timeoutMs = 20000,
    maxBytes = 0,
    maxRedirects = 3,
    signal
  } = opts;
  let url = parseUrl(rawUrl);
  const authOrigin = opts.authOrigin || url.origin;

  for (let hop = 0; ; hop++) {
    const sameOrigin = url.origin === authOrigin;
    const sendAuth = Boolean(token) && sameOrigin;
    if (sendAuth && url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !allowHttp) {
      throw new ApiError('insecure_transport', 'Token 不會透過未加密的 HTTP 傳送。請改用 https，或在設定開啟「允許 HTTP」。');
    }
    const headers = {
      Accept: 'application/json, */*;q=0.5',
      'User-Agent': 'orca-skill-sync/1',
      ...(opts.headers || {}),
      ...(sendAuth ? { Authorization: `Bearer ${token}` } : {})
    };
    const res = await once(url, { headers, timeoutMs, maxBytes, insecureTls, signal });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop >= maxRedirects) throw new ApiError('too_many_redirects', `轉址超過 ${maxRedirects} 次`);
      const next = parseUrl(new URL(res.headers.location, url).toString());
      if (url.protocol === 'https:' && next.protocol === 'http:') {
        throw new ApiError('insecure_transport', '拒絕從 https 轉址到 http');
      }
      url = next;
      continue;
    }
    return { ...res, url: url.toString() };
  }
}
