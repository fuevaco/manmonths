import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { accounts, version, health, fixture, modelListServer, until, appServer, appServerArgs, requests, unfinishedAnswer, failedTurn } from './codex-fixture.mjs';

test('Codex 用當下 Orca 帳號，以同一個隔離程序開兩個 ephemeral 對話，兩個階段都帶使用者選的模型並回報實際模型', async t => {
  const emptyAtInit = [];
  const { spawn, send, poll } = await fixture(t, [accounts('new'), appServer({
    onRequest({ method, call }) {
      if (method === 'initialize') emptyAtInit.push(readdirSync(call.cwd));
    }
  })], { model: 'chosen-answer' });
  const id = await send('怎麼整理會議？');
  const done = await until(() => poll(id), value => !value.running);
  assert.deepEqual(done.messages.at(-1), {
    role: 'assistant', text: '推薦 **示範資源包**', packageKeys: ['demo'],
    reference: { packageCount: 1, keys: ['demo'], names: ['示範資源包'], fallback: false,
      selectModel: 'actual-select', answerModel: 'actual-answer', streamed: true }
  });
  const calls = spawn.calls;
  assert.deepEqual(calls.map(call => call.args[0]), ['account', 'app-server']);
  const cli = calls[1];
  assert.deepEqual(cli.env, { USERPROFILE: 'C:\\Users\\test', APPDATA: 'D:\\Roaming', PATH: 'C:\\bin',
    CODEX_HOME: 'D:\\Roaming\\orca\\codex-accounts\\new\\home' });
  assert.equal(cli.options.shell, false);
  assert.equal(cli.options.windowsHide, true);
  assert.deepEqual(emptyAtInit, [[]]);
  assert.notEqual(cli.cwd, process.cwd());
  await assert.rejects(access(cli.cwd), { code: 'ENOENT' });
  assert.deepEqual(cli.args, appServerArgs);
  const rpc = requests(cli);
  assert.deepEqual(rpc.map(value => value.method), [
    'initialize', 'initialized', 'config/read', 'thread/start', 'turn/start', 'thread/start', 'turn/start'
  ]);
  assert.deepEqual(rpc[0].params.capabilities, { experimentalApi: true });
  assert.deepEqual(rpc[2].params, { cwd: cli.cwd });
  for (const { params } of [rpc[3], rpc[5]]) {
    assert.equal(params.cwd, cli.cwd);
    assert.equal(params.ephemeral, true);
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.approvalPolicy, 'never');
    assert.match(params.baseInstructions, /^你沒有任何工具，不要呼叫工具，直接以文字回答。\n/);
    assert.deepEqual(params.config.mcp_servers, {
      'one.server': { enabled: false }, 'second-server': { enabled: false }, disabled: { enabled: false }
    });
  }
  assert.doesNotMatch(rpc[3].params.baseInstructions, /會議整理說明/);
  assert.match(rpc[5].params.baseInstructions, /會議整理說明/);
  assert.equal(rpc[3].params.model, 'chosen-answer');
  assert.equal(rpc[5].params.model, 'chosen-answer');
  assert.equal(rpc[4].params.threadId, 'thread-1');
  assert.equal(rpc[4].params.effort, 'low');
  assert.deepEqual(rpc[4].params.outputSchema, {
    type: 'object', properties: { scope: { type: 'string', enum: ['in', 'out'] }, keys: { type: 'array', items: { type: 'string' } } },
    required: ['scope', 'keys'], additionalProperties: false
  });
  assert.match(rpc[4].params.input[0].text, /^最新提問：怎麼整理會議？\n\n任務：/);
  assert.deepEqual(rpc[6].params, { threadId: 'thread-2', input: [{ type: 'text', text: '怎麼整理會議？' }] });
});

test('停止 Codex 時先送 turn/interrupt，再終止程序並保留回覆和實際模型', async t => {
  let requestsAtKill;
  const { worker, spawn, send, poll } = await fixture(t, [accounts(), appServer({
    onRequest(event) {
      if (event.method === 'initialize') {
        const kill = event.call.child.kill;
        event.call.child.kill = () => { requestsAtKill = requests(event.call); return kill(); };
      }
      return unfinishedAnswer(event);
    }
  })]);
  const id = await send('推薦');
  const running = await until(() => poll(id), value => value.messages.at(-1).text === '已收到');
  assert.equal(running.running, true);
  const stopped = await worker.call('rc.ai.chat.stop', { streamId: id });
  assert.equal(stopped.running, false);
  assert.equal(stopped.messages.at(-1).text, '已收到');
  assert.equal(stopped.messages.at(-1).reference.answerModel, 'actual-answer');
  const cli = spawn.calls.at(-1);
  await until(async () => cli.child.killed, Boolean);
  assert.equal(requestsAtKill.at(-1).method, 'turn/interrupt');
  assert.deepEqual(requestsAtKill.at(-1).params, { threadId: 'thread-2', turnId: 'turn-to-interrupt' });
  await until(async () => access(cli.cwd).then(() => false, error => error.code === 'ENOENT'), Boolean);
});

test('Codex 逾時中斷已開始的 turn，保留文字並重檢健康狀態', async t => {
  const { worker, spawn, send, poll } = await fixture(t, [
    accounts(), appServer({ onRequest: unfinishedAnswer }), ...health()
  ], { aiChatTimeoutMs: 450 });
  const checkedAt = (await worker.call('rc.ai.status.get')).checkedAt;
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, 'AI 回覆逾時，請再試一次');
  assert.equal(done.messages.at(-1).text, '已收到');
  const cli = spawn.calls.find(call => call.args[0] === 'app-server');
  assert.equal(requests(cli).at(-1).method, 'turn/interrupt');
  assert.deepEqual(requests(cli).at(-1).params, { threadId: 'thread-2', turnId: 'turn-to-interrupt' });
  assert.equal(cli.child.killed, true);
  await assert.rejects(access(cli.cwd), { code: 'ENOENT' });
  await until(() => worker.call('rc.ai.status.get'), status => status.checkedAt > checkedAt);
});

test('Codex 找不到 CLI 時顯示草圖錯誤並重新檢查狀態', async t => {
  const { worker, send, poll } = await fixture(t, [accounts(), { error: 'ENOENT' }, accounts(), { error: 'ENOENT' }]);
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, '找不到 Codex，請先安裝，或到 AI 設定改用其他端點。');
  await until(() => worker.call('rc.ai.status.get'), status => status.reasonCode === 'missing-cli');
});

test('app-server 發來的請求一律回 JSON-RPC 錯誤，雜訊通知與 stderr 不影響回答', async t => {
  const answers = [];
  const { spawn, send, poll } = await fixture(t, [accounts(), appServer({
    onRequest({ id, method, params, error, call, write }) {
      if (error) { answers.push({ id, error }); return true; }
      if (method === 'turn/start' && params.threadId === 'thread-2') {
        call.child.stderr.write('code-mode host is disabled\n');
        write({ method: 'warning', params: { message: 'tool call failed' } });
        write({ method: 'remoteControl/status/changed', params: { status: 'disabled' } });
        write({ id: 'approve-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-2' } });
        write({ id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'thread-2' } });
      }
    }
  })]);
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, undefined);
  assert.equal(done.messages.at(-1).text, '推薦 **示範資源包**');
  assert.deepEqual(answers.map(answer => answer.id), ['approve-1', 7]);
  for (const { error } of answers) assert.equal(typeof error.code, 'number');
  const cli = spawn.calls.find(call => call.args[0] === 'app-server');
  assert.equal(requests(cli).filter(value => value.method === undefined).length, 2);
});

for (const [name, server, expected, options = {}] of [
  ['未登入', appServer({ onRequest: failedTurn({ message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized' }) }),
    'Codex 的 managed@example.com 尚未登入，請在 Orca 登入後再試。'],
  ['達到用量上限', appServer({ onRequest: failedTurn({ message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' }) }),
    'Codex 已達用量上限，請稍後再試，或到 AI 設定改用其他端點。'],
  ['版本過舊', { stderr: 'Error: Unknown feature flag: in_app_browser\n', code: 1 },
    'Codex 版本過舊（0.160.0），請更新到 0.172.0 以上。', { cliVersion: { lines: ['codex-cli 0.160.0'] } }]
]) {
  test(`Codex ${name}時顯示草圖錯誤`, async t => {
    const { send, poll } = await fixture(t, [accounts(), server, ...health(options.cliVersion)], options);
    const id = await send('推薦');
    const done = await until(() => poll(id), value => !value.running);
    assert.equal(done.messages.at(-1).error, expected);
    assert.doesNotMatch(expected, /；/);
  });
}

test('Codex 帳號解析失敗時報錯且不啟動 app-server', async t => {
  const { spawn, send, poll } = await fixture(t, [{ code: 1, lines: ['boom'] }, ...health()]);
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, '無法向 Orca 查詢目前的 Codex 帳號，請確認 Orca 運作正常後再試。');
  assert.equal(spawn.calls.some(call => call.args[0] === 'app-server'), false);
});

const listedModels = [
  { id: 'astra', model: 'gpt-6.2-astra', displayName: 'GPT-6.2 Astra', isDefault: false, hidden: false },
  { id: 'sol', model: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', isDefault: true, hidden: false },
  { id: 'old', model: 'gpt-5-hidden', displayName: 'Hidden', isDefault: false, hidden: true },
  { id: 'terra', model: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', isDefault: false, hidden: false }
];

test('Codex 測試連線另外啟動 app-server 呼叫 model/list，定期檢查不呼叫', async t => {
  const { worker, spawn } = await fixture(t, [...health(), modelListServer(listedModels), ...health()]);
  const [endpoint] = (await worker.call('rc.ai.settings.get')).endpoints;
  const before = spawn.calls.length;
  const result = await worker.call('rc.ai.endpoints.test', { id: endpoint.id, type: 'local-tool', platform: 'codex', model: '' });
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.models, ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra']);
  assert.equal(result.defaultModel, 'gpt-6.2-sol');
  const calls = spawn.calls.slice(before);
  assert.deepEqual(calls.map(call => call.args[0]), ['account', '--version', 'login', 'app-server']);
  const server = calls[3];
  assert.equal(server.env.CODEX_HOME, 'D:\\Roaming\\orca\\codex-accounts\\managed\\home');
  assert.deepEqual(server.args, appServerArgs);
  assert.deepEqual(requests(server).map(value => value.method), ['initialize', 'initialized', 'model/list']);
  await until(async () => server.child.killed, Boolean);
  await assert.rejects(access(server.cwd), { code: 'ENOENT' });
  await worker.call('rc.ai.status.check');
  assert.deepEqual(spawn.calls.slice(before + 4).map(call => call.args[0]), ['account', '--version', 'login']);
  assert.equal(spawn.calls.filter(call => call.args[0] === 'app-server').length, 1);
});

test('Codex 未登入時測試連線不取模型清單', async t => {
  const { worker, spawn } = await fixture(t, [accounts(), version, { lines: ['Not logged in'], code: 1 }]);
  const result = await worker.call('rc.ai.endpoints.test', { type: 'local-tool', platform: 'codex', model: '' });
  assert.equal(result.reasonCode, 'not-signed-in');
  assert.deepEqual(result.models, []);
  assert.equal(result.defaultModel, '');
  assert.equal(spawn.calls.some(call => call.args[0] === 'app-server'), false);
});

test('Codex 在儲存與測試連線時記下 model/list 標記的預設模型，取不到清單時保留原值', async t => {
  const { worker } = await fixture(t, [
    ...health(), modelListServer([{ id: 'next', model: 'gpt-7-sol', isDefault: true, hidden: false }]),
    ...health(), { code: 1 }, ...health()
  ], { defaultModel: 'gpt-6.2-sol' });
  const stored = () => worker.state.storage.get('resource-center.ai-settings').endpoints[0];
  assert.equal(stored().defaultModel, 'gpt-6.2-sol');
  const [endpoint] = (await worker.call('rc.ai.settings.get')).endpoints;
  assert.equal(endpoint.defaultModel, 'gpt-6.2-sol');
  assert.equal((await worker.call('rc.ai.status.get')).defaultModel, 'gpt-6.2-sol');
  await worker.call('rc.ai.endpoints.test', { id: endpoint.id, type: 'local-tool', platform: 'codex', model: '' });
  assert.equal(stored().defaultModel, 'gpt-7-sol');
  assert.equal((await worker.call('rc.ai.status.get')).defaultModel, 'gpt-7-sol');
  await worker.call('rc.ai.settings.save', { endpoint: { id: endpoint.id, type: 'local-tool', platform: 'codex', name: '改名', model: '' } });
  assert.deepEqual(stored(), { id: endpoint.id, name: '改名', type: 'local-tool', platform: 'codex', model: '', defaultModel: 'gpt-7-sol' });
});
