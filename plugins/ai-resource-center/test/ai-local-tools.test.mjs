import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSpawner, startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';

async function fixture(t, spawn, deps = {}) {
  const market = await startFakeMarket();
  t.after(() => market.close());
  const worker = startWorker({ deps: { spawn, ...deps } });
  t.after(() => worker.dispose());
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return worker;
}

test('偵測回傳兩個 CLI 的版本，較舊的版本仍可用', async t => {
  const spawn = createFakeSpawner([
    { lines: ['2.1.331 (Claude Code)'] }, { lines: ['codex-cli 0.160.0'] }
  ]);
  const worker = await fixture(t, spawn);
  assert.deepEqual(await worker.call('rc.ai.localTools.detect'), {
    'claude-code': { installed: true, version: '2.1.331', versionWarning: '' },
    codex: { installed: true, version: '0.160.0', versionWarning: '低於實測版本 0.172.0，建議更新' }
  });
  assert.deepEqual(spawn.calls.map(call => call.argv), [['claude', '--version'], ['codex', '--version']]);
  assert.ok(spawn.calls.every(call => call.options.shell === false && call.options.windowsHide === true));
});

const windows = {
  platform: 'win32',
  execPath: 'C:\\Apps\\Orca\\Orca.exe',
  env: {
    USERPROFILE: 'C:\\Users\\test', PATH: 'C:\\bin',
    claude_config_dir: 'inherited', CODEX_HOME: 'inherited',
    ORCA_CODEX_HOME: 'inherited', ORCA_CLAUDE_TEST: 'inherited', ORCA_OTHER: 'inherited'
  }
};
const orcaAccounts = result => ({ lines: [JSON.stringify({ id: 'list', ok: true, result })] });
const claudeVersion = { lines: ['2.1.320 (Claude Code)'] };
const claudeAuth = { lines: ['{"loggedIn":true,"email":"cli@example.com"}'] };

test('Claude Code 健康檢查跟隨 Orca 的 host 帳號，舊版仍標示正常', async t => {
  const home = 'C:\\orca\\claude-selected';
  const spawn = createFakeSpawner([orcaAccounts({ claude: {
    activeAccountId: 'legacy',
    activeAccountIdsByRuntime: { host: 'selected', wsl: 'other' },
    accounts: [{ id: 'selected', email: 'you@example.com', home }],
    systemDefaultEmail: 'default@example.com'
  } }), claudeVersion, claudeAuth]);
  const worker = await fixture(t, spawn, windows);
  const status = await worker.call('rc.ai.endpoints.test', { type: 'local-tool', platform: 'claude-code' });
  assert.equal(status.state, 'ok');
  assert.equal(status.platform, 'claude-code');
  assert.equal(status.account, 'you@example.com');
  assert.equal(status.version, '2.1.320');
  assert.equal(status.versionWarning, '低於實測版本 2.1.331，建議更新');
  assert.deepEqual(spawn.calls.map(call => call.argv), [
    ['C:\\Apps\\Orca\\resources\\bin\\orca.exe', 'account', 'list', '--json'],
    ['claude', '--version'], ['claude', 'auth', 'status', '--json']
  ]);
  assert.equal(spawn.calls[0].env.APPDATA, 'C:\\Users\\test\\AppData\\Roaming');
  for (const call of spawn.calls) {
    assert.equal(call.env.PATH, 'C:\\bin');
    assert.ok(Object.keys(call.env).every(key => !/^(ORCA_|CODEX_HOME$|claude_config_dir$)/.test(key)));
  }
  assert.equal(spawn.calls[0].env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(spawn.calls[1].env.CLAUDE_CONFIG_DIR, home);
  assert.equal(spawn.calls[2].env.CLAUDE_CONFIG_DIR, home);
});

test('Codex 優先使用 Orca host 帳號並從 Orca 資料目錄組出 Codex home', async t => {
  const spawn = createFakeSpawner([orcaAccounts({ codex: {
    activeAccountId: 'old',
    activeAccountIdsByRuntime: { host: 'managed', wsl: 'wsl' },
    accounts: [{ id: 'managed', email: 'codex@example.com' }],
    systemDefault: { email: 'default@example.com' }
  } }), { lines: ['codex-cli 0.172.0'] }, { lines: ['Logged in using ChatGPT'] }]);
  const worker = await fixture(t, spawn, { ...windows, env: { ...windows.env, APPDATA: 'D:\\Roaming' } });
  const result = await worker.call('rc.ai.endpoints.test', { type: 'local-tool', platform: 'codex', model: '自訂模型' });
  assert.equal(result.account, 'codex@example.com');
  assert.equal(result.state, 'ok');
  assert.equal(result.model, '自訂模型');
  assert.deepEqual(spawn.calls.slice(1).map(call => call.argv), [['codex', '--version'], ['codex', 'login', 'status']]);
  assert.equal(spawn.calls[0].env.CODEX_HOME, undefined);
  for (const call of spawn.calls.slice(1)) {
    assert.equal(call.env.CODEX_HOME, 'D:\\Roaming\\orca\\codex-accounts\\managed\\home');
    assert.equal(call.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(call.stdin, '');
  }
});

test('保存本機 AI 工具只儲存端點欄位，預設模型可啟用且不使用秘密儲存', async t => {
  const accounts = orcaAccounts({ claude: { accounts: [], systemDefaultEmail: 'default@example.com' } });
  const spawn = createFakeSpawner([accounts, claudeVersion, claudeAuth, accounts, claudeVersion, claudeAuth]);
  const worker = await fixture(t, spawn, windows);
  const reads = t.mock.method(worker.orca.secrets, 'get');
  const writes = t.mock.method(worker.orca.secrets, 'set');
  const result = await worker.call('rc.ai.settings.save', { endpoint: {
    type: 'local-tool', platform: 'claude-code', name: ' Claude Code ',
    baseUrl: 'ignored', pat: 'ignored', account: 'ignored@example.com'
  } });
  const { id, status, hasPat } = result.endpoints[0];
  assert.equal(status.state, 'ok');
  assert.equal(hasPat, false);
  const active = await worker.call('rc.ai.settings.save', { activeEndpointId: id });
  assert.equal(active.activeEndpointId, id);
  assert.deepEqual(worker.state.storage.get('resource-center.ai-settings').endpoints, [
    { id, name: 'Claude Code', type: 'local-tool', platform: 'claude-code', model: '', defaultModel: '' }
  ]);
  assert.equal((await worker.call('rc.ai.status.get')).state, 'ok');
  assert.equal((await worker.call('rc.ai.status.get')).model, '');
  assert.ok(reads.mock.calls.every(({ arguments: [key] }) => !key.startsWith('resource-center.ai-pat.')));
  assert.ok(writes.mock.calls.every(({ arguments: [key] }) => !key.startsWith('resource-center.ai-pat.')));
  await assert.rejects(worker.call('rc.ai.settings.save', { endpoint: { name: '平台錯誤', type: 'local-tool', platform: 'openai' } }), { code: 'invalid_params' });
  await assert.rejects(worker.call('rc.ai.settings.save', { endpoint: { name: ' ', type: 'local-tool', platform: 'codex' } }), { code: 'invalid_params' });
});

test('一個 CLI 查詢逾時時，仍能偵測另一個平台', async t => {
  const spawn = createFakeSpawner([{ hang: true }, { lines: ['codex-cli 0.172.0'] }]);
  const worker = await fixture(t, spawn, { ...windows, aiRequestTimeoutMs: 100 });
  assert.deepEqual(await worker.call('rc.ai.localTools.detect'), {
    'claude-code': { installed: false, version: '', versionWarning: '' },
    codex: { installed: true, version: '0.172.0', versionWarning: '' }
  });
  assert.equal(spawn.calls[0].child.killed, true);
});

for (const [tool, provider, homeVar, version, loggedIn, systemDefault] of [
  ['claude-code', 'claude', 'CLAUDE_CONFIG_DIR', claudeVersion, claudeAuth, { systemDefaultEmail: 'default@example.com' }],
  ['codex', 'codex', 'CODEX_HOME', { lines: ['codex-cli 0.172.0'] }, { lines: ['Logged in using ChatGPT'] }, { systemDefault: { email: 'default@example.com' } }]
]) {
  test(tool + ' 使用系統預設帳號時會清除繼承的設定路徑', async t => {
    const selectedDefault = { activeAccountId: 'default', accounts: [{ id: 'default', runsOnSystemDefault: true, home: 'C:\\ignored', email: 'ignored@example.com' }] };
    const missingSelection = { activeAccountId: null, activeAccountIdsByRuntime: { wsl: 'only-wsl' }, accounts: [{ id: 'only-wsl' }] };
    // Codex 只看有沒有使用中的帳號 id，runsOnSystemDefault 不影響 CODEX_HOME（另見下方測試）。
    const scenarios = tool === 'claude-code' ? [selectedDefault, missingSelection] : [missingSelection];
    const spawn = createFakeSpawner(scenarios.flatMap(selection => [
      orcaAccounts({ [provider]: { ...systemDefault, ...selection } }), version, loggedIn,
      // Codex 的測試連線另外啟動 app-server 取模型清單，這裡讓它直接結束。
      ...(tool === 'codex' ? [{ code: 1 }] : [])
    ]));
    const worker = await fixture(t, spawn, windows);
    for (const selection of scenarios) {
      const result = await worker.call('rc.ai.endpoints.test', { type: 'local-tool', platform: tool });
      assert.equal(result.state, 'ok', JSON.stringify(selection));
      assert.equal(result.account, 'default@example.com');
    }
    assert.ok(spawn.calls.every(call => call.env[homeVar] === undefined));
  });

  test(tool + ' 查不到可解析的 Orca 帳號時，不啟動平台 CLI', async t => {
    const failures = [{ code: 1 }, { lines: ['not a json response'] }, { lines: ['{"ok":false}'] }, orcaAccounts({}), { hang: true }];
    const spawn = createFakeSpawner(failures);
    const worker = await fixture(t, spawn, { ...windows, aiRequestTimeoutMs: 100 });
    for (const failure of failures) {
      const result = await worker.call('rc.ai.endpoints.test', { type: 'local-tool', platform: tool });
      assert.equal(result.state, 'error', JSON.stringify(failure));
      assert.equal(result.reason, '無法向 Orca 查詢目前的帳號，請確認 Orca 運作正常');
      assert.equal(result.account, '');
    }
    assert.equal(spawn.calls.length, failures.length);
    assert.ok(spawn.calls.every(call => call.file.endsWith('orca.exe')));
    assert.equal(spawn.calls.at(-1).child.killed, true);
  });
}

test('啟用中的 Codex 每五分鐘重查 Orca 帳號，切換後使用新的 home 且不呼叫模型', async t => {
  const selected = (id, email) => orcaAccounts({ codex: { accounts: [{ id, email }], activeAccountId: id } });
  const version = { lines: ['codex-cli 0.172.0'] };
  const loggedIn = { lines: ['Logged in using ChatGPT'] };
  const first = [selected('first', 'first@example.com'), version, loggedIn];
  // 儲存時另外啟動 app-server 取模型清單，這裡讓它直接結束。
  const spawn = createFakeSpawner([...first, { code: 1 }, ...first, selected('second', 'second@example.com'), version, loggedIn]);
  const scheduled = new Map();
  let sequence = 0;
  const scheduler = {
    setTimeout(fn, ms) { assert.equal(ms, 300000); scheduled.set(++sequence, fn); return sequence; },
    clearTimeout(id) { scheduled.delete(id); }
  };
  const worker = await fixture(t, spawn, { ...windows, aiScheduler: scheduler });
  const added = await worker.call('rc.ai.settings.save', { endpoint: { name: 'Codex', type: 'local-tool', platform: 'codex', model: 'custom-model' } });
  await worker.call('rc.ai.settings.save', { activeEndpointId: added.endpoints[0].id });
  assert.equal((await worker.call('rc.ai.status.get')).account, 'first@example.com');
  const [id, tick] = [...scheduled][0];
  scheduled.delete(id);
  await tick();
  const status = await worker.call('rc.ai.status.get');
  assert.equal(status.account, 'second@example.com');
  assert.equal(status.model, 'custom-model');
  assert.equal(status.state, 'ok');
  const loginChecks = spawn.calls.filter(call => call.file === 'codex' && call.args[0] === 'login');
  assert.match(loginChecks[1].env.CODEX_HOME, /codex-accounts\\first\\home$/);
  assert.match(loginChecks[2].env.CODEX_HOME, /codex-accounts\\second\\home$/);
  const listing = spawn.calls.filter(call => call.args[0] === 'app-server');
  assert.equal(listing.length, 1);
  assert.doesNotMatch(listing[0].stdin, /thread.start|turn.start/);
  assert.ok(spawn.calls.filter(call => !listing.includes(call))
    .every(call => call.stdin === '' && ['account', '--version', 'login'].includes(call.args[0])));
  await worker.call('rc.session.signOut');
  assert.equal(scheduled.size, 0);
});

test('偵測保留 CLI 預發行版本的名稱，並辨識同版本的預發行版較舊', async t => {
  const spawn = createFakeSpawner([
    { lines: ['2.1.332-next.1 (Claude Code)'] }, { lines: ['codex-cli 0.172.0-alpha.2'] }
  ]);
  const worker = await fixture(t, spawn);
  assert.deepEqual(await worker.call('rc.ai.localTools.detect'), {
    'claude-code': { installed: true, version: '2.1.332-next.1', versionWarning: '' },
    codex: { installed: true, version: '0.172.0-alpha.2', versionWarning: '低於實測版本 0.172.0，建議更新' }
  });
});

test('Codex 用登入狀態的結束碼判斷異常，並保留 Orca 帳號與查到的版本', async t => {
  const accounts = orcaAccounts({ codex: { accounts: [], systemDefault: { email: 'codex@example.com' } } });
  const spawn = createFakeSpawner([accounts, { lines: ['codex-cli 0.172.0'] }, { lines: ['Not logged in'], code: 1 }]);
  const worker = await fixture(t, spawn, windows);
  const result = await worker.call('rc.ai.endpoints.test', { type: 'local-tool', platform: 'codex' });
  assert.equal(result.state, 'error');
  assert.equal(result.reason, 'Codex 未登入（codex@example.com）');
  assert.equal(result.account, 'codex@example.com');
  assert.equal(result.version, '0.172.0');
});

test('Claude Code 的使用中帳號不在 Orca 帳號清單時報錯，不改用系統預設帳號', async t => {
  const spawn = createFakeSpawner([orcaAccounts({ claude: {
    activeAccountIdsByRuntime: { host: 'removed' }, accounts: [{ id: 'other', home: 'C:\\orca\\other' }],
    systemDefaultEmail: 'default@example.com'
  } })]);
  const worker = await fixture(t, spawn, windows);
  const result = await worker.call('rc.ai.endpoints.test', { type: 'local-tool', platform: 'claude-code' });
  assert.equal(result.state, 'error');
  assert.equal(result.reasonCode, 'account-unavailable');
  assert.equal(result.reason, '無法向 Orca 查詢目前的帳號，請確認 Orca 運作正常');
  assert.equal(result.account, '');
  assert.equal(spawn.calls.length, 1);
});

test('Codex 的使用中帳號標記 runsOnSystemDefault 時，仍使用 Orca 帳號目錄', async t => {
  const spawn = createFakeSpawner([orcaAccounts({ codex: {
    activeAccountId: 'default', accounts: [{ id: 'default', runsOnSystemDefault: true, email: 'codex@example.com' }],
    systemDefault: { email: 'system@example.com' }
  } }), { lines: ['codex-cli 0.172.0'] }, { lines: ['Logged in using ChatGPT'] }, { code: 1 }]);
  const worker = await fixture(t, spawn, { ...windows, env: { ...windows.env, APPDATA: 'D:\\Roaming' } });
  const result = await worker.call('rc.ai.endpoints.test', { type: 'local-tool', platform: 'codex' });
  assert.equal(result.state, 'ok');
  assert.equal(result.account, 'codex@example.com');
  for (const call of spawn.calls.slice(1)) assert.equal(call.env.CODEX_HOME, 'D:\\Roaming\\orca\\codex-accounts\\default\\home');
});

const modelsServer = data => ({
  hang: true,
  onStdin(text, call) {
    const { id, method } = JSON.parse(text);
    const reply = result => call.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    if (method === 'initialize') reply({ userAgent: 'codex/0.172.0' });
    if (method === 'model/list') reply({ data, nextCursor: null });
  }
});
const windowsRoaming = { ...windows, env: { ...windows.env, APPDATA: 'D:\\Roaming' } };
const managedCodex = orcaAccounts({ codex: { activeAccountId: 'managed', accounts: [{ id: 'managed', email: 'codex@example.com' }] } });

test('Codex 模型清單唯讀取得：用 Orca 帳號隔離啟動 app-server，過濾隱藏模型，不做登入檢查', async t => {
  const spawn = createFakeSpawner([managedCodex, modelsServer([
    { id: 'a', model: 'gpt-6.2-astra', isDefault: false, hidden: false },
    { id: 'b', model: 'gpt-6.2-sol', isDefault: true, hidden: false },
    { id: 'c', model: 'gpt-5-hidden', isDefault: false, hidden: true }
  ])]);
  const worker = await fixture(t, spawn, windowsRoaming);
  const result = await worker.call('rc.ai.localTools.models', { platform: 'codex' });
  assert.deepEqual(result, { models: ['gpt-6.2-astra', 'gpt-6.2-sol'], defaultModel: 'gpt-6.2-sol', reason: '' });
  assert.deepEqual(spawn.calls.map(call => call.args[0]), ['account', 'app-server']);
  assert.equal(spawn.calls[1].env.CODEX_HOME, 'D:\\Roaming\\orca\\codex-accounts\\managed\\home');
  assert.deepEqual(spawn.calls[1].stdin.trim().split('\n').map(line => JSON.parse(line).method), ['initialize', 'initialized', 'model/list']);
});

test('Claude Code 的模型清單回傳空清單，不啟動任何程序', async t => {
  const spawn = createFakeSpawner([]);
  const worker = await fixture(t, spawn, windowsRoaming);
  assert.deepEqual(await worker.call('rc.ai.localTools.models', { platform: 'claude-code' }), { models: [], defaultModel: '', reason: '' });
  assert.equal(spawn.calls.length, 0);
});

test('Codex 模型清單讀取失敗時回傳空清單與原因，不丟例外', async t => {
  const failures = [[{ code: 1 }], [managedCodex, { code: 1 }]];
  for (const scenarios of failures) {
    const worker = await fixture(t, createFakeSpawner(scenarios), windowsRoaming);
    const result = await worker.call('rc.ai.localTools.models', { platform: 'codex' });
    assert.deepEqual(result.models, []);
    assert.equal(result.defaultModel, '');
    assert.equal(typeof result.reason, 'string');
    assert.notEqual(result.reason, '');
  }
  const worker = await fixture(t, createFakeSpawner([]), windowsRoaming);
  await assert.rejects(worker.call('rc.ai.localTools.models', { platform: 'other' }), { code: 'invalid_params' });
});
