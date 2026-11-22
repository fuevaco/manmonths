// 工項 07（面板端）：使用說明以 Markdown 渲染、連結以系統瀏覽器開啟、文件內錨點捲動、⤢ 全版閱讀模式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const listItem = { packageKey: 'demo', name: 'Demo 資源包', type: 'skill', description: '清單描述', hasFullGuide: false, latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [], tools: [] };
const README = [
  '# 標題一', '',
  '簡介 [官網](https://docs.example/guide) 與 [跳到安裝](#安裝)。', '',
  '## 安裝', '',
  '- 項目一', '- 項目二', '',
  '| 欄 | 值 |', '|---|---|', '| a | b |', '',
  '```sh', 'npm i demo', '```', '',
  '<script>alert(1)</script>', '',
  '[壞連結](javascript:alert(1))'
].join('\n');
const detailOf = (extra = {}) => ({ packageKey: 'demo', name: 'Demo 資源包', type: 'skill', description: '明細描述', selectedVersion: '1.2.0', readme: README,
  versions: [{ version: '1.2.0', channel: 'release', hosts: ['codex'] }], installationStatus: 'notInstalled', deployments: [], ...extra });

async function start({ detail = detailOf(), shell = true } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.catalog.list') return { data: [listItem] };
    if (method === 'rc.package.getDetails') return detail;
    return {};
  });
  if (!shell) panel.window.orca.shell = undefined;
  const open = async () => { await findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click'); await settle(); };
  return { panel, calls, open };
}
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');
const tagOf = (node) => String(node.tagName).toLowerCase();
const walk = (node, fn) => { fn(node); node.children.forEach(child => walk(child, fn)); };
const tags = (root) => { const found = []; walk(root, n => found.push(tagOf(n))); return found; };
const linkWith = (root, action, text) => findAllByData(root, 'action', action).find(n => textOf(n).includes(text));

test('index.html 在面板腳本之前載入 markdown.css 與 markdown.js；使用說明容器不再是 <pre>', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="markdown\.css">/);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.equal(scripts[0], 'markdown.js', 'markdown.js 最先載入');
  assert.ok(scripts.length > 1 && scripts.slice(1).every(s => s.startsWith('js/')), `其後才是面板腳本：${scripts}`);
  assert.doesNotMatch(html, /<pre id="details-readme"/);
  assert.match(html.match(/<[^>]*id="details-readme"[^>]*>/)[0], /^<div/);
  const reader = html.match(/<button[^>]*id="btn-reader"[\s\S]*?<\/button>/)[0];
  assert.match(reader, /data-action="reader"/);
  assert.match(reader, /aria-label="放大閱讀"/);
  assert.match(reader, /<svg/);
  const css = await readFile(new URL('../panel/panel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#details-readme[^{]*\{[^}]*pre-wrap/, '使用說明由 Markdown 排版，不再沿用純文字的 pre-wrap');
});

test('使用說明以 Markdown 渲染：標題、清單、表格、程式碼；原始 HTML 與壞連結只留文字', async () => {
  const { panel, open } = await start();
  await open();
  const readme = panel.get('details-readme');
  assert.equal(readme.children.length, 1);
  assert.equal(readme.children[0].getAttribute('class'), 'rc-markdown');
  const found = tags(readme);
  for (const tag of ['h1', 'h2', 'ul', 'li', 'table', 'th', 'td', 'pre', 'code', 'a']) assert.ok(found.includes(tag), `有 <${tag}>`);
  assert.ok(!found.includes('script'), '不建立 script 節點');
  assert.match(textOf(readme), /<script>alert\(1\)<\/script>/, '原始 HTML 成為純文字');
  assert.match(textOf(readme), /壞連結/);
  assert.equal(findAllByData(readme, 'href').filter(n => /javascript:/i.test(n.getAttribute('data-href'))).length, 0, '危險連結沒有可點選的目標');
  assert.match(textOf(readme), /npm i demo/);
});

test('點選外部連結以系統瀏覽器開啟並攔截預設動作；Enter 同樣開啟，其他鍵不會', async () => {
  const { panel, open } = await start();
  await open();
  const link = linkWith(panel.get('details-readme'), 'external-link', '官網');
  assert.equal(link.getAttribute('data-href'), 'https://docs.example/guide');
  let prevented = 0;
  await panel.get('details-readme').fire('click', { target: link, preventDefault: () => { prevented += 1; } });
  await settle();
  assert.deepEqual(panel.externalUrls, ['https://docs.example/guide']);
  assert.equal(prevented, 1);
  await panel.get('details-readme').fire('keydown', { target: link, key: 'a' });
  await panel.get('details-readme').fire('keydown', { target: link, key: 'Tab' });
  assert.equal(panel.externalUrls.length, 1);
  await panel.get('details-readme').fire('keydown', { target: link, key: 'Enter', preventDefault: () => { prevented += 1; } });
  await settle();
  assert.equal(panel.externalUrls.length, 2);
  assert.equal(prevented, 2);
  assert.equal(hidden(panel, 'view-details'), false, '面板不跳轉');
});

test('點在連結內的子元素也能開啟（沿著父節點找到連結）；點在連結以外不開啟', async () => {
  const { panel, open } = await start();
  await open();
  const link = linkWith(panel.get('details-readme'), 'external-link', '官網');
  await panel.get('details-readme').fire('click', { target: { parentNode: link, getAttribute: () => null } });
  await settle();
  assert.equal(panel.externalUrls.length, 1);
  await panel.get('details-readme').fire('click', { target: { parentNode: null, getAttribute: () => null } });
  await panel.get('details-readme').fire('click', { target: panel.get('details-readme') });
  await settle();
  assert.equal(panel.externalUrls.length, 1);
});

test('沒有 shell.openExternal 時退回 window.open（noopener）；開啟失敗時顯示短提示而不是丟出例外', async () => {
  const { panel, open } = await start({ shell: false });
  const opened = [];
  panel.window.open = (...args) => { opened.push(args); };
  await open();
  const link = linkWith(panel.get('details-readme'), 'external-link', '官網');
  await panel.get('details-readme').fire('click', { target: link });
  await settle();
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'https://docs.example/guide');
  assert.match(String(opened[0][2]), /noopener/);

  const failing = await start();
  failing.panel.window.orca.shell.openExternal = async () => { throw new Error('系統瀏覽器無法啟動'); };
  await failing.open();
  await failing.panel.get('details-readme').fire('click', { target: linkWith(failing.panel.get('details-readme'), 'external-link', '官網') });
  await settle();
  assert.match(textOf(failing.panel.get('toast')), /系統瀏覽器無法啟動/);
  assert.match(failing.panel.get('toast').className, /error/);
});

test('Markdown 外部連結的 openExternal 回傳處理：opened 與 cancelled 不提示；consent-unavailable 提示視窗不在前景', async () => {
  const cases = [[{ opened: true }, null], [undefined, null], [{ opened: false, reason: 'cancelled' }, null],
    [{ opened: false, reason: 'consent-unavailable' }, /Orca 視窗不在前景，無法確認開啟，請再試一次/]];
  for (const [reply, expected] of cases) {
    const { panel, open } = await start();
    panel.window.orca.shell.openExternal = async (url) => { panel.externalUrls.push(url); return reply; };
    await open();
    await panel.get('details-readme').fire('click', { target: linkWith(panel.get('details-readme'), 'external-link', '官網') });
    await settle();
    assert.deepEqual(panel.externalUrls, ['https://docs.example/guide']);
    const toast = textOf(panel.get('toast')).trim();
    if (expected) { assert.match(toast, expected); assert.match(panel.get('toast').className, /error/); } else assert.equal(toast, '');
  }
});

test('點選文件內錨點：捲動到對應標題，不開啟瀏覽器', async () => {
  const { panel, open } = await start();
  await open();
  const readme = panel.get('details-readme');
  const link = linkWith(readme, 'anchor-link', '跳到安裝');
  const slug = link.getAttribute('data-href').slice(1);
  const heading = findAllByData(readme, 'anchor', slug)[0];
  assert.ok(heading, '有對應的標題');
  assert.equal(heading.scrolledIntoView, 0);
  let prevented = 0;
  await readme.fire('click', { target: link, preventDefault: () => { prevented += 1; } });
  assert.equal(heading.scrolledIntoView, 1);
  assert.equal(prevented, 1);
  assert.deepEqual(panel.externalUrls, []);
  await readme.fire('keydown', { target: link, key: 'Enter' });
  assert.equal(heading.scrolledIntoView, 2);
  // 找不到的錨點不會丟出例外
  await readme.fire('click', { target: { getAttribute: (k) => k === 'data-action' ? 'anchor-link' : k === 'data-href' ? '#不存在' : null } });
});

test('⤢ 在有使用說明時顯示、沒有時隱藏；點選進入全版閱讀，只剩使用說明區（用 reader 類別）', async () => {
  const empty = await start({ detail: detailOf({ readme: '' }) });
  await empty.open();
  assert.equal(hidden(empty.panel, 'btn-reader'), true, '沒有使用說明就沒有放大按鈕');

  const { panel, open } = await start();
  await open();
  assert.equal(hidden(panel, 'btn-reader'), false);
  assert.equal(panel.get('btn-reader').getAttribute('aria-label'), '放大閱讀');
  assert.equal(panel.get('view-details').classList.contains('reader'), false);
  await panel.get('btn-reader').fire('click');
  assert.equal(panel.get('view-details').classList.contains('reader'), true);
  assert.equal(panel.get('btn-reader').getAttribute('aria-label'), '結束放大閱讀');
  assert.equal(panel.get('btn-back').getAttribute('aria-label'), '返回明細');
  assert.equal(hidden(panel, 'view-details'), false);
  await panel.get('btn-reader').fire('click');
  assert.equal(panel.get('view-details').classList.contains('reader'), false, '再按一次也能離開');
  assert.equal(panel.get('btn-reader').getAttribute('aria-label'), '放大閱讀');
});

test('閱讀模式下 ← 回到明細頁並還原捲動位置；再按 ← 才回到清單', async () => {
  const { panel, open } = await start();
  await open();
  const view = panel.get('view-details');
  view.scrollTop = 321;
  await panel.get('btn-reader').fire('click');
  assert.equal(view.scrollTop, 0, '閱讀從頭開始');
  view.scrollTop = 900;
  await panel.get('btn-back').fire('click');
  await settle();
  assert.equal(hidden(panel, 'view-details'), false, '仍在明細頁');
  assert.equal(hidden(panel, 'view-main'), true);
  assert.equal(view.classList.contains('reader'), false);
  assert.equal(view.scrollTop, 321, '還原進入閱讀前的捲動位置');
  assert.equal(panel.get('btn-back').getAttribute('aria-label'), '返回清單');
  assert.equal(panel.get('header-title').textContent, 'Demo 資源包');
  await panel.get('btn-back').fire('click');
  await settle();
  assert.equal(hidden(panel, 'view-main'), false);
  assert.equal(hidden(panel, 'view-details'), true);
});

test('Esc 離開閱讀模式；重新開啟明細或登出後不殘留閱讀模式', async () => {
  const { panel, open } = await start();
  await open();
  await panel.get('btn-reader').fire('click');
  await panel.document.fire('keydown', { key: 'Escape' });
  assert.equal(panel.get('view-details').classList.contains('reader'), false);
  assert.equal(hidden(panel, 'view-details'), false);

  await panel.get('btn-reader').fire('click');
  await panel.get('btn-refresh').fire('click');
  await settle();
  assert.equal(panel.get('view-details').classList.contains('reader'), false, '↻ 重新讀取明細後回到一般明細');
  assert.equal(panel.get('btn-back').getAttribute('aria-label'), '返回清單');
});
