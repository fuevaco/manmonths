import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rejectLinks } from './managed-downloads.mjs';
import { RcError, ErrorCode } from './contract.mjs';

const idleMs = 10 * 60 * 1000;
const stopped = () => new RcError(ErrorCode.saveFailed, '完整說明頁準備已停止，請重新開啟');

// URL 只查記憶體白名單，絕不把請求路徑拼成磁碟路徑。
export function createGuideHttpServer({ makeServer = createServer, scheduler = { setTimeout, clearTimeout } } = {}) {
  const token = randomBytes(32).toString('hex');
  const pages = new Map();
  let server = null;
  let starting = null;
  let timer = null;

  function touch() {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = scheduler.setTimeout(stop, idleMs);
    timer?.unref?.();
  }

  async function respond(req, res) {
    touch();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== `127.0.0.1:${server?.address()?.port}`) {
      res.writeHead(403); res.end(); return;
    }
    // 精確比對原始 request-target；不做會折疊 .. 或解碼分隔符的 URL 正規化。
    if (!req.url?.startsWith(`/${token}/`) || req.url.includes('..') || /[%\\\\]/.test(req.url)) {
      res.writeHead(404); res.end(); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    const file = pages.get(req.url);
    if (!file) { res.writeHead(404); res.end(); return; }
    try {
      await rejectLinks(file);
      const bytes = await readFile(file);
      res.setHeader('Content-Length', bytes.length);
      res.writeHead(200);
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404); res.end(); }
  }

  async function register(packageKey, version, file, localRevision) {
    if (!server) {
      const current = makeServer((req, res) => { void respond(req, res); });
      server = current;
      starting = new Promise((resolve, reject) => {
        current.once('error', reject);
        current.listen(0, '127.0.0.1', () => {
          current.removeListener('error', reject);
          resolve();
        });
      });
    }
    const current = server;
    try { await starting; }
    catch {
      if (server === current) stop();
      throw new RcError(ErrorCode.saveFailed, '無法啟動完整說明頁本機伺服器，請重試');
    }
    if (server !== current) { current.close(); throw stopped(); }
    const route = `/${token}/${packageKey}/${version}/${localRevision ? `local-${localRevision}/` : ''}index.html`;
    pages.set(route, file);
    touch();
    return `http://127.0.0.1:${current.address().port}${route}`;
  }

  function stop() {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    const current = server;
    server = null;
    starting = null;
    pages.clear();
    current?.close();
    current?.closeAllConnections();
  }
  return { register, stop };
}
