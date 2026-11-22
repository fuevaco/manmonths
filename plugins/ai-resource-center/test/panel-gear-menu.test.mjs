// 工項 02：精簡登入畫面、固定頂部列與齒輪選單。
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

test('齒輪選單依序為帳號、市集網址、Orca 外掛版本、設定區容器與登出；預設收合', async () => {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const menuHtml = html.slice(html.indexOf('id="settings-menu"'), html.indexOf('<div id="banner"'));
  const order = ['id="menu-account"', 'id="menu-url"', 'id="menu-version"', 'data-section="settings"', 'id="btn-logout"'].map(k => menuHtml.indexOf(k));
  assert.ok(order.every(i => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), '依序：帳號、網址、版本、設定區、登出');
  assert.equal((menuHtml.match(/<hr/g) || []).length, 2, '設定區前後各一條分隔線');
  const settingsAt = menuHtml.indexOf('data-section="settings"');
  const settings = menuHtml.slice(menuHtml.indexOf('>', settingsAt) + 1, menuHtml.lastIndexOf('<hr'));
  assert.deepEqual(settings.replace(/<option[^>]*>[^<]*<\/option>/g, '').replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean), ['顯示', 'Preview', '版本', '檢查更新'],
    '設定區有「顯示 Preview 版本」（工項 04）與「檢查更新」（工項 13）');
  const { panel } = await startSignedIn();
  const menu = panel.get('settings-menu');
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(panel.get('btn-settings').getAttribute('aria-expanded'), 'false');
  await openMenu(panel);
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(panel.get('btn-settings').getAttribute('aria-expanded'), 'true');
  assert.equal(textOf(panel.get('menu-account')).trim(), 'alice');
  assert.equal(textOf(panel.get('menu-url')).trim(), signedIn.marketUrl);
  assert.equal(textOf(panel.get('menu-version')).trim(), 'Orca 外掛 1.2.3');
  assert.doesNotMatch(['menu-account', 'menu-url', 'menu-version'].map(id => textOf(panel.get(id))).join(' '), /LC-AI-Pack/);
  await openMenu(panel);
  assert.equal(menu.classList.contains('hidden'), true, '再按一次齒輪收合');
});

test('市集網址在選單內可換行，不撐出面板', async () => {
  const css = await readFile(new URL('../panel/panel.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  assert.match(html.match(/<[^>]*id="menu-url"[^>]*>/)[0], /class="[^"]*wrap/);
  const menuRule = css.match(/#settings-menu \{[^}]*\}/)[0];
  assert.match(menuRule, /max-width: calc\(100% - \d+px\)/, '220 px 寬度下不超出面板');
  assert.match(menuRule, /position: absolute/);
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
  assert.equal(textOf(panel.get('menu-version')).trim(), 'Orca 外掛 1.2.3');
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
