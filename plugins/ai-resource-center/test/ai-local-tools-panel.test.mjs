import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSpawner, startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { findByData, settle, startPanel, textOf } from './panel-harness.mjs';

async function fixture(t, scenarios, deps = {}, { prepare, add = true } = {}) {
  const market = await startFakeMarket();
  t.after(() => market.close());
  const spawn = createFakeSpawner(scenarios);
  const worker = startWorker({ deps: { spawn, ...deps } });
  t.after(() => worker.dispose());
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  await prepare?.(worker);
  const panel = await startPanel(worker.call);
  for (let i = 0; i < 100 && panel.get('view-main').classList.contains('hidden'); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(panel.get('view-main').classList.contains('hidden'), false);
  await panel.get('btn-ai').fire('click');
  if (add) await panel.get('ai-add').fire('click');
  return { panel, worker, spawn };
}
const claudeCli = { lines: ['2.1.331 (Claude Code)'] };
const missing = { error: 'ENOENT' };
const hidden = node => node.classList.contains('hidden');
const customOption = select => select.children.find(option => textOf(option) === '自行輸入…').value;

test('設定開啟時偵測平台，只裝 Claude Code 時 Codex 反灰，切回仍可編輯 OpenAI 相容欄位', async t => {
  const { panel, spawn } = await fixture(t, [claudeCli, missing]);
  assert.deepEqual(spawn.calls.map(call => call.argv), [['claude', '--version'], ['codex', '--version']]);
  assert.equal(panel.get('ai-type-openai').getAttribute('aria-pressed'), 'true');
  assert.equal(panel.get('ai-type-local').getAttribute('aria-pressed'), 'false');
  assert.equal(hidden(panel.get('ai-url-field')), false);
  panel.get('ai-url').value = 'http://endpoint.example';
  panel.get('ai-pat').value = 'test-only';
  await panel.get('ai-type-local').fire('click');
  assert.equal(hidden(panel.get('ai-url-field')), true);
  assert.equal(hidden(panel.get('ai-pat-field')), true);
  assert.equal(hidden(panel.get('ai-openai-model')), true);
  assert.equal(panel.get('ai-platform-claude-code').checked, true);
  assert.equal(panel.get('ai-platform-claude-code-hint').textContent, '已偵測到 2.1.331');
  assert.equal(panel.get('ai-platform-codex').disabled, true);
  assert.equal(panel.get('ai-platform-codex-hint').textContent, '未偵測到 Codex CLI，請先安裝並在 Orca 登入');
  await panel.get('ai-type-openai').fire('click');
  assert.equal(hidden(panel.get('ai-platform-field')), true);
  assert.equal(hidden(panel.get('ai-url-field')), false);
  assert.equal(hidden(panel.get('ai-pat-field')), false);
  assert.equal(hidden(panel.get('ai-openai-model')), false);
  assert.equal(panel.get('ai-url').value, 'http://endpoint.example');
  assert.equal(panel.get('ai-pat').value, 'test-only');
});

test('Claude Code 與 Codex 的模型下拉、提示及說明隨平台切換', async t => {
  const { panel } = await fixture(t, [claudeCli, { lines: ['codex-cli 0.160.0'] }]);
  await panel.get('ai-type-local').fire('click');
  const models = panel.get('ai-local-model');
  assert.deepEqual(models.children.map(textOf), ['預設（依你的 Claude 方案決定）', 'fable', 'opus', 'sonnet', 'haiku', '自行輸入…']);
  assert.equal(panel.get('ai-local-model-hint'), undefined);
  assert.equal(panel.get('ai-local-notice').textContent, '帳號跟隨 Orca，每次提問都使用 Orca 當下選定的 Claude Code 帳號與額度，要換帳號請在 Orca 切換。資源包說明與 README 會送到 Anthropic。請依 Claude Code 的使用條款自行登入。');
  models.value = customOption(models);
  await models.fire('change');
  assert.equal(hidden(panel.get('ai-custom-model-field')), false);
  assert.equal(panel.get('ai-custom-model-hint').textContent, '輸入完整的模型名稱。儲存時不會檢查名稱，第一次提問時才知道能不能用。');
  await panel.get('ai-platform-codex').fire('change');
  assert.equal(panel.get('ai-platform-codex-warning').textContent, '⚠ 低於實測版本 0.172.0，建議更新');
  assert.deepEqual(models.children.map(textOf), ['預設', '自行輸入…']);
  assert.equal(hidden(panel.get('ai-custom-model-field')), true);
  assert.equal(panel.get('ai-local-notice').textContent, '帳號跟隨 Orca，每次提問都使用 Orca 當下選定的 Codex 帳號與額度，要換帳號請在 Orca 切換。資源包說明與 README 會送到 OpenAI。請依 Codex 的使用條款自行登入。');
});

const accounts = { lines: ['{"ok":true,"result":{"claude":{"accounts":[],"systemDefaultEmail":"you@example.com"}}}'] };
const loggedIn = { lines: ['{"loggedIn":true}'] };
const loggedOut = { lines: ['{"loggedIn":false}'], code: 1 };

test('本機 AI 工具的測試連線顯示四種草圖文字', async t => {
  const { panel, spawn } = await fixture(t, [
    claudeCli, missing,
    accounts, claudeCli, loggedIn,
    accounts, claudeCli, loggedOut,
    accounts, missing,
    { code: 1 }
  ]);
  await panel.get('ai-type-local').fire('click');
  for (const [expected, style] of [
    ['✓ 已登入 · Claude Code 2.1.331', 'ai-ok'],
    ['✕ 尚未登入，請在 Orca 登入後再試', 'error'],
    ['✕ 找不到 Claude Code，請先安裝', 'error'],
    ['✕ 無法向 Orca 查詢目前的帳號，請確認 Orca 運作正常', 'error']
  ]) {
    await panel.get('ai-test').fire('click');
    assert.equal(panel.get('ai-test-result').textContent, expected);
    assert.ok(panel.get('ai-test-result').classList.contains(style));
  }
  assert.ok(spawn.calls.every(call => !call.args.includes('-p') && call.stdin === ''));
});

test('本機 AI 工具能儲存預設模型、單選啟用，並顯示帳號及刪除說明', async t => {
  const { panel, worker } = await fixture(t, [
    claudeCli, missing, accounts, claudeCli, loggedIn, accounts, claudeCli, loggedIn
  ]);
  await panel.get('ai-type-local').fire('click');
  panel.get('ai-name').value = 'Claude Code';
  await panel.get('ai-editor').fire('submit');
  assert.equal(hidden(panel.get('ai-editor')), true);
  const [endpoint] = (await worker.call('rc.ai.settings.get')).endpoints;
  assert.equal(endpoint.model, '');
  const list = panel.get('ai-endpoints');
  assert.match(textOf(list), /預設（依你的 Claude 方案決定）/);
  assert.match(textOf(list), /本機 AI 工具 · Claude Code · you@example.com（跟隨 Orca）/);
  await findByData(list, 'ai-select', endpoint.id).fire('change');
  assert.equal((await worker.call('rc.ai.settings.get')).activeEndpointId, endpoint.id);
  await findByData(list, 'ai-delete', endpoint.id).fire('click');
  assert.equal(textOf(panel.get('sheet-title')).trim(), '刪除 AI 端點「Claude Code」？');
  assert.match(textOf(panel.get('sheet-body')), /類型：本機 AI 工具（Claude Code）/);
  assert.match(textOf(panel.get('sheet-body')), /只刪除這個端點設定，不影響 Claude Code 本身或你在 Orca 的登入。/);
  assert.match(textOf(panel.get('sheet-body')), /這是目前使用中的端點，刪除後 AI 助手會變成「未設定」，需要另外選擇端點。/);
});

test('目錄頁 tooltip 顯示本機端點模型、Orca 帳號、檢查時間和版本提示', async t => {
  const older = { lines: ['2.1.320 (Claude Code)'] };
  const { panel } = await fixture(t, [
    older, missing, accounts, older, loggedIn, accounts, older, loggedIn, accounts, older, loggedOut
  ], { now: () => new Date(2026, 10, 25, 14, 32).getTime() });
  await panel.get('ai-type-local').fire('click');
  panel.get('ai-name').value = '自訂名稱';
  panel.get('ai-local-model').value = 'sonnet';
  await panel.get('ai-editor').fire('submit');
  await findByData(panel.get('ai-endpoints'), 'ai-select').fire('change');
  await panel.get('btn-back').fire('click');
  assert.ok(panel.get('ai-status-dot').classList.contains('ok'));
  assert.equal(panel.get('ai-tooltip-state').textContent, '● 正常');
  assert.equal(panel.get('ai-tooltip-model').textContent, 'sonnet');
  assert.equal(panel.get('ai-tooltip-detail').textContent, 'Claude Code · you@example.com（跟隨 Orca）· 14:32 檢查');
  assert.equal(panel.get('ai-tooltip-warning').textContent, '⚠ Claude Code 2.1.320 低於實測版本 2.1.331，建議更新');
  await panel.get('btn-ai').fire('click');
  assert.ok(panel.get('ai-status-dot').classList.contains('error'));
  assert.equal(panel.get('ai-tooltip-state').textContent, '● 異常');
  assert.equal(panel.get('ai-tooltip-model').textContent, '—');
  assert.equal(panel.get('ai-tooltip-detail').textContent, 'Claude Code 未登入（you@example.com）');
  assert.equal(panel.get('ai-tooltip-warning').textContent, '');
});

test('兩個 CLI 都找不到時，反灰顯示本機類型並附草圖說明', async t => {
  const { panel } = await fixture(t, [missing, missing]);
  assert.equal(panel.get('ai-type-local').disabled, true);
  assert.equal(panel.get('ai-local-unavailable').textContent, '未偵測到 Claude Code 或 Codex CLI。安裝並在 Orca 登入後，重新開啟設定頁。');
  await panel.get('ai-type-local').fire('click');
  assert.equal(hidden(panel.get('ai-platform-field')), true);
});

test('Claude Code 對話標題先顯示預設，回答後在標題與參考說明顯示實際模型', async t => {
  const { panel } = await fixture(t, [
    claudeCli, missing, accounts, claudeCli, loggedIn, accounts, claudeCli, loggedIn, accounts, claudeCli, loggedIn,
    accounts, { lines: ['{"type":"result","is_error":false,"result":"{\\"scope\\":\\"in\\",\\"keys\\":[]}","modelUsage":{"claude-haiku-5-5":{}}}'] },
    accounts, { lines: [
      '{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"請參考資源中心。"}}}',
      '{"type":"result","is_error":false}'
    ] }
  ]);
  await panel.get('ai-type-local').fire('click');
  panel.get('ai-name').value = 'Claude Code';
  await panel.get('ai-editor').fire('submit');
  await findByData(panel.get('ai-endpoints'), 'ai-select').fire('change');
  await panel.get('btn-back').fire('click');
  await panel.get('btn-ai').fire('click');
  await settle();
  assert.equal(hidden(panel.get('view-ai-chat')), false);
  assert.equal(panel.get('ai-chat-question').disabled, false);
  assert.equal(panel.get('ai-chat-unavailable').textContent, '');
  assert.equal(panel.get('ai-header-model').textContent, '· 預設（依你的 Claude 方案決定）');
  panel.get('ai-chat-question').value = '請推薦資源包';
  await panel.get('ai-chat-form').fire('submit');
  for (let i = 0; i < 100 && panel.get('ai-chat-send').textContent === '■'; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    for (const timer of panel.timers.calls.filter(call => call.delay === 250)) await panel.timers.fire(timer.id);
  }
  for (const timer of panel.timers.calls.filter(call => call.delay === 5000)) await panel.timers.fire(timer.id);
  assert.equal(panel.get('ai-header-model').textContent, '· claude-sonnet-5-5');
  const reference = panel.get('ai-chat-messages').children.at(-1).children.find(node => node.classList.contains('ai-chat-context'));
  assert.match(reference.textContent, / · 挑選 claude-haiku-5-5 · 回答 claude-sonnet-5-5$/);
  await panel.get('btn-ai-clear').fire('click');
  assert.equal(panel.get('ai-header-model').textContent, '· 預設（claude-sonnet-5-5）');
  await panel.get('btn-back').fire('click');
  assert.equal(panel.get('ai-tooltip-model').textContent, '預設（claude-sonnet-5-5）');
  await panel.get('btn-ai').fire('click');
  await panel.get('btn-ai-settings').fire('click');
  assert.match(textOf(panel.get('ai-endpoints')), /預設（claude-sonnet-5-5）/);
});

test('自行輸入的名稱儲存後，重新編輯會顯示原值', async t => {
  const { panel, worker } = await fixture(t, [claudeCli, missing, accounts, claudeCli, loggedIn, claudeCli, missing]);
  await panel.get('ai-type-local').fire('click');
  panel.get('ai-name').value = 'Claude Code';
  panel.get('ai-local-model').value = customOption(panel.get('ai-local-model'));
  await panel.get('ai-local-model').fire('change');
  const model = 'custom/claude-opus-5-5';
  panel.get('ai-custom-model').value = model;
  await panel.get('ai-editor').fire('submit');
  const [endpoint] = (await worker.call('rc.ai.settings.get')).endpoints;
  assert.equal(endpoint.model, model);
  await findByData(panel.get('ai-endpoints'), 'ai-edit', endpoint.id).fire('click');
  assert.equal(hidden(panel.get('ai-custom-model-field')), false);
  assert.equal(panel.get('ai-local-model').value, customOption(panel.get('ai-local-model')));
  assert.equal(panel.get('ai-custom-model').value, model);
});

const codexCli = { lines: ['codex-cli 0.172.0'] };
// 選到 Codex 時面板會自動讀一次模型清單（帳號查詢與 app-server）。這裡讓它讀不到，改由測試連線取清單。
const autoLoadFails = [{ lines: ['{"ok":true,"result":{"codex":{"accounts":[],"systemDefault":{"email":"you@example.com"}}}}'] }, { code: 1 }];
async function autoLoadDone(spawn) {
  await eventually(() => assert.equal(appServers(spawn).length, 1));
  await new Promise(resolve => setTimeout(resolve, 20));
}
const codexAccounts = { lines: ['{"ok":true,"result":{"codex":{"accounts":[],"systemDefault":{"email":"you@example.com"}}}}'] };
function modelListServer(data) {
  return {
    hang: true,
    onStdin(text, call) {
      const { id, method } = JSON.parse(text);
      const reply = result => call.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      if (method === 'initialize') reply({ userAgent: 'codex/0.172.0' });
      if (method === 'model/list') reply({ data, nextCursor: null });
    }
  };
}

test('Codex 測試連線把 model/list 填進模型下拉，預設顯示清單標記的模型並保留選擇', async t => {
  const { panel, spawn } = await fixture(t, [
    missing, codexCli, ...autoLoadFails, codexAccounts, codexCli, { lines: ['Logged in using ChatGPT'] }, modelListServer([
      { id: 'astra', model: 'gpt-6.2-astra', displayName: 'GPT-6.2 Astra', isDefault: false, hidden: false },
      { id: 'sol', model: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', isDefault: true, hidden: false },
      { id: 'terra', model: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', isDefault: false, hidden: false }
    ])
  ]);
  await panel.get('ai-type-local').fire('click');
  await autoLoadDone(spawn);
  assert.equal(panel.get('ai-platform-codex').checked, true);
  const models = panel.get('ai-local-model');
  assert.deepEqual(models.children.map(textOf), ['預設', '自行輸入…']);
  models.value = customOption(models);
  await models.fire('change');
  panel.get('ai-custom-model').value = 'gpt-6.1-terra';
  await panel.get('ai-test').fire('click');
  assert.equal(panel.get('ai-test-result').textContent, '✓ 已登入 · Codex 0.172.0');
  assert.deepEqual(models.children.map(textOf), ['預設（gpt-6.2-sol）', 'gpt-6.2-astra', 'gpt-6.1-terra', '自行輸入…']);
  assert.deepEqual(models.children.slice(0, -1).map(option => option.value), ['', 'gpt-6.2-astra', 'gpt-6.1-terra']);
  assert.equal(models.value, 'gpt-6.1-terra');
  assert.equal(hidden(panel.get('ai-custom-model-field')), true);
  assert.equal(appServers(spawn).length, 2);
});

test('模型清單裡有名為 custom 的模型時，仍和「自行輸入…」分開', async t => {
  const { panel, worker, spawn } = await fixture(t, [
    missing, codexCli, ...autoLoadFails, codexAccounts, codexCli, { lines: ['Logged in using ChatGPT'] }, modelListServer([
      { id: 'sol', model: 'gpt-6.2-sol', isDefault: true, hidden: false },
      { id: 'custom', model: 'custom', isDefault: false, hidden: false }
    ]),
    codexAccounts, codexCli, { lines: ['Logged in using ChatGPT'] }, { code: 1 }
  ]);
  await panel.get('ai-type-local').fire('click');
  await autoLoadDone(spawn);
  await panel.get('ai-test').fire('click');
  const models = panel.get('ai-local-model');
  assert.deepEqual(models.children.map(textOf), ['預設（gpt-6.2-sol）', 'custom', '自行輸入…']);
  assert.notEqual(customOption(models), 'custom');
  models.value = 'custom';
  await models.fire('change');
  assert.equal(hidden(panel.get('ai-custom-model-field')), true);
  panel.get('ai-name').value = 'Codex';
  await panel.get('ai-editor').fire('submit');
  assert.equal((await worker.call('rc.ai.settings.get')).endpoints[0].model, 'custom');
});

test('Codex 選預設時，清單、tooltip、標題列和下拉選單都附上記錄的預設模型名稱', async t => {
  const codexLoggedIn = { lines: ['Logged in using ChatGPT'] };
  const health = [codexAccounts, codexCli, codexLoggedIn];
  const { panel, spawn } = await fixture(t, [
    missing, codexCli, ...autoLoadFails, ...health, modelListServer([{ id: 'sol', model: 'gpt-6.2-sol', isDefault: true, hidden: false }]),
    ...health, ...health, missing, codexCli, ...autoLoadFails
  ]);
  await panel.get('ai-type-local').fire('click');
  await autoLoadDone(spawn);
  panel.get('ai-name').value = 'Codex';
  await panel.get('ai-editor').fire('submit');
  assert.match(textOf(panel.get('ai-endpoints')), /預設（gpt-6\.2-sol）/);
  await findByData(panel.get('ai-endpoints'), 'ai-select').fire('change');
  await panel.get('btn-back').fire('click');
  assert.equal(panel.get('ai-tooltip-model').textContent, '預設（gpt-6.2-sol）');
  await panel.get('btn-ai').fire('click');
  await settle();
  assert.equal(panel.get('ai-header-model').textContent, '· 預設（gpt-6.2-sol）');
  await panel.get('btn-ai-settings').fire('click');
  await findByData(panel.get('ai-endpoints'), 'ai-edit').fire('click');
  assert.deepEqual(panel.get('ai-local-model').children.map(textOf), ['預設（gpt-6.2-sol）', '自行輸入…']);
});

test('Codex 還不知道預設模型時，標題列顯示「預設」而不是空白', async t => {
  const codexLoggedIn = { lines: ['Logged in using ChatGPT'] };
  const health = [codexAccounts, codexCli, codexLoggedIn];
  const { panel, spawn } = await fixture(t, [missing, codexCli, ...autoLoadFails, ...health, { code: 1 }, ...health, ...health]);
  await panel.get('ai-type-local').fire('click');
  await autoLoadDone(spawn);
  panel.get('ai-name').value = 'Codex';
  await panel.get('ai-editor').fire('submit');
  await findByData(panel.get('ai-endpoints'), 'ai-select').fire('change');
  await panel.get('btn-back').fire('click');
  await panel.get('btn-ai').fire('click');
  await settle();
  assert.equal(panel.get('ai-header-model').textContent, '· 預設');
});

const lunaModels = [
  { id: 'sol', model: 'gpt-6.2-sol', isDefault: true, hidden: false },
  { id: 'luna', model: 'gpt-5.6-luna', isDefault: false, hidden: false },
  { id: 'terra', model: 'gpt-6.1-terra', isDefault: false, hidden: false }
];
const lunaLabels = ['預設（gpt-6.2-sol）', 'gpt-5.6-luna', 'gpt-6.1-terra', '自行輸入…'];
/** 儲存一個 Codex 端點（儲存時會檢查並取一次模型清單，這裡讓清單取不到）。 */
const saveCodex = model => worker => worker.call('rc.ai.settings.save', { endpoint: { name: 'Codex', type: 'local-tool', platform: 'codex', model } });
const savedCodex = [codexAccounts, codexCli, { lines: ['Logged in using ChatGPT'] }, { code: 1 }];
/** 等 release 之後才回覆 model/list，用來觀察清單還沒回來時的畫面。 */
function gatedModelListServer(data) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return { release, server: {
    hang: true,
    onStdin(text, call) {
      const { id, method } = JSON.parse(text);
      const reply = result => call.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      if (method === 'initialize') reply({ userAgent: 'codex/0.172.0' });
      if (method === 'model/list') gate.then(() => reply({ data, nextCursor: null }));
    }
  } };
}
const appServers = spawn => spawn.calls.filter(call => call.args[0] === 'app-server');
/** 背景載入沒有可等待的承諾，輪詢到斷言成立為止。 */
async function eventually(assertion) {
  for (let i = 0; i < 200; i++) {
    try { return assertion(); } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  return assertion();
}
async function openEditor(panel) {
  if (!hidden(panel.get('view-ai-chat'))) await panel.get('btn-ai-settings').fire('click');
  await findByData(panel.get('ai-endpoints'), 'ai-edit').fire('click');
}

test('編輯 Codex 端點時自動載入模型清單並選好已存的模型，不必按測試連線', async t => {
  const { panel, spawn } = await fixture(t, [
    ...savedCodex, missing, codexCli, codexAccounts, modelListServer(lunaModels)
  ], {}, { prepare: saveCodex('gpt-5.6-luna'), add: false });
  await openEditor(panel);
  const models = panel.get('ai-local-model');
  await eventually(() => assert.deepEqual(models.children.map(textOf), lunaLabels));
  assert.equal(models.value, 'gpt-5.6-luna');
  assert.equal(hidden(panel.get('ai-custom-model-field')), true);
  assert.equal(panel.get('ai-test-result').textContent, '');
  assert.equal(appServers(spawn).length, 2);
});

test('清單還沒回來時，已存的模型顯示成一般選項，不變成自行輸入', async t => {
  const gated = gatedModelListServer(lunaModels);
  const { panel, spawn } = await fixture(t, [
    ...savedCodex, missing, codexCli, codexAccounts, gated.server
  ], {}, { prepare: saveCodex('gpt-5.6-luna'), add: false });
  await openEditor(panel);
  await eventually(() => assert.equal(appServers(spawn).length, 2));
  const models = panel.get('ai-local-model');
  assert.deepEqual(models.children.map(textOf), ['預設', 'gpt-5.6-luna', '自行輸入…']);
  assert.equal(models.value, 'gpt-5.6-luna');
  assert.equal(hidden(panel.get('ai-custom-model-field')), true);
  gated.release();
  await eventually(() => assert.deepEqual(models.children.map(textOf), lunaLabels));
  assert.equal(models.value, 'gpt-5.6-luna');
});

test('讀取模型清單失敗時，已存的模型仍是一般選項', async t => {
  const { panel, spawn } = await fixture(t, [
    ...savedCodex, missing, codexCli, codexAccounts, { code: 1 }
  ], {}, { prepare: saveCodex('gpt-5.6-luna'), add: false });
  await openEditor(panel);
  await eventually(() => assert.equal(appServers(spawn).length, 2));
  await settle();
  const models = panel.get('ai-local-model');
  assert.deepEqual(models.children.map(textOf), ['預設', 'gpt-5.6-luna', '自行輸入…']);
  assert.equal(models.value, 'gpt-5.6-luna');
  assert.equal(hidden(panel.get('ai-custom-model-field')), true);
});

test('清單載入後，不在清單裡的已存模型仍顯示成自行輸入', async t => {
  const { panel } = await fixture(t, [
    ...savedCodex, missing, codexCli, codexAccounts, modelListServer(lunaModels)
  ], {}, { prepare: saveCodex('my-private-model'), add: false });
  await openEditor(panel);
  const models = panel.get('ai-local-model');
  await eventually(() => assert.equal(models.children.length, 4));
  assert.equal(models.value, customOption(models));
  assert.equal(panel.get('ai-custom-model').value, 'my-private-model');
  assert.equal(hidden(panel.get('ai-custom-model-field')), false);
});

test('已存的模型剛好是清單的預設模型時，顯示成一般選項，不變成自行輸入', async t => {
  const { panel } = await fixture(t, [
    ...savedCodex, missing, codexCli, codexAccounts, modelListServer(lunaModels)
  ], {}, { prepare: saveCodex('gpt-6.2-sol'), add: false });
  await openEditor(panel);
  const models = panel.get('ai-local-model');
  await eventually(() => assert.deepEqual(models.children.map(textOf),
    ['預設（gpt-6.2-sol）', 'gpt-6.2-sol', 'gpt-5.6-luna', 'gpt-6.1-terra', '自行輸入…']));
  assert.equal(models.value, 'gpt-6.2-sol');
  assert.equal(hidden(panel.get('ai-custom-model-field')), true);
});

test('在編輯區切換到 Codex 平台時才載入模型清單，Claude Code 不載入', async t => {
  const { panel, spawn } = await fixture(t, [
    claudeCli, codexCli, codexAccounts, modelListServer(lunaModels)
  ]);
  await panel.get('ai-type-local').fire('click');
  await settle();
  assert.equal(spawn.calls.length, 2);
  await panel.get('ai-platform-codex').fire('change');
  await eventually(() => assert.deepEqual(panel.get('ai-local-model').children.map(textOf), lunaLabels));
  assert.equal(appServers(spawn).length, 1);
});

test('Codex 是唯一可用的平台時，從 OpenAI 相容切到本機 AI 工具就載入清單', async t => {
  const { panel, spawn } = await fixture(t, [
    missing, codexCli, codexAccounts, modelListServer(lunaModels)
  ]);
  assert.equal(appServers(spawn).length, 0);
  await panel.get('ai-type-local').fire('click');
  await eventually(() => assert.deepEqual(panel.get('ai-local-model').children.map(textOf), lunaLabels));
});

test('再次打開編輯區先顯示快取的清單，背景更新後換成新的', async t => {
  const gated = gatedModelListServer([
    { id: 'new', model: 'gpt-7-new', isDefault: true, hidden: false }, { id: 'luna', model: 'gpt-5.6-luna', isDefault: false, hidden: false }
  ]);
  const { panel, spawn } = await fixture(t, [
    ...savedCodex, missing, codexCli, codexAccounts, modelListServer(lunaModels),
    missing, codexCli, codexAccounts, gated.server
  ], {}, { prepare: saveCodex('gpt-5.6-luna'), add: false });
  const models = panel.get('ai-local-model');
  await openEditor(panel);
  await eventually(() => assert.deepEqual(models.children.map(textOf), lunaLabels));
  await panel.get('ai-cancel').fire('click');
  await openEditor(panel);
  assert.deepEqual(models.children.map(textOf), lunaLabels);
  assert.equal(models.value, 'gpt-5.6-luna');
  await eventually(() => assert.equal(appServers(spawn).length, 3));
  gated.release();
  await eventually(() => assert.deepEqual(models.children.map(textOf), ['預設（gpt-7-new）', 'gpt-5.6-luna', '自行輸入…']));
  assert.equal(models.value, 'gpt-5.6-luna');
});

test('清單晚到時，使用者正在自行輸入的欄位不會被清掉', async t => {
  const gated = gatedModelListServer(lunaModels);
  const { panel, spawn } = await fixture(t, [
    ...savedCodex, missing, codexCli, codexAccounts, gated.server
  ], {}, { prepare: saveCodex(''), add: false });
  await openEditor(panel);
  await eventually(() => assert.equal(appServers(spawn).length, 2));
  const models = panel.get('ai-local-model');
  models.value = customOption(models);
  await models.fire('change');
  gated.release();
  await eventually(() => assert.deepEqual(models.children.map(textOf), lunaLabels));
  assert.equal(models.value, customOption(models));
  assert.equal(hidden(panel.get('ai-custom-model-field')), false);
});

test('編輯區已關閉後才回來的清單被丟棄', async t => {
  const gated = gatedModelListServer(lunaModels);
  const { panel, spawn } = await fixture(t, [
    ...savedCodex, missing, codexCli, codexAccounts, gated.server
  ], {}, { prepare: saveCodex('gpt-5.6-luna'), add: false });
  await openEditor(panel);
  await eventually(() => assert.equal(appServers(spawn).length, 2));
  await panel.get('ai-cancel').fire('click');
  gated.release();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(panel.get('ai-local-model').children.map(textOf), ['預設', 'gpt-5.6-luna', '自行輸入…']);
});
