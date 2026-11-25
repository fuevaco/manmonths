import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createFakeSpawner, startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';

const accounts = (id = 'you') => ({ lines: [JSON.stringify({
  ok: true, result: { claude: { activeAccountId: id, accounts: [{ id, home: 'C:\\orca\\' + id, email: id + '@example.com' }] } }
})] });
const version = { lines: ['2.1.331 (Claude Code)'] };
const auth = { lines: ['{"loggedIn":true}'] };
const health = [accounts(), version, auth];
const selection = (result = '{"scope":"in","keys":["demo"]}') => ({ lines: [JSON.stringify({
  type: 'result', is_error: false, result, modelUsage: { 'claude-haiku-5-5': {} }
})] });
const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' });
const delta = (text, type = 'text_delta') => JSON.stringify({
  type: 'stream_event', event: { type: 'content_block_delta', delta: { type, ...(type === 'text_delta' ? { text } : { thinking: text }) } }
});
const resultLine = JSON.stringify({ type: 'result', is_error: false, result: '推薦 [[pkg:demo]]' });
const answer = { lines: [init, delta('推薦 [[pkg:demo]]'), resultLine] };

async function fixture(t, scenarios, { model = '', cliVersion = version, configureSpawn = spawn => spawn, ...deps } = {}) {
  const market = await startFakeMarket({ packages: [{ packageKey: 'demo', type: 'skill', name: '示範資源包', description: '整理會議', latestReleaseVersion: '1.0.0' }] });
  market.override('GET /api/market/packages/demo/versions/1.0.0/readme', () => ({ status: 200, body: { readme: '會議整理說明' } }));
  const setup = [accounts(), cliVersion, auth];
  const spawn = createFakeSpawner([...setup, ...setup, ...scenarios]);
  const worker = startWorker({ deps: { spawn: configureSpawn(spawn), platform: 'win32', execPath: 'C:\\Apps\\Orca\\Orca.exe', env: {
    USERPROFILE: 'C:\\Users\\test', PATH: 'C:\\bin', CLAUDE_CONFIG_DIR: 'inherited', CODEX_HOME: 'inherited', ORCA_CLAUDE_TEST: 'inherited'
  }, ...deps } });
  t.after(async () => { worker.dispose(); await market.close(); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const saved = await worker.call('rc.ai.settings.save', { endpoint: { type: 'local-tool', platform: 'claude-code', name: 'Claude Code', model } });
  await worker.call('rc.ai.settings.save', { activeEndpointId: saved.endpoints[0].id });
  const send = async message => {
    const { streamId } = await worker.call('rc.ai.chat.send', { message });
    return streamId;
  };
  const poll = (streamId, params = {}) => worker.call('rc.ai.chat.poll', { streamId, ...params });
  return { worker, spawn, send, poll };
}

async function until(read, predicate) {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(JSON.stringify(await read()));
}

test('Claude Code 用 Orca 帳號挑選資源包，再回答並回報兩階段的實際模型', async t => {
  const { send, poll } = await fixture(t, [accounts(), selection(), accounts(), answer]);
  const id = await send('怎麼整理會議？');
  const done = await until(() => poll(id), value => !value.running);
  assert.deepEqual(done.messages.at(-1), {
    role: 'assistant', text: '推薦 **示範資源包**', packageKeys: ['demo'],
    reference: { packageCount: 1, keys: ['demo'], names: ['示範資源包'], fallback: false,
      selectModel: 'claude-haiku-5-5', answerModel: 'claude-sonnet-5-5', streamed: true }
  });
  const incremental = await poll(id, { offsets: ['怎麼整理會議？'.length, 0] });
  assert.deepEqual(incremental.updates[0].reference, done.messages.at(-1).reference);
});

test('停止 Claude Code 時保留已收到的文字，Windows 程序未退出時用 taskkill 並清理暫存目錄', async t => {
  let kill, killRequested = false;
  t.after(() => kill?.());
  const { worker, spawn, send, poll } = await fixture(t, [
    accounts(), selection(), accounts(), { lines: [init, delta('已收到')], hang: true }, {}
  ], { configureSpawn: spawn => (file, args, options) => {
    const child = spawn(file, args, options);
    if (args.includes('stream-json')) {
      kill = child.kill;
      child.kill = () => { killRequested = true; return true; };
    }
    if (file === 'taskkill') kill();
    return child;
  } });
  const id = await send('推薦');
  await until(() => poll(id), value => value.messages.at(-1).text === '已收到');
  const cli = spawn.calls.at(-1);
  const stopped = await worker.call('rc.ai.chat.stop', { streamId: id });
  assert.equal(stopped.running, false);
  assert.equal(stopped.messages.at(-1).text, '已收到');
  assert.equal(stopped.messages.at(-1).reference.answerModel, 'claude-sonnet-5-5');
  assert.equal(stopped.messages.at(-1).reference.streamed, true);
  assert.equal(killRequested, true);
  const fallback = await until(async () => spawn.calls.find(call => call.file === 'taskkill'), Boolean);
  assert.deepEqual(fallback.args, ['/PID', String(cli.child.pid), '/T', '/F']);
  await until(async () => access(cli.cwd).then(() => false, error => error.code === 'ENOENT'), Boolean);
});

test('Claude Code 找不到 CLI 時提示安裝或切換端點，並重新檢查狀態', async t => {
  const { worker, spawn, send, poll } = await fixture(t, [accounts(), { error: 'ENOENT' }, accounts(), { error: 'ENOENT' }]);
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, '找不到 Claude Code，請先安裝，或到 AI 設定改用其他端點。');
  await until(() => worker.call('rc.ai.status.get'), status => status.reasonCode === 'missing-cli');
  assert.equal(spawn.calls.filter(call => call.args.includes('-p')).length, 1);
});

test('Claude Code 無登入時顯示本次解析的 Orca 帳號並重新檢查登入狀態', async t => {
  const loggedOut = { lines: ['{"loggedIn":false}'], code: 1 };
  const { worker, spawn, send, poll } = await fixture(t, [
    accounts('switched'), { lines: ['{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'] },
    accounts('switched'), version, loggedOut
  ]);
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, 'Claude Code 的 switched@example.com 尚未登入，請在 Orca 登入後再試。');
  assert.equal(done.messages.at(-1).text, '');
  await until(() => worker.call('rc.ai.status.get'), status => status.reasonCode === 'not-signed-in');
  assert.equal(spawn.calls.filter(call => call.args.includes('-p')).length, 1);
});

test('Claude Code 串流的 result 回報用量上限時，保留已收到的文字並重新檢查狀態', async t => {
  const { worker, send, poll } = await fixture(t, [
    accounts(), selection(), accounts(), { lines: [
      init, delta('已收到'), '{"type":"result","is_error":true,"api_error_status":429,"result":"You\'ve hit your limit"}'
    ] }, ...health
  ]);
  const checkedAt = (await worker.call('rc.ai.status.get')).checkedAt;
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, 'Claude Code 已達用量上限，請稍後再試，或到 AI 設定改用其他端點。');
  assert.equal(done.messages.at(-1).text, '已收到');
  await until(() => worker.call('rc.ai.status.get'), status => status.checkedAt > checkedAt);
});

test('Claude Code 不認得必要參數時，顯示偵測到的版本與建議更新版本', async t => {
  const old = { lines: ['2.0.12 (Claude Code)'] };
  const { worker, send, poll } = await fixture(t, [
    accounts(), { code: 1, stderr: "error: unknown option '--safe-mode'" }, accounts(), old, auth
  ], { cliVersion: old });
  const checkedAt = (await worker.call('rc.ai.status.get')).checkedAt;
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, 'Claude Code 版本過舊（2.0.12），請更新到 2.1.331 以上。');
  const status = await until(() => worker.call('rc.ai.status.get'), status => status.checkedAt > checkedAt);
  assert.equal(status.state, 'ok');
});

test('Claude Code 重新解析每階段的 Orca 帳號，從隔離目錄讀系統提示並經 stdin 接收提問', async t => {
  const prompts = [];
  const { spawn, send, poll } = await fixture(t, [
    accounts('first'), selection(), accounts('second'), answer,
    accounts('third'), selection(), accounts('fourth'), answer
  ], { model: 'custom/claude-opus-5-5', configureSpawn: spawn => (file, args, options) => {
    if (args.includes('-p')) {
      const systemFile = args[args.indexOf('--system-prompt-file') + 1];
      prompts.push({ files: readdirSync(options.cwd), system: readFileSync(systemFile, 'utf8') });
    }
    return spawn(file, args, options);
  } });
  for (const question of ['怎麼整理會議？', '可以說明安裝嗎？']) {
    const id = await send(question);
    const done = await until(() => poll(id), value => !value.running);
    assert.equal(done.messages.at(-1).error, undefined);
  }
  const cli = spawn.calls.slice(6);
  assert.deepEqual(cli.map(call => [call.file, call.args[0]]), [
    ['C:\\Apps\\Orca\\resources\\bin\\orca.exe', 'account'], ['claude', '-p'],
    ['C:\\Apps\\Orca\\resources\\bin\\orca.exe', 'account'], ['claude', '-p'],
    ['C:\\Apps\\Orca\\resources\\bin\\orca.exe', 'account'], ['claude', '-p'],
    ['C:\\Apps\\Orca\\resources\\bin\\orca.exe', 'account'], ['claude', '-p']
  ]);
  const calls = cli.filter(call => call.file === 'claude');
  assert.equal(new Set(calls.map(call => call.cwd)).size, 4);
  for (const [i, call] of calls.entries()) {
    const common = ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--safe-mode',
      '--disable-slash-commands', '--no-session-persistence', '--system-prompt-file', path.join(call.cwd, 'system-prompt.txt')];
    assert.deepEqual(call.args, [...common, ...(i % 2 ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'custom/claude-opus-5-5']
      : ['--output-format', 'json', '--model', 'custom/claude-opus-5-5'])]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.env, { APPDATA: 'C:\\Users\\test\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\test', PATH: 'C:\\bin',
      CLAUDE_CONFIG_DIR: 'C:\\orca\\' + ['first', 'second', 'third', 'fourth'][i] });
    assert.deepEqual(prompts[i].files, ['system-prompt.txt']);
    assert.match(prompts[i].system, /^你沒有任何工具，不要呼叫工具，直接以文字回答。\n/);
    assert.match(prompts[i].system, /示範資源包/);
    await assert.rejects(access(call.cwd), { code: 'ENOENT' });
  }
  assert.doesNotMatch(prompts[0].system, /會議整理說明/);
  assert.match(prompts[1].system, /會議整理說明/);
  assert.equal(calls[1].stdin, '怎麼整理會議？');
  assert.match(calls[2].stdin, /^使用者先前的提問：\n- 怎麼整理會議？\n先前推薦過的資源包：demo\n\n最新提問：可以說明安裝嗎？/);
  assert.doesNotMatch(calls[2].stdin, /推薦 \[\[pkg:/);
  assert.match(calls[2].stdin, /任務：[^\n]+$/);
  assert.equal(calls[3].stdin, '先前的提問：怎麼整理會議？\n\n先前的回答：推薦 [[pkg:demo]]\n\n本次提問：可以說明安裝嗎？');
});

test('Claude Code 選預設時兩個階段都省略 --model，忽略 thinking 與完整訊息，跨 UTF-8 分段仍顯示文字', async t => {
  const stream = { lines: [
    init, delta('思考內容', 'thinking_delta'), delta('第一段'), delta('第二段'),
    '{"type":"assistant","message":{"content":[{"type":"text","text":"第一段第二段"}]}}', resultLine
  ] };
  const { spawn, send, poll } = await fixture(t, [accounts(), selection(), accounts(), stream], {
    configureSpawn: spawn => (file, args, options) => {
      const child = spawn(file, args, options);
      if (args.includes('stream-json')) {
        const write = child.stdout.write.bind(child.stdout);
        child.stdout.write = line => {
          const bytes = Buffer.from(line.trimEnd());
          const fragment = bytes.indexOf(Buffer.from('第')) + 1;
          if (fragment > 0) write(bytes.subarray(0, fragment));
          write(bytes.subarray(fragment));
          if (!line.includes('"type":"result"')) write('\r\n');
        };
      }
      return child;
    }
  });
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).text, '第一段第二段');
  assert.equal(done.messages.at(-1).error, undefined);
  const claudeCalls = spawn.calls.filter(call => call.file === 'claude' && call.args[0] === '-p');
  assert.equal(claudeCalls.length, 2);
  for (const call of claudeCalls) assert.equal(call.args.includes('--model'), false);
});

test('Claude Code 查不到第二階段的 Orca 帳號時立即顯示錯誤，重檢後也不呼叫回答模型', async t => {
  const invalid = { lines: ['{invalid'] };
  const { worker, spawn, send, poll } = await fixture(t, [accounts(), selection(), invalid, invalid]);
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, '無法向 Orca 查詢目前的 Claude Code 帳號，請確認 Orca 運作正常後再試。');
  assert.equal(done.messages.at(-1).reference.answerModel, '');
  await until(() => worker.call('rc.ai.status.get'), status => status.reasonCode === 'account-unavailable');
  assert.equal(spawn.calls.filter(call => call.args.includes('-p')).length, 1);
});

test('Claude Code 的文字 JSON 可擷取第一個物件，無法解析時只用說明，scope out 略過第二階段', async t => {
  const { spawn, send, poll } = await fixture(t, [
    accounts(), selection('以下是結果\n```json\n{"scope":"in","keys":["demo"]}\n```'), accounts(), answer,
    accounts(), selection('無法判斷'), accounts(), answer,
    accounts(), selection('{"scope":"out","keys":[]}')
  ]);
  const ask = async message => {
    const id = await send(message);
    return (await until(() => poll(id), value => !value.running)).messages.at(-1);
  };
  assert.deepEqual((await ask('找整理資源包')).reference.keys, ['demo']);
  const fallback = await ask('有安裝說明嗎？');
  assert.deepEqual(fallback.reference.keys, []);
  assert.equal(fallback.reference.fallback, true);
  assert.equal(fallback.reference.selectModel, 'claude-haiku-5-5');
  const unrelated = await ask('幫我寫一封信');
  assert.match(unrelated.text, /^這個問題不在我的服務範圍。/);
  assert.equal(unrelated.reference.answerModel, '');
  assert.equal(unrelated.reference.streamed, false);
  assert.equal(spawn.calls.filter(call => call.args.includes('stream-json')).length, 2);
});

test('Claude Code 逾時終止回答程序、清理暫存目錄並保留文字', async t => {
  const { spawn, worker, send, poll } = await fixture(t, [
    accounts(), selection(), accounts(), { lines: [init, delta('逾時前的文字')], hang: true }, ...health
  ], { aiChatTimeoutMs: 400 });
  const checkedAt = (await worker.call('rc.ai.status.get')).checkedAt;
  const id = await send('推薦');
  const done = await until(() => poll(id), value => !value.running);
  assert.equal(done.messages.at(-1).error, 'AI 回覆逾時，請再試一次');
  assert.equal(done.messages.at(-1).text, '逾時前的文字');
  const cli = spawn.calls.find(call => call.args.includes('stream-json'));
  assert.equal(cli.child.killed, true);
  await assert.rejects(access(cli.cwd), { code: 'ENOENT' });
  await until(() => worker.call('rc.ai.status.get'), status => status.checkedAt > checkedAt);
});

test('切換 AI 端點後開啟新對話，切換本身不啟動 Codex 對話程序', async t => {
  const codexHealth = [
    { lines: ['{"ok":true,"result":{"codex":{"accounts":[]}}}'] },
    { lines: ['codex-cli 0.172.0'] }, { lines: ['Logged in using ChatGPT'] }
  ];
  const { spawn, worker, send, poll } = await fixture(t, [
    accounts(), selection(), accounts(), answer, ...codexHealth, { code: 1 }, ...health, ...codexHealth
  ]);
  const id = await send('Claude Code 的提問');
  await until(() => poll(id), value => !value.running);
  const saved = await worker.call('rc.ai.settings.save', { endpoint: { type: 'local-tool', platform: 'codex', name: 'Codex' } });
  const target = saved.endpoints.find(endpoint => endpoint.platform === 'codex');
  await worker.call('rc.ai.settings.save', { activeEndpointId: target.id });
  assert.deepEqual((await worker.call('rc.ai.chat.poll')).messages, []);
  // 儲存 Codex 端點時另外啟動 app-server 取模型清單，不開對話。
  const codex = spawn.calls.filter(call => call.file === 'codex');
  assert.deepEqual(codex.map(call => call.args[0]), ['--version', 'login', 'app-server', '--version', 'login']);
  assert.doesNotMatch(codex[2].stdin, /thread.start|turn.start/);
});

test('Claude Code 追問時只攤平最近六輪有效問答，挑選提示仍只保留先前提問和推薦識別碼', async t => {
  const scenarios = Array.from({ length: 8 }, () => [accounts(), selection(), accounts(), answer]).flat();
  const { spawn, send, poll } = await fixture(t, scenarios);
  for (let i = 1; i <= 8; i++) {
    const id = await send(`問題 ${i}`);
    await until(() => poll(id), value => !value.running);
  }
  assert.equal(spawn.calls.at(-1).stdin, [
    ...[2, 3, 4, 5, 6, 7].flatMap(i => [`先前的提問：問題 ${i}`, '先前的回答：推薦 [[pkg:demo]]']),
    '本次提問：問題 8'
  ].join('\n\n'));
  assert.match(spawn.calls.at(-3).stdin, /^使用者先前的提問：\n- 問題 2\n- 問題 3\n- 問題 4\n- 問題 5\n- 問題 6\n- 問題 7\n先前推薦過的資源包：demo/);
  assert.doesNotMatch(spawn.calls.at(-3).stdin, /先前的回答|\[\[pkg:/);
});

test('編輯使用中端點的名稱或模型時保留對話，改平台時開啟新對話', async t => {
  const codexHealth = [
    { lines: ['{"ok":true,"result":{"codex":{"accounts":[]}}}'] },
    { lines: ['codex-cli 0.172.0'] }, { lines: ['Logged in using ChatGPT'] }
  ];
  const { worker, send, poll } = await fixture(t, [
    accounts(), selection(), accounts(), answer, ...health, ...health, ...codexHealth, { code: 1 }, ...codexHealth
  ]);
  const id = await send('Claude Code 的提問');
  await until(() => poll(id), value => !value.running);
  const [endpoint] = (await worker.call('rc.ai.settings.get')).endpoints;
  await worker.call('rc.ai.settings.save', { endpoint: { id: endpoint.id, type: 'local-tool', platform: 'claude-code', name: '改名', model: 'sonnet' } });
  assert.equal((await worker.call('rc.ai.chat.poll')).messages.length, 2);
  await worker.call('rc.ai.settings.save', { endpoint: { id: endpoint.id, type: 'local-tool', platform: 'codex', name: '改名', model: '' } });
  assert.deepEqual((await worker.call('rc.ai.chat.poll')).messages, []);
});

test('Claude Code 選預設時，每次回答後用實際回答模型更新預設模型名稱，換帳號後跟著更新', async t => {
  const answeredBy = model => ({ lines: [JSON.stringify({ type: 'system', subtype: 'init', model }), delta('推薦'), resultLine] });
  const { worker, send, poll } = await fixture(t, [
    accounts(), selection(), accounts(), answer,
    accounts('other'), selection(), accounts('other'), answeredBy('claude-opus-5-5')
  ]);
  const stored = () => worker.state.storage.get('resource-center.ai-settings').endpoints[0];
  assert.equal(stored().defaultModel, '');
  let id = await send('第一題');
  await until(() => poll(id), value => !value.running);
  assert.equal(stored().defaultModel, 'claude-sonnet-5-5');
  assert.equal((await worker.call('rc.ai.settings.get')).endpoints[0].defaultModel, 'claude-sonnet-5-5');
  assert.equal((await worker.call('rc.ai.status.get')).defaultModel, 'claude-sonnet-5-5');
  id = await send('第二題');
  await until(() => poll(id), value => !value.running);
  assert.equal(stored().defaultModel, 'claude-opus-5-5');
});

test('Claude Code 選定模型時，回答不改動預設模型名稱', async t => {
  const { worker, send, poll } = await fixture(t, [accounts(), selection(), accounts(), answer], { model: 'sonnet' });
  const id = await send('推薦');
  await until(() => poll(id), value => !value.running);
  assert.equal(worker.state.storage.get('resource-center.ai-settings').endpoints[0].defaultModel, '');
});
