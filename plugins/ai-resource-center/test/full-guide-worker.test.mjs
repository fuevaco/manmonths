import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, utimes, stat, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { request, createServer } from 'node:http';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { zip, manifest } from './zip-fixture.mjs';
import { send } from '../worker/http.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t, extraDeps = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-guide-空白 #'));
  const dataDirectory = path.join(dir, 'plugin-data');
  const market = await startFakeMarket();
  let clock = Date.UTC(2026, 10, 21);
  const deps = { userHome: dir, lcaipackHome: path.join(dir, 'shared'), dataDirectory, now: () => clock, env: {}, ...extraDeps };
  const worker = startWorker({ deps });
  const versions = [];
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', name: 'Demo', recommendedVersion: versions[0]?.version, versions } }));
  function add({ version = '1.0.0', hasFullGuide = true, entries = {}, channel = 'release', checksum } = {}) {
    const bytes = zip({ 'lcpack.json': JSON.stringify({ ...manifest, version }), 'README.md': '# Demo', 'index.html': '<h1>完整說明</h1>', ...entries });
    versions.push({ version, hasFullGuide, channel, isEnabled: true, sha256: checksum ?? sha(bytes) });
    market.override(`GET /api/market/packages/demo/versions/${version}/download`, () => ({ status: 200, raw: bytes, headers: { 'X-Checksum-Sha256': sha(bytes) } }));
    return bytes;
  }
  t.after(async () => { worker.dispose(); await market.close(); await rm(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { dir, dataDirectory, market, worker, versions, add, deps, advance(ms) { clock += ms; } };
}

test('完整說明頁只輸出根目錄 index.html、回傳本機 HTTP URL，重開仍沿用快取並更新時間', async t => {
  const e = await setup(t);
  const bytes = e.add({ entries: { 'assets/ignored.txt': 'x' } });
  const result = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal(result.path, path.join(e.dataDirectory, 'full-guides', 'demo', '1.0.0', sha(bytes).slice(0, 16), 'index.html'));
  assert.equal(result.fileUrl, undefined);
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32,}\/demo\/1\.0\.0\/index\.html$/);
  await e.worker.call('rc.install.run', { packageKey: 'demo', action: 'install' });
  assert.equal(await readFile(result.path, 'utf8'), '<h1>完整說明</h1>');
  assert.deepEqual((await readdir(path.dirname(result.path))).sort(), ['.complete.json', 'index.html']);
  e.advance(10000);
  await Promise.all([e.worker.call('rc.guide.prepare', { packageKey: 'demo' }), e.worker.call('rc.guide.prepare', { packageKey: 'demo' })]);
  assert.equal((await stat(result.path)).mtimeMs, e.deps.now());
  e.worker.dispose();
  const restarted = startWorker({ state: e.worker.state, deps: e.deps });
  t.after(() => restarted.dispose());
  const again = await restarted.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal(again.path, result.path);
  assert.notEqual(new URL(again.url).pathname.split('/')[1], new URL(result.url).pathname.split('/')[1]);
  assert.equal(e.market.requests.filter(r => r.path.endsWith('/download')).length, 1);
  // 說明頁遭改動後，從同一份受管 ZIP 重建，不再下載。
  await writeFile(result.path, 'changed');
  await restarted.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal(await readFile(result.path, 'utf8'), '<h1>完整說明</h1>');
  assert.equal(e.market.requests.filter(r => r.path.endsWith('/download')).length, 1);
});

function http(url, { method = 'GET', rawPath, host } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path: rawPath ?? target.pathname,
      method, headers: host ? { Host: host } : {}, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

test('HTTP 說明頁拒絕錯誤權杖、未登記檔、穿越、錯誤 Host 與 POST', async t => {
  const e = await setup(t); e.add();
  const { url } = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  const route = new URL(url).pathname;
  const prefix = route.slice(0, route.lastIndexOf('/'));
  // 用原始 request-target，避免 URL/fetch 先正規化掉 .. 而漏測。
  for (const rawPath of [route.replace(/^\/[^/]+/, '/wrong'), `${prefix}/style.css`, `${prefix}/`,
    route.replace('/demo/', '/unprepared/'), `${prefix}/../index.html`, `${prefix}/%2e%2e/index.html`,
    `${prefix}/%2E%2E%2Findex.html`, `${prefix}/%5cindex.html`, `${prefix}\\index.html`,
    `/${route}`, `http://127.0.0.1:${new URL(url).port}${route}`, route.replace('/demo/', '/demo%2f/'),
    `${route}%00`, `${prefix}/%252e%252e/index.html`]) {
    assert.equal((await http(url, { rawPath })).status, 404, rawPath);
  }
  for (const host of ['localhost:' + new URL(url).port, 'evil.example.com', '127.0.0.1', '127.0.0.1:1']) {
    assert.equal((await http(url, { host })).status, 403, host);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await http(url, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'GET, HEAD');
  }
});

function guideTimers() {
  const tasks = new Map();
  let id = 0;
  return { tasks, setTimeout(fn, ms) { tasks.set(++id, { fn, ms }); return id; }, clearTimeout(key) { tasks.delete(key); },
    async expire() { const [key, task] = [...tasks][0]; tasks.delete(key); await task.fn(); } };
}

test('HTTP 說明頁閒置 10 分鐘關閉，請求與 prepare 延長時間，再次 prepare 重啟並維持權杖', async t => {
  const timers = guideTimers();
  const e = await setup(t, { guideScheduler: timers }); e.add();
  assert.equal(timers.tasks.size, 0);
  const first = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal(timers.tasks.size, 1);
  assert.equal([...timers.tasks.values()][0].ms, 10 * 60000);
  const old = [...timers.tasks.keys()][0];
  await http(first.url);
  assert.ok(!timers.tasks.has(old));
  const afterRequest = [...timers.tasks.keys()][0];
  await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.ok(!timers.tasks.has(afterRequest));
  assert.equal(timers.tasks.size, 1);
  await timers.expire();
  await assert.rejects(http(first.url));
  const second = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal(new URL(first.url).pathname, new URL(second.url).pathname);
  assert.equal((await http(second.url)).status, 200);
});

test('登出與 worker 停止立即關閉說明頁，重新登入須重新 prepare 才列入白名單', async t => {
  const timers = guideTimers();
  const e = await setup(t, { guideScheduler: timers }); e.add();
  const first = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  await e.worker.call('rc.session.signOut');
  assert.equal(timers.tasks.size, 0);
  await assert.rejects(http(first.url));
  await e.worker.call('rc.session.signIn', { marketUrl: e.market.url, username: 'alice', password: 'pw-alice' });
  e.add({ version: '2.0.0' });
  const second = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal((await http(second.url, { rawPath: new URL(first.url).pathname })).status, 404);
  e.worker.dispose();
  assert.equal(timers.tasks.size, 0);
  await assert.rejects(http(second.url));
});

for (const action of ['signOut', 'dispose']) {
  test(`${action} 發生在下載途中，不會由未完成 prepare 重新啟動 HTTP`, async t => {
    let reached;
    const downloading = new Promise(resolve => { reached = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const servers = [];
    const e = await setup(t, {
      transport: async options => {
        const response = await send(options);
        if (options.url.endsWith('/download')) { reached(); await gate; }
        return response;
      },
      guideCreateServer: handler => { const s = createServer(handler); servers.push(s); return s; }
    });
    e.add();
    const pending = e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
    const rejected = assert.rejects(pending, { code: 'save_failed' });
    await downloading;
    if (action === 'dispose') e.worker.dispose();
    else await e.worker.call('rc.session.signOut');
    release();
    await rejected;
    assert.equal(servers.length, 0);
  });
}

test('HTTP 啟動失敗可重試，停止發生在 listen 完成時不留下 listener', async t => {
  let attempts = 0;
  let halt = false;
  const servers = [];
  const e = await setup(t, { guideCreateServer: handler => {
    const s = createServer(handler); servers.push(s);
    if (++attempts === 1) s.listen = () => { queueMicrotask(() => s.emit('error', new Error('synthetic bind failure'))); return s; };
    s.prependListener('listening', () => { if (halt) e.worker.dispose(); });
    return s;
  } });
  e.add();
  await assert.rejects(e.worker.call('rc.guide.prepare', { packageKey: 'demo' }), { code: 'save_failed' });
  const result = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal((await http(result.url)).status, 200);
  await e.worker.call('rc.session.signOut');
  await e.worker.call('rc.session.signIn', { marketUrl: e.market.url, username: 'alice', password: 'pw-alice' });
  halt = true;
  await assert.rejects(e.worker.call('rc.guide.prepare', { packageKey: 'demo' }), { code: 'save_failed' });
  assert.ok(servers.every(s => s.address() === null));
});

test('完整說明頁 lazy 綁定 IPv4 loopback，GET/HEAD 提供 HTML 與安全標頭', async t => {
  const servers = [];
  const e = await setup(t, { guideCreateServer: handler => { const s = createServer(handler); servers.push(s); return s; } });
  e.add();
  assert.equal(servers.length, 0);
  const result = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal(servers.length, 1);
  assert.deepEqual(servers[0].address(), { address: '127.0.0.1', family: 'IPv4', port: Number(new URL(result.url).port) });
  const response = await http(result.url);
  assert.equal(response.status, 200);
  assert.equal(response.body, '<h1>完整說明</h1>');
  for (const [name, value] of Object.entries({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })) assert.equal(response.headers[name], value);
  const head = await http(result.url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], response.headers['content-length']);
  assert.equal((await e.worker.call('rc.guide.prepare', { packageKey: 'demo' })).url, result.url);
  assert.equal(servers.length, 1);
  assert.ok(!e.worker.state.logs.join('\n').includes(new URL(result.url).pathname.split('/')[1]));
});

test('推薦版本依 Preview 偏好可見性選取，忽略面板自行指定版本', async t => {
  const e = await setup(t);
  e.add({ version: '2.0.0', channel: 'preview' });
  e.add();
  assert.match((await e.worker.call('rc.guide.prepare', { packageKey: 'demo' })).path, /1\.0\.0/);
  await e.worker.call('rc.preferences.set', { showPreview: true });
  assert.match((await e.worker.call('rc.guide.prepare', { packageKey: 'demo' })).path, /2\.0\.0/);
  for (const input of [{ packageKey: '../demo' }, { packageKey: 'demo', version: '1.0.0' }, { packageKey: 'demo', previewMode: true }]) {
    await assert.rejects(e.worker.call('rc.guide.prepare', input), { code: 'invalid_params' });
  }
});

for (const [label, config, code, message] of [
  ['沒有說明頁', { hasFullGuide: false }, 'guide_unavailable', /未提供完整說明頁/],
  ['SHA 驗證失敗', { checksum: '0'.repeat(64) }, 'checksum_mismatch', /SHA-256/],
  ['缺少根目錄檔', { entries: { 'index.html': undefined, 'nested/index.html': 'wrong' } }, 'guide_index_missing', /缺少根目錄 index.html/],
  ['超過 20 MB', { entries: { 'index.html': 'x'.repeat(20 * 1024 * 1024 + 1) } }, 'guide_too_large', /20 MB/],
  ['路徑穿越', { entries: { '../index.html': 'unsafe' } }, 'unsafe_path', /不安全/]
]) {
  test(`完整說明頁：${label} 回報明確錯誤且不開啟瀏覽器`, async t => {
    const e = await setup(t);
    if (label === '缺少根目錄檔') {
      const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo', 'nested/index.html': 'wrong' });
      e.add(); e.versions[0].sha256 = sha(bytes);
      e.market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes }));
    } else e.add(config);
    await assert.rejects(e.worker.call('rc.guide.prepare', { packageKey: 'demo' }), e => e.code === code && message.test(e.message));
    assert.equal(e.worker.state.hostCalls.filter(c => c.method !== 'statusBar.update').length, 0);
    await assert.rejects(readFile(path.join(e.dir, 'index.html')), { code: 'ENOENT' });
  });
}

test('worker 啟動清掉超過 30 天未使用的說明頁，保留最近存取的檔案與 ZIP', async t => {
  const e = await setup(t); e.add();
  const result = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  const stale = new Date(e.deps.now() - 31 * 86400000);
  await utimes(result.path, stale, stale);
  const staleExtra = path.join(path.dirname(result.path), 'stale-only.txt');
  await writeFile(staleExtra, 'must be removed with expired directory');
  const recent = path.join(e.dataDirectory, 'full-guides', 'other', '1.0.0', 'b'.repeat(16), 'index.html');
  await mkdir(path.dirname(recent), { recursive: true }); await writeFile(recent, 'keep');
  await utimes(recent, new Date(e.deps.now()), stale);
  e.worker.dispose();
  const restarted = startWorker({ state: e.worker.state, deps: e.deps });
  t.after(() => restarted.dispose());
  // prepare 與啟動清理共用序列，回傳前清理必定完成。
  await restarted.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal((await stat(result.path)).mtimeMs, e.deps.now());
  await assert.rejects(readFile(staleExtra), { code: 'ENOENT' });
  assert.equal(await readFile(recent, 'utf8'), 'keep');
  assert.equal(e.market.requests.filter(r => r.path.endsWith('/download')).length, 1);
});

test('完整說明頁拒絕目錄符號連結，不寫入連結指向位置', async t => {
  const e = await setup(t); e.add();
  const outside = path.join(e.dir, 'outside'); await mkdir(outside);
  await mkdir(e.dataDirectory, { recursive: true });
  await symlink(outside, path.join(e.dataDirectory, 'full-guides'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(e.worker.call('rc.guide.prepare', { packageKey: 'demo' }), { code: 'unsafe_path' });
  assert.deepEqual(await readdir(outside), []);
});

test('已驗證 ZIP 快取遭竄改時重新下載驗證，不使用損壞內容', async t => {
  const e = await setup(t); const bytes = e.add();
  const result = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  const zipPath = path.join(e.dataDirectory, 'cache', 'demo', '1.0.0', `${sha(bytes)}.zip`);
  await writeFile(zipPath, 'corrupt'); await rm(path.dirname(result.path), { recursive: true });
  await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal(await readFile(result.path, 'utf8'), '<h1>完整說明</h1>');
  assert.equal(e.market.requests.filter(r => r.path.endsWith('/download')).length, 2);
});

test('worker 啟動清理 30 天未使用 ZIP，保留最近存取、邊界與非 ZIP 檔案', async t => {
  const e = await setup(t); const bytes = e.add();
  await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  const dir = path.join(e.dataDirectory, 'cache', 'demo', '1.0.0');
  const old = new Date(e.deps.now() - 31 * 86400000);
  const files = { stale: 'a'.repeat(64) + '.zip', recent: 'b'.repeat(64) + '.zip', boundary: 'c'.repeat(64) + '.zip', other: 'notes.txt' };
  for (const [kind, name] of Object.entries(files)) {
    const file = path.join(dir, name); await writeFile(file, 'synthetic');
    await utimes(file, kind === 'recent' ? new Date(e.deps.now()) : kind === 'boundary' ? new Date(e.deps.now() - 30 * 86400000) : old, old);
  }
  e.worker.dispose();
  const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
  await restarted.call('rc.guide.prepare', { packageKey: 'demo' });
  await assert.rejects(stat(path.join(dir, files.stale)), { code: 'ENOENT' });
  for (const name of [files.recent, files.boundary, files.other, `${sha(bytes)}.zip`]) assert.ok((await stat(path.join(dir, name))).isFile());
});

test('每次使用 ZIP 都更新時間，重開 worker 不刪除剛使用的舊 ZIP', async t => {
  const e = await setup(t); const bytes = e.add();
  const guide = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  const file = path.join(e.dataDirectory, 'cache', 'demo', '1.0.0', `${sha(bytes)}.zip`);
  const old = new Date(e.deps.now() - 31 * 86400000);
  await utimes(file, old, old);
  e.advance(10000);
  await rm(path.dirname(guide.path), { recursive: true });
  await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal((await stat(file)).mtimeMs, e.deps.now());
  e.worker.dispose();
  const restarted = startWorker({ state: e.worker.state, deps: e.deps }); t.after(() => restarted.dispose());
  await rm(path.dirname(guide.path), { recursive: true });
  await restarted.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal(e.market.requests.filter(r => r.path.endsWith('/download')).length, 1);
});

test('完整說明頁可接受正好 20 MB 的根目錄 index.html', async t => {
  const e = await setup(t); e.add({ entries: { 'index.html': 'x'.repeat(20 * 1024 * 1024) } });
  const result = await e.worker.call('rc.guide.prepare', { packageKey: 'demo' });
  assert.equal((await stat(result.path)).size, 20 * 1024 * 1024);
});
