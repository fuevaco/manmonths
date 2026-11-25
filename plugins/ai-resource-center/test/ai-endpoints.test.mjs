import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startWorker, createHostState, createFakeSpawner, leakedSecrets } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { startPanel, findByData, textOf } from './panel-harness.mjs';

async function fixture(t, deps = {}) {
  const market = await startFakeMarket();
  const state = createHostState();
  const spawn = (...args) => createFakeSpawner([{ error: 'ENOENT' }])(...args);
  const worker = startWorker({ state, deps: { spawn, ...deps } });
  t.after(() => worker.dispose());
  t.after(() => market.close());
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return worker;
}
async function endpoint(t, respond = (req, res) => res.end(JSON.stringify({ data: [{ id: 'sample-model' }] }))) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push({ url: req.url, authorization: req.headers.authorization }); respond(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('AI 端點可保存、重開後讀取，PAT 只進秘密儲存且登出保留設定', async t => {
  const ai = await endpoint(t);
  const worker = await fixture(t);
  const saved = await worker.call('rc.ai.settings.save', { endpoint: { name: '測試服務', baseUrl: ai.url, model: 'sample-model', pat: 'synthetic-ai-secret' } });
  assert.equal(saved.endpoints[0].baseUrl, `${ai.url}/v1`);
  assert.equal(saved.endpoints[0].hasPat, true);
  await worker.call('rc.session.signOut');
  const reopened = startWorker({ state: worker.state });
  t.after(() => reopened.dispose());
  const read = await reopened.call('rc.ai.settings.get');
  assert.equal(read.endpoints[0].name, '測試服務');
  assert.deepEqual(leakedSecrets([...worker.state.transcript, ...worker.state.logs, JSON.stringify([...worker.state.storage])], ['synthetic-ai-secret']), []);
});

test('新端點儲存失敗時移除剛寫入的 PAT，且不留下未儲存的端點', async t => {
  const ai = await endpoint(t);
  const worker = await fixture(t);
  const secrets = [...worker.state.secrets];
  const original = worker.orca.storage.set;
  const mock = t.mock.method(worker.orca.storage, 'set', async (key, value) => {
    if (key === 'resource-center.ai-settings') throw new Error('synthetic-storage-failure');
    return original(key, value);
  });
  await assert.rejects(worker.call('rc.ai.settings.save', { endpoint: {
    name: '測試服務', baseUrl: ai.url, model: 'sample-model', pat: 'synthetic-new-secret'
  } }), { code: 'internal' });
  assert.deepEqual([...worker.state.secrets], secrets);
  assert.deepEqual((await worker.call('rc.ai.settings.get')).endpoints, []);
  mock.mock.restore();
  const saved = await worker.call('rc.ai.settings.save', { endpoint: { name: '重試', baseUrl: ai.url, model: 'sample-model' } });
  assert.equal(saved.endpoints.length, 1);
});

test('自訂端點逾時顯示實際秒數，單次請求計時器不維持程序存活', async t => {
  const ai = await endpoint(t, () => {});
  const worker = await fixture(t, { aiRequestTimeoutMs: 37 });
  const timers = [], original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    const timer = original(fn, ms, ...args);
    if (ms === 37) timers.push(timer);
    return timer;
  });
  const pending = worker.call('rc.ai.endpoints.test', { baseUrl: ai.url });
  await waitFor(() => timers.length > 0);
  assert.equal(timers[0].hasRef(), false);
  const result = await pending;
  assert.equal(result.reason, '連線逾時（0.037 秒）');
});

test('測試連線正規化網址、送出可選 PAT，回傳模型並自動選取唯一模型', async t => {
  const ai = await endpoint(t);
  const worker = await fixture(t);
  for (const [suffix, path] of [['///', '/v1/models'], ['/v1/', '/v1/models'], ['/custom///', '/custom/models']]) {
    const result = await worker.call('rc.ai.endpoints.test', { baseUrl: ai.url + suffix, pat: 'synthetic-ai-secret' });
    assert.deepEqual(result.models, ['sample-model']);
    assert.equal(result.model, 'sample-model');
    assert.equal(ai.requests.at(-1).url, path);
    assert.equal(ai.requests.at(-1).authorization, 'Bearer synthetic-ai-secret');
  }
  await worker.call('rc.ai.endpoints.test', { baseUrl: ai.url, pat: '' });
  assert.equal(ai.requests.at(-1).authorization, undefined);
  for (const baseUrl of ['ftp://127.0.0.1', 'file:///tmp/ai', 'bad-url', `${ai.url}?secret=value`]) {
    await assert.rejects(worker.call('rc.ai.endpoints.test', { baseUrl }), { code: 'invalid_params' });
  }
});

test('儲存會檢查狀態，連線錯誤仍保存且原因不洩漏 PAT', async t => {
  let mode = 'ok';
  const ai = await endpoint(t, (req, res) => {
    if (mode === 'timeout') return;
    res.statusCode = mode === '401' ? 401 : 200;
    res.end(mode === 'bad' ? '{' : JSON.stringify(mode === '401' ? { error: 'synthetic-ai-secret' } : { data: [{ id: 'sample-model' }] }));
  });
  const worker = await fixture(t, { aiRequestTimeoutMs: 30 });
  for (const [state, model, reason] of [['ok', 'sample-model', ''], ['ok', 'missing', '模型'], ['401', 'sample-model', '401'], ['bad', 'sample-model', '格式'], ['timeout', 'sample-model', '逾時']]) {
    mode = state;
    const saved = await worker.call('rc.ai.settings.save', { endpoint: { name: '測試服務', baseUrl: ai.url, model, pat: 'synthetic-ai-secret' } });
    const id = saved.endpoints.at(-1).id;
    await worker.call('rc.ai.settings.save', { activeEndpointId: id });
    const status = await worker.call('rc.ai.status.get');
    assert.equal(status.state, reason ? 'error' : 'ok');
    if (reason) assert.match(status.reason, new RegExp(reason));
  }
  assert.deepEqual(leakedSecrets([...worker.state.transcript, ...worker.state.logs], ['synthetic-ai-secret']), []);
});

test('只有登入且啟用的端點每五分鐘檢查，切換與開啟對話立即檢查，停用與登出停止', async t => {
  const pending = new Map(); let next = 0;
  const scheduler = { setTimeout: (fn, ms) => { assert.equal(ms, 300000); pending.set(++next, fn); return next; }, clearTimeout: id => pending.delete(id) };
  const ai = await endpoint(t);
  const worker = await fixture(t, { aiScheduler: scheduler });
  let saved = await worker.call('rc.ai.settings.save', { endpoint: { name: '服務一', baseUrl: ai.url, model: 'sample-model' } });
  saved = await worker.call('rc.ai.settings.save', { activeEndpointId: saved.endpoints[0].id });
  assert.equal(pending.size, 1);
  const before = ai.requests.length;
  const [id, tick] = [...pending][0]; pending.delete(id); await tick();
  assert.equal(ai.requests.length, before + 1);
  await worker.call('rc.ai.status.check');
  assert.equal(ai.requests.length, before + 2);
  await worker.call('rc.ai.settings.save', { enabled: false });
  assert.equal(pending.size, 0);
  assert.equal((await worker.call('rc.ai.status.get')).state, 'unset');
  await worker.call('rc.ai.settings.save', { enabled: true });
  assert.equal(pending.size, 1);
  await worker.call('rc.session.signOut');
  assert.equal(pending.size, 0);
});

test('編輯留白 PAT 保留既有秘密，刪除啟用端點移除秘密並不切換其他端點', async t => {
  const ai = await endpoint(t);
  const worker = await fixture(t);
  const first = (await worker.call('rc.ai.settings.save', { endpoint: { name: '服務一', baseUrl: ai.url, model: 'sample-model', pat: 'synthetic-ai-secret' } })).endpoints[0];
  await worker.call('rc.ai.settings.save', { endpoint: { ...first, name: '更名', pat: undefined }, activeEndpointId: first.id });
  assert.equal(ai.requests.at(-1).authorization, 'Bearer synthetic-ai-secret');
  await worker.call('rc.ai.settings.save', { endpoint: { name: '服務二', baseUrl: ai.url, model: 'sample-model' } });
  const saved = await worker.call('rc.ai.settings.save', { deleteId: first.id });
  assert.equal(saved.endpoints.length, 1);
  assert.equal(saved.activeEndpointId, null);
  assert.equal((await worker.call('rc.ai.status.get')).state, 'unset');
  assert.ok(![...worker.state.secrets.values()].includes('synthetic-ai-secret'));
});

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(predicate(), '面板未完成更新');
}

test('AI 助手按鈕只在登入後顯示，未設定進入設定頁並可返回目錄', async t => {
  const worker = await fixture(t);
  await worker.call('rc.session.signOut');
  const panel = await startPanel(worker.call);
  await waitFor(() => panel.get('view-login').classList.contains('hidden') === false);
  assert.equal(panel.get('btn-ai').classList.contains('hidden'), true);
  panel.get('in-url').value = worker.state.settings.get('marketUrl');
  panel.get('in-user').value = 'alice'; panel.get('in-pass').value = 'pw-alice';
  await panel.get('login-form').fire('submit');
  assert.equal(panel.get('btn-ai').classList.contains('hidden'), false);
  await panel.get('btn-ai').fire('click');
  assert.equal(panel.get('view-ai-settings').classList.contains('hidden'), false);
  assert.equal(panel.get('header-title').textContent, 'AI 助手設定');
  await panel.get('btn-back').fire('click');
  assert.equal(panel.get('view-main').classList.contains('hidden'), false);
  await panel.get('btn-logout').fire('click');
  assert.equal(panel.get('btn-ai').classList.contains('hidden'), true);
});

test('設定頁即時顯示實際呼叫網址、欄位錯誤，測試連線填入並選取唯一模型', async t => {
  const ai = await endpoint(t);
  const worker = await fixture(t);
  const panel = await startPanel(worker.call);
  await waitFor(() => !panel.get('view-main').classList.contains('hidden'));
  await panel.get('btn-ai').fire('click');
  await panel.get('ai-add').fire('click');
  assert.equal(panel.get('ai-editor').classList.contains('hidden'), false);
  panel.get('ai-url').value = 'file:///tmp/ai';
  await panel.get('ai-url').fire('input');
  assert.equal(panel.get('ai-url-error').classList.contains('hidden'), false);
  panel.get('ai-url').value = ai.url + '/';
  await panel.get('ai-url').fire('input');
  assert.equal(panel.get('ai-url-hint').textContent, `實際呼叫：${ai.url}/v1/models`);
  await panel.get('ai-test').fire('click');
  assert.equal(panel.get('ai-test-result').textContent, '✓ 取得 1 個模型');
  assert.equal(panel.get('ai-model').value, 'sample-model');
});

test('設定頁新增、編輯、單選及刪除端點，已設定時開啟含模型與設定入口的對話殼', async t => {
  const ai = await endpoint(t);
  const worker = await fixture(t);
  const panel = await startPanel(worker.call);
  await waitFor(() => !panel.get('view-main').classList.contains('hidden'));
  await panel.get('btn-ai').fire('click'); await panel.get('ai-add').fire('click');
  panel.get('ai-name').value = '服務一'; panel.get('ai-url').value = ai.url;
  await panel.get('ai-test').fire('click');
  await panel.get('ai-editor').fire('submit');
  assert.match(textOf(panel.get('ai-endpoints')), /服務一/);
  const id = (await worker.call('rc.ai.settings.get')).endpoints[0].id;
  await findByData(panel.get('ai-endpoints'), 'ai-select', id).fire('change');
  await panel.get('btn-back').fire('click');
  await panel.get('btn-ai').fire('click');
  assert.equal(panel.get('view-ai-chat').classList.contains('hidden'), false);
  assert.equal(panel.get('ai-header-model').textContent, '· sample-model');
  assert.match(panel.get('btn-ai').getAttribute('title'), /AI 助手：● 正常 · sample-model\n服務一 · \d\d:\d\d 檢查/);
  await panel.get('btn-ai-settings').fire('click');
  await findByData(panel.get('ai-endpoints'), 'ai-edit', id).fire('click');
  panel.get('ai-name').value = '更名'; await panel.get('ai-editor').fire('submit');
  assert.match(textOf(panel.get('ai-endpoints')), /更名/);
  const editButton = findByData(panel.get('ai-endpoints'), 'ai-edit', id);
  assert.equal(editButton.textContent, '編輯');
  const deleteButton = findByData(panel.get('ai-endpoints'), 'ai-delete', id);
  assert.equal(deleteButton.textContent, '刪除');
  assert.ok(deleteButton.classList.contains('btn-danger-outline'), '刪除鈕為紅字紅框');
  // 按刪除只開確認視窗；取消後端點仍在
  await deleteButton.fire('click');
  assert.equal(panel.get('sheet-layer').classList.contains('hidden'), false);
  assert.match(textOf(panel.get('sheet-title')), /刪除 AI 端點「更名」？/);
  assert.match(textOf(panel.get('sheet-body')), new RegExp(`Base URL：${ai.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(textOf(panel.get('sheet-body')), /一併刪除這個端點儲存的 PAT，刪除後無法復原。/);
  assert.match(textOf(panel.get('sheet-body')), /這是目前使用中的端點，刪除後 AI 助手會變成「未設定」，需要另外選擇端點。/);
  assert.equal(panel.get('sheet-primary').textContent, '刪除');
  assert.ok(panel.get('sheet-primary').classList.contains('btn-danger'), '確認鈕為紅色實心');
  await panel.get('sheet-cancel').fire('click');
  assert.equal(panel.get('sheet-layer').classList.contains('hidden'), true);
  assert.equal((await worker.call('rc.ai.settings.get')).endpoints.length, 1, '取消不刪除');
  // 確認後才刪除
  await findByData(panel.get('ai-endpoints'), 'ai-delete', id).fire('click');
  await panel.get('sheet-primary').fire('click');
  await waitFor(() => panel.get('sheet-layer').classList.contains('hidden'));
  assert.equal((await worker.call('rc.ai.settings.get')).endpoints.length, 0);
  assert.doesNotMatch(textOf(panel.get('ai-endpoints')), /更名/);
});

test('刪除非使用中的端點時，確認視窗不顯示使用中提醒', async t => {
  const ai = await endpoint(t);
  const worker = await fixture(t);
  await worker.call('rc.ai.settings.save', { endpoint: { name: '備援', baseUrl: ai.url, model: 'sample-model' } });
  const panel = await startPanel(worker.call);
  await waitFor(() => !panel.get('view-main').classList.contains('hidden'));
  await panel.get('btn-ai').fire('click'); // 已有端點時開啟對話，再從 ⚙ 進設定
  await panel.get('btn-ai-settings').fire('click');
  const id = (await worker.call('rc.ai.settings.get')).endpoints[0].id;
  await findByData(panel.get('ai-endpoints'), 'ai-delete', id).fire('click');
  assert.match(textOf(panel.get('sheet-title')), /刪除 AI 端點「備援」？/);
  assert.doesNotMatch(textOf(panel.get('sheet-body')), /使用中/);
});

test('端點測試更新已儲存端點的最後狀態，未啟用端點也可在清單讀到', async t => {
  let fail = false;
  const ai = await endpoint(t, (req, res) => { res.statusCode = fail ? 401 : 200; res.end(JSON.stringify({ data: [{ id: 'sample-model' }] })); });
  const worker = await fixture(t);
  const saved = (await worker.call('rc.ai.settings.save', { endpoint: { name: '備援', baseUrl: ai.url, model: 'sample-model' } })).endpoints[0];
  fail = true;
  await worker.call('rc.ai.endpoints.test', { ...saved });
  assert.equal((await worker.call('rc.ai.settings.get')).endpoints[0].status.state, 'error');
});

test('登出後較晚抵達的 AI 設定不重新開啟已登入畫面', async t => {
  const worker = await fixture(t);
  let release, hold = false;
  const panel = await startPanel((method, input) => method === 'rc.ai.settings.get' && hold ? new Promise(resolve => { release = resolve; }) : worker.call(method, input));
  await waitFor(() => !panel.get('view-main').classList.contains('hidden'));
  hold = true;
  const opening = panel.get('btn-ai').fire('click');
  await panel.get('btn-logout').fire('click');
  hold = false; release(await worker.call('rc.ai.settings.get')); await opening;
  assert.equal(panel.get('view-login').classList.contains('hidden'), false);
  assert.equal(panel.get('view-ai-settings').classList.contains('hidden'), true);
});

test('預設五秒限制涵蓋持續傳送但未完成的回應，不跟隨轉址且網路失敗有安全原因', async t => {
  const worker = await fixture(t);
  const slow = await endpoint(t, (req, res) => {
    res.writeHead(200);
    const ticker = setInterval(() => res.write(' '), 100);
    req.on('close', () => clearInterval(ticker));
  });
  const started = Date.now();
  const timeout = await worker.call('rc.ai.endpoints.test', { baseUrl: slow.url });
  assert.equal(timeout.state, 'error');
  assert.match(timeout.reason, /逾時/);
  assert.ok(Date.now() - started >= 4900);
  const target = await endpoint(t);
  const redirect = await endpoint(t, (req, res) => { res.writeHead(302, { location: `${target.url}/v1/models` }); res.end(); });
  const redirected = await worker.call('rc.ai.endpoints.test', { baseUrl: redirect.url, pat: 'synthetic-ai-secret' });
  assert.match(redirected.reason, /302/);
  assert.equal(target.requests.length, 0);
  const broken = await endpoint(t, req => req.socket.destroy());
  assert.match((await worker.call('rc.ai.endpoints.test', { baseUrl: broken.url })).reason, /無法連線/);
});

test('已登入的 worker 重開後不必開啟面板也會恢復端點檢查排程', async t => {
  const ai = await endpoint(t);
  const worker = await fixture(t);
  const saved = await worker.call('rc.ai.settings.save', { endpoint: { name: '服務', baseUrl: ai.url, model: 'sample-model' } });
  await worker.call('rc.ai.settings.save', { activeEndpointId: saved.endpoints[0].id });
  worker.dispose();
  const pending = new Map(); let id = 0;
  const reopened = startWorker({ state: worker.state, deps: { aiScheduler: { setTimeout: (fn, ms) => { pending.set(++id, { fn, ms }); return id; }, clearTimeout: key => pending.delete(key) } } });
  t.after(() => reopened.dispose());
  await waitFor(() => pending.size === 1);
  assert.equal([...pending.values()][0].ms, 300000);
  assert.equal((await reopened.call('rc.ai.status.get')).state, 'ok');
});

test('有多個模型但尚未選用時，儲存端點顯示異常而不誤報正常', async t => {
  const ai = await endpoint(t, (req, res) => res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })));
  const worker = await fixture(t);
  const saved = await worker.call('rc.ai.settings.save', { endpoint: { name: '服務', baseUrl: ai.url, model: '' } });
  assert.equal(saved.endpoints[0].status.state, 'error');
  assert.match(saved.endpoints[0].status.reason, /模型/);
});

test('舊版端點讀成 OpenAI 相容，切換為本機 AI 工具後清除舊 PAT', async t => {
  const spawn = createFakeSpawner([
    { lines: ['{"ok":true,"result":{"claude":{"accounts":[]}}}'] },
    { lines: ['2.1.331 (Claude Code)'] },
    { lines: ['{"loggedIn":true}'] }
  ]);
  const ai = await endpoint(t);
  const worker = await fixture(t);
  const { state } = worker;
  const id = 'legacy-endpoint';
  const secretKey = 'resource-center.ai-pat.' + id;
  state.storage.set('resource-center.ai-settings', {
    enabled: true, activeEndpointId: null, endpoints: [{ id, name: '舊端點', baseUrl: ai.url + '/v1', model: 'sample-model' }]
  });
  state.secrets.set(secretKey, 'synthetic-legacy-pat');
  const reopened = startWorker({ state, deps: { spawn } });
  t.after(() => reopened.dispose());
  const before = (await reopened.call('rc.ai.settings.get')).endpoints[0];
  assert.equal(before.type, 'openai');
  assert.equal(before.hasPat, true);
  assert.equal(Object.hasOwn(state.storage.get('resource-center.ai-settings').endpoints[0], 'type'), false);
  const converted = (await reopened.call('rc.ai.settings.save', {
    endpoint: { id, type: 'local-tool', name: '新端點', platform: 'claude-code', model: '' }
  })).endpoints[0];
  assert.equal(converted.type, 'local-tool');
  assert.equal(converted.id, id);
  assert.equal(converted.hasPat, false);
  assert.equal(state.secrets.has(secretKey), false);
  const reverted = (await reopened.call('rc.ai.settings.save', {
    endpoint: { id, type: 'openai', name: '再切回', baseUrl: ai.url, model: 'sample-model' }
  })).endpoints[0];
  assert.equal(reverted.hasPat, false);
  assert.equal(ai.requests.at(-1).authorization, undefined);
});
