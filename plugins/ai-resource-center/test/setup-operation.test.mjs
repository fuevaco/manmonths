// operation 紀錄、單一 log、秘密遮罩、秘密交付框架與執行 context
// （對照 SetupOperationTests、SetupOperationLogTests、SetupSecretChannelTests、SetupExecutionContextTests、
// SetupSecretDeliveryTests 的靜態部分、SetupCommandOutputTests 的 log 部分）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecretMasker, Placeholder } from '../worker/setup/masker.mjs';
import { openOperationLog } from '../worker/setup/operation-log.mjs';
import { createOperationStore, OperationState, OperationIdPattern } from '../worker/setup/operations.mjs';
import { openSecretChannel, BeginMarker, EndMarker } from '../worker/setup/secret-channel.mjs';
import { createExecutionContext } from '../worker/setup/execution-context.mjs';
import { createSecretManager, setupSecretReference } from '../worker/setup/secrets.mjs';
import { openCanonicalPackage } from '../worker/deploy/canonical-package.mjs';
import { ofBytes } from '../worker/deploy/digest.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';

const KEY = 'demo-setup';
const SECRET = 'fake-vault-pat-0123456789';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-op-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const b64 = value => Buffer.from(value, 'utf8').toString('base64');

// ---------- 遮罩（SetupSecretMaskerTests） ----------

test('已註冊的值與其 base64 形式都會被遮罩；常見鍵值樣式即使是未知秘密也會遮罩', () => {
  const masker = createSecretMasker();
  masker.register('fake-pat-value');
  assert.ok(!masker.mask('used fake-pat-value here').includes('fake-pat-value'));
  assert.ok(!masker.mask(`echoed ${b64('fake-pat-value')}`).includes(b64('fake-pat-value')));
  assert.ok(!masker.mask('password=hunter2').includes('hunter2'));
  assert.ok(!masker.mask('https://market.example/a?token=abc123&x=1').includes('abc123'));
  assert.ok(!masker.mask('api_key: zzz').includes('zzz'));
  assert.equal(masker.mask('https://market.example/a?token=abc123&x=1'), `https://market.example/a?token=${Placeholder}&x=1`);
});

test('較長的秘密先取代，不留殘片；空輸入與空註冊無害', () => {
  const masker = createSecretMasker();
  masker.register('abc'); masker.register('abcdef');
  assert.equal(masker.mask('abcdef'), Placeholder);
  assert.ok(masker.longestSecretLength >= 8);
  const empty = createSecretMasker();
  empty.register(null); empty.register('');
  assert.equal(empty.mask(null), '');
  assert.equal(empty.mask('plain text'), 'plain text');
  assert.equal(empty.longestSecretLength, 0);
});

// ---------- operation store（SetupOperationStoreTests） ----------

test('Create 在回傳前就已落檔、狀態 planned；operation 狀態永遠在家目錄，即使是專案範圍', t => {
  const home = path.join(temp(t), 'home'), project = path.join(temp(t), 'repo');
  const store = createOperationStore({ home });
  const record = store.create({ kind: 'install', packageKey: KEY, packageVersion: '1.0.0', scope: 'project', projectRoot: project });
  assert.equal(fs.existsSync(store.getStatePath(record.operationId)), true);
  assert.deepEqual([record.state, record.sessionCount, record.logPath], ['planned', 0, store.getLogPath(record.operationId)]);
  assert.match(record.operationId, OperationIdPattern);
  assert.ok(store.getStatePath(record.operationId).startsWith(path.resolve(home, 'operations')));
  assert.equal(fs.existsSync(path.join(project, '.lcaipack')), false);
  assert.throws(() => store.create({ kind: 'install', packageKey: KEY, packageVersion: '1.0.0', scope: 'project' }), /project root/);
});

test('七種狀態往返；成功是不可離開的終局；未完成的操作可在同一 id 與 log 下重試', t => {
  const store = createOperationStore({ home: path.join(temp(t), 'home') });
  const record = store.create({ kind: 'install', packageKey: KEY, packageVersion: '1.0.0', scope: 'global' });
  for (const state of ['running', 'incomplete', 'cancelled', 'timed-out', 'failed', 'planned']) {
    store.transition(record.operationId, state);
    assert.equal(store.get(record.operationId).state, state);
  }
  assert.equal(store.beginSession(record.operationId), 1);
  store.transition(record.operationId, OperationState.incomplete, 'setup-command:tfs.install');
  assert.equal(store.beginSession(record.operationId), 2);
  const reloaded = store.get(record.operationId);
  assert.deepEqual([reloaded.operationId, reloaded.logPath, reloaded.state], [record.operationId, record.logPath, 'running']);
  store.transition(record.operationId, 'succeeded');
  assert.throws(() => store.transition(record.operationId, 'running'), /已成功結案/);
  assert.equal(store.isTerminal(store.get(record.operationId)), true);
});

test('checkpoint 與 target 摘要重新讀取後保留；失敗摘要先遮罩、不含換行並截斷，狀態檔不含秘密', t => {
  const store = createOperationStore({ home: path.join(temp(t), 'home') });
  const record = store.create({ kind: 'install', packageKey: KEY, packageVersion: '1.0.0', scope: 'global' });
  store.recordTarget(record.operationId, { targetKey: 'codex|codex-cli|project|c:\\repos\\alpha', result: 'succeeded' });
  store.recordTarget(record.operationId, { targetKey: 'claude|claude-code|project|c:\\repos\\alpha', result: 'failed', detail: 'config 寫入失敗' });
  store.recordTarget(record.operationId, { targetKey: 'claude|claude-code|project|c:\\repos\\alpha', result: 'succeeded' });
  assert.deepEqual(store.get(record.operationId).targets.map(x => x.result), ['succeeded', 'succeeded']);
  const masker = createSecretMasker();
  masker.register(SECRET);
  store.transition(record.operationId, 'failed', 'setup-command:tfs.install', `認證失敗\ntoken=${SECRET}\n請重新設定`, masker);
  const text = fs.readFileSync(store.getStatePath(record.operationId), 'utf8');
  assert.ok(!text.includes(SECRET));
  const summary = store.get(record.operationId).failureSummary;
  assert.ok(summary.includes(Placeholder) && !summary.includes('\n'));
  store.transition(record.operationId, 'failed', undefined, 'x'.repeat(5000));
  assert.ok(store.get(record.operationId).failureSummary.length <= 2001);
});

test('列出時最新在前並忽略外來檔案；找不到的 operation 讀為 null、轉移明確失敗；id 形狀不合法一律拒絕', t => {
  const store = createOperationStore({ home: path.join(temp(t), 'home') });
  const first = store.create({ kind: 'install', packageKey: KEY, packageVersion: '1.0.0', scope: 'global' });
  const second = store.create({ kind: 'update', packageKey: KEY, packageVersion: '1.1.0', scope: 'global' });
  fs.writeFileSync(path.join(store.directoryPath, 'op-not-an-id.json'), '{}');
  fs.writeFileSync(path.join(store.directoryPath, 'notes.json'), '{}');
  const ids = store.list().map(r => r.operationId);
  assert.deepEqual(ids, [first.operationId, second.operationId].sort().reverse());
  const missing = 'op-20260821T120000Z-deadbeef';
  assert.equal(store.get(missing), null);
  assert.throws(() => store.transition(missing, 'running'), /找不到 operation/);
  for (const bad of ['../../etc/passwd', 'op-20260821T120000Z-DEADBEEF', 'op-1']) assert.throws(() => store.ensureValidId(bad), /不是合法的 OperationId/);
  assert.equal(store.ensureValidId(missing), missing);
});

test('損壞或格式版本不支援的狀態檔明確失敗；紀錄不含參數值或秘密欄位；序列化與 .NET 版欄位順序相同', t => {
  const home = path.join(temp(t), 'home');
  const store = createOperationStore({ home, now: () => new Date('2026-08-21T01:02:03.456Z') });
  const record = store.create({ kind: 'install', packageKey: KEY, packageVersion: '1.0.0', scope: 'global' });
  const text = fs.readFileSync(store.getStatePath(record.operationId), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['operationFormatVersion', 'operationId', 'kind', 'packageKey', 'packageVersion', 'scope', 'projectRoot', 'state', 'checkpoint',
    'targets', 'logPath', 'sessionCount', 'failureSummary', 'localSourcePath', 'createdAt', 'updatedAt']);
  assert.ok(text.includes('"createdAt": "2026-08-21T01:02:03.456+00:00"'));
  const names = Object.keys(JSON.parse(text));
  for (const forbidden of ['parameters', 'values', 'secrets']) assert.ok(!names.includes(forbidden));
  fs.writeFileSync(store.getStatePath(record.operationId), '{ broken');
  assert.throws(() => store.get(record.operationId), /setup 狀態檔|operation/);
  fs.writeFileSync(store.getStatePath(record.operationId), '{"operationFormatVersion":77,"operationId":"x"}');
  assert.throws(() => store.get(record.operationId), /77/);
});

// ---------- operation log（SetupOperationLogTests） ----------

function newOperation(t) {
  const store = createOperationStore({ home: path.join(temp(t), 'home') });
  const record = store.create({ kind: 'install', packageKey: KEY, packageVersion: '1.0.0', scope: 'global' });
  return { store, record, open: (masker = createSecretMasker(), reason = 'first-run') => openOperationLog({ logPath: record.logPath, masker, sessionNumber: store.beginSession(record.operationId), reason }) };
}
const maskerWith = (...secrets) => { const m = createSecretMasker(); secrets.forEach(s => m.register(s)); return m; };

test('每個 operation 一個 UTF-8 無 BOM 的 log；重試追加 session 標頭到同一個檔案且永不截斷', t => {
  const { store, record, open } = newOperation(t);
  const first = open(); first.writeNote('安裝設定開始'); first.close();
  const bytes = fs.readFileSync(record.logPath);
  assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
  assert.ok(bytes.toString('utf8').includes('安裝設定開始'));
  const length = bytes.length;
  const second = open(createSecretMasker(), 'retry'); second.writeNote('第二次'); second.close();
  const text = fs.readFileSync(record.logPath, 'utf8');
  assert.ok(fs.statSync(record.logPath).size > length);
  assert.ok(text.includes('=== session 1 |') && text.includes('=== session 2 |') && text.includes('first-run') && text.includes('retry') && text.includes('安裝設定開始'));
  assert.equal(fs.readdirSync(store.directoryPath).filter(f => f.endsWith('.log')).length, 1);
});

test('argv、exit code、耗時、取消、逾時與 target 結果都被記錄', t => {
  const { record, open } = newOperation(t);
  const log = open();
  log.writeCommandStart('tfs.install', 'powershell', 'setup/install.ps1', ['-CollectionUrl', 'https://tfs.example.local']);
  log.writeCommandEnd('tfs.install', 3, 12000);
  log.writeCancelled('tfs.verify', 1000);
  log.writeTimedOut('tfs.slow', 30 * 60 * 1000);
  log.writeTargetResult('codex|codex-cli|global|c:\\users\\dev', 'succeeded');
  log.close();
  const text = fs.readFileSync(record.logPath, 'utf8');
  for (const expected of ['[command-start] tfs.install runner=powershell script=setup/install.ps1', 'argv=[-CollectionUrl https://tfs.example.local]', '[command-end] tfs.install exitCode=3 durationMs=12000',
    '[cancelled] tfs.verify', '[timed-out] tfs.slow timeoutMinutes=30', '[target] codex|codex-cli|global|c:\\users\\dev result=succeeded']) assert.ok(text.includes(expected), expected);
});

test('stdout 與 stderr 分別標示', t => {
  const { record, open } = newOperation(t);
  const log = open(); log.writeStdout('正在準備 Node\n'); log.writeStderr('警告：找不到 pwsh 7\n'); log.close();
  const text = fs.readFileSync(record.logPath, 'utf8');
  assert.ok(text.includes('[stdout] 正在準備 Node') && text.includes('[stderr] 警告：找不到 pwsh 7'));
});

test('被切成任意 chunk 的秘密永遠不會寫入檔案（逐字元到 11 字元的切法）', t => {
  for (const chunkSize of [1, 2, 3, 5, 7, 11]) {
    const { record, open } = newOperation(t);
    const log = open(maskerWith(SECRET));
    const payload = `prefix ${SECRET} suffix\ndone\n`;
    for (let i = 0; i < payload.length; i += chunkSize) log.writeStdout(payload.slice(i, i + chunkSize));
    log.close();
    const text = fs.readFileSync(record.logPath, 'utf8');
    assert.ok(!text.includes(SECRET), `chunk ${chunkSize}`);
    assert.ok(text.includes(Placeholder) && text.includes('done'));
  }
});

test('沒有換行結尾又被切開的秘密，在關閉時仍被遮罩', t => {
  const { record, open } = newOperation(t);
  const log = open(maskerWith(SECRET));
  log.writeStdout('tail ' + SECRET.slice(0, 10)); log.writeStdout(SECRET.slice(10)); log.close();
  const text = fs.readFileSync(record.logPath, 'utf8');
  assert.ok(!text.includes(SECRET) && text.includes(Placeholder));
});

test('秘密在 argv、說明、細節與 session 原因中都被遮罩；秘密的 base64 回吐與未知的第三方秘密也被遮罩', t => {
  const { record, open } = newOperation(t);
  const log = open(maskerWith(SECRET), `retry after ${SECRET}`);
  log.writeNote(`note ${SECRET}`);
  log.writeCommandStart('tfs.install', 'powershell', 'setup/install.ps1', [`--pat=${SECRET}`]);
  log.writeTargetResult('codex|codex-cli|global|root', 'failed', `detail ${SECRET}`);
  log.writeStderr(`error ${SECRET}\n`);
  log.writeStdout(`received ${b64(SECRET)}\n`);
  log.writeStdout('azure token=zzz-not-registered-value\n');
  log.close();
  const text = fs.readFileSync(record.logPath, 'utf8');
  for (const leaked of [SECRET, b64(SECRET), 'zzz-not-registered-value']) assert.ok(!text.includes(leaked), leaked);
});

test('沒有換行的超長單行仍會前進，不會無上限累積', t => {
  const { record, open } = newOperation(t);
  const log = open(maskerWith(SECRET));
  for (let i = 0; i < 200; i++) log.writeStdout('x'.repeat(1024));
  log.flushStreams(); log.close();
  const text = fs.readFileSync(record.logPath, 'utf8');
  assert.ok(text.includes('x'.repeat(1024)) && !text.includes(SECRET));
});

// ---------- 秘密交付框架（SetupSecretChannelTests） ----------

function channelFixture() {
  const store = memoryStore();
  const manager = createSecretManager(store);
  const declarations = [{ parameterId: 'setup-pat', usage: 'setup-time', required: true }, { parameterId: 'runtime-pat', usage: 'runtime', required: true },
    { parameterId: 'optional-pat', usage: 'setup-time', required: false }];
  const put = (parameterId, value) => manager.set(setupSecretReference({ packageKey: KEY, parameterId, scope: 'global', canonicalRoot: os.homedir() }), value);
  const open = (usage = 'setup-time', decls = declarations) => openSecretChannel({ manager, packageKey: KEY, scope: 'global', canonicalRoot: os.homedir(), declarations: decls, usage });
  const render = channel => { let out = ''; channel.writeTo({ write: text => { out += text; } }); return out; };
  return { store, put, open, render };
}

test('秘密框架只含該用途的秘密；每行一個 base64 值，固定使用 LF；沒有秘密時仍輸出確定的空框架', () => {
  const f = channelFixture();
  f.put('setup-pat', SECRET); f.put('runtime-pat', 'runtime-canary-value');
  const frame = f.render(f.open('setup-time'));
  assert.equal(frame, `${BeginMarker}\nsetup-pat ${b64(SECRET)}\n${EndMarker}\n`);
  assert.ok(!frame.includes(SECRET) && !frame.includes('runtime-canary') && !frame.includes('\r'));
  assert.equal(f.render(f.open('runtime')), `${BeginMarker}\nruntime-pat ${b64('runtime-canary-value')}\n${EndMarker}\n`);
  assert.equal(f.render(f.open('setup-time', [])), `${BeginMarker}\n${EndMarker}\n`);
});

test('含換行與結束標記的值不會破壞框架；必填秘密不存在時中止而不是交付空值', () => {
  const f = channelFixture();
  const nasty = `line1\nLCAIPACK-SECRET-END\nline3`;
  f.put('setup-pat', nasty);
  const frame = f.render(f.open());
  assert.equal(frame.split('\n').filter(l => l === EndMarker).length, 1);
  assert.equal(Buffer.from(frame.split('\n')[1].split(' ')[1], 'base64').toString('utf8'), nasty);
  const empty = channelFixture();
  assert.throws(() => empty.open(), /必填秘密參數 setup-pat/);
  empty.put('setup-pat', 'x');
  assert.deepEqual(empty.open().parameterIds, ['setup-pat']);
});

test('通道只能寫出一次且釋放後不可用；遮罩註冊在寫出前拿到原始值；未知用途被拒', () => {
  const f = channelFixture();
  f.put('setup-pat', SECRET);
  const channel = f.open();
  const registered = []; channel.registerRedaction(v => registered.push(v));
  assert.deepEqual(registered, [SECRET]);
  f.render(channel);
  assert.throws(() => f.render(channel), /只能寫出一次/);
  channel.dispose();
  assert.throws(() => channel.registerRedaction(() => {}), /已釋放/);
  assert.throws(() => f.open('whatever'), /未知的 secretUsage/);
});

// ---------- 執行 context（SetupExecutionContextTests） ----------

function payloadPackage(script = 'Write-Host \'v1\'\n') {
  const manifest = { packageFormatVersion: 1, key: KEY, name: 'Payload', type: 'bundle', version: '1.0.0', description: 'Synthetic',
    contents: [{ id: 'hello', kind: 'skill', path: 'resources/skills/hello' }],
    setup: { commands: [{ commandId: 'install', name: 'Install', runner: 'powershell', script: 'setup/install.ps1', payloads: ['resources/mcp/gateway'] }] } };
  const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Payload', 'resources/skills/hello/SKILL.md': '---\nname: hello\ndescription: Synthetic\n---\nHello',
    'setup/install.ps1': script, 'resources/mcp/gateway/client-gateway.js': 'console.log(1)', 'resources/mcp/gateway/package.json': '{}', 'resources/mcp/other/skip.txt': 'x' });
  return { pkg: openCanonicalPackage({ bytes, expectedSha256: ofBytes(bytes) }), commands: manifest.setup.commands };
}

function project(t) {
  const dir = temp(t);
  const ctx = createExecutionContext({ home: path.join(dir, 'home'), packageKey: KEY, packageVersion: '1.0.0', scope: 'project', canonicalRoot: path.join(dir, 'repo'), projectRoot: path.join(dir, 'repo') });
  return { dir, ctx };
}

test('配置是 setup root 下三個固定子目錄；setup root 穩定、不含原始專案路徑，建立前什麼都不存在', t => {
  const { dir, ctx } = project(t);
  assert.equal(ctx.payloadRoot, path.join(ctx.setupRoot, 'payload'));
  assert.equal(ctx.runtimeRoot, path.join(ctx.setupRoot, 'runtime'));
  assert.equal(ctx.mcpRoot, path.join(ctx.setupRoot, 'mcp'));
  assert.ok(!ctx.setupRoot.toLowerCase().includes('repo'));
  assert.equal(fs.existsSync(ctx.setupRoot), false);
  ctx.ensureDirectories();
  assert.ok([ctx.payloadRoot, ctx.runtimeRoot, ctx.mcpRoot].every(d => fs.statSync(d).isDirectory()));
  assert.ok(ctx.setupRoot.startsWith(path.resolve(dir, 'home')));
});

test('落地 payload 只含作者明確宣告的腳本與 payloads，逐位元組等於 zip 內容', t => {
  const { ctx } = project(t);
  const { pkg, commands } = payloadPackage('Write-Host \'v2\'\n');
  ctx.materializePayload(pkg, commands);
  assert.equal(fs.readFileSync(path.join(ctx.payloadRoot, 'setup', 'install.ps1'), 'utf8'), 'Write-Host \'v2\'\n');
  assert.ok(fs.existsSync(path.join(ctx.payloadRoot, 'resources', 'mcp', 'gateway', 'client-gateway.js')));
  assert.ok(fs.existsSync(path.join(ctx.payloadRoot, 'resources', 'mcp', 'gateway', 'package.json')));
  for (const undeclared of [['resources', 'skills'], ['resources', 'mcp', 'other'], ['README.md'], ['lcpack.json']]) assert.equal(fs.existsSync(path.join(ctx.payloadRoot, ...undeclared)), false);
});

test('重建 payload 會清掉舊檔，但完全不碰發布者的 runtime 目錄', t => {
  const { ctx } = project(t);
  ctx.ensureDirectories();
  fs.writeFileSync(path.join(ctx.payloadRoot, 'stale.txt'), 'old');
  fs.mkdirSync(path.join(ctx.runtimeRoot, 'node'), { recursive: true });
  fs.writeFileSync(path.join(ctx.runtimeRoot, 'node', 'credentials.json'), 'publisher state');
  const { pkg, commands } = payloadPackage();
  ctx.materializePayload(pkg, commands);
  assert.equal(fs.existsSync(path.join(ctx.payloadRoot, 'stale.txt')), false);
  assert.equal(fs.readFileSync(path.join(ctx.runtimeRoot, 'node', 'credentials.json'), 'utf8'), 'publisher state');
});

test('payload 路徑解析拒絕離開 payload 目錄的路徑', t => {
  const { ctx } = project(t);
  for (const bad of ['../escape.ps1', 'setup/../../escape.ps1', '/etc/passwd', 'C:/Windows/System32/cmd.exe']) assert.throws(() => ctx.resolvePayloadPath(bad), /setup 路徑/);
  const resolved = ctx.resolvePayloadPath('setup/install.ps1');
  assert.ok(resolved.startsWith(ctx.payloadRoot) && resolved.endsWith('install.ps1'));
});

test('環境變數只有身分與根目錄，沒有任何秘密；全域不公布專案根，沒有 operation 時不設 operation id', t => {
  const { dir, ctx } = project(t);
  const variables = ctx.buildEnvironment('op-20260821T010203Z-abcdef12');
  assert.deepEqual(variables, { LCAIPACK_SETUP_ROOT: ctx.setupRoot, LCAIPACK_PAYLOAD_ROOT: ctx.payloadRoot, LCAIPACK_RUNTIME_ROOT: ctx.runtimeRoot,
    LCAIPACK_PACKAGE_KEY: KEY, LCAIPACK_PACKAGE_VERSION: '1.0.0', LCAIPACK_SCOPE: 'project', LCAIPACK_PROJECT_ROOT: variables.LCAIPACK_PROJECT_ROOT, LCAIPACK_OPERATION_ID: 'op-20260821T010203Z-abcdef12' });
  assert.ok(variables.LCAIPACK_PROJECT_ROOT.toLowerCase().includes('repo'));
  assert.ok(!Object.keys(variables).some(k => /SECRET|PAT|TOKEN|PASSWORD/i.test(k.replace('PATH', ''))));
  const global = createExecutionContext({ home: path.join(dir, 'home'), packageKey: KEY, packageVersion: '1.0.0', scope: 'global', canonicalRoot: os.homedir() }).buildEnvironment();
  assert.equal(global.LCAIPACK_SCOPE, 'global');
  assert.ok(!('LCAIPACK_PROJECT_ROOT' in global) && !('LCAIPACK_OPERATION_ID' in global));
});
