// rc-package-dev 工項 04（面板）：從資料夾安裝的 sheet、我的資源包的「本機開發中」區塊、資源中心卡片與明細的開發中版本。
// worker 以替身回應（回應形狀見 worker/handlers/sideload.mjs），驗證面板送出的請求與畫面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const tools = [{ hostId: 'codex', label: 'Codex' }, { hostId: 'claude-code', label: 'Claude Code' }];
const codexTarget = { targetId: 'codex|codex-cli|global|/home/a/.codex', hostId: 'codex', label: 'Codex', rootPath: '/home/a/.codex' };
const claudeTarget = { targetId: 'claude-code|claude-code-cli|global|/home/a/.claude', hostId: 'claude-code', label: 'Claude Code', rootPath: '/home/a/.claude' };
const summary = { key: 'example.dev', name: '示範開發包', version: '0.1.3', type: 'bundle', contentCounts: { skill: 2 }, fileCount: 8, totalBytes: 1024, hasFullGuide: false };
const prepared = (extra = {}, plan = {}) => ({ needsConfirmation: true, reasons: [], allBlocked: false, planId: 'plan-1',
  plan: { deployableCount: 2, blockedTargets: [], setupCommands: [], missingParameters: [], ...plan },
  packageKey: 'example.dev', version: '0.1.3', sourcePath: '/work/dev', summary, disclosures: [], tools, replacesMarketVersion: null, ...extra });
const failedCheck = (extra = {}) => ({ precheckFailed: true, blocking: [{ code: 'manifest.version', message: '版本號不可包含「-」', path: 'lcpack.json' },
  { code: 'path.missing', message: '找不到宣告的路徑', path: 'resources/skills/demo' }], disclosures: [], summary: { ...summary, name: null, version: null }, ...extra });
const done = (targets = [codexTarget, claudeTarget], extra = {}) => ({ ok: true, succeeded: targets, failed: [], skipped: [], backups: [], ...extra });
const localPkg = (extra = {}) => ({ packageKey: 'example.dev', name: '示範開發包', version: '0.1.3', sourcePath: '/work/dev', sourceExists: true, tools, ...extra });

async function start({ handlers = {}, local = [], catalog = [], forbidden = false, open = true } = {}) {
  const calls = [];
  const state = { local, catalog };
  const panel = await startPanel(async (method, input, options) => {
    calls.push({ method, input: clone(input), options });
    if (handlers[method]) {
      const custom = await handlers[method](input, options, state);
      if (custom !== undefined) return custom;
    }
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.preferences.get') return { sortField: 'installCount', sortDirection: 'desc', showPreview: false };
    if (method === 'rc.catalog.list') return { data: state.catalog };
    if (method === 'rc.dev.listMyPackages') return { forbidden, packages: [] };
    if (method === 'rc.dev.listLocal') return { packages: state.local };
    if (method === 'rc.updates.checkNow' || method === 'rc.updates.summary') return { count: 0 };
    if (method === 'rc.install.discard') return { discarded: true };
    return {};
  });
  const count = (method) => calls.filter(c => c.method === method).length;
  const of = (method) => calls.filter(c => c.method === method);
  if (open) { await panel.get('btn-settings').fire('click'); await panel.get('btn-my-packages').fire('click'); await settle(); }
  return { panel, calls, state, count, of };
}

const descendants = (node) => [node, ...node.children.flatMap(descendants)];
const text = (node) => node ? textOf(node).replace(/\s+/g, ' ').trim() : '';
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');
const sheetBody = (panel) => text(panel.get('sheet-body'));
const sheetTitle = (panel) => text(panel.get('sheet-title'));
const role = (panel, name, root = panel.get('sheet-body')) => findByData(root, 'role', name);
const pathInput = (panel) => descendants(panel.get('sheet-body')).find(n => n.tagName === 'input' && n.getAttribute('aria-label') === '資源包資料夾');
const pick = (panel) => findByData(panel.get('sheet-body'), 'action', 'pick-folder');
const type = async (control, value) => { control.value = value; await control.dispatch('input'); };
const primary = async (panel) => { await panel.get('sheet-primary').fire('click'); await settle(); };
const openInstall = async (panel) => { await panel.get('btn-dev-install').fire('click'); await settle(); };
/** 開啟從資料夾安裝、輸入路徑並按「預檢」。 */
async function precheck(env, folder = '/work/dev') {
  await openInstall(env.panel);
  await type(pathInput(env.panel), folder);
  await primary(env.panel);
}
const param = (panel, id) => findByData(panel.get('sheet-body'), 'param', id);
const toast = (panel) => text(panel.get('toast'));

// ---------- 從資料夾安裝：選資料夾與預檢 ----------
test('「從資料夾安裝…」開啟 sheet：標題、路徑列與「預檢」；上次資料夾預設帶入，使用者已輸入就不覆蓋', async () => {
  const env = await start({ handlers: { 'rc.dev.install.lastFolder': () => ({ folder: '/work/last' }) } });
  await openInstall(env.panel);
  assert.equal(hidden(env.panel, 'sheet-layer'), false);
  assert.equal(sheetTitle(env.panel), '從資料夾安裝');
  assert.equal(env.panel.get('sheet-primary').textContent, '預檢');
  assert.equal(pathInput(env.panel).value, '/work/last', '預設帶入上次從資料夾安裝的資料夾');
  assert.equal(text(pick(env.panel)), '選擇…');
  assert.equal(env.panel.get('sheet-primary').disabled, false);

  await env.panel.get('sheet-cancel').fire('click');
  assert.equal(hidden(env.panel, 'sheet-layer'), true);
  const typed = await start({ handlers: { 'rc.dev.install.lastFolder': async () => { await settle(); return { folder: '/work/last' }; } } });
  await openInstall(typed.panel);
  await type(pathInput(typed.panel), '/work/mine');
  await settle(); await settle();
  assert.equal(pathInput(typed.panel).value, '/work/mine');
});

test('本機包有完整說明頁時，確認畫面可開啟已預檢版本', async () => {
  const env = await start({ handlers: {
    'rc.dev.install.prepare': () => prepared({ summary: { ...summary, hasFullGuide: true } }),
    'rc.dev.guide.prepare': () => ({ url: 'http://127.0.0.1:51234/index.html' })
  } });
  await precheck(env);
  const button = findByData(env.panel.get('sheet-body'), 'action', 'local-full-guide');
  assert.match(text(button), /檢視完整說明頁/);
  await button.fire('click');
  await settle();
  assert.deepEqual(env.of('rc.dev.guide.prepare').map(c => c.input), [{ planId: 'plan-1' }]);
  assert.equal(env.count('rc.install.run'), 0);
});

test('本機開發中卡片的地球圖示開啟本機說明頁', async () => {
  const env = await start({
    local: [localPkg({ hasFullGuide: true, localFullGuide: true })],
    handlers: { 'rc.dev.guide.openInstalled': () => ({ url: 'http://127.0.0.1:51234/index.html' }) }
  });
  const button = findByData(env.panel.get('developer-local'), 'action', 'full-guide');
  assert.ok(button);
  await button.fire('click');
  await settle();
  assert.deepEqual(env.of('rc.dev.guide.openInstalled').map(c => c.input), [{ packageKey: 'example.dev' }]);
  assert.equal(env.count('rc.guide.prepare'), 0);
});

test('沒有路徑時「預檢」停用；貼上的路徑會去掉前後空白與雙引號再送出', async () => {
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared() } });
  await openInstall(env.panel);
  assert.equal(pathInput(env.panel).value, '');
  assert.equal(env.panel.get('sheet-primary').disabled, true);
  await type(pathInput(env.panel), '  "/work/dev"  ');
  assert.equal(env.panel.get('sheet-primary').disabled, false);
  await primary(env.panel);
  assert.deepEqual(env.of('rc.dev.install.prepare').map(c => c.input), [{ folder: '/work/dev' }]);
  assert.equal(env.of('rc.dev.install.prepare')[0].options.timeoutMs, 120000);
});

test('預檢有阻擋項：紅色清單（問題＋檔案路徑）、「重新檢查」；修正後不用重選資料夾，揭露項是黃色可折疊提醒', async () => {
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => failedCheck({ disclosures: [{ code: 'x', message: 'SKILL.md 有非標準欄位 allowed-tools', path: 'resources/skills/demo/SKILL.md' }] }) } });
  await precheck(env);
  const list = role(env.panel, 'precheck-failures');
  assert.ok(list.classList.contains('failure-list'));
  assert.match(text(list), /有 2 個問題需要修正/);
  const items = findAllByData(list, 'role', 'precheck-item').map(text);
  assert.deepEqual(items, ['版本號不可包含「-」 lcpack.json', '找不到宣告的路徑 resources/skills/demo']);
  assert.equal(env.panel.get('sheet-primary').textContent, '重新檢查');
  assert.equal(env.panel.get('sheet-primary').classList.contains('hidden'), false);
  const notice = role(env.panel, 'disclosures');
  assert.ok(notice.classList.contains('notice') && notice.tagName === 'details');
  assert.match(text(notice), /1 個提醒（不影響安裝）.*allowed-tools.*SKILL\.md/);
  assert.doesNotMatch(sheetBody(env.panel), /預檢通過/);
  assert.equal(findAllByData(env.panel.get('sheet-body'), 'param-row').length, 0);

  await primary(env.panel); // 重新檢查：同一個資料夾再送一次
  assert.deepEqual(env.of('rc.dev.install.prepare').map(c => c.input), [{ folder: '/work/dev' }, { folder: '/work/dev' }]);
});

test('預檢通過：「✓ 預檢通過 · 將安裝到 <工具圖示與名稱>」、副標題「名稱 · 開發中 版本」、主要按鈕「安裝」；沒有取代提示、參數與命令', async () => {
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared() } });
  await precheck(env);
  assert.equal(text(role(env.panel, 'precheck-ok')), '✓ 預檢通過 · 將安裝到 Codex、 Claude Code');
  assert.deepEqual(findAllByData(role(env.panel, 'precheck-ok'), 'role', 'tool').map(n => n.getAttribute('data-tool')), ['codex', 'claude-code']);
  assert.ok(findByData(role(env.panel, 'precheck-ok'), 'role', 'tool').children[0].classList.contains('tool-icon'), '每個工具有圖示');
  assert.equal(sheetTitle(env.panel), '從資料夾安裝 示範開發包 · 開發中 0.1.3');
  assert.equal(env.panel.get('sheet-primary').textContent, '安裝');
  assert.equal(role(env.panel, 'replaces-market'), null);
  assert.equal(role(env.panel, 'disclosures'), null);
  assert.equal(findByData(env.panel.get('sheet-body'), 'section', 'setupCommands'), null);
  assert.equal(findAllByData(env.panel.get('sheet-body'), 'param-row').length, 0);
});

test('已安裝市集版時摘要出現取代提示；改動路徑會丟棄計畫並回到「預檢」', async () => {
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared({ replacesMarketVersion: '0.1.2' }) } });
  await precheck(env);
  const notice = role(env.panel, 'replaces-market');
  assert.ok(notice.classList.contains('notice'));
  assert.equal(text(notice), '將以開發中版本 0.1.3 取代已安裝的市集版 0.1.2；之後可在資源中心改用市集版。');

  await type(pathInput(env.panel), '/work/other');
  assert.deepEqual(env.of('rc.install.discard').map(c => c.input), [{ planId: 'plan-1' }], '路徑改了，已預檢的計畫作廢並丟棄');
  assert.equal(env.panel.get('sheet-primary').textContent, '預檢');
  assert.equal(role(env.panel, 'replaces-market'), null);
  assert.equal(sheetTitle(env.panel), '從資料夾安裝');
});

test('設定參數欄位與「安裝時會執行」命令清單放在同一個 sheet；缺必填時不送出，填好後先儲存（帶 planId）再安裝，秘密欄位清空', async () => {
  const params = [{ parameterId: 'org', label: 'Azure DevOps 組織網址', type: 'string', required: true, isSecret: false, value: null, source: 'Unset' },
    { parameterId: 'pat', label: '個人存取權杖（PAT）', type: 'string', required: true, isSecret: true, isSet: false }];
  const commands = [{ commandId: 'c1', name: '安裝個人 Azure DevOps MCP（Windows）', runner: 'powershell', script: 'setup/install.ps1', willExecute: true, timeoutMinutes: 5 }];
  const env = await start({ handlers: {
    'rc.dev.install.prepare': () => prepared({ reasons: ['missingParameters', 'setupCommands'] }, { missingParameters: params, setupCommands: commands }),
    'rc.install.run': () => done() } });
  await precheck(env);
  assert.equal(findAllByData(env.panel.get('sheet-body'), 'param-row').length, 2);
  assert.equal(param(env.panel, 'pat').type, 'password');
  const section = findByData(env.panel.get('sheet-body'), 'section', 'setupCommands');
  assert.match(text(section), /^安裝時會執行 /);
  assert.equal(text(findByData(section, 'role', 'setup-command')), '安裝個人 Azure DevOps MCP（Windows） powershell · setup/install.ps1 最長執行 5 分鐘');

  await primary(env.panel); // 缺必填
  assert.match(text(env.panel.get('sheet-error')) || '', /請填寫「Azure DevOps 組織網址」/);
  assert.equal(env.count('rc.install.saveSetup'), 0);
  assert.equal(env.count('rc.install.run'), 0);
  assert.equal(env.panel.get('sheet-primary').textContent, '安裝');

  param(env.panel, 'org').value = 'https://tfs.example.invalid/org';
  param(env.panel, 'pat').value = 'secret-value';
  await primary(env.panel);
  assert.deepEqual(env.of('rc.install.saveSetup').map(c => c.input), [{ packageKey: 'example.dev', planId: 'plan-1', values: { org: 'https://tfs.example.invalid/org' }, secrets: { pat: 'secret-value' } }]);
  assert.equal(param(env.panel, 'pat'), null, '結果取代了表單，秘密不留在畫面');
  assert.deepEqual(env.of('rc.install.run').map(c => c.input), [{ packageKey: 'example.dev', action: 'install', confirmedPlanId: 'plan-1' }]);
  assert.equal(env.of('rc.install.run')[0].options.timeoutMs, 300000 + 5 * 60000, '逾時含設定命令宣告的時間');
});

test('儲存參數後重新規劃只剩已確認過的命令：自動以新的 planId 再安裝一次，不重複詢問', async () => {
  const params = [{ parameterId: 'org', label: '組織網址', type: 'string', required: true, isSecret: false, value: null, source: 'Unset' }];
  const commands = [{ commandId: 'c1', name: '安裝', runner: 'bash', script: 'setup/install.sh', willExecute: true }];
  const first = prepared({ reasons: ['missingParameters', 'setupCommands'] }, { missingParameters: params, setupCommands: commands });
  let runs = 0;
  const env = await start({ handlers: {
    'rc.dev.install.prepare': () => first,
    'rc.install.run': () => (++runs === 1 ? prepared({ reasons: ['setupCommands'], planId: 'plan-2' }, { setupCommands: commands }) : done()) } });
  await precheck(env);
  param(env.panel, 'org').value = 'https://tfs.example.invalid/org';
  await primary(env.panel);
  assert.deepEqual(env.of('rc.install.run').map(c => c.input.confirmedPlanId), ['plan-1', 'plan-2']);
  assert.match(text(role(env.panel, 'result-title')), /已安裝到 2 個位置/);
});

test('部分位置受阻：列出受阻位置並說明其餘仍會安裝；全部受阻時沒有「安裝」，取消鈕改為「關閉」', async () => {
  const blocked = [{ ...claudeTarget, reason: '缺少 libsecret' }];
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared({ reasons: ['blockedTargets'] }, { deployableCount: 1, blockedTargets: blocked }) } });
  await precheck(env);
  const section = findByData(env.panel.get('sheet-body'), 'section', 'blockedTargets');
  assert.match(text(section), /1 個位置無法安裝/);
  assert.match(text(findByData(section, 'role', 'blocked-target')), /Claude Code.*\/home\/a\/\.claude.*缺少 libsecret/);
  assert.match(text(findByData(section, 'role', 'deployable')), /其餘 1 個位置仍會安裝/);
  assert.equal(env.panel.get('sheet-primary').textContent, '安裝到其餘 1 個位置');

  const all = await start({ handlers: { 'rc.dev.install.prepare': () => prepared({ needsConfirmation: false, allBlocked: true, reasons: ['blockedTargets'], planId: null, tools: [] }, { deployableCount: 0, blockedTargets: [{ ...codexTarget, reason: '沒有可用的工具' }] }) } });
  await precheck(all);
  assert.match(text(findByData(all.panel.get('sheet-body'), 'section', 'blockedTargets')), /1 個位置無法安裝/);
  assert.equal(all.panel.get('sheet-primary').classList.contains('hidden'), true);
  assert.equal(all.panel.get('sheet-cancel').textContent, '關閉');
  await all.panel.get('sheet-cancel').fire('click');
  assert.equal(all.count('rc.install.discard'), 0, '沒有計畫就沒有東西可丟棄');
});

test('預檢丟出錯誤（例如不是資料夾）：顯示在 sheet 錯誤區、保留路徑與「預檢」', async () => {
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => { throw Object.assign(new Error('請輸入資源包資料夾的完整路徑'), { code: 'bad_params' }); } } });
  await precheck(env, 'relative/dir');
  assert.equal(text(env.panel.get('sheet-error')), '請輸入資源包資料夾的完整路徑');
  assert.equal(pathInput(env.panel).value, 'relative/dir');
  assert.equal(env.panel.get('sheet-primary').textContent, '預檢');
});

// ---------- 安裝與結果 ----------
test('按「安裝」：帶 confirmedPlanId 執行，結果顯示在同一個 sheet；主要按鈕改為「完成」，關閉後不再丟棄（計畫已套用）', async () => {
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared(), 'rc.install.run': () => done() } });
  await precheck(env);
  await primary(env.panel);
  assert.deepEqual(env.of('rc.install.run').map(c => c.input), [{ packageKey: 'example.dev', action: 'install', confirmedPlanId: 'plan-1' }]);
  assert.equal(text(role(env.panel, 'result-title')), '✓ 已安裝到 2 個位置');
  assert.deepEqual(findAllByData(env.panel.get('sheet-body'), 'role', 'installed-target').map(text), ['Codex /home/a/.codex', 'Claude Code /home/a/.claude']);
  assert.equal(env.panel.get('sheet-primary').textContent, '完成');
  assert.equal(env.panel.get('sheet-cancel').classList.contains('hidden'), true, '結果只有一顆按鈕');
  assert.equal(hidden(env.panel, 'sheet-layer'), false);
  assert.equal(env.count('rc.dev.listLocal') >= 2, true, '安裝後重新讀取本機開發中區塊');
  assert.ok(env.of('rc.catalog.list').length >= 2, '並重新讀取資源中心的狀態');
  await primary(env.panel);
  assert.equal(hidden(env.panel, 'sheet-layer'), true);
  assert.equal(env.panel.get('sheet-cancel').classList.contains('hidden'), false, '關閉後取消鈕恢復顯示，不影響其他 sheet');
  assert.equal(env.count('rc.install.discard'), 0);
});

test('結果含失敗、略過、警告與備份：失敗原因、略過清單、警告與備份位置都列在 sheet 內', async () => {
  const result = { ok: false, succeeded: [codexTarget], failed: [{ ...claudeTarget, reason: '設定命令失敗', backupPaths: ['/home/a/.claude/bak'] }],
    skipped: [{ targetId: 'x', hostId: 'claude-desktop', label: 'Claude Desktop', rootPath: '/home/a/Desktop', reason: '已略過' }], backups: [{ backupPath: '/home/a/.claude/bak' }], warnings: [{ summary: '檔案已改名', path: 'a.md' }] };
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared(), 'rc.install.run': () => result } });
  await precheck(env);
  await primary(env.panel);
  assert.equal(text(role(env.panel, 'result-title')), '已安裝到 1 個位置，1 個位置失敗');
  assert.match(text(role(env.panel, 'failure-list')), /Claude Code.*設定命令失敗/);
  assert.match(text(role(env.panel, 'skipped-list')), /Claude Desktop.*已略過/);
  assert.equal(text(role(env.panel, 'result-warning')), '檔案已改名 a.md');
  assert.match(text(role(env.panel, 'backups')), /備份位置（1）.*\/home\/a\/\.claude\/bak/);
  assert.equal(env.panel.get('sheet-primary').textContent, '完成');
});

test('使用者取消設定的結果顯示「已取消安裝」', async () => {
  const cancelled = { ok: false, succeeded: [], failed: [{ ...codexTarget, reason: '已取消設定，尚未完成安裝', backupPaths: [] }], skipped: [], backups: [] };
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared(), 'rc.install.run': () => cancelled } });
  await precheck(env);
  await primary(env.panel);
  assert.equal(text(role(env.panel, 'result-title')), '已取消安裝');
});

test('執行中：主要按鈕「安裝中…」，取消鈕改為「取消安裝」並送出 rc.install.cancel', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared(), 'rc.install.run': () => gate.then(() => done([codexTarget])), 'rc.install.cancel': () => ({ cancelled: true }) } });
  await precheck(env);
  const running = primary(env.panel);
  await settle();
  assert.equal(env.panel.get('sheet-primary').textContent, '安裝中…');
  assert.equal(env.panel.get('sheet-primary').disabled, true);
  assert.equal(env.panel.get('sheet-cancel').textContent, '取消安裝');
  assert.equal(env.panel.get('sheet-cancel').disabled, false);
  await env.panel.get('sheet-cancel').fire('click');
  await settle();
  assert.deepEqual(env.of('rc.install.cancel').map(c => c.input), [{ packageKey: 'example.dev' }]);
  assert.equal(hidden(env.panel, 'sheet-layer'), false, '執行中取消鈕不關閉 sheet');
  assert.equal(env.panel.get('sheet-cancel').disabled, true, '送出取消後停用，避免重複');
  release();
  await running;
  await settle();
  assert.equal(text(role(env.panel, 'result-title')), '✓ 已安裝到 1 個位置');
});

test('套用時本機狀態改變、重新規劃後仍有例外：同一個 sheet 換成新的確認內容並提示，再確認時帶新的 planId', async () => {
  const commands = [{ commandId: 'c1', name: '安裝', runner: 'bash', script: 'setup/install.sh', willExecute: true }];
  let runs = 0;
  const env = await start({ handlers: {
    'rc.dev.install.prepare': () => prepared(),
    'rc.install.run': () => (++runs === 1 ? prepared({ reasons: ['setupCommands'], planId: 'plan-2' }, { setupCommands: commands }) : done()) } });
  await precheck(env);
  await primary(env.panel);
  assert.match(text(role(env.panel, 'replanned')), /本機狀態已改變/);
  assert.ok(findByData(env.panel.get('sheet-body'), 'section', 'setupCommands'));
  assert.equal(env.panel.get('sheet-primary').textContent, '安裝');
  await primary(env.panel);
  assert.deepEqual(env.of('rc.install.run').map(c => c.input.confirmedPlanId), ['plan-1', 'plan-2']);
  assert.match(text(role(env.panel, 'result-title')), /已安裝到 2 個位置/);
});

test('安裝丟出錯誤：顯示原因並回到「預檢」（計畫已失效），不留下舊的確認內容', async () => {
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared(), 'rc.install.run': () => { throw Object.assign(new Error('確認已失效，請重新執行安裝'), { code: 'plan_stale' }); } } });
  await precheck(env);
  await primary(env.panel);
  assert.equal(text(env.panel.get('sheet-error')), '確認已失效，請重新執行安裝');
  assert.equal(env.panel.get('sheet-primary').textContent, '預檢');
  assert.equal(role(env.panel, 'precheck-ok'), null);
  assert.equal(env.count('rc.install.discard'), 0);
});

// ---------- 關閉時丟棄計畫 ----------
test('關閉未套用的 sheet（取消、Esc 對應的取消、被其他 sheet 取代）一律丟棄計畫', async () => {
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared() } });
  await precheck(env);
  await env.panel.get('sheet-cancel').fire('click');
  assert.deepEqual(env.of('rc.install.discard').map(c => c.input), [{ planId: 'plan-1' }]);
  assert.equal(hidden(env.panel, 'sheet-layer'), true);

  await precheck(env);
  env.panel.window.RcPanel.closeSheet(); // 登出、換帳號會走這條
  assert.equal(env.count('rc.install.discard'), 2);

  assert.deepEqual(env.of('rc.install.discard').map(c => c.input), [{ planId: 'plan-1' }, { planId: 'plan-1' }]);
});

test('重新檢查會先丟棄上一份等待確認的計畫', async () => {
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => prepared() } });
  await precheck(env);
  await type(pathInput(env.panel), '/work/dev2');
  assert.equal(env.count('rc.install.discard'), 1);
  await primary(env.panel);
  assert.equal(env.of('rc.dev.install.prepare').length, 2);
  await env.panel.get('sheet-cancel').fire('click');
  assert.equal(env.count('rc.install.discard'), 2, '第二份計畫也在關閉時丟棄');
});

test('預檢進行中 sheet 被關閉：回來的計畫立即丟棄，不留下暫存打包產物', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const env = await start({ handlers: { 'rc.dev.install.prepare': () => gate.then(() => prepared({ planId: 'late' })) } });
  await openInstall(env.panel);
  await type(pathInput(env.panel), '/work/dev');
  const checking = primary(env.panel);
  await settle();
  env.panel.window.RcPanel.closeSheet();
  release();
  await checking;
  await settle();
  assert.deepEqual(env.of('rc.install.discard').map(c => c.input), [{ planId: 'late' }]);
});

// ---------- 選擇資料夾 ----------
test('「選擇…」：等待時顯示提示並停用按鈕（逾時 118 秒）；選好路徑後自動預檢', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const env = await start({ handlers: { 'rc.dev.pickFolder': () => gate.then(() => ({ path: '/picked/dev' })), 'rc.dev.install.prepare': () => prepared() } });
  await openInstall(env.panel);
  await type(pathInput(env.panel), '/work/start');
  const clicking = pick(env.panel).fire('click');
  await settle();
  assert.equal(text(role(env.panel, 'pick-hint')), '已開啟選擇視窗；若沒看到，請查看工作列');
  assert.equal(pick(env.panel).disabled, true);
  assert.equal(env.panel.get('sheet-primary').disabled, true);
  release();
  await clicking; await settle();
  assert.deepEqual(env.of('rc.dev.pickFolder').map(c => c.input), [{ initialPath: '/work/start' }]);
  assert.equal(env.of('rc.dev.pickFolder')[0].options.timeoutMs, 118000);
  assert.equal(pathInput(env.panel).value, '/picked/dev');
  assert.equal(role(env.panel, 'pick-hint').classList.contains('hidden'), true);
  assert.deepEqual(env.of('rc.dev.install.prepare').map(c => c.input), [{ folder: '/picked/dev' }]);
  assert.ok(role(env.panel, 'precheck-ok'));
});

test('選擇視窗取消或不可用：取消不動作；不可用時只能貼上路徑並說明', async () => {
  let answer = { cancelled: true };
  const env = await start({ handlers: { 'rc.dev.pickFolder': () => answer, 'rc.dev.install.prepare': () => prepared() } });
  await openInstall(env.panel);
  await type(pathInput(env.panel), '/work/keep');
  await pick(env.panel).fire('click'); await settle();
  assert.equal(pathInput(env.panel).value, '/work/keep');
  assert.equal(env.count('rc.dev.install.prepare'), 0);
  assert.equal(role(env.panel, 'pick-hint').classList.contains('hidden'), true);
  answer = { unavailable: true };
  await pick(env.panel).fire('click'); await settle();
  assert.match(text(role(env.panel, 'pick-hint')), /無法開啟選擇視窗，請直接貼上資料夾路徑/);
  assert.equal(pick(env.panel).disabled, false);
});

// ---------- 本機開發中區塊 ----------
test('沒有開發中版本時區塊隱藏；有時標題「本機開發中（N）」在「我的資源包」之上，卡片有名稱、識別碼、「開發中 x.y.z」、來源路徑（title 為完整路徑）與按鈕', async () => {
  const empty = await start();
  assert.equal(hidden(empty.panel, 'developer-local'), true);
  assert.equal(empty.panel.get('developer-local').children.length, 0);

  const env = await start({ local: [localPkg()] });
  assert.equal(env.count('rc.dev.listLocal'), 1);
  assert.equal(hidden(env.panel, 'developer-local'), false);
  assert.equal(text(role(env.panel, 'local-heading', env.panel.get('developer-local'))), '本機開發中（1）');
  const card = findByData(env.panel.get('developer-local'), 'role', 'local-package');
  assert.ok(card.classList.contains('is-dev') && card.classList.contains('dev-card'));
  assert.equal(text(findByData(card, 'role', 'package-name')), '示範開發包');
  assert.equal(text(findByData(card, 'role', 'package-key')), 'example.dev');
  assert.ok(findByData(card, 'role', 'package-key').classList.contains('mono'));
  assert.equal(text(findByData(card, 'role', 'dev-badge')), '開發中 0.1.3');
  const path = findByData(card, 'role', 'source-path');
  assert.equal(text(path), '/work/dev');
  assert.equal(path.getAttribute('title'), '/work/dev');
  assert.ok(path.classList.contains('ell') && path.classList.contains('mono'), '單行截斷的等寬字');
  assert.deepEqual(findAllByData(card, 'action').map(n => text(n)), ['重新安裝', '上傳…']);
  assert.equal(findByData(card, 'role', 'source-missing'), null);
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="developer-local"') < html.indexOf('id="developer-list"'));
});

test('⋯ 選單只有「解除安裝」：取部署位置後走一般解除安裝確認層，確認後送出 rc.install.run uninstall', async () => {
  const deployments = [{ id: codexTarget.targetId, hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', rootPath: '/home/a/.codex', label: 'Codex', version: '0.1.3', source: 'local' },
    { id: 'p', hostId: 'codex', surfaceId: 'codex-cli', scope: 'project', rootPath: '/proj', label: 'Codex', version: '0.1.3' }];
  const env = await start({ local: [localPkg()], handlers: {
    'rc.package.getDetails': () => ({ packageKey: 'example.dev', name: 'example.dev', installationStatus: 'current', deployments, readme: '' }),
    'rc.install.run': () => ({ ok: true, succeeded: [codexTarget], failed: [], backups: [] }) } });
  const more = findByData(env.panel.get('developer-local'), 'role', 'local-package').children[0].children[1];
  assert.equal(more.className.includes('dev-more'), true);
  await more.fire('click');
  assert.deepEqual(env.panel.get('popover').children.map(n => text(n)), ['解除安裝']);
  assert.ok(env.panel.get('popover').children[0].classList.contains('is-danger'));
  await env.panel.get('popover').children[0].fire('click'); await settle();
  assert.deepEqual(env.of('rc.package.getDetails').map(c => c.input), [{ packageKey: 'example.dev', previewMode: false }]);
  assert.equal(hidden(env.panel, 'confirm-layer'), false);
  assert.match(text(env.panel.get('confirm-title')), /解除安裝 示範開發包？/);
  assert.match(text(env.panel.get('confirm-body')), /將從 1 個位置移除.*\/home\/a\/\.codex/);
  await env.panel.get('confirm-primary').fire('click'); await settle();
  assert.deepEqual(env.of('rc.install.run').map(c => c.input), [{ packageKey: 'example.dev', action: 'uninstall' }]);
  assert.ok(env.count('rc.dev.listLocal') >= 2, '解除安裝後重新讀取本機開發中區塊');
});

test('「重新安裝」：rc.dev.reinstallLocal 預檢後開啟同一個確認 sheet（路徑已帶入），安裝流程相同；關閉時丟棄計畫', async () => {
  const env = await start({ local: [localPkg()], handlers: { 'rc.dev.reinstallLocal': () => prepared({ sourcePath: '/work/dev' }), 'rc.install.run': () => done() } });
  const card = findByData(env.panel.get('developer-local'), 'role', 'local-package');
  await findByData(card, 'action', 'reinstall-local').fire('click'); await settle();
  assert.deepEqual(env.of('rc.dev.reinstallLocal').map(c => c.input), [{ packageKey: 'example.dev' }]);
  assert.equal(sheetTitle(env.panel), '從資料夾安裝 示範開發包 · 開發中 0.1.3');
  assert.equal(pathInput(env.panel).value, '/work/dev');
  assert.ok(role(env.panel, 'precheck-ok'));
  assert.equal(env.panel.get('sheet-primary').textContent, '安裝');
  await env.panel.get('sheet-cancel').fire('click');
  assert.deepEqual(env.of('rc.install.discard').map(c => c.input), [{ planId: 'plan-1' }]);

  await findByData(findByData(env.panel.get('developer-local'), 'role', 'local-package'), 'action', 'reinstall-local').fire('click'); await settle();
  await primary(env.panel);
  assert.deepEqual(env.of('rc.install.run').map(c => c.input), [{ packageKey: 'example.dev', action: 'install', confirmedPlanId: 'plan-1' }]);
  assert.match(text(role(env.panel, 'result-title')), /已安裝到 2 個位置/);
});

test('重新安裝時預檢有阻擋項：同一個 sheet 列出問題，「重新檢查」仍走 reinstallLocal；路徑被改動後改走一般預檢', async () => {
  const env = await start({ local: [localPkg()], handlers: { 'rc.dev.reinstallLocal': () => failedCheck() } });
  await findByData(env.panel.get('developer-local'), 'action', 'reinstall-local').fire('click'); await settle();
  assert.ok(role(env.panel, 'precheck-failures'));
  assert.equal(env.panel.get('sheet-primary').textContent, '重新檢查');
  await primary(env.panel);
  assert.equal(env.of('rc.dev.reinstallLocal').length, 2);
  assert.equal(env.count('rc.dev.install.prepare'), 0);
  await type(pathInput(env.panel), '/work/other');
  await primary(env.panel);
  assert.deepEqual(env.of('rc.dev.install.prepare').map(c => c.input), [{ folder: '/work/other' }]);
});

test('重新安裝失敗（來源資料夾已不存在）：顯示原因並重新讀取區塊，不開 sheet', async () => {
  const env = await start({ local: [localPkg()], handlers: { 'rc.dev.reinstallLocal': () => { throw Object.assign(new Error('來源資料夾已不存在，無法重新打包：/work/dev。'), { code: 'source_missing' }); } } });
  await findByData(env.panel.get('developer-local'), 'action', 'reinstall-local').fire('click'); await settle();
  assert.match(toast(env.panel), /來源資料夾已不存在/);
  assert.equal(env.panel.window.RcPanel.sheetOpen(), false);
  assert.equal(env.count('rc.dev.listLocal'), 2);
});

test('「上傳…」呼叫 RC.openUploadSheet({ folder: 來源資料夾 })；沒有提供上傳 sheet 時不出錯', async () => {
  const env = await start({ local: [localPkg()] });
  const card = findByData(env.panel.get('developer-local'), 'role', 'local-package');
  await findByData(card, 'action', 'upload-local').fire('click');
  const opened = [];
  env.panel.window.RcPanel.openUploadSheet = (input) => { opened.push(clone(input)); };
  await findByData(findByData(env.panel.get('developer-local'), 'role', 'local-package'), 'action', 'upload-local').fire('click');
  assert.deepEqual(opened, [{ folder: '/work/dev' }]);
});

test('來源資料夾已不存在：顯示「來源資料夾已不存在」，停用「重新安裝」與「上傳…」，仍可解除安裝', async () => {
  const env = await start({ local: [localPkg({ sourceExists: false })] });
  const card = findByData(env.panel.get('developer-local'), 'role', 'local-package');
  assert.equal(text(findByData(card, 'role', 'source-missing')), '來源資料夾已不存在');
  assert.equal(findByData(card, 'action', 'reinstall-local').disabled, true);
  assert.equal(findByData(card, 'action', 'upload-local').disabled, true);
  assert.equal(findByData(card, 'role', 'source-path').getAttribute('title'), '/work/dev');
  const more = card.children[0].children[1];
  assert.equal(more.disabled, false);
});

test('沒有上傳權限（403）：本機開發中區塊與「從資料夾安裝…」照常可用', async () => {
  const env = await start({ forbidden: true, local: [localPkg()] });
  assert.equal(env.panel.get('btn-dev-upload').disabled, true);
  assert.equal(env.panel.get('btn-dev-install').disabled, false);
  assert.equal(hidden(env.panel, 'developer-local'), false);
  await openInstall(env.panel);
  assert.equal(hidden(env.panel, 'sheet-layer'), false);
});

test('↻ 重新讀取我的資源包時一併重新讀取本機開發中區塊；登出清空區塊', async () => {
  const env = await start({ local: [localPkg()] });
  env.state.local = [localPkg(), localPkg({ packageKey: 'example.next', name: 'example.next', version: '0.2.0' })];
  await env.panel.get('btn-refresh').fire('click'); await settle();
  assert.equal(text(role(env.panel, 'local-heading', env.panel.get('developer-local'))), '本機開發中（2）');
  env.panel.window.RcPanel.resetDeveloper();
  assert.equal(hidden(env.panel, 'developer-local'), true);
  assert.equal(env.panel.get('developer-local').children.length, 0);
});

// ---------- 資源中心：卡片與明細 ----------
const toolList = (codex, claude) => [{ hostId: 'codex', label: 'Codex', deployed: codex }, { hostId: 'claude-code', label: 'Claude Code', deployed: claude }];
const devDeployment = (extra = {}) => ({ id: 'codex|codex-cli|global|/home/a/.codex', hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', rootPath: '/home/a/.codex', version: '0.1.3', source: 'local', sourcePath: '/work/dev', status: 'current', label: 'Codex', backupPaths: [], ...extra });
const devItem = (extra = {}) => ({ packageKey: 'example.dev', name: '示範開發包', type: 'bundle', owner: 'alice', installCount: 3, lastUploadedAt: '2026-11-20T08:00:00Z', latestVisibleVersion: '0.1.2',
  installationStatus: 'current', deployments: [devDeployment()], tools: toolList(true, true), pendingTargets: { count: 0, targets: [] }, lastFailure: null,
  devVersion: '0.1.3', devSourcePath: '/work/dev', devSourceExists: true, canSwitchToMarket: true, ...extra });
const goneItem = (extra = {}) => devItem({ packageKey: 'example.next', name: 'example.next', owner: null, installCount: null, lastUploadedAt: null, latestVisibleVersion: null, canSwitchToMarket: false,
  devVersion: '0.2.0', statusHint: '市集上沒有這個資源包', tools: toolList(true, false), ...extra });
const cardOf = (panel, key) => findByData(panel.get('catalog-list'), 'package-key', key);
const actionNames = (card) => findAllByData(findByData(card, 'slot', 'card-actions'), 'action').map(n => n.getAttribute('data-action'));
const statusOf = (card) => text(findByData(card, 'role', 'status-text'));

test('開發中卡片：藍色左邊（is-dev）、「開發中」徽章＋版本、不算可更新（即使市集有較新的版本）、「改用市集版」與「解除安裝」', async () => {
  const env = await start({ open: false, catalog: [devItem({ installationStatus: 'updateAvailable', latestVisibleVersion: '0.1.9', deployments: [devDeployment(), devDeployment({ id: 'other', source: 'market', status: 'updateAvailable', updateVersion: '0.1.9', version: '0.1.0' })] })] });
  const card = cardOf(env.panel, 'example.dev');
  assert.ok(card.classList.contains('is-dev'));
  assert.equal(card.classList.contains('has-update'), false);
  assert.equal(findByData(card, 'role', 'update-badge'), null, '沒有「可更新」徽章');
  assert.equal(statusOf(card), '開發中 0.1.3');
  assert.equal(text(findByData(card, 'role', 'dev-badge')), '開發中');
  assert.ok(findByData(card, 'role', 'dev-badge').classList.contains('b-dev'));
  assert.equal(findByData(card, 'role', 'status-text').getAttribute('data-kind'), 'dev');
  assert.deepEqual(actionNames(card), ['switch-market', 'uninstall']);
  assert.equal(text(findByData(card, 'action', 'switch-market')), '改用市集版');
  assert.equal(findByData(card, 'action', 'switch-market').classList.contains('btn-primary'), false);
  assert.ok(findByData(card, 'role', 'meta'), '市集有這個資源包時照常顯示擁有者與安裝次數');
});

test('「改用市集版」等同一般安裝（rc.install.run install），不是更新', async () => {
  const env = await start({ open: false, catalog: [devItem()], handlers: { 'rc.install.run': () => done([codexTarget]) } });
  await findByData(cardOf(env.panel, 'example.dev'), 'action', 'switch-market').fire('click'); await settle();
  assert.deepEqual(env.of('rc.install.run').map(c => c.input), [{ packageKey: 'example.dev', action: 'install' }]);
  assert.match(toast(env.panel), /已安裝到 1 個位置/);
});

test('市集沒有這個資源包：資訊列顯示「市集上沒有這個資源包」，沒有「改用市集版」；待補裝時有主要按鈕「補裝」與「N 個新位置」', async () => {
  const pending = { count: 1, targets: [claudeTarget] };
  const env = await start({ open: false, catalog: [goneItem({ pendingTargets: pending })], handlers: { 'rc.install.run': () => done([claudeTarget]) } });
  const card = cardOf(env.panel, 'example.next');
  assert.ok(card.classList.contains('is-dev'));
  assert.equal(text(findByData(card, 'role', 'meta')), '市集上沒有這個資源包');
  assert.equal(findByData(card, 'role', 'status-hint'), null, '提示放在資訊列，不重複');
  assert.equal(statusOf(card), '開發中 0.2.0 · 1 個新位置');
  assert.deepEqual(actionNames(card), ['fill-pending', 'uninstall']);
  assert.ok(findByData(card, 'action', 'fill-pending').classList.contains('btn-primary'));
  await findByData(card, 'action', 'fill-pending').fire('click'); await settle();
  assert.deepEqual(env.of('rc.install.run').map(c => c.input), [{ packageKey: 'example.next', action: 'fillPending' }]);
});

test('開發中版本待補裝但來源資料夾不存在：「補裝」停用並以 title 說明原因，仍可解除安裝；市集有此資源包時同時有「改用市集版」', async () => {
  const reason = '來源資料夾已不存在，無法重新打包：/work/dev。請在「我的資源包」用「從資料夾安裝…」重新指定資料夾。';
  const env = await start({ open: false, catalog: [devItem({ devSourceExists: false, fillUnavailableReason: reason, pendingTargets: { count: 1, targets: [claudeTarget] } })] });
  const card = cardOf(env.panel, 'example.dev');
  assert.deepEqual(actionNames(card), ['fill-pending', 'switch-market', 'uninstall']);
  const fill = findByData(card, 'action', 'fill-pending');
  assert.equal(fill.disabled, true);
  assert.equal(fill.getAttribute('title'), reason);
  assert.equal(findByData(card, 'action', 'uninstall').disabled, false);
  assert.equal(findByData(card, 'action', 'switch-market').disabled, false);
});

test('一般卡片不受影響：沒有 devVersion 的可更新與已安裝卡片照舊', async () => {
  const normal = devItem({ packageKey: 'example.up', name: '一般更新', devVersion: null, devSourcePath: null, canSwitchToMarket: false, installationStatus: 'updateAvailable', latestVisibleVersion: '1.2.0',
    deployments: [devDeployment({ source: 'market', version: '1.0.0', status: 'updateAvailable', updateVersion: '1.2.0' })] });
  const env = await start({ open: false, catalog: [normal] });
  const card = cardOf(env.panel, 'example.up');
  assert.equal(card.classList.contains('is-dev'), false);
  assert.equal(card.classList.contains('has-update'), true);
  assert.equal(statusOf(card), '可更新 1.0.0 → 1.2.0');
  assert.deepEqual(actionNames(card), ['update', 'uninstall']);
});

test('明細頁的狀態列同樣顯示「開發中 x.y.z」與「改用市集版」', async () => {
  const item = devItem();
  const env = await start({ open: false, catalog: [item], handlers: { 'rc.package.getDetails': () => ({ ...item, readme: '', selectedVersion: '0.1.2', recommendedVersion: '0.1.2', versions: [{ version: '0.1.2', channel: 'release', hosts: ['codex'] }], parameters: [] }) } });
  await cardOf(env.panel, 'example.dev').fire('click'); await settle();
  const row = env.panel.get('details-status-row');
  assert.equal(text(findByData(row, 'role', 'status-text')), '開發中 0.1.3');
  assert.equal(text(findByData(row, 'action', 'switch-market')), '改用市集版');
});

test('路徑欄按 Enter 直接預檢（與打包上傳的 sheet 一致）', async () => {
  const env = await start();
  await openInstall(env.panel);
  await type(pathInput(env.panel), '/work/dev');
  await pathInput(env.panel).fire('keydown', { key: 'Enter' }); await settle();
  assert.equal(env.count('rc.dev.install.prepare'), 1);
});

test('本機開發中卡片：「重新安裝」與「上傳…」有滑過說明，來源不存在時說明原因', async () => {
  const env = await start({ local: [localPkg()] });
  const card = findByData(env.panel.get('developer-local'), 'role', 'local-package');
  assert.match(findByData(card, 'action', 'reinstall-local').getAttribute('title'), /安裝到這台電腦.*不會送到市集/);
  assert.match(findByData(card, 'action', 'upload-local').getAttribute('title'), /上傳到市集.*Preview.*版號/);
  const gone = await start({ local: [localPkg({ sourceExists: false })] });
  const missing = findByData(gone.panel.get('developer-local'), 'role', 'local-package');
  assert.equal(findByData(missing, 'action', 'reinstall-local').getAttribute('title'), '來源資料夾已不存在，無法重新安裝');
  assert.equal(findByData(missing, 'action', 'upload-local').getAttribute('title'), '來源資料夾已不存在，無法上傳');
});
