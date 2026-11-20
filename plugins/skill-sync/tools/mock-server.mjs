#!/usr/bin/env node
// Skills Registry API 標準 v1 的參考實作（模擬伺服器）。
// 用途：開發外掛時的測試對象；也是網店開發者實作時的「標準答案」可以對照。
//
//   node tools/mock-server.mjs <skills 資料夾> [--port 8787] [--token secret] [--prefix /api/v1]
//
// 啟動後：
//   node tools/verify-api.mjs http://127.0.0.1:8787/api/v1/ --token secret
//
// 測試用選項（startServer 參數）：tamper（回傳被竄改的檔案）、acceptAnyToken（不檢查 Token）、
// publicApi（完全不驗證）。

import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildRegistry } from './build-registry.mjs';

function sendJson(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ...extra });
  res.end(body);
}

const errorBody = (code, message) => ({ error: { code, message } });

export async function startServer({
  skillsDir,
  port = 0,
  token = '',
  prefix = '',
  tamper = '',
  tamperMode = 'append',
  acceptAnyToken = false,
  publicApi = false,
  registryName = '範例技能庫'
} = {}) {
  const { index, routes } = await buildRegistry(skillsDir, { registryName });
  const base = prefix.replace(/\/+$/, '');
  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, auth: req.headers.authorization || '' });
    if (!url.pathname.startsWith(`${base}/`)) {
      return sendJson(res, 404, errorBody('not_found', '找不到'));
    }
    if (!publicApi) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!m) {
        return sendJson(res, 401, errorBody('unauthorized', '需要 Authorization: Bearer <token>'), { 'WWW-Authenticate': 'Bearer' });
      }
      if (!acceptAnyToken && m[1] !== token) {
        return sendJson(res, 401, errorBody('invalid_token', 'Token 無效'), { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      }
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname.slice(base.length + 1));
    } catch {
      return sendJson(res, 400, errorBody('bad_request', '路徑編碼不正確'));
    }
    // routes 的 key 是編碼過的路徑；兩種都試
    const hit = routes.get(url.pathname.slice(base.length + 1)) || routes.get(rel) || [...routes].find(([k]) => decodeURIComponent(k) === rel)?.[1];
    if (!hit) return sendJson(res, 404, errorBody('not_found', `找不到 ${rel}`));

    let body = hit.body;
    if (tamper && rel.startsWith(`skills/${tamper}/`) && rel.includes('/files/')) {
      if (tamperMode === 'flip' && body.length) {
        body = Buffer.from(body); // 大小不變、只改一個位元組，只有雜湊能抓到
        body[0] ^= 0x01;
      } else {
        body = Buffer.concat([body, Buffer.from('\n# tampered\n')]);
      }
    }
    const headers = { 'Content-Type': hit.type, 'Content-Length': body.length };
    if (rel === 'index.json') {
      const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
      headers.ETag = etag;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
    }
    res.writeHead(200, headers);
    res.end(body);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}${base}/`,
    port: addr.port,
    index,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const dir = args[0];
  if (!dir || dir.startsWith('--')) {
    console.log('用法：node tools/mock-server.mjs <skills 資料夾> [--port 8787] [--token secret] [--prefix /api/v1] [--public]');
    process.exit(2);
  }
  const srv = await startServer({
    skillsDir: path.resolve(dir),
    port: Number(opt('--port', 8787)),
    token: opt('--token', 'secret'),
    prefix: opt('--prefix', '/api/v1'),
    publicApi: args.includes('--public')
  });
  console.log(`模擬技能庫已啟動：${srv.url}`);
  console.log(args.includes('--public') ? '（公開，不需 Token）' : `Token：${opt('--token', 'secret')}`);
  console.log(`${srv.index.skills.length} 個 skill：${srv.index.skills.map((s) => `${s.name}@${s.version}`).join(', ')}`);
}
