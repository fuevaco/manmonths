// 工項 02：精簡登入畫面、固定頂部列與齒輪選單；rc-package-dev 工項 01：固定查詢列、齒輪選單改版、我的資源包視圖骨架。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, textOf, findByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com/very/long/path/that/must/wrap/instead/of/overflowing', account: 'alice' };
const item = { packageKey: 'demo', name: 'Demo', type: 'skill', latestVisibleVersion: '1.0.0', installationStatus: 'notInstalled', deployments: [] };

function startSignedIn(extra = {}) {
  const calls = [];
  const handler = async (method, input) => {
    calls.push({ method, input });
    if (extra[method]) return extra[method](input);
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.session.signOut') return { signedIn: false, marketUrl: 'https://market.example.com' };
    if (method === 'rc.catalog.list') return { data: [item] };
    if (method === 'rc.client.getVersions') return { orca: { version: '1.2.3', source: 'plugin' } };
    if (method === 'rc.package.getDetails') return { ...item, selectedVersion: '1.0.0', versions: [{ version: '1.0.0', hosts: [] }], readme: '' };
    return {};
  };
  return startPanel(handler).then(panel => ({ panel, calls }));
}
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');
const openMenu = async panel => { await panel.get('btn-settings').fire('click'); };
// 瀏覽器裡 closest 會找到選單或齒輪按鈕；harness 的節點沒有 DOM 結構，以假的 target 模擬。
const clickOutside = (panel) => panel.document.fire('click', { target: { closest: () => null } });
const clickInsideMenu = (panel) => panel.document.fire('click', { target: { closest: () => ({}) } });

test('登入畫面只剩欄位與登入按鈕：沒有網址說明與兩邊獨立的說明，網址首次為空並有通用範例 placeholder', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const login = html.slice(html.indexOf('id="view-login"'), html.indexOf('<!-- 已登入 -->'));
  assert.doesNotMatch(login, /輸入你有權使用的市集網址/);
  assert.doesNotMatch(login, /各自獨立/);
  assert.doesNotMatch(login, /class="hint"/);
  assert.match(login, /id="in-url"[^>]*placeholder="https:\/\/market\.example\.com"/);
  const panel = await startPanel(async method => method === 'rc.session.getState' ? { signedIn: false } : {});
  assert.equal(hidden(panel, 'view-login'), false);
  assert.equal(panel.get('in-url').value, '');
  assert.equal(hidden(panel, 'btn-settings'), true, '登入前沒有齒輪');
  assert.equal(hidden(panel, 'btn-refresh'), true, '登入前沒有重新整理');
});

test('頂部列在 header 內固定，捲動只發生在各畫面的 .content 內', async () => {
  const [html, css] = await Promise.all(['index.html', 'panel.css'].map(f => readFile(new URL(`../panel/${f}`, import.meta.url), 'utf8')));
  const body = html.slice(html.indexOf('<body>'));
  const header = body.slice(body.indexOf('<header'), body.indexOf('</header>'));
  for (const id of ['btn-refresh', 'btn-settings', 'settings-menu']) assert.ok(header.includes(`id="${id}"`), `${id} 在頂部列內`);
  assert.match(css, /html, body \{[^}]*overflow: hidden/);
  assert.match(css, /\.content \{[^}]*overflow-y: auto/);
  assert.doesNotMatch(css, /\.header \{[^}]*position: (sticky|fixed)/, '頂部列在捲動容器之外，不需 sticky');
});

test('登入後頂部列右側有 ↻ 與 ⚙（都是 SVG 圖示按鈕，含名稱）；清單與明細頁都顯示', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  for (const id of ['btn-refresh', 'btn-settings']) {
    const button = html.match(new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?</button>`))[0];
    assert.match(button, /<svg/);
    assert.match(button, /aria-label="/);
  }
  assert.match(html.match(/<button[^>]*id="btn-refresh"[^>]*>/)[0], /aria-label="重新整理"[^>]*title="重新整理"|title="重新整理"[^>]*aria-label="重新整理"/);
  assert.match(html.match(/<button[^>]*id="btn-settings"[^>]*>/)[0], /aria-label="設定"/);
  const { panel } = await startSignedIn();
  assert.equal(hidden(panel, 'view-main'), false);
  assert.equal(hidden(panel, 'btn-refresh'), false);
  assert.equal(hidden(panel, 'btn-settings'), false);
  await findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click');
  assert.equal(hidden(panel, 'view-details'), false);
  assert.equal(hidden(panel, 'btn-refresh'), false);
  assert.equal(hidden(panel, 'btn-settings'), false);
});

test('主畫面不再有帳號資訊區（市集、帳號、用戶端版本與整塊登出）', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const main = html.slice(html.indexOf('id="view-main"'), html.indexOf('id="view-details"'));
  for (const id of ['main-url', 'main-account', 'client-versions', 'btn-logout']) assert.ok(!main.includes(`id="${id}"`), `${id} 已從主畫面移除`);
});

test('齒輪選單依序為身分列、我的資源包、設定區（檢查更新在前、Preview 在下）、登出與最底部的外掛版本；預設收合', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const menuHtml = html.slice(html.indexOf('id="settings-menu"'), html.indexOf('<div id="banner"'));
  const keys = ['id="menu-avatar"', 'id="menu-account"', 'id="menu-url"', 'id="btn-my-packages"', 'data-section="settings"', 'id="check-interval"', 'id="catalog-preview"', 'id="btn-logout"', 'id="menu-version"'];
  const order = keys.map(k => menuHtml.indexOf(k));
  assert.ok(order.every(i => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), '依序：頭像、帳號、網址、我的資源包、設定區、檢查更新、Preview（在下拉下方）、登出、版本');
  assert.equal((menuHtml.match(/<hr/g) || []).length, 3, '身分列、我的資源包、設定區之後各一條分隔線');
  const seps = [...menuHtml.matchAll(/<hr/g)].map(m => m.index);
  assert.ok(menuHtml.indexOf('id="menu-url"') < seps[0] && seps[0] < menuHtml.indexOf('id="btn-my-packages"') && menuHtml.indexOf('id="btn-my-packages"') < seps[1]
    && seps[1] < menuHtml.indexOf('data-section="settings"') && menuHtml.indexOf('id="catalog-preview"') < seps[2] && seps[2] < menuHtml.indexOf('id="btn-logout"'));
  assert.match(menuHtml.match(/<button[^>]*id="btn-my-packages"[\s\S]*?<\/button>/)[0].replace(/<[^>]*>/g, '').trim(), /^📦 我的資源包\s*›$/);
  const settingsAt = menuHtml.indexOf('data-section="settings"');
  const settings = menuHtml.slice(menuHtml.indexOf('>', settingsAt) + 1, seps[2]);
  assert.deepEqual(settings.replace(/<option[^>]*>[^<]*<\/option>/g, '').replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean), ['檢查更新', '顯示', 'Preview', '版本'],
    '設定區有「檢查更新」與其下的「顯示 Preview 版本」');
  const { panel } = await startSignedIn();
  const menu = panel.get('settings-menu');
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(panel.get('btn-settings').getAttribute('aria-expanded'), 'false');
  await openMenu(panel);
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(panel.get('btn-settings').getAttribute('aria-expanded'), 'true');
  assert.equal(textOf(panel.get('menu-account')).trim(), 'alice');
  assert.equal(textOf(panel.get('menu-version')).trim(), '外掛 v1.2.3');
  assert.doesNotMatch(['menu-account', 'menu-url', 'menu-version'].map(id => textOf(panel.get(id))).join(' '), /LC-AI-Pack/);
  await openMenu(panel);
  assert.equal(menu.classList.contains('hidden'), true, '再按一次齒輪收合');
});

test('身分列：圓形縮寫頭像是帳號第一個字元的大寫；網址只顯示主機名稱，title 是完整網址', async () => {
  const { panel } = await startSignedIn();
  assert.equal(textOf(panel.get('menu-avatar')).trim(), 'A');
  assert.equal(textOf(panel.get('menu-url')).trim(), 'market.example.com');
  assert.equal(panel.get('menu-url').getAttribute('title'), signedIn.marketUrl);
  assert.equal(panel.get('menu-account').getAttribute('title'), 'alice');
  assert.doesNotMatch(textOf(panel.get('menu-url')), /https?:|\/very/);
  const other = await startPanel(async method => method === 'rc.session.getState' ? { signedIn: true, marketUrl: 'http://127.0.0.1:5199/x', account: '陳小明' } : method === 'rc.catalog.list' ? { data: [] } : {});
  assert.equal(textOf(other.get('menu-avatar')).trim(), '陳');
  assert.equal(textOf(other.get('menu-url')).trim(), '127.0.0.1');
  assert.equal(other.get('menu-url').getAttribute('title'), 'http://127.0.0.1:5199/x');
  const lower = await startPanel(async method => method === 'rc.session.getState' ? { signedIn: true, marketUrl: 'https://market.example.com', account: 'bob' } : method === 'rc.catalog.list' ? { data: [] } : {});
  assert.equal(textOf(lower.get('menu-avatar')).trim(), 'B');
});

test('身分列與選單樣式：頭像為圓形、帳號粗體、帳號與主機名稱單行截斷、登出為紅框 btn-danger-outline 且整列置中、版本為置中小字', async () => {
  const [css, html] = await Promise.all(['panel.css', 'index.html'].map(f => readFile(new URL(`../panel/${f}`, import.meta.url), 'utf8')));
  assert.match(html.match(/<[^>]*id="menu-url"[^>]*>/)[0], /class="[^"]*\bell\b/);
  assert.match(html.match(/<[^>]*id="menu-account"[^>]*>/)[0], /class="[^"]*\bell\b/);
  assert.match(css, /\.ell \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.menu-avatar \{[^}]*border-radius: 50%/);
  assert.match(css, /\.menu-account \{[^}]*font-weight: (700|bold)/);
  assert.match(css, /\.menu-version \{[^}]*text-align: center/);
  const logout = html.match(/<button[^>]*id="btn-logout"[^>]*>/)[0];
  assert.match(logout, /class="btn btn-danger-outline btn-block"/);
  assert.doesNotMatch(logout, /menu-item/);
  assert.match(css, /\.btn-block \{[^}]*width: 100%/);
  assert.match(css, /\.btn \{[^}]*justify-content: center/);
  assert.ok(html.indexOf('id="btn-logout"') < html.indexOf('id="menu-version"'), '外掛版本在最底部');
});

test('選單樣式不超出面板：寬度上限隨面板縮小', async () => {
  const css = await readFile(new URL('../panel/panel.css', import.meta.url), 'utf8');
  const menuRule = css.match(/#settings-menu \{[^}]*\}/)[0];
  assert.match(menuRule, /max-width: calc\(100% - \d+px\)/, '220 px 寬度下不超出面板');
  assert.match(menuRule, /position: absolute/);
});

test('查詢列固定：#catalog-form 帶 sticky-bar（sticky、top 0、不透明背景、底線、負邊距蓋住容器留白）；更新提示列與「共 N 個」不在固定列內', async () => {
  const [css, html] = await Promise.all(['panel.css', 'index.html'].map(f => readFile(new URL(`../panel/${f}`, import.meta.url), 'utf8')));
  assert.match(html.match(/<form[^>]*id="catalog-form"[^>]*>/)[0], /class="[^"]*\bsticky-bar\b/);
  const rule = css.match(/\.sticky-bar \{[^}]*\}/)[0];
  assert.match(rule, /position: sticky/);
  assert.match(rule, /top: calc\(-1 \* var\(--content-pad\)\)/, 'sticky 的基準在捲動容器內距之內，需用負的內距貼到最頂端');
  assert.match(rule, /background: var\(--bg\)/, '不透明背景');
  assert.match(rule, /border-bottom: 1px solid/);
  assert.match(rule, /box-shadow/);
  assert.match(rule, /margin: calc\(-1 \* var\(--content-pad\)\)/);
  assert.match(css, /\.content \{[^}]*--content-pad: 10px[^}]*padding: var\(--content-pad\)/, '捲動容器仍是 .content');
  assert.match(css, /@media \(max-width: 260px\) \{[\s\S]*\.content \{[^}]*--content-pad: 8px/, '窄側欄的留白同步縮小');
  const form = html.slice(html.indexOf('<form id="catalog-form"'), html.indexOf('</form>'));
  for (const id of ['update-banner', 'catalog-status', 'catalog-list']) assert.ok(!form.includes(`id="${id}"`), `${id} 跟著清單捲動`);
  assert.ok(html.indexOf('</form>') < html.indexOf('id="update-banner"'));
});

test('從齒輪選單進入我的資源包再返回：資源中心的篩選與捲動位置不變', async () => {
  const { panel, calls } = await startSignedIn();
  const list = () => calls.filter(c => c.method === 'rc.catalog.list');
  panel.get('catalog-type').value = 'skill';
  panel.get('catalog-search').value = 'demo';
  panel.get('view-main').scrollTop = 321;
  await openMenu(panel);
  await panel.get('btn-my-packages').fire('click');
  assert.equal(hidden(panel, 'settings-menu'), true, '點下後選單收合');
  assert.equal(hidden(panel, 'view-developer'), false);
  assert.equal(hidden(panel, 'view-main'), true);
  assert.equal(hidden(panel, 'btn-back'), false);
  assert.equal(hidden(panel, 'status-dot'), true);
  assert.equal(textOf(panel.get('header-title')).trim(), '我的資源包');
  assert.equal(hidden(panel, 'btn-refresh'), false);
  assert.equal(hidden(panel, 'btn-settings'), false);
  panel.get('view-main').scrollTop = 0; // 瀏覽器隱藏容器時會歸零
  const before = list().length;
  await panel.get('btn-back').fire('click');
  await settle();
  assert.equal(hidden(panel, 'view-main'), false);
  assert.equal(hidden(panel, 'view-developer'), true);
  assert.equal(panel.get('view-main').scrollTop, 321);
  assert.equal(panel.get('catalog-type').value, 'skill');
  assert.equal(panel.get('catalog-search').value, 'demo');
  assert.equal(textOf(panel.get('header-title')).trim(), '資源中心');
  assert.equal(hidden(panel, 'status-dot'), false);
  assert.equal(hidden(panel, 'btn-back'), true);
  assert.equal(list().length, before + 1, '返回後背景重新整理清單');
  assert.equal(list().at(-1).input.type, 'skill', '沿用原本的篩選查詢');
});

test('在明細頁開啟我的資源包：← 回到資源中心清單並還原進入明細前的捲動位置', async () => {
  const { panel } = await startSignedIn();
  panel.get('view-main').scrollTop = 150;
  await findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click');
  assert.equal(hidden(panel, 'view-details'), false);
  await openMenu(panel);
  await panel.get('btn-my-packages').fire('click');
  assert.equal(hidden(panel, 'view-developer'), false);
  assert.equal(hidden(panel, 'view-details'), true);
  await panel.get('btn-back').fire('click');
  await settle();
  assert.equal(hidden(panel, 'view-main'), false);
  assert.equal(panel.get('view-main').scrollTop, 150);
  assert.equal(panel.get('btn-back').getAttribute('aria-label'), '返回清單');
});

test('我的資源包視圖骨架：固定按鈕列有「打包並上傳…」（主要）與「從資料夾安裝…」，下方是空的 #developer-list；樣式並排、窄側欄上下排', async () => {
  const [css, html] = await Promise.all(['panel.css', 'index.html'].map(f => readFile(new URL(`../panel/${f}`, import.meta.url), 'utf8')));
  const view = html.slice(html.indexOf('id="view-developer"'), html.indexOf('id="view-details"'));
  assert.match(view.match(/<[^>]*id="developer-toolbar"[^>]*>/)[0], /class="[^"]*\bsticky-bar\b/);
  assert.match(view.match(/<button[^>]*id="btn-dev-upload"[^>]*>[^<]*/)[0], /btn btn-primary[^>]*>打包並上傳…/);
  assert.match(view.match(/<button[^>]*id="btn-dev-install"[^>]*>[^<]*/)[0], /class="btn"[^>]*>從資料夾安裝…/);
  assert.ok(view.indexOf('id="btn-dev-upload"') < view.indexOf('id="btn-dev-install"') && view.indexOf('id="btn-dev-install"') < view.indexOf('id="developer-list"'));
  assert.match(css, /\.developer-toolbar \.btn \{[^}]*flex: 1 1 0/);
  assert.match(css, /@media \(max-width: 260px\) \{[\s\S]*\.developer-toolbar \{[^}]*flex-direction: column/);
  assert.match(html, /<script src="js\/developer\.js"><\/script>[\s\S]*<script src="js\/boot\.js"><\/script>/, 'developer.js 在 boot.js 之前載入');
  const { panel } = await startSignedIn();
  assert.equal(panel.get('developer-list').children.length, 0);
  for (const id of ['btn-dev-upload', 'btn-dev-install']) assert.equal(panel.get(id).disabled, false);
});

test('↻ 在我的資源包視圖呼叫 RC.loadDeveloper，不重新讀取登入狀態與目錄，也不離開此視圖', async () => {
  const { panel, calls } = await startSignedIn();
  await openMenu(panel);
  await panel.get('btn-my-packages').fire('click');
  const count = (m) => calls.filter(c => c.method === m).length;
  const [sessions, lists] = [count('rc.session.getState'), count('rc.catalog.list')];
  let loads = 0;
  const original = panel.window.RcPanel.loadDeveloper;
  panel.window.RcPanel.loadDeveloper = () => { loads += 1; };
  await panel.get('btn-refresh').fire('click');
  await settle();
  assert.equal(loads, 1);
  assert.equal(count('rc.session.getState'), sessions);
  assert.equal(count('rc.catalog.list'), lists);
  assert.equal(hidden(panel, 'view-developer'), false);
  assert.equal(typeof original, 'function', '預設有空函式，後續工項再取代');
});

test('在我的資源包視圖登出：回到登入畫面並隱藏返回鍵', async () => {
  const { panel } = await startSignedIn();
  await openMenu(panel);
  await panel.get('btn-my-packages').fire('click');
  await openMenu(panel);
  await panel.get('btn-logout').fire('click');
  await settle();
  assert.equal(hidden(panel, 'view-login'), false);
  assert.equal(hidden(panel, 'view-developer'), true);
  assert.equal(hidden(panel, 'btn-back'), true);
});

test('點選選單外部或按 Esc 關閉齒輪選單；點選單內部不關閉', async () => {
  const { panel } = await startSignedIn();
  const menu = panel.get('settings-menu');
  await openMenu(panel);
  await clickInsideMenu(panel);
  assert.equal(menu.classList.contains('hidden'), false);
  await panel.document.fire('keydown', { key: 'Enter' });
  assert.equal(menu.classList.contains('hidden'), false);
  await clickOutside(panel);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(panel.get('btn-settings').getAttribute('aria-expanded'), 'false');
  await openMenu(panel);
  await panel.document.fire('keydown', { key: 'Escape' });
  assert.equal(menu.classList.contains('hidden'), true);
});

test('從齒輪選單登出：呼叫 rc.session.signOut、回到登入畫面並收合選單，且只登出 Orca 的工作階段', async () => {
  const { panel, calls } = await startSignedIn();
  await openMenu(panel);
  await panel.get('btn-logout').fire('click');
  await settle();
  assert.equal(calls.filter(c => c.method === 'rc.session.signOut').length, 1);
  assert.equal(hidden(panel, 'view-login'), false);
  assert.equal(hidden(panel, 'btn-settings'), true);
  assert.equal(hidden(panel, 'btn-refresh'), true);
  assert.equal(hidden(panel, 'settings-menu'), true);
  assert.equal(panel.get('in-pass').value, '');
  assert.equal(calls.some(c => /lcaipack|lc-ai-pack/i.test(c.method)), false);
});

test('登出失敗時顯示錯誤並保留已登入畫面；選單先收合', async () => {
  const { panel } = await startSignedIn({ 'rc.session.signOut': async () => { throw Object.assign(new Error('登出失敗：網路中斷'), { code: 'network' }); } });
  await openMenu(panel);
  await panel.get('btn-logout').fire('click');
  await settle();
  assert.match(textOf(panel.get('banner')), /登出失敗：網路中斷/);
  assert.equal(hidden(panel, 'view-main'), false);
  assert.equal(hidden(panel, 'settings-menu'), true);
});

test('不再顯示 LC-AI-Pack 版本：即使 worker 仍回傳 lcAiPack 欄位也不呈現；版本讀取失敗時不顯示版本行', async () => {
  let { panel } = await startSignedIn({ 'rc.client.getVersions': async () => ({ orca: { version: '1.2.3' }, lcAiPack: { version: '0.9.7', receiptVersion: '0.9.5' } }) });
  await openMenu(panel);
  assert.doesNotMatch(['menu-account', 'menu-url', 'menu-version'].map(id => textOf(panel.get(id))).join(' '), /LC-AI-Pack|0\.9\.7|0\.9\.5/);
  assert.equal(textOf(panel.get('menu-version')).trim(), '外掛 v1.2.3');
  ({ panel } = await startSignedIn({ 'rc.client.getVersions': async () => { throw new Error('boom'); } }));
  await openMenu(panel);
  assert.equal(hidden(panel, 'menu-version'), true);
  assert.doesNotMatch(textOf(panel.get('menu-version')), /boom/);
});

test('↻ 在清單頁重新讀取登入狀態與目錄；在明細頁重新讀取同一份詳情而不跳回清單', async () => {
  const { panel, calls } = await startSignedIn();
  await panel.get('btn-refresh').fire('click');
  await settle();
  assert.equal(calls.filter(c => c.method === 'rc.session.getState').length, 2);
  assert.equal(calls.filter(c => c.method === 'rc.catalog.list').length, 2);
  await findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click');
  const before = calls.filter(c => c.method === 'rc.package.getDetails').length;
  await panel.get('btn-refresh').fire('click');
  await settle();
  assert.equal(calls.filter(c => c.method === 'rc.package.getDetails').length, before + 1);
  assert.equal(hidden(panel, 'view-details'), false);
  assert.equal(hidden(panel, 'view-main'), true);
});

test('共用資料由較新的 LC-AI-Pack 寫入時，顯示易懂提示而非技術細節', async () => {
  const friendly = '共用資料由較新的 LC-AI-Pack 寫入，請更新 Orca 外掛';
  const tooNew = () => Object.assign(new Error('receiptFormatVersion 99 is newer than supported 1 (receipts.json)'), { code: 'sharedDataTooNew' });
  let { panel } = await startSignedIn({ 'rc.catalog.list': async () => { throw tooNew(); } });
  assert.equal(textOf(panel.get('catalog-status')).trim(), friendly);
  assert.doesNotMatch(textOf(panel.get('catalog-status')), /receiptFormatVersion/);
  ({ panel } = await startSignedIn({ 'rc.catalog.list': async () => ({ data: [item], installedError: { code: 'sharedDataTooNew', message: '技術細節 99' } }) }));
  assert.match(textOf(panel.get('catalog-status')), new RegExp(friendly));
  assert.doesNotMatch(textOf(panel.get('catalog-status')), /技術細節/);
  ({ panel } = await startSignedIn({ 'rc.package.getDetails': async () => { throw tooNew(); } }));
  await findByData(panel.get('catalog-list'), 'package-key', 'demo').fire('click');
  assert.equal(textOf(panel.get('details-status')).trim(), friendly);
  // 其他錯誤維持原訊息
  ({ panel } = await startSignedIn({ 'rc.catalog.list': async () => { throw Object.assign(new Error('損壞的收據'), { code: 'receipt_invalid' }); } }));
  assert.equal(textOf(panel.get('catalog-status')).trim(), '損壞的收據');
});
