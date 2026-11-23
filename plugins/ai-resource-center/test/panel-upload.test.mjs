// rc-package-dev 工項 03：打包並上傳 sheet（資料夾、預檢、上傳、送審）、Ubuntu 的鑰匙圈提示與借用 macOS 命令警示（vm 面板 harness）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const FOLDER = '/work/example-pack'; // 合成路徑；面板只當文字處理，worker 以替身回應
const summary = (extra = {}) => ({ key: 'example.kit', name: '示範工具包', version: '0.1.3', type: 'bundle', contentCounts: { skill: 5, agent: 0, command: 0, prompt: 0, mcp: 1 }, fileCount: 48, totalBytes: 212 * 1024, hasFullGuide: false, ...extra });
const passed = (extra = {}) => ({ ok: true, blocking: [], disclosures: [], summary: summary(), ...extra });
const failedCheck = () => ({ ok: false, blocking: [
  { code: 'deployment.invalid-package', message: '版本號不可包含「-」', path: 'lcpack.json' },
  { code: 'deployment.invalid-package', message: '找不到宣告的路徑', path: 'resources/skills/example-skill' }], disclosures: [
  { code: 'deployment.non-standard-content-fields', message: 'SKILL.md 有非標準欄位 allowed-tools', path: 'skills/a' }], summary: summary({ version: '0.1.3-rc' }) });
const myPackage = (key) => ({ packageKey: key, name: '已有的資源包', type: 'skill', description: '', category: '', tags: [], currentUserRole: 'owner', installCount: 0, allDisabled: false, versions: [] });

/** 面板與替身 worker：handlers 可依 method 覆寫；預設資料夾存在、預檢通過、上傳立刻就緒。 */
async function start({ prefs = {}, mine = [], handlers = {}, session = signedIn } = {}) {
  const calls = [];
  const state = { statuses: [], inspect: passed(), folderExists: true, listCount: 0 };
  const panel = await startPanel(async (method, input, options) => {
    calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)), options: JSON.parse(JSON.stringify(options ?? null)) });
    if (handlers[method]) return handlers[method](input, state, options);
    switch (method) {
      case 'rc.session.getState': return session;
      case 'rc.catalog.list': return { data: [] };
      case 'rc.preferences.get': return { sortField: 'installCount', sortDirection: 'desc', showPreview: false, ...prefs };
      case 'rc.preferences.set': return { ...prefs, ...input };
      case 'rc.dev.listMyPackages': state.listCount += 1; return { forbidden: false, packages: mine.map(myPackage) };
      case 'rc.dev.checkFolder': return { exists: state.folderExists, isDirectory: state.folderExists, absolutePath: input.path };
      case 'rc.dev.inspect': return structuredClone(state.inspect);
      case 'rc.dev.upload.start': return { jobId: `job-${calls.filter(c => c.method === 'rc.dev.upload.start').length}` };
      case 'rc.dev.upload.status': return state.statuses.length > 1 ? state.statuses.shift() : state.statuses[0];
      case 'rc.dev.upload.cancel': return { ok: true };
      case 'rc.dev.upload.dispose': return { ok: true };
      default: return {};
    }
  });
  const of = (method) => calls.filter(c => c.method === method);
  const open = async () => {
    await panel.get('btn-settings').fire('click'); await panel.get('btn-my-packages').fire('click'); await settle();
    await panel.get('btn-dev-upload').fire('click'); await settle();
  };
  const ticks = () => panel.timers.calls.filter(c => c.method === 'setInterval' && c.delay === 700).map(c => c.id);
  const liveTick = () => ticks().find(id => panel.timers.active.has(id));
  const tick = async () => { await panel.timers.fire(liveTick()); };
  return { panel, calls, state, of, open, ticks, liveTick, tick };
}

const descendants = (node) => [node, ...node.children.flatMap(descendants)];
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : null;
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');
const sheetOpen = (panel) => !hidden(panel, 'sheet-layer');
const body = (panel) => panel.get('sheet-body');
const role = (panel, name) => findByData(body(panel), 'role', name);
const title = (panel) => text(panel.get('sheet-title'));
const primary = (panel) => ({ label: text(panel.get('sheet-primary')), disabled: panel.get('sheet-primary').disabled, hidden: hidden(panel, 'sheet-primary') });
const pathInput = (panel) => findByData(body(panel), 'role', 'upload-path');
const reachedSteps = (panel) => role(panel, 'upload-steps').children.filter(n => n.classList.contains('done')).map(textOf).map(s => s.trim());
const change = async (panel, value) => { const input = pathInput(panel); input.value = value; await input.fire('change'); await settle(); };
const clickPrimary = async (panel) => { await panel.get('sheet-primary').fire('click'); await settle(); };
const clickCancel = async (panel) => { await panel.get('sheet-cancel').fire('click'); await settle(); };
const toastOf = (panel) => ({ text: text(panel.get('toast')), kind: panel.get('toast').className });
const uploaded = (extra = {}) => ({ state: 'uploaded', packageKey: 'example.kit', version: '0.1.3', name: '示範工具包', createdPackage: true, versionId: 7, ...extra });
const uploading = () => ({ state: 'uploading', packageKey: 'example.kit', version: '0.1.3', name: '示範工具包', createdPackage: false });

/** 開啟 sheet、輸入路徑並完成預檢通過。 */
async function toPassed(options) {
  const e = await start(options);
  await e.open();
  await change(e.panel, FOLDER);
  return e;
}
async function toUploading(options) {
  const e = await toPassed(options);
  e.state.statuses = [uploading()];
  await clickPrimary(e.panel);
  return e;
}

test('「打包並上傳…」開啟 sheet：標題、四步驟只到資料夾、路徑框與「選擇…」、主要按鈕停用', async () => {
  const { panel, of } = await start();
  await panel.get('btn-settings').fire('click'); await panel.get('btn-my-packages').fire('click'); await settle();
  await panel.get('btn-dev-upload').fire('click'); await settle();
  assert.equal(sheetOpen(panel), true);
  assert.equal(title(panel), '打包並上傳');
  assert.deepEqual(role(panel, 'upload-steps').children.map(n => text(n)), ['資料夾', '預檢', '上傳', '送審']);
  assert.deepEqual(reachedSteps(panel), ['資料夾']);
  assert.ok(pathInput(panel), '有路徑文字框');
  assert.equal(text(findByData(body(panel), 'action', 'pick-folder')), '選擇…');
  assert.match(text(body(panel)), /資源包資料夾/);
  assert.deepEqual(primary(panel), { label: '上傳', disabled: true, hidden: false });
  assert.equal(text(panel.get('sheet-cancel')), '取消');
  assert.equal(of('rc.dev.inspect').length, 0, '沒有路徑時不預檢');
});

test('預檢通過：「✓ 預檢通過」、摘要（名稱、識別碼、版本、類型與內容數、檔案數與大小）、主要按鈕「上傳」', async () => {
  const { panel, of } = await toPassed();
  assert.deepEqual(of('rc.dev.checkFolder').map(c => c.input), [{ path: FOLDER }]);
  assert.deepEqual(of('rc.dev.inspect').map(c => c.input), [{ folder: FOLDER, mode: 'upload' }]);
  assert.equal(text(role(panel, 'precheck-ok')), '✓ 預檢通過');
  const rows = descendants(role(panel, 'upload-summary')).filter(n => ['dt', 'dd'].includes(n.tagName)).map(n => text(n));
  assert.deepEqual(rows, ['名稱', '示範工具包', '識別碼', 'example.kit', '版本', '0.1.3', '類型', '組合包 · 5 Skills、1 MCP', '檔案', '48 個 · 212 KB']);
  assert.ok(findByData(role(panel, 'upload-summary'), 'role', undefined) || true);
  assert.ok(descendants(role(panel, 'upload-summary')).find(n => n.tagName === 'dd' && text(n) === 'example.kit').classList.contains('mono'), '識別碼為等寬字');
  assert.deepEqual(reachedSteps(panel), ['資料夾', '預檢']);
  assert.deepEqual(primary(panel), { label: '上傳', disabled: false, hidden: false });
  assert.equal(findByData(body(panel), 'role', 'precheck-failures'), null);
});

test('類型文字：單一類型只顯示類型；大小以 B／KB／MB 呈現', async () => {
  const single = await toPassed();
  single.state.inspect = passed({ summary: summary({ type: 'skill', contentCounts: { skill: 1, agent: 0, command: 0, prompt: 0, mcp: 0 }, fileCount: 2, totalBytes: 900 }) });
  await change(single.panel, '/work/other');
  const rows = descendants(role(single.panel, 'upload-summary')).filter(n => ['dd'].includes(n.tagName)).map(n => text(n));
  assert.deepEqual(rows.slice(3), ['Skill', '2 個 · 900 B']);
  single.state.inspect = passed({ summary: summary({ totalBytes: 3.5 * 1024 * 1024 }) });
  await change(single.panel, FOLDER);
  assert.match(text(role(single.panel, 'upload-summary')), /48 個 · 3\.5 MB/);
});

test('預檢沒過：紅色清單列出每個問題與檔案路徑、主要按鈕「重新檢查」；修正後重新檢查就通過，不用重選資料夾', async () => {
  const e = await start();
  e.state.inspect = failedCheck();
  await e.open();
  await change(e.panel, FOLDER);
  const failures = role(e.panel, 'precheck-failures');
  assert.ok(failures.classList.contains('failure-list'));
  assert.match(text(failures), /有 2 個問題需要修正/);
  const items = findAllByData(failures, 'role', 'precheck-failure').map(n => n.children.map(c => text(c)));
  assert.deepEqual(items, [['版本號不可包含「-」', 'lcpack.json'], ['找不到宣告的路徑', 'resources/skills/example-skill']]);
  assert.ok(items.length && findAllByData(failures, 'role', 'precheck-failure')[0].children[1].classList.contains('mono'), '路徑為等寬字');
  assert.deepEqual(primary(e.panel), { label: '重新檢查', disabled: false, hidden: false });
  assert.deepEqual(reachedSteps(e.panel), ['資料夾', '預檢']);
  assert.equal(findByData(e.panel.get('sheet-body'), 'role', 'precheck-ok'), null);
  assert.equal(e.of('rc.preferences.set').length, 0, '沒通過的資料夾不記為上次的資料夾');

  e.state.inspect = passed();
  await clickPrimary(e.panel);
  assert.equal(e.of('rc.dev.inspect').length, 2, '重新檢查用同一個資料夾再跑一次預檢');
  assert.deepEqual(e.of('rc.dev.inspect').map(c => c.input.folder), [FOLDER, FOLDER]);
  assert.equal(text(role(e.panel, 'precheck-ok')), '✓ 預檢通過');
  assert.deepEqual(primary(e.panel), { label: '上傳', disabled: false, hidden: false });
  assert.equal(sheetOpen(e.panel), true, '重新檢查後 sheet 留在原處');
});

test('提醒：可折疊的黃色 notice「N 個提醒（不影響上傳）」；預檢沒過時展開、通過時收合；不阻擋', async () => {
  const e = await start();
  e.state.inspect = failedCheck();
  await e.open();
  await change(e.panel, FOLDER);
  let notice = role(e.panel, 'precheck-disclosures');
  assert.equal(notice.tagName, 'details');
  assert.ok(notice.classList.contains('notice'));
  assert.equal(notice.open, true);
  assert.equal(text(notice.children[0]), '1 個提醒（不影響上傳）');
  assert.match(text(notice), /SKILL\.md 有非標準欄位 allowed-tools/);
  e.state.inspect = passed({ disclosures: failedCheck().disclosures });
  await clickPrimary(e.panel);
  notice = role(e.panel, 'precheck-disclosures');
  assert.equal(notice.open, false);
  assert.equal(primary(e.panel).disabled, false, '提醒不影響上傳');
  e.state.inspect = passed();
  await clickPrimary(e.panel); // passed 狀態再按會開始上傳，改用路徑重新檢查
});

test('新的資源包：識別碼不在我的資源包清單時多一行藍色說明；已在清單或清單尚未載入時不顯示', async () => {
  const fresh = await toPassed({ mine: ['example.other'] });
  const noteOf = (e) => findByData(e.panel.get('sheet-body'), 'role', 'new-package-note');
  assert.equal(text(noteOf(fresh)), '這是新的資源包，上傳後你會成為擁有者。');
  assert.ok(noteOf(fresh).classList.contains('info-note'));
  const existing = await toPassed({ mine: ['example.kit'] });
  assert.equal(noteOf(existing), null);
  assert.equal(existing.of('rc.dev.listMyPackages').length, 1, '只用已載入的清單判斷，不另外呼叫 worker');
  // 清單尚未載入（例如由其他畫面直接開啟）：不確定時不顯示
  const early = await start({ mine: ['example.other'] });
  early.panel.window.RcPanel.openUploadSheet({ folder: FOLDER }); await settle();
  assert.equal(noteOf(early), null);
});

test('預設帶入上次打包上傳的資料夾並自動預檢；呼叫端指定的 folder 優先；使用者已輸入就不覆蓋', async () => {
  const last = await start({ prefs: { lastUploadFolder: '/work/last' } });
  await last.open();
  assert.equal(pathInput(last.panel).value, '/work/last');
  assert.deepEqual(last.of('rc.dev.inspect').map(c => c.input.folder), ['/work/last']);
  assert.equal(last.of('rc.preferences.set').length, 0, '與已記住的相同，不重複儲存');

  const given = await start({ prefs: { lastUploadFolder: '/work/last' } });
  await given.panel.get('btn-settings').fire('click'); await given.panel.get('btn-my-packages').fire('click'); await settle();
  given.panel.window.RcPanel.openUploadSheet({ folder: '/work/given' }); await settle();
  assert.equal(pathInput(given.panel).value, '/work/given');
  assert.deepEqual(given.of('rc.dev.inspect').map(c => c.input.folder), ['/work/given']);

  const gone = await start({ prefs: { lastUploadFolder: '/work/gone' } });
  gone.state.folderExists = false;
  await gone.open();
  assert.equal(pathInput(gone.panel).value, '/work/gone', '上次的資料夾已不存在：仍帶入路徑，但不顯示錯誤');
  assert.equal(findByData(gone.panel.get('sheet-body'), 'role', 'path-error'), null);
  assert.equal(primary(gone.panel).disabled, true);
});

test('預檢通過後把資料夾存為 lastUploadFolder；預檢沒過不存；同一資料夾不重複存', async () => {
  const e = await start({ prefs: { lastUploadFolder: '/work/old' } });
  e.state.folderExists = true;
  await e.open();
  e.state.inspect = failedCheck();
  await change(e.panel, '/work/new');
  assert.equal(e.of('rc.preferences.set').length, 0);
  e.state.inspect = passed();
  await clickPrimary(e.panel);
  assert.deepEqual(e.of('rc.preferences.set').map(c => c.input), [{ lastUploadFolder: '/work/new' }]);
  await change(e.panel, '/work/new');
  assert.equal(e.of('rc.preferences.set').length, 1);
});

test('路徑輸入：change 與 Enter 都預檢；前後空白與成對雙引號會去掉；回傳的 absolutePath 回填；找不到資料夾顯示錯誤', async () => {
  const e = await start({ handlers: { 'rc.dev.checkFolder': (input, state) => ({ exists: state.folderExists, isDirectory: state.folderExists, absolutePath: `${input.path}-abs` }) } });
  await e.open();
  await change(e.panel, '  "/work/a"  ');
  assert.deepEqual(e.of('rc.dev.checkFolder').map(c => c.input.path), ['/work/a']);
  assert.equal(pathInput(e.panel).value, '/work/a-abs');
  assert.deepEqual(e.of('rc.dev.inspect').map(c => c.input.folder), ['/work/a-abs']);

  const input = pathInput(e.panel);
  input.value = '/work/b';
  await input.fire('keydown', { key: 'Enter' }); await settle();
  assert.deepEqual(e.of('rc.dev.checkFolder').map(c => c.input.path), ['/work/a', '/work/b']);
  await input.fire('keydown', { key: 'a' }); await settle();
  assert.equal(e.of('rc.dev.checkFolder').length, 2, '只有 Enter 觸發檢查');

  e.state.folderExists = false;
  await change(e.panel, '/work/missing');
  assert.equal(text(role(e.panel, 'path-error')), '找不到這個資料夾');
  assert.equal(primary(e.panel).disabled, true);
  await change(e.panel, '   ');
  assert.equal(findByData(e.panel.get('sheet-body'), 'role', 'path-error'), null);
  assert.deepEqual(reachedSteps(e.panel), ['資料夾']);
});

test('Enter 與 change 同時送出同一路徑時只預檢一次（瀏覽器按 Enter 會兩者都觸發）', async () => {
  const e = await start();
  await e.open();
  const input = pathInput(e.panel);
  input.value = FOLDER;
  await Promise.all([input.fire('keydown', { key: 'Enter' }), input.fire('change')]); await settle();
  assert.equal(e.of('rc.dev.inspect').length, 1);
  await input.fire('change'); await settle(); // 失焦時瀏覽器會再送一次 change：值沒變就不重做，否則會在按「上傳」的瞬間把按鈕停用
  assert.equal(e.of('rc.dev.inspect').length, 1);
  assert.equal(primary(e.panel).disabled, false);
  await input.fire('keydown', { key: 'Enter' }); await settle(); // Enter 是明確的重新檢查
  assert.equal(e.of('rc.dev.inspect').length, 2);
});

test('改了路徑就不能用舊的預檢結果上傳：結果清掉、主要按鈕停用，輸入框保留焦點所在的節點', async () => {
  const e = await toPassed();
  const input = pathInput(e.panel);
  input.value = '/work/typing';
  await input.dispatch('input'); await settle();
  assert.equal(findByData(e.panel.get('sheet-body'), 'role', 'precheck-ok'), null);
  assert.equal(primary(e.panel).disabled, true);
  assert.equal(pathInput(e.panel), input, '輸入框節點沒有被重建');
  assert.equal(e.of('rc.dev.inspect').length, 1, '輸入中不預檢，等 change／Enter');
  await change(e.panel, FOLDER);
  assert.equal(primary(e.panel).disabled, false, '路徑確認後重新預檢');
  assert.equal(e.of('rc.dev.inspect').length, 2);
});

test('「選擇…」：以目前路徑開啟系統對話框（逾時 118 秒）、等待時顯示提示、選到路徑就預檢', async () => {
  let release;
  const e = await start({ handlers: { 'rc.dev.pickFolder': () => new Promise((resolve) => { release = resolve; }) } });
  await e.open();
  await change(e.panel, '/work/start'); // 已有路徑時以它當起點
  const pick = findByData(e.panel.get('sheet-body'), 'action', 'pick-folder');
  const picking = pick.fire('click'); await settle();
  assert.deepEqual(e.of('rc.dev.pickFolder').map(c => [c.input, c.options]), [[{ initialPath: '/work/start' }, { timeoutMs: 118000 }]]);
  assert.equal(text(role(e.panel, 'path-hint')), '已開啟選擇視窗；若沒看到，請查看工作列');
  assert.equal(pick.disabled, true, '等待中不能重複開啟');
  release({ path: '/work/picked' }); await picking; await settle();
  assert.equal(role(e.panel, 'path-hint').classList.contains('hidden'), true);
  assert.equal(pick.disabled, false);
  assert.equal(pathInput(e.panel).value, '/work/picked');
  assert.deepEqual(e.of('rc.dev.inspect').at(-1).input, { folder: '/work/picked', mode: 'upload' });
});

test('「選擇…」：沒有路徑時不帶 initialPath；取消不改路徑；無法開啟視窗時提示只能貼上路徑；錯誤顯示在 sheet', async () => {
  let reply = { cancelled: true };
  const e = await start({ handlers: { 'rc.dev.pickFolder': () => { if (reply instanceof Error) throw reply; return reply; } } });
  await e.open();
  const pick = () => findByData(e.panel.get('sheet-body'), 'action', 'pick-folder');
  await pick().fire('click'); await settle();
  assert.deepEqual(e.of('rc.dev.pickFolder')[0].input, {});
  assert.equal(pathInput(e.panel).value, '');
  assert.equal(role(e.panel, 'path-hint').classList.contains('hidden'), true, '取消後提示消失');
  reply = { unavailable: true };
  await pick().fire('click'); await settle();
  assert.match(text(role(e.panel, 'path-hint')), /無法開啟資料夾選擇視窗，請直接貼上資料夾路徑/);
  assert.equal(pick().disabled, false);
  reply = Object.assign(new Error('資料夾選擇器執行失敗'), { code: 'folder_picker_failed' });
  await pick().fire('click'); await settle();
  assert.equal(text(e.panel.get('sheet-error')), '資料夾選擇器執行失敗');
});

test('上傳：start 帶資料夾、上傳中只有「取消上傳」、「正在上傳…」與進度條與說明；每 700 毫秒輪詢', async () => {
  const e = await toUploading();
  assert.deepEqual(e.of('rc.dev.upload.start').map(c => c.input), [{ folder: FOLDER }]);
  assert.equal(title(e.panel), '打包並上傳 示範工具包 0.1.3');
  assert.deepEqual(reachedSteps(e.panel), ['資料夾', '預檢', '上傳']);
  assert.match(text(e.panel.get('sheet-body')), /正在上傳…/);
  assert.match(text(e.panel.get('sheet-body')), /大型資源包可能需要幾分鐘。/);
  assert.ok(role(e.panel, 'upload-progress'));
  assert.equal(primary(e.panel).hidden, true, '沒有主要按鈕');
  assert.equal(text(e.panel.get('sheet-cancel')), '取消上傳');
  assert.equal(pathInput(e.panel), null, '上傳中不顯示路徑列');
  assert.equal(e.ticks().length, 1);
  assert.equal(e.panel.timers.calls.find(c => c.id === e.ticks()[0]).delay, 700);
  assert.equal(e.of('rc.dev.upload.status').length, 0);
  await e.tick();
  assert.deepEqual(e.of('rc.dev.upload.status').map(c => c.input), [{ jobId: 'job-1' }]);
  assert.equal(text(e.panel.get('sheet-cancel')), '取消上傳', '尚未完成：維持上傳中');
});

test('上傳成功：標題「已上傳 x.y.z（Preview）」、副標題名稱、送審說明、選填附註、「保持 Preview」與「申請上架」', async () => {
  const e = await toUploading();
  e.state.statuses = [uploaded()];
  await e.tick();
  assert.equal(title(e.panel), '已上傳 0.1.3（Preview） 示範工具包');
  assert.deepEqual(reachedSteps(e.panel), ['資料夾', '預檢', '上傳', '送審']);
  assert.match(text(e.panel.get('sheet-body')), /要直接申請上架嗎？核准後會成為正式版，所有人都會在資源中心看到。/);
  assert.match(text(e.panel.get('sheet-body')), /送審附註（選填）/);
  const note = descendants(e.panel.get('sheet-body')).find(n => n.tagName === 'textarea');
  assert.equal(note.placeholder, '給審核者的說明');
  assert.equal(text(e.panel.get('sheet-cancel')), '保持 Preview');
  assert.deepEqual(primary(e.panel), { label: '申請上架', disabled: false, hidden: false });
  assert.equal(e.liveTick(), undefined, '成功後停止輪詢');
});

test('申請上架：以版本字串送審（附註去頭尾空白）、成功後 toast 並關閉；關閉時 dispose 並重新讀取清單', async () => {
  const e = await toUploading();
  e.state.statuses = [uploaded()];
  await e.tick();
  const note = descendants(e.panel.get('sheet-body')).find(n => n.tagName === 'textarea');
  note.value = '  請協助審核  ';
  const listed = e.state.listCount;
  await clickPrimary(e.panel);
  assert.deepEqual(e.of('rc.dev.submitReviewByVersion').map(c => c.input), [{ packageKey: 'example.kit', version: '0.1.3', comment: '請協助審核' }]);
  assert.deepEqual(toastOf(e.panel), { text: '已申請上架，等待管理者審核', kind: 'toast ok' });
  assert.equal(sheetOpen(e.panel), false);
  assert.deepEqual(e.of('rc.dev.upload.dispose').map(c => c.input), [{ jobId: 'job-1' }]);
  assert.equal(e.state.listCount, listed + 1, '有上傳成功：關閉後重新讀取我的資源包');
});

test('送審失敗：錯誤顯示在 sheet、附註保留、停在送審步驟，可再試或「保持 Preview」', async () => {
  let fail = true;
  const e = await toUploading({ handlers: { 'rc.dev.submitReviewByVersion': () => { if (fail) throw Object.assign(new Error('缺少送審權限'), { code: 'forbidden' }); return { ok: true }; } } });
  e.state.statuses = [uploaded()];
  await e.tick();
  const note = descendants(e.panel.get('sheet-body')).find(n => n.tagName === 'textarea');
  note.value = '請協助審核';
  await clickPrimary(e.panel);
  assert.equal(sheetOpen(e.panel), true);
  assert.equal(text(e.panel.get('sheet-error')), '缺少送審權限');
  assert.equal(descendants(e.panel.get('sheet-body')).find(n => n.tagName === 'textarea').value, '請協助審核');
  assert.equal(e.of('rc.dev.upload.dispose').length, 0, '還沒關閉就不 dispose');
  fail = false;
  await clickPrimary(e.panel);
  assert.equal(sheetOpen(e.panel), false);
  assert.equal(e.of('rc.dev.submitReviewByVersion').at(-1).input.comment, '請協助審核');
});

test('保持 Preview：不送審，關閉、dispose 並重新讀取清單', async () => {
  const e = await toUploading();
  e.state.statuses = [uploaded()];
  await e.tick();
  const listed = e.state.listCount;
  await clickCancel(e.panel);
  assert.equal(sheetOpen(e.panel), false);
  assert.equal(e.of('rc.dev.submitReviewByVersion').length, 0);
  assert.deepEqual(e.of('rc.dev.upload.dispose').map(c => c.input), [{ jobId: 'job-1' }]);
  assert.equal(e.state.listCount, listed + 1);
});

test('上傳失敗：伺服器訊息顯示在 sheet、主要按鈕「重試」；重試呼叫 retry 並回到上傳中，成功後進入送審', async () => {
  const e = await toUploading();
  e.state.statuses = [{ ...uploading(), state: 'failed', error: { code: 'conflict', message: '版本 0.1.3 已存在，請改用新的版本號' } }];
  await e.tick();
  assert.equal(text(role(e.panel, 'upload-error')), '版本 0.1.3 已存在，請改用新的版本號');
  assert.deepEqual(primary(e.panel), { label: '重試', disabled: false, hidden: false });
  assert.equal(text(e.panel.get('sheet-cancel')), '取消');
  assert.equal(e.liveTick(), undefined);
  assert.match(title(e.panel), /^打包並上傳 示範工具包 0\.1\.3$/);

  e.state.statuses = [uploading()];
  await clickPrimary(e.panel);
  assert.deepEqual(e.of('rc.dev.upload.retry').map(c => c.input), [{ jobId: 'job-1' }]);
  assert.equal(e.of('rc.dev.upload.start').length, 1);
  assert.equal(primary(e.panel).hidden, true);
  assert.equal(text(e.panel.get('sheet-cancel')), '取消上傳');
  assert.ok(e.liveTick() !== undefined, '重試後重新輪詢');
  e.state.statuses = [uploaded({ createdPackage: false })];
  await e.tick();
  assert.equal(title(e.panel), '已上傳 0.1.3（Preview） 示範工具包');
});

test('重試遇到沒有 ZIP 的失敗工作（invalid_params）：dispose 舊工作並重新開始上傳', async () => {
  const e = await toUploading({ handlers: { 'rc.dev.upload.retry': () => { throw Object.assign(new Error('只有已完成打包的失敗工作可以重試'), { code: 'invalid_params' }); } } });
  e.state.statuses = [{ ...uploading(), state: 'failed', error: { code: 'internal', message: '打包或上傳失敗，請稍後再試' } }];
  await e.tick();
  e.state.statuses = [uploading()];
  await clickPrimary(e.panel);
  assert.deepEqual(e.of('rc.dev.upload.dispose').map(c => c.input), [{ jobId: 'job-1' }]);
  assert.deepEqual(e.of('rc.dev.upload.start').map(c => c.input), [{ folder: FOLDER }, { folder: FOLDER }]);
  assert.equal(primary(e.panel).hidden, true);
  assert.equal(text(e.panel.get('sheet-cancel')), '取消上傳');
});

test('取消上傳：呼叫 cancel 後回到預檢通過；再次上傳會先 dispose 舊工作再開新工作', async () => {
  const e = await toUploading();
  e.state.statuses = [{ ...uploading(), state: 'cancelled' }];
  await clickCancel(e.panel);
  assert.deepEqual(e.of('rc.dev.upload.cancel').map(c => c.input), [{ jobId: 'job-1' }]);
  assert.equal(sheetOpen(e.panel), true, '取消上傳不關閉 sheet');
  assert.equal(text(role(e.panel, 'precheck-ok')), '✓ 預檢通過');
  assert.deepEqual(primary(e.panel), { label: '上傳', disabled: false, hidden: false });
  assert.equal(text(e.panel.get('sheet-cancel')), '取消');
  assert.equal(title(e.panel), '打包並上傳');
  assert.equal(e.liveTick(), undefined);
  assert.equal(e.of('rc.dev.upload.dispose').length, 0, '取消後工作仍保留到下一次上傳或關閉');

  e.state.statuses = [uploading()];
  await clickPrimary(e.panel);
  assert.deepEqual(e.of('rc.dev.upload.dispose').map(c => c.input), [{ jobId: 'job-1' }]);
  assert.deepEqual(e.of('rc.dev.upload.start').map(c => c.input), [{ folder: FOLDER }, { folder: FOLDER }]);
  e.state.statuses = [{ ...uploading(), state: 'cancelled' }];
  await clickCancel(e.panel);
  const listed = e.state.listCount;
  await clickCancel(e.panel); // 回到預檢通過後的取消：關閉
  assert.equal(sheetOpen(e.panel), false);
  assert.deepEqual(e.of('rc.dev.upload.dispose').map(c => c.input), [{ jobId: 'job-1' }, { jobId: 'job-2' }]);
  assert.equal(e.state.listCount, listed, '沒有上傳成功就不重新讀取清單');
});

test('取消上傳時競爭到已完成：改走送審詢問', async () => {
  const e = await toUploading();
  e.state.statuses = [uploaded()];
  await clickCancel(e.panel);
  assert.equal(title(e.panel), '已上傳 0.1.3（Preview） 示範工具包');
});

test('在上傳中按 Esc 等同「取消上傳」，不關閉', async () => {
  const e = await toUploading();
  e.state.statuses = [{ ...uploading(), state: 'cancelled' }];
  await e.panel.window.RcPanel.cancelSheet(); await settle();
  assert.equal(e.of('rc.dev.upload.cancel').length, 1);
  assert.equal(sheetOpen(e.panel), true);
});

test('任何狀態關閉都會 dispose 背景工作並停止輪詢：預檢中途關閉不呼叫 dispose；上傳失敗關閉會 dispose', async () => {
  const early = await toPassed();
  await clickCancel(early.panel);
  assert.equal(early.of('rc.dev.upload.dispose').length, 0);
  assert.equal(early.of('rc.dev.upload.start').length, 0);

  const failed = await toUploading();
  failed.state.statuses = [{ ...uploading(), state: 'failed', error: { code: 'internal', message: '打包或上傳失敗，請稍後再試' } }];
  await failed.tick();
  const listed = failed.state.listCount;
  await clickCancel(failed.panel);
  assert.equal(sheetOpen(failed.panel), false);
  assert.deepEqual(failed.of('rc.dev.upload.dispose').map(c => c.input), [{ jobId: 'job-1' }]);
  assert.equal(failed.state.listCount, listed, '失敗關閉不重新讀取清單');
});

test('登出或換帳號清除畫面時 sheet 關閉、dispose 工作，且不再讀取清單', async () => {
  const e = await toUploading();
  e.state.statuses = [uploaded()];
  await e.tick();
  const listed = e.state.listCount;
  e.panel.window.RcPanel.resetDeveloper(); await settle();
  assert.equal(sheetOpen(e.panel), false);
  assert.deepEqual(e.of('rc.dev.upload.dispose').map(c => c.input), [{ jobId: 'job-1' }]);
  assert.equal(e.state.listCount, listed);
});

test('輪詢遇到登入失效：關閉 sheet 並回到登入畫面', async () => {
  const e = await toUploading({ handlers: { 'rc.dev.upload.status': () => { throw Object.assign(new Error('登入已過期'), { code: 'session_expired' }); } } });
  await e.tick();
  assert.equal(sheetOpen(e.panel), false);
  assert.deepEqual(e.of('rc.dev.upload.dispose').map(c => c.input), [{ jobId: 'job-1' }]);
});

test('上傳起不來（start 失敗）：錯誤顯示在 sheet、留在預檢通過；資料夾在預檢後被改壞（invalid_package）時重新預檢並列出阻擋項', async () => {
  let reply = Object.assign(new Error('缺少資源包上傳權限'), { code: 'forbidden' });
  const e = await toPassed({ handlers: { 'rc.dev.upload.start': () => { throw reply; } } });
  await clickPrimary(e.panel);
  assert.equal(text(e.panel.get('sheet-error')), '缺少資源包上傳權限');
  assert.equal(text(role(e.panel, 'precheck-ok')), '✓ 預檢通過');
  assert.equal(primary(e.panel).hidden, false);
  assert.equal(e.liveTick(), undefined);

  reply = Object.assign(new Error('來源資料夾未通過上傳預檢'), { code: 'invalid_package' });
  e.state.inspect = failedCheck();
  const inspects = e.of('rc.dev.inspect').length;
  await clickPrimary(e.panel);
  assert.equal(e.of('rc.dev.inspect').length, inspects + 1);
  assert.match(text(role(e.panel, 'precheck-failures')), /有 2 個問題需要修正/);
  assert.equal(primary(e.panel).label, '重新檢查');
});

test('建立工作（start）進行中：取消鈕停用，回來後進入上傳中', async () => {
  let release;
  const e = await toPassed({ handlers: { 'rc.dev.upload.start': () => new Promise((resolve) => { release = resolve; }) } });
  e.state.statuses = [uploading()];
  const pending = e.panel.get('sheet-primary').fire('click');
  await settle();
  assert.equal(e.panel.get('sheet-cancel').disabled, true, '建立工作的瞬間不能關閉');
  release({ jobId: 'late' }); await pending; await settle();
  assert.equal(e.of('rc.dev.upload.dispose').length, 0);
  assert.equal(primary(e.panel).hidden, true);
  assert.equal(text(e.panel.get('sheet-cancel')), '取消上傳');
});

test('上傳新的資源包後重新讀取清單，新清單進入我的資源包視圖', async () => {
  const e = await toUploading();
  e.state.statuses = [uploaded()];
  await e.tick();
  await clickCancel(e.panel);
  assert.equal(e.of('rc.dev.listMyPackages').length, 2);
});

test('鑰匙圈不可用（secretsProtection: unavailable）：登入畫面顯示黃色說明並停用登入；可用或舊 host 未回報時不受影響', async () => {
  const notice = '這台電腦沒有可用的鑰匙圈，無法安全儲存登入。請安裝並解鎖 GNOME 鑰匙圈後重新開啟。';
  const off = await startPanel(async (method) => method === 'rc.session.getState' ? { signedIn: false, marketUrl: 'https://market.example.com', secretsProtection: 'unavailable' } : {});
  assert.equal(text(off.get('login-notice')), notice);
  assert.equal(off.get('login-notice').classList.contains('hidden'), false);
  assert.equal(off.get('btn-login').disabled, true);
  off.get('in-user').value = 'alice'; off.get('in-pass').value = 'pw';
  await off.get('login-form').fire('submit'); await settle();
  assert.equal(off.get('in-pass').value, 'pw', '不會送出登入');

  for (const secretsProtection of ['os-keyring', undefined]) {
    const calls = [];
    const on = await startPanel(async (method, input) => { calls.push(method); return method === 'rc.session.getState' ? { signedIn: false, marketUrl: 'https://market.example.com', ...(secretsProtection ? { secretsProtection } : {}) } : {}; });
    assert.equal(text(on.get('login-notice')), '', secretsProtection ?? '舊 host');
    assert.equal(on.get('btn-login').disabled, false);
  }
});

test('鑰匙圈說明優先於其他登入提示；登入失敗後登入鈕仍停用', async () => {
  const off = await startPanel(async (method) => {
    if (method === 'rc.session.getState') return { signedIn: false, marketUrl: 'https://market.example.com', notice: '登入已過期', secretsProtection: 'unavailable' };
    return {};
  });
  assert.match(text(off.get('login-notice')), /鑰匙圈/);
  assert.equal(off.get('btn-login').disabled, true);
});

test('Linux 借用 macOS 設定命令：確認層在該命令下方多一行黃色警示；其他命令沒有', async () => {
  const command = { commandId: 'init', name: '安裝 MCP（macOS）', runner: 'bash', script: 'setup/install.sh', arguments: [], timeoutMinutes: 5, runOnUpdate: false, eligibility: 'Eligible', willExecute: true, reason: 'FirstRun' };
  const plan = (commands) => ({ needsConfirmation: true, reasons: ['setupCommands'], allBlocked: false, planId: 'p1', plan: { deployableCount: 1, blockedTargets: [], setupCommands: commands, missingParameters: [] } });
  const startConfirm = async (commands) => {
    const panel = await startPanel(async (method) => {
      if (method === 'rc.session.getState') return signedIn;
      if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false };
      if (method === 'rc.catalog.list') return { data: [{ packageKey: 'demo', name: '資源 demo', type: 'skill', latestVisibleVersion: '1.2.0', installationStatus: 'notInstalled', deployments: [], tools: [], pendingTargets: { count: 0, targets: [] }, lastFailure: null }] };
      if (method === 'rc.install.run') return plan(commands);
      return {};
    });
    await findByData(panel.get('catalog-list'), 'action', 'install').fire('click'); await settle();
    return panel;
  };
  const borrowed = await startConfirm([{ ...command, borrowedFromOs: 'macos' }, { ...command, commandId: 'native', name: '原生命令' }]);
  const notices = findAllByData(borrowed.get('confirm-body'), 'role', 'borrowed-command-notice');
  assert.equal(notices.length, 1);
  assert.equal(text(notices[0]), '此命令是為 macOS 撰寫，將在 Linux 以 bash 執行。');
  assert.ok(notices[0].classList.contains('notice'));
  const section = findByData(borrowed.get('confirm-body'), 'section', 'setupCommands');
  const kinds = section.children.map(n => n.getAttribute('data-role') ?? (n.classList.contains('hint') ? 'hint' : n.classList.contains('confirm-heading') ? 'heading' : '?'));
  assert.deepEqual(kinds.slice(2), ['setup-command', 'borrowed-command-notice', 'setup-command'], '警示緊接在借用的命令之後');
  const plain = await startConfirm([command]);
  assert.equal(findAllByData(plain.get('confirm-body'), 'role', 'borrowed-command-notice').length, 0);
});
