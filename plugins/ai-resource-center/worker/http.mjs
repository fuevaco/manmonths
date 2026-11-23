// 最小的 HTTP 傳輸層：送出 JSON 請求、收完整回應文字，並把失敗分成「確定未送出」與「可能已送達」。
// 不記 log、例外訊息不含請求標頭或內容（避免帶出 token）。

import http from 'node:http';
import https from 'node:https';

export class HttpError extends Error {
  /**
   * @param {'not_sent'|'timeout'|'network'|'cancelled'|'too_large'} kind
   * @param {string} message  只含來源與錯誤代碼，不含任何請求內容
   * @param {{notSent?: boolean, tls?: boolean, code?: string}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.notSent = Boolean(extra.notSent);
    this.tls = Boolean(extra.tls);
    this.errno = extra.code || '';
  }
}

// 連線建立前就失敗（DNS、拒絕連線、無路由、TLS 握手）：請求確定沒有送達伺服器。
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);
const isTlsError = (code) =>
  /^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_OSSL)/.test(code || '');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * @param {object} req
 * @param {string} req.method
 * @param {string|URL} req.url
 * @param {Record<string,string>} [req.headers]
 * @param {unknown} [req.json]      JSON 本文
 * @param {Buffer} [req.body]       二進位本文；Content-Type 可由 headers 指定
 * @param {number} [req.timeoutMs]
 * @param {AbortSignal} [req.signal]
 * @returns {Promise<{status: number, headers: object, text: string}>}
 */
export function send({ method, url, headers = {}, json, body: rawBody, timeoutMs = 10000, signal, maxBytes = DEFAULT_MAX_BYTES, responseType }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const body = rawBody ?? (json === undefined ? null : Buffer.from(JSON.stringify(json), 'utf8'));
    let settled = false;
    const abort = () => fail(new HttpError('cancelled', '已取消'));
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(err);
    };
    const req = lib.request(
      u,
      {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'orca-ai-resource-center/1',
          ...(body ? { 'Content-Type': rawBody ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Content-Length': body.length } : {}),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) return fail(new HttpError('too_large', `回應超過 ${maxBytes} 位元組：${u.origin}`));
          chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 0, headers: res.headers, bytes,
            text: responseType === 'bytes' && res.statusCode >= 200 && res.statusCode < 300 ? '' : bytes.toString('utf8') });
        });
        res.on('error', (e) => fail(new HttpError('network', `連線中斷：${u.origin}（${e.code || 'error'}）`, { code: e.code })));
      }
    );
    req.setTimeout(timeoutMs, () => fail(new HttpError('timeout', `連線逾時：${u.origin}`)));
    req.on('error', (e) => {
      const code = e.code || '';
      if (isTlsError(code)) {
        return fail(new HttpError('not_sent', `無法建立安全連線：${u.origin}（${code}）`, { notSent: true, tls: true, code }));
      }
      if (NOT_SENT_CODES.has(code)) {
        return fail(new HttpError('not_sent', `無法連線：${u.origin}（${code}）`, { notSent: true, code }));
      }
      fail(new HttpError('network', `連線中斷：${u.origin}（${code || 'error'}）`, { code }));
    });
    if (signal) {
      if (signal.aborted) return fail(new HttpError('cancelled', '已取消'));
      signal.addEventListener('abort', abort, { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

/** 解析 JSON；失敗回傳 null。 */
export function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
