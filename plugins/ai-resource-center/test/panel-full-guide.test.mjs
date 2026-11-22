// 工項 08（面板端）：🌐 完整說明頁按鈕的顯示條件、rc.guide.prepare → openExternal、進行中與失敗處理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const base = { packageKey: 'demo', name: 'Demo 資源包', type: 'skill', description: '清單描述', hasFullGuide: true, latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [], tools: [] };
const noGuide = { ...base, packageKey: 'plain', name: '沒有說明頁', hasFullGuide: false };
const detailOf = (key) => ({ packageKey: key, name: key === 'demo' ? 'Demo 資源包' : '沒有說明頁', type: 'skill', description: '明細描述', selectedVersion: '1.2.0', readme: '# 說明',
  versions: [{ version: '1.2.0', channel: 'release', hosts: ['codex'] }], installationStatus: 'notInstalled', deployments: [] });
const GUIDE_URL = 'http://127.0.0.1:51234/index.html';

async function start({ prepare = async () => ({ url: GUIDE_URL }), openExternal } = {}) {
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)) });
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.catalog.list') return { data: [base, noGuide] };
    if (method === 'rc.package.getDetails') return detailOf(input.packageKey);
    if (method === 'rc.guide.prepare') return prepare(input);
    return {};
  }, openExternal ? { openExternal } : {});
  const card = (key = 'demo') => findByData(panel.get('catalog-list'), 'package-key', key);
  const cardGuide = (key = 'demo') => findByData(card(key), 'action', 'full-guide');
  const open = async (key = 'demo') => { await card(key).fire('click'); await settle(); };
  const detailGuide = () => findByData(panel.get('details-guide-slot'), 'action', 'full-guide');
  const prepares = () => calls.filter(c => c.method === 'rc.guide.prepare');
  return { panel, calls, card, cardGuide, open, detailGuide, prepares };
}
const classes = (node) => node.className.split(/\s+/);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('🌐 只在 hasFullGuide 為 true 時顯示（卡片），且不再隱藏', async () => {
  const { cardGuide } = await start();
  const guide = cardGuide('demo');
  assert.ok(guide);
  assert.equal(guide.getAttribute('aria-label'), '開啟完整說明頁');
  assert.equal(guide.getAttribute('title'), '開啟完整說明頁');
  assert.ok(!classes(guide).includes('hidden'));
  assert.equal(guide.disabled, false);
  assert.equal(cardGuide('plain'), null);
});

test('明細頁使用說明標題列：有完整說明頁時才有 🌐，與 ⤢ 同列（🌐 在 ⤢ 左邊）', async () => {
  const { open, detailGuide, panel } = await start();
  await open('demo');
  assert.ok(detailGuide());
  assert.equal(detailGuide().getAttribute('aria-label'), '開啟完整說明頁');
  assert.equal(panel.get('btn-reader').getAttribute('aria-label'), '放大閱讀');
  await panel.get('btn-back').fire('click');
  await settle();
  await open('plain');
  assert.equal(detailGuide(), null);
});

test('點選卡片上的 🌐：呼叫 rc.guide.prepare 後以系統瀏覽器開啟 url，不進入明細', async () => {
  const { panel, cardGuide, prepares } = await start();
  await cardGuide().dispatch('click'); // 冒泡到卡片也不會進入明細
  await settle();
  assert.deepEqual(prepares().map(c => c.input), [{ packageKey: 'demo' }]);
  assert.deepEqual(panel.externalUrls, [GUIDE_URL]);
  assert.equal(panel.get('view-details').classList.contains('hidden'), true, '點 🌐 不會進入明細');
  assert.equal(panel.get('view-main').classList.contains('hidden'), false);
});

test('進行中：按鈕停用並顯示「準備中…」，重複點選不會再呼叫；完成後恢復', async () => {
  const pending = deferred();
  const { panel, cardGuide, prepares } = await start({ prepare: () => pending.promise });
  const click = () => cardGuide().fire('click');
  const first = click();
  await settle();
  let guide = cardGuide();
  assert.equal(guide.disabled, true);
  assert.equal(guide.getAttribute('aria-label'), '準備中…');
  assert.equal(guide.getAttribute('title'), '準備中…');
  assert.equal(guide.getAttribute('aria-busy'), 'true');
  await click(); await click();
  await settle();
  assert.equal(prepares().length, 1, '進行中不能重複觸發');
  assert.deepEqual(panel.externalUrls, []);
  pending.resolve({ url: GUIDE_URL });
  await first; await settle();
  assert.deepEqual(panel.externalUrls, [GUIDE_URL]);
  guide = cardGuide();
  assert.equal(guide.disabled, false);
  assert.equal(guide.getAttribute('aria-label'), '開啟完整說明頁');
  assert.equal(guide.getAttribute('aria-busy'), 'false');
});

test('進行中狀態卡片與明細共用：從明細觸發時卡片也顯示準備中，且兩處都不能重複觸發', async () => {
  const pending = deferred();
  const { panel, cardGuide, detailGuide, open, prepares } = await start({ prepare: () => pending.promise });
  await open('demo');
  const run = detailGuide().fire('click');
  await settle();
  assert.equal(detailGuide().disabled, true);
  assert.equal(detailGuide().getAttribute('aria-label'), '準備中…');
  assert.equal(cardGuide().disabled, true);
  await cardGuide().fire('click');
  await detailGuide().fire('click');
  assert.equal(prepares().length, 1);
  pending.resolve({ url: GUIDE_URL });
  await run; await settle();
  assert.deepEqual(panel.externalUrls, [GUIDE_URL]);
  assert.equal(detailGuide().disabled, false);
});

test('失敗：顯示 worker 回傳的訊息，不開啟瀏覽器，按鈕恢復可再試', async () => {
  let fail = true;
  const { panel, cardGuide, prepares } = await start({ prepare: async () => {
    if (fail) throw Object.assign(new Error('此資源版本未提供完整說明頁'), { code: 'guide_unavailable' });
    return { url: GUIDE_URL };
  } });
  await cardGuide().fire('click');
  await settle();
  assert.match(textOf(panel.get('toast')), /此資源版本未提供完整說明頁/);
  assert.match(panel.get('toast').className, /error/);
  assert.deepEqual(panel.externalUrls, []);
  assert.equal(cardGuide().disabled, false);
  assert.equal(cardGuide().getAttribute('aria-label'), '開啟完整說明頁');
  fail = false;
  await cardGuide().fire('click');
  await settle();
  assert.equal(prepares().length, 2);
  assert.deepEqual(panel.externalUrls, [GUIDE_URL]);
});

test('系統瀏覽器開啟失敗：顯示提示並恢復按鈕；工作階段失效則回到登入畫面', async () => {
  const { panel, cardGuide } = await start({ openExternal: async () => { throw new Error('找不到瀏覽器'); } });
  await cardGuide().fire('click');
  await settle();
  assert.match(textOf(panel.get('toast')), /找不到瀏覽器/);
  assert.equal(cardGuide().disabled, false);

  const lost = await start({ prepare: async () => { throw Object.assign(new Error('登入已過期'), { code: 'session_expired' }); } });
  await lost.cardGuide().fire('click');
  await settle();
  assert.equal(lost.panel.externalUrls.length, 0);
  assert.ok(lost.calls.filter(c => c.method === 'rc.session.getState').length >= 2, '重新讀取登入狀態');
});

test('卡片重繪（例如清單重新整理）後，進行中的資源包仍維持準備中', async () => {
  const pending = deferred();
  const { panel, cardGuide } = await start({ prepare: () => pending.promise });
  const run = cardGuide().fire('click');
  await settle();
  await panel.get('catalog-type').fire('change'); // 重新查詢清單，卡片重建
  await settle();
  assert.equal(cardGuide().disabled, true);
  assert.equal(findAllByData(panel.get('catalog-list'), 'action', 'full-guide').length, 1);
  pending.resolve({ url: GUIDE_URL });
  await run; await settle();
  assert.equal(cardGuide().disabled, false);
});

const READY_LABEL = '開啟完整說明頁（已準備好）';
const gestureError = () => Object.assign(new Error('openExternal 需要在視窗內點擊或按鍵'), { code: 'not_permitted' });
const urlOf = (n) => `http://127.0.0.1:${50000 + n}/index.html`;

test('舊版外掛只回傳 fileUrl（沒有 url）：視為錯誤，不開啟瀏覽器、不進入已準備好狀態', async () => {
  const { panel, cardGuide } = await start({ prepare: async () => ({ fileUrl: 'file:///C:/x/index.html', path: 'x' }) });
  await cardGuide().fire('click');
  await settle();
  assert.match(textOf(panel.get('toast')), /這個版本的外掛無法開啟完整說明頁/);
  assert.match(panel.get('toast').className, /error/);
  assert.deepEqual(panel.externalUrls, []);
  assert.equal(cardGuide().getAttribute('aria-label'), '開啟完整說明頁');
  assert.equal(cardGuide().disabled, false);
});

test('使用者手勢過期（openExternal 拋錯）：按鈕切成已準備好；再按一次直接用同一個 url 開啟，不重新 prepare', async () => {
  let reject = true;
  const { panel, cardGuide, detailGuide, open, prepares } = await start({ openExternal: async () => { if (reject) throw gestureError(); return { opened: true }; } });
  await cardGuide().fire('click');
  await settle();
  assert.match(textOf(panel.get('toast')), /openExternal 需要在視窗內點擊或按鍵/);
  assert.match(panel.get('toast').className, /error/);
  const guide = cardGuide();
  assert.equal(guide.getAttribute('aria-label'), READY_LABEL);
  assert.equal(guide.getAttribute('title'), READY_LABEL);
  assert.ok(classes(guide).includes('is-ready'));
  assert.equal(guide.disabled, false);
  assert.equal(guide.getAttribute('aria-busy'), 'false');
  assert.equal(prepares().length, 1);
  // 明細頁的 🌐 共用同一個狀態
  await open('demo');
  assert.equal(detailGuide().getAttribute('aria-label'), READY_LABEL);
  assert.ok(classes(detailGuide()).includes('is-ready'));

  reject = false;
  await detailGuide().fire('click');
  await settle();
  assert.equal(prepares().length, 1, '直接使用已準備好的 url');
  assert.deepEqual(panel.externalUrls, [GUIDE_URL, GUIDE_URL]);
  assert.equal(detailGuide().getAttribute('aria-label'), '開啟完整說明頁');
  assert.ok(!classes(detailGuide()).includes('is-ready'));
  assert.equal(cardGuide().getAttribute('aria-label'), '開啟完整說明頁');
});

test('已準備好後再按仍失敗：顯示錯誤並維持已準備好，可再試', async () => {
  const { panel, cardGuide, prepares } = await start({ openExternal: async () => { throw gestureError(); } });
  await cardGuide().fire('click');
  await cardGuide().fire('click');
  await settle();
  assert.equal(prepares().length, 1);
  assert.equal(panel.externalUrls.length, 2);
  assert.equal(cardGuide().getAttribute('aria-label'), READY_LABEL);
  assert.match(panel.get('toast').className, /error/);
});

test('已準備好的 url 10 分鐘內有效；過期後重繪恢復一般狀態，再按會重新 prepare 並使用新的 url', async () => {
  let n = 0;
  let reject = true;
  const { panel, cardGuide, prepares } = await start({
    prepare: async () => ({ url: urlOf(n += 1) }),
    openExternal: async () => { if (reject) throw gestureError(); return { opened: true }; }
  });
  await cardGuide().fire('click');
  await settle();
  assert.equal(cardGuide().getAttribute('aria-label'), READY_LABEL);
  panel.clock.advance(9 * 60 * 1000);
  await panel.get('catalog-type').fire('change');
  await settle();
  assert.equal(cardGuide().getAttribute('aria-label'), READY_LABEL, '9 分鐘仍有效');
  panel.clock.advance(2 * 60 * 1000);
  await panel.get('catalog-type').fire('change');
  await settle();
  assert.equal(cardGuide().getAttribute('aria-label'), '開啟完整說明頁');
  reject = false;
  await cardGuide().fire('click');
  await settle();
  assert.equal(prepares().length, 2, '過期後重新 prepare');
  assert.deepEqual(panel.externalUrls, [urlOf(1), urlOf(2)]);
});

test('畫面仍顯示已準備好但實際已過期（沒有重繪）：點選時改為重新 prepare', async () => {
  let n = 0;
  let reject = true;
  const { panel, cardGuide, prepares } = await start({
    prepare: async () => ({ url: urlOf(n += 1) }),
    openExternal: async () => { if (reject) throw gestureError(); return { opened: true }; }
  });
  await cardGuide().fire('click');
  await settle();
  const stale = cardGuide();
  panel.clock.advance(11 * 60 * 1000);
  reject = false;
  await stale.fire('click');
  await settle();
  assert.equal(prepares().length, 2);
  assert.equal(panel.externalUrls.at(-1), urlOf(2));
});

test('openExternal 回傳 cancelled：使用者自己取消，不顯示錯誤、不進入已準備好', async () => {
  const { panel, cardGuide } = await start({ openExternal: async () => ({ opened: false, reason: 'cancelled' }) });
  await cardGuide().fire('click');
  await settle();
  assert.equal(textOf(panel.get('toast')).trim(), '', '沒有提示');
  assert.equal(cardGuide().getAttribute('aria-label'), '開啟完整說明頁');
  assert.equal(cardGuide().disabled, false);
});

test('openExternal 回傳 consent-unavailable：提示 Orca 視窗不在前景，可再試且不必重新 prepare', async () => {
  let reply = { opened: false, reason: 'consent-unavailable' };
  const { panel, cardGuide, prepares } = await start({ openExternal: async () => reply });
  await cardGuide().fire('click');
  await settle();
  assert.match(textOf(panel.get('toast')), /Orca 視窗不在前景，無法確認開啟，請再試一次/);
  assert.match(panel.get('toast').className, /error/);
  assert.equal(cardGuide().getAttribute('aria-label'), READY_LABEL);
  reply = { opened: true };
  await cardGuide().fire('click');
  await settle();
  assert.equal(prepares().length, 1);
  assert.deepEqual(panel.externalUrls, [GUIDE_URL, GUIDE_URL]);
  assert.equal(cardGuide().getAttribute('aria-label'), '開啟完整說明頁');
});
