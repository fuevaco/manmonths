import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { startPanel } from './panel-harness.mjs';
import { createFakeSpawner } from './harness.mjs';
import { accounts, health, version, auth, fixture, until, appServer, appServerArgs, requests, failedTurn, modelListServer } from './codex-fixture.mjs';

const isolation = appServerArgs.slice(1);

/** app-server 對指定方法回 JSON-RPC 錯誤，模擬方法或參數不被新版本接受。 */
function rejecting(method, { error = { code: -32601, message: 'Method not found' }, inner = appServer() } = {}) {
  return {
    hang: true,
    onStdin(text, call) {
      if (JSON.parse(text).method !== method) return inner.onStdin(text, call);
      call.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(text).id, error }) + '\n');
    }
  };
}

/** codex exec --json 的事件行，並在收到提示時讀下暫存檔，之後暫存檔會被刪除。 */
function exec(text, { capture, events = [] } = {}) {
  return {
    lines: [
      { type: 'thread.started', thread_id: 'exec-thread' }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'noise', type: 'error', message: 'tool call failed' } },
      ...events,
      ...(text === undefined ? [] : [{ type: 'item.completed', item: { id: 'message', type: 'agent_message', text } }]),
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
    ].map(event => JSON.stringify(event)),
    onStdin(prompt, call) {
      const flag = call.args.find(arg => arg.startsWith('model_instructions_file='));
      capture?.({ files: readdirSync(call.cwd).sort(), prompt, system: readFileSync(JSON.parse(flag.slice(flag.indexOf('=') + 1)), 'utf8'),
        schema: call.args.includes('--output-schema') ? JSON.parse(readFileSync(call.args[call.args.indexOf('--output-schema') + 1], 'utf8')) : null });
    }
  };
}

const selection = '{"scope":"in","keys":["demo"]}';

test('app-server initialize 失敗時兩個階段都改用 codex exec，都帶使用者選的模型並標記相容模式', async t => {
  const captured = [];
  const { spawn, send, poll } = await fixture(t, [accounts('new'), rejecting('initialize'),
    exec(selection, { capture: value => captured.push(value) }),
    exec('推薦 [[pkg:demo]]', { capture: value => captured.push(value) })], { model: 'chosen-answer', defaultModel: 'gpt-6.2-sol' });
  const id = await send('怎麼整理會議？');
  const done = await until(() => poll(id), value => !value.running);
  assert.deepEqual(done.messages.at(-1), {
    role: 'assistant', text: '推薦 **示範資源包**', packageKeys: ['demo'],
    reference: { packageCount: 1, keys: ['demo'], names: ['示範資源包'], fallback: false,
      selectModel: 'chosen-answer', answerModel: 'chosen-answer', streamed: false, appServerFallback: true }
  });
  const calls = spawn.calls;
  assert.deepEqual(calls.map(call => call.args[0]), ['account', 'app-server', 'exec', 'exec']);
  const [, , select, answer] = calls;
  const common = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--sandbox', 'read-only', '--color', 'never', ...isolation];
  const instructions = call => `model_instructions_file=${JSON.stringify(path.join(call.cwd, 'system-prompt.txt'))}`;
  assert.deepEqual(select.args, [...common, '-c', instructions(select), '--output-schema',
    path.join(select.cwd, 'output-schema.json'), '-c', 'model_reasoning_effort="low"', '-m', 'chosen-answer', '-']);
  assert.deepEqual(answer.args, [...common, '-c', instructions(answer), '-m', 'chosen-answer', '-']);
  for (const call of [select, answer]) {
    assert.deepEqual(call.env, { USERPROFILE: 'C:\\Users\\test', APPDATA: 'D:\\Roaming', PATH: 'C:\\bin',
      CODEX_HOME: 'D:\\Roaming\\orca\\codex-accounts\\new\\home' });
    assert.equal(call.options.shell, false);
    assert.notEqual(call.cwd, process.cwd());
    await assert.rejects(access(call.cwd), { code: 'ENOENT' });
  }
  assert.match(captured[0].prompt, /^最新提問：怎麼整理會議？\n\n任務：/);
  assert.equal(captured[1].prompt, '怎麼整理會議？');
  assert.deepEqual(captured[0].schema.required, ['scope', 'keys']);
  assert.equal(captured[1].schema, null);
  assert.match(captured[0].system, /^你沒有任何工具，不要呼叫工具，直接以文字回答。\n/);
  assert.doesNotMatch(captured[0].system, /會議整理說明/);
  assert.match(captured[1].system, /會議整理說明/);
  // 沿用解析出的 CODEX_HOME，cwd 只放提示與 schema，沒有複製任何憑證或設定檔。
  assert.deepEqual(captured[0].files, ['output-schema.json', 'system-prompt.txt']);
  assert.deepEqual(captured[1].files.filter(name => name !== 'output-schema.json'), ['system-prompt.txt']);
  assert.equal(requests(calls[1]).length, 1);
});

/** 第一次 thread/start 正常，第二次被拒絕：只有第二階段退回。 */
function rejectingSecondThread() {
  let starts = 0;
  return appServer({ onRequest({ id, method, write }) {
    if (method !== 'thread/start' || ++starts < 2) return false;
    write({ id, error: { code: -32602, message: 'Invalid params: unknown field' } });
    return true;
  } });
}

test('只有第二階段的 app-server 被拒絕時，第一階段保留 app-server 的模型，仍標記相容模式', async t => {
  const { spawn, send, poll } = await fixture(t, [accounts(), rejectingSecondThread(), exec('第二階段完整回答 [[pkg:demo]]')]);
  const id = await send('怎麼整理會議？');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, undefined);
  assert.equal(done.messages.at(-1).text, '第二階段完整回答 **示範資源包**');
  assert.deepEqual(done.messages.at(-1).reference, { packageCount: 1, keys: ['demo'], names: ['示範資源包'], fallback: false,
    selectModel: 'actual-select', answerModel: '', streamed: false, appServerFallback: true });
  const calls = spawn.calls;
  assert.deepEqual(calls.map(call => call.args[0]), ['account', 'app-server', 'exec']);
  assert.equal(calls[2].args.includes('--output-schema'), false);
  assert.equal(calls[2].args.includes('-m'), false);
  assert.equal(calls[1].child.killed, true);
});

/** 開啟面板會同時做健康檢查，改依指令分派情境，不依啟動順序。 */
async function panelFallback(t, appServers, execs) {
  const lanes = { account: [accounts()], '--version': [version], login: [auth], 'app-server': appServers, exec: execs };
  const spawners = Object.fromEntries(Object.entries(lanes).map(([name, scenarios]) =>
    [name, createFakeSpawner(name === 'account' || name === '--version' || name === 'login' ? Array(20).fill(scenarios[0]) : scenarios)]));
  const routed = (file, args, options) => spawners[args[0]](file, args, options);
  const { worker } = await fixture(t, [], { spawn: routed });
  const panel = await startPanel(worker.call);
  await until(async () => panel.get('view-main').classList.contains('hidden'), hidden => !hidden);
  await panel.get('btn-ai').fire('click');
  panel.get('ai-chat-question').value = '怎麼整理會議？';
  await panel.get('ai-chat-form').fire('submit');
  const context = () => panel.get('ai-chat-messages').children.at(-1)?.children.find(node => node.classList.contains('ai-chat-context'));
  await until(async () => {
    for (const timer of panel.timers.calls.filter(call => call.delay === 250)) await panel.timers.fire(timer.id);
    return panel.get('ai-chat-send').textContent !== '■' && context()?.textContent;
  }, Boolean);
  return { context: context().textContent, title: panel.get('ai-header-model').textContent };
}

test('面板在 Codex 改用相容模式時，ⓘ 兩個階段模型相同時只寫一次並以白話說明沒有逐字顯示', async t => {
  const { context, title } = await panelFallback(t,
    [modelListServer([{ id: 'sol', model: 'gpt-6.2-sol', isDefault: true, hidden: false }]), rejecting('initialize')],
    [exec(selection), exec('完整回答')]);
  assert.equal(context, 'ⓘ 從 1 個資源包中挑出 1 個參考 · 模型 gpt-6.2-sol · 這次以相容模式回答，沒有逐字顯示');
  assert.equal(title, '· gpt-6.2-sol');
});

test('相容模式不知道預設模型時省略模型，標題列仍顯示「預設」', async t => {
  const { context, title } = await panelFallback(t, [{ code: 1 }, rejecting('initialize')], [exec(selection), exec('完整回答')]);
  assert.equal(context, 'ⓘ 從 1 個資源包中挑出 1 個參考 · 這次以相容模式回答，沒有逐字顯示');
  assert.equal(title, '· 預設');
});

test('只有回答階段改用相容模式時，ⓘ 以 app-server 回報的挑選模型為準', async t => {
  const { context } = await panelFallback(t, [{ code: 1 }, rejectingSecondThread()], [exec('完整回答')]);
  assert.equal(context, 'ⓘ 從 1 個資源包中挑出 1 個參考 · 模型 actual-select · 這次以相容模式回答，沒有逐字顯示');
});

test('Codex 選預設而改用相容模式時，兩個階段都以記錄的預設模型名稱帶 -m', async t => {
  const { spawn, send, poll } = await fixture(t, [accounts(), rejecting('initialize'), exec(selection), exec('推薦')], { defaultModel: 'gpt-6.2-sol' });
  const id = await send('怎麼整理會議？');
  const done = await until(() => poll(id), value => !value.running);
  const execs = spawn.calls.filter(call => call.args[0] === 'exec');
  assert.deepEqual(execs.map(call => call.args.slice(-3)), [['-m', 'gpt-6.2-sol', '-'], ['-m', 'gpt-6.2-sol', '-']]);
  assert.equal(done.messages.at(-1).reference.selectModel, 'gpt-6.2-sol');
  assert.equal(done.messages.at(-1).reference.answerModel, 'gpt-6.2-sol');
});

/** exec 已完成一則回答但尚未結束，程序一直存活直到被終止。 */
const hangingExec = () => ({
  hang: true,
  lines: [{ type: 'thread.started', thread_id: 'exec-thread' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: '已收到' } }].map(event => JSON.stringify(event))
});
const execCalls = spawn => spawn.calls.filter(call => call.args[0] === 'exec');

test('停止時終止 exec 子程序，已完成的部分保留並清掉暫存資料夾', async t => {
  const { worker, spawn, send, poll } = await fixture(t, [accounts(), rejecting('initialize'), exec(selection), hangingExec()]);
  const id = await send('推薦');
  const running = await until(() => poll(id), value => value.messages.at(-1).text === '已收到');
  assert.equal(running.running, true);
  const stopped = await worker.call('rc.ai.chat.stop', { streamId: id });
  assert.equal(stopped.running, false);
  assert.equal(stopped.messages.at(-1).text, '已收到');
  assert.equal(stopped.messages.at(-1).error, undefined);
  const cli = execCalls(spawn).at(-1);
  await until(async () => cli.child.killed, Boolean);
  await until(async () => access(cli.cwd).then(() => false, error => error.code === 'ENOENT'), Boolean);
  assert.equal(execCalls(spawn).length, 2);
});

test('逾時時終止 exec 子程序，保留文字並重檢健康狀態', async t => {
  const { worker, spawn, send, poll } = await fixture(t, [accounts(), rejecting('initialize'), exec(selection), hangingExec(), ...health()],
    { aiChatTimeoutMs: 450 });
  const checkedAt = (await worker.call('rc.ai.status.get')).checkedAt;
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, 'AI 回覆逾時，請再試一次');
  assert.equal(done.messages.at(-1).text, '已收到');
  const cli = execCalls(spawn).at(-1);
  assert.equal(cli.child.killed, true);
  await assert.rejects(access(cli.cwd), { code: 'ENOENT' });
  await until(() => worker.call('rc.ai.status.get'), status => status.checkedAt > checkedAt);
});

const GENERIC = '無法取得 AI 回覆，請檢查端點連線或回應格式';
const LOGIN = 'Codex 的 managed@example.com 尚未登入，請在 Orca 登入後再試。';
const LIMIT = 'Codex 已達用量上限，請稍後再試，或到 AI 設定改用其他端點。';

for (const [name, server, expected, options = {}] of [
  ['turn 回報未登入', appServer({ onRequest: failedTurn({ message: '401 Unauthorized', codexErrorInfo: 'unauthorized' }) }), LOGIN],
  ['turn 回報用量上限', appServer({ onRequest: failedTurn({ message: 'limit', codexErrorInfo: 'usageLimitExceeded' }) }), LIMIT],
  ['方法的 JSON-RPC 錯誤說明未登入', rejecting('thread/start', { error: { code: -32000, message: 'Not logged in. Run codex login' } }), LOGIN],
  ['方法的 JSON-RPC 錯誤說明用量上限', rejecting('thread/start', { error: { code: -32000, message: "You've hit your usage limit" } }), LIMIT],
  ['找不到 CLI', { error: 'ENOENT' }, '找不到 Codex，請先安裝，或到 AI 設定改用其他端點。'],
  ['版本過舊', { stderr: 'Error: Unknown feature flag: in_app_browser\n', code: 1 }, 'Codex 版本過舊（0.160.0），請更新到 0.172.0 以上。',
    { cliVersion: { lines: ['codex-cli 0.160.0'] } }],
  ['turn 因模型端錯誤失敗', appServer({ onRequest: failedTurn({ message: 'model overloaded', codexErrorInfo: 'serverOverloaded' }) }), GENERIC]
]) {
  test(`${name}時不退回 exec`, async t => {
    const { spawn, send, poll } = await fixture(t, [accounts(), server, ...health(options.cliVersion)], options);
    const id = await send('推薦');
    const done = await until(() => poll(id), value => !value.running);
    assert.equal(done.messages.at(-1).error, expected);
    assert.equal(done.messages.at(-1).reference?.appServerFallback, undefined);
    assert.equal(execCalls(spawn).length, 0);
  });
}

/** 啟動後立即結束的 app-server，stderr 沒有任何可辨識的訊息。 */
const crashing = { stderr: 'thread panicked at app-server/src/main.rs\n', code: 101 };
const garbled = { hang: true, onStdin(text, call) { call.child.stdout.write('這不是 JSON\n'); } };
const wrongShape = (method, result) => ({ hang: true, onStdin(text, call) {
  const request = JSON.parse(text);
  if (request.method === method) call.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  else appServer().onStdin(text, call);
} });

for (const [name, server] of [
  ['initialize 回應不是物件', wrongShape('initialize', null)],
  ['config/read 方法不被接受', rejecting('config/read')],
  ['thread/start 參數不被接受', rejecting('thread/start', { error: { code: -32602, message: 'Invalid params' } })],
  ['turn/start 參數不被接受', rejecting('turn/start', { error: { code: -32602, message: 'unknown field outputSchema' } })],
  ['thread/start 回應缺少模型', wrongShape('thread/start', { thread: { id: 'thread-1' } })],
  ['回應無法解析成 JSON', garbled],
  ['程序啟動後直接結束', crashing],
  ['程序無法啟動（非找不到 CLI）', { error: 'EACCES' }]
]) {
  test(`app-server ${name}時退回 exec`, async t => {
    const { spawn, send, poll } = await fixture(t, [accounts(), server, exec(selection), exec('推薦 [[pkg:demo]]')]);
    const id = await send('推薦');
    const done = await until(() => poll(id), value => !value.running);
    assert.equal(done.messages.at(-1).error, undefined);
    assert.equal(done.messages.at(-1).text, '推薦 **示範資源包**');
    assert.equal(done.messages.at(-1).reference.appServerFallback, true);
    assert.equal(done.messages.at(-1).reference.streamed, false);
    assert.equal(execCalls(spawn).length, 2);
  });
}

test('已把串流文字交給使用者後 app-server 才失敗，不退回 exec 以免文字重複', async t => {
  const { spawn, send, poll } = await fixture(t, [accounts(), appServer({
    onRequest({ method, params, reply, notify, call }) {
      if (method !== 'turn/start' || params.threadId !== 'thread-2') return false;
      const turn = { id: 'turn-2', items: [], status: 'inProgress' };
      notify('turn/started', { threadId: 'thread-2', turn });
      reply({ turn });
      notify('item/agentMessage/delta', { threadId: 'thread-2', turnId: 'turn-2', itemId: 'message', delta: '已收到' });
      setImmediate(() => call.child.kill());
      return true;
    }
  }), ...health()]);
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).text, '已收到');
  assert.equal(done.messages.at(-1).error, GENERIC);
  assert.equal(execCalls(spawn).length, 0);
});

const failedExec = (...events) => ({ lines: events.map(event => JSON.stringify(event)), code: 1 });

for (const [name, scenario, expected] of [
  ['未登入', failedExec({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } }), LOGIN],
  ['達到用量上限', failedExec({ type: 'error', message: "You've hit your usage limit" }, { type: 'turn.failed', error: { message: "You've hit your usage limit" } }), LIMIT],
  ['其他失敗', failedExec({ type: 'turn.failed', error: { message: 'model overloaded' } }), GENERIC],
  ['沒有完成事件就結束', { lines: [JSON.stringify({ type: 'turn.started' })], code: 0 }, GENERIC],
  ['找不到 CLI', { error: 'ENOENT' }, '找不到 Codex，請先安裝，或到 AI 設定改用其他端點。']
]) {
  test(`exec 回報${name}時顯示草圖錯誤`, async t => {
    const { send, poll } = await fixture(t, [accounts(), rejecting('initialize'), scenario, ...health()]);
    const id = await send('推薦');
    const done = await until(() => poll(id), value => !value.running);
    assert.equal(done.messages.at(-1).error, expected);
    assert.doesNotMatch(expected, /；/);
  });
}

test('turn/completed 通知缺少必要欄位時視為通訊協定失敗並退回 exec', async t => {
  const { send, poll, spawn } = await fixture(t, [accounts(), appServer({
    onRequest({ method, params, reply, notify }) {
      if (method !== 'turn/start') return false;
      const turn = { id: 'turn-1', items: [], status: 'inProgress' };
      notify('turn/started', { threadId: params.threadId, turn });
      reply({ turn });
      notify('turn/completed', { threadId: params.threadId, turnId: 'turn-1' });
      return true;
    }
  }), exec(selection), exec('推薦 [[pkg:demo]]')]);
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).text, '推薦 **示範資源包**');
  assert.equal(execCalls(spawn).length, 2);
});
