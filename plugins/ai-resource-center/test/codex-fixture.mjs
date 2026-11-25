import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createFakeSpawner, startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';

export const accounts = (id = 'managed') => ({ lines: [JSON.stringify({
  ok: true, result: { codex: { activeAccountId: id, accounts: [{ id, email: id + '@example.com' }] } }
})] });
export const version = { lines: ['codex-cli 0.172.0'] };
export const auth = { lines: ['Logged in using ChatGPT'] };
export const health = (cliVersion = version) => [accounts(), cliVersion, auth];

/** app-server 只回 initialize 與 model/list，模擬測試連線與儲存時取模型清單。 */
export function modelListServer(models) {
  return {
    hang: true,
    onStdin(text, call) {
      const { id, method } = JSON.parse(text);
      const reply = result => call.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      if (method === 'initialize') reply({ userAgent: 'codex/0.172.0' });
      if (method === 'model/list') reply({ data: models, nextCursor: null });
    }
  };
}

/**
 * 儲存並啟用 Codex 端點。defaultModel 有值時，儲存時的 model/list 把它標成預設，否則清單取不到。
 * 回傳的 spawn.calls 只含設定完成後的呼叫。
 */
export async function fixture(t, scenarios, { model = '', defaultModel = '', cliVersion = version, ...deps } = {}) {
  const market = await startFakeMarket({ packages: [{
    packageKey: 'demo', type: 'skill', name: '示範資源包', description: '整理會議', latestReleaseVersion: '1.0.0'
  }] });
  market.override('GET /api/market/packages/demo/versions/1.0.0/readme', () => ({ status: 200, body: { readme: '會議整理說明' } }));
  const listing = defaultModel ? modelListServer([{ id: 'default', model: defaultModel, isDefault: true, hidden: false }]) : { code: 1 };
  const spawn = createFakeSpawner([...health(cliVersion), listing, ...health(cliVersion), ...scenarios]);
  const worker = startWorker({ deps: { spawn, platform: 'win32', execPath: 'C:\\Apps\\Orca\\Orca.exe', env: {
    USERPROFILE: 'C:\\Users\\test', APPDATA: 'D:\\Roaming', PATH: 'C:\\bin', CODEX_HOME: 'inherited', CLAUDE_CONFIG_DIR: 'inherited', ORCA_SESSION: 'inherited'
  }, ...deps } });
  t.after(async () => { worker.dispose(); await market.close(); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const saved = await worker.call('rc.ai.settings.save', { endpoint: { type: 'local-tool', platform: 'codex', name: 'Codex', model } });
  await worker.call('rc.ai.settings.save', { activeEndpointId: saved.endpoints[0].id });
  if (!deps.spawn) spawn.calls.splice(0);
  const send = async message => (await worker.call('rc.ai.chat.send', { message })).streamId;
  const poll = streamId => worker.call('rc.ai.chat.poll', { streamId });
  return { worker, spawn, send, poll };
}

export async function until(read, predicate) {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(JSON.stringify(await read()));
}

export function appServer({ selection = '{"scope":"in","keys":["demo"]}', answer = '推薦 [[pkg:demo]]', onRequest } = {}) {
  let thread = 0;
  return {
    hang: true,
    onStdin(text, call) {
      const { id, method, params, error } = JSON.parse(text);
      const write = value => call.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
      const reply = result => write({ id, result });
      const notify = (method, params) => write({ method, params });
      if (onRequest?.({ id, method, params, error, call, reply, notify, write })) return;
      if (method === 'initialize') reply({ userAgent: 'codex/0.172.0' });
      if (method === 'config/read') reply({ config: { mcp_servers: {
        'one.server': { command: 'first-mcp' }, 'second-server': { enabled: true }, disabled: { enabled: false }
      } } });
      if (method === 'thread/start') {
        thread++;
        reply({ thread: { id: 'thread-' + thread }, model: thread === 1 ? 'actual-select' : 'actual-answer' });
      }
      if (method === 'turn/start') {
        const threadId = params.threadId, turnId = 'turn-' + thread;
        const turn = { id: turnId, items: [], status: 'inProgress' };
        notify('turn/started', { threadId, turn });
        reply({ turn });
        const text = thread === 1 ? selection : answer;
        if (thread === 2) notify('item/agentMessage/delta', { threadId, turnId, itemId: 'message', delta: text });
        notify('item/completed', { threadId, turnId, item: { id: 'message', type: 'agentMessage', text } });
        notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
      }
      if (method === 'turn/interrupt') reply({});
    }
  };
}

export const appServerArgs = ['app-server',
  ...['code_mode_host', 'shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'plugins', 'apps', 'remote_plugin',
    'hooks', 'sleep_tool', 'goals', 'computer_use', 'browser_use', 'image_generation', 'view_image', 'tool_suggest',
    'skill_search', 'in_app_browser'].flatMap(feature => ['--disable', feature]),
  ...['notify=[]', 'skills.include_instructions=false', 'project_doc_max_bytes=0', 'web_search="disabled"',
    'include_permissions_instructions=false', 'include_apps_instructions=false', 'include_collaboration_mode_instructions=false',
    'include_environment_context=false'].flatMap(config => ['-c', config])
];
export const requests = call => call.stdin.trim().split('\n').map(line => JSON.parse(line));

export function unfinishedAnswer({ method, params, reply, notify }) {
  if (method !== 'turn/start' || params.threadId !== 'thread-2') return false;
  const threadId = params.threadId, turnId = 'turn-to-interrupt';
  const turn = { id: turnId, items: [], status: 'inProgress' };
  notify('turn/started', { threadId, turn });
  reply({ turn });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'message', delta: '已收到' });
  return true;
}

export function failedTurn(error) {
  return ({ method, params, reply, notify }) => {
    if (method !== 'turn/start') return false;
    const threadId = params.threadId, turn = { id: 'turn-failed', items: [], status: 'inProgress' };
    notify('turn/started', { threadId, turn });
    reply({ turn });
    notify('error', { threadId, turnId: turn.id, willRetry: false, error });
    notify('turn/completed', { threadId, turn: { ...turn, status: 'failed', error } });
    return true;
  };
}
