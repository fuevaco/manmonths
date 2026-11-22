// 秘密參數（對照 LcAiPack.Tests SetupSecretTests；Core Mcp/McpSecrets.cs、Setup/SetupSecrets.cs）。
// 秘密依 LC-AI-Pack 的既有識別存進作業系統安全儲存區：Windows Credential Manager（Generic credential，
// target name = key），macOS Keychain（service com.linkchain.lcaipack，account = key）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';
import { setupSecretReference, createSecretManager, SetupSecretStoreError, createWindowsCredentialStore,
  createMacKeychainStore, createDefaultSecretStore, KeychainService } from '../worker/setup/secrets.mjs';

import { memoryStore } from './fake-secret-store.mjs';

const winRules = createPathRules({ platform: 'win32', resolveLinks: false });

test('秘密識別與 LC-AI-Pack 相同：package、參數、scope 與正規化根目錄雜湊，不含原始路徑與版本', () => {
  // 期望值由 LcAiPack.Core SetupSecretReference.For(...).Key 實際產生。
  const ref = setupSecretReference({ packageKey: 'orca-rc-demo-mcp-params', parameterId: 'demo-api-key', scope: 'global', canonicalRoot: 'C:\\Users\\Demo\\' }, winRules);
  assert.equal(ref.key, 'lcaipack:setup:orca-rc-demo-mcp-params:demo-api-key:global:dda80ed47911b77077f5d544');
  assert.equal(ref.key.includes('Demo'), false);
  const project = setupSecretReference({ packageKey: 'orca-rc-demo-mcp-params', parameterId: 'demo-api-key', scope: 'project', canonicalRoot: 'C:\\Users\\Demo' }, winRules);
  assert.notEqual(project.key, ref.key);
  assert.equal(setupSecretReference({ packageKey: 'p', parameterId: 'a', scope: 'project', canonicalRoot: 'C:\\Work\\A' }, winRules).key,
    setupSecretReference({ packageKey: 'p', parameterId: 'a', scope: 'project', canonicalRoot: 'c:\\work\\a\\' }, winRules).key);
});

test('寫入、查詢、刪除往返；狀態查詢只回答有無且可依用途過濾', () => {
  const store = memoryStore();
  const secrets = createSecretManager(store, winRules);
  const ref = setupSecretReference({ packageKey: 'p', parameterId: 'token', scope: 'global', canonicalRoot: 'C:\\Users\\Demo' }, winRules);
  assert.equal(secrets.exists(ref), false);
  secrets.set(ref, 'canary-secret-1');
  assert.equal(secrets.exists(ref), true);
  const decls = [{ parameterId: 'token', usage: 'runtime', required: true }, { parameterId: 'other', usage: 'setup-time', required: true },
    { parameterId: 'optional', usage: 'runtime', required: false }];
  const statuses = secrets.describe('p', 'global', 'C:\\Users\\Demo', decls);
  assert.deepEqual(statuses, [
    { parameterId: 'token', usage: 'runtime', required: true, exists: true },
    { parameterId: 'other', usage: 'setup-time', required: true, exists: false },
    { parameterId: 'optional', usage: 'runtime', required: false, exists: false }]);
  assert.equal(JSON.stringify(statuses).includes('canary'), false);
  assert.deepEqual(secrets.describe('p', 'global', 'C:\\Users\\Demo', decls, 'runtime').map(s => s.parameterId), ['token', 'optional']);
  assert.deepEqual(secrets.missingRequired('p', 'global', 'C:\\Users\\Demo', decls), ['other']);
  secrets.delete(ref);
  assert.equal(secrets.exists(ref), false);
  assert.throws(() => secrets.describe('p', 'global', 'C:\\x', [{ parameterId: 'a', usage: 'later', required: true }]), /secretUsage/);
});

test('空秘密被拒絕；安全儲存區失敗是明確的阻擋錯誤，訊息不含秘密值', () => {
  const ref = setupSecretReference({ packageKey: 'p', parameterId: 'token', scope: 'global', canonicalRoot: 'C:\\x' }, winRules);
  assert.throws(() => createSecretManager(memoryStore(), winRules).set(ref, ''), /token/);
  const failing = createSecretManager(memoryStore({ fail: true }), winRules);
  assert.throws(() => failing.set(ref, 'canary-secret-2'), e => e instanceof SetupSecretStoreError && /token/.test(e.message) && !e.message.includes('canary'));
  assert.throws(() => failing.exists(ref), SetupSecretStoreError);
});

test('Windows 透過 PowerShell 呼叫 Credential Manager，秘密只經 stdin 傳遞、不進命令列', () => {
  const calls = [];
  const replies = { exists: '1\n0\n', get: Buffer.from('值-x').toString('base64') + '\n', set: '', delete: '' };
  const store = createWindowsCredentialStore({ run: (file, args, input) => {
    calls.push({ file, args, input });
    return { status: 0, stdout: replies[input.split('\n')[0]] };
  } });
  assert.deepEqual(store.existsMany(['k1', 'k2']), [true, false]);
  assert.equal(store.get('k1'), '值-x');
  store.set('lcaipack:setup:p:token:global:abc', 'canary-secret-3');
  store.delete('k1');
  for (const c of calls) {
    assert.match(c.file, /powershell\.exe$/i);
    assert.ok(c.args.includes('-EncodedCommand'));
    assert.equal(c.args.join(' ').includes('canary'), false);
    const script = Buffer.from(c.args[c.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    // 與 LC-AI-Pack WindowsCredentialSecretStore 相同的 Generic credential 形狀。
    for (const fragment of ['CredWrite', 'CredRead', 'CredDelete', 'Type = 1', 'Persist = 2', '"LC-AI-Pack"', '"lcaipack"', 'Encoding.UTF8']) assert.ok(script.includes(fragment), fragment);
  }
  const set = calls.find(c => c.input.startsWith('set'));
  assert.deepEqual(set.input.split('\n').slice(1, 3).map(v => Buffer.from(v, 'base64').toString()), ['lcaipack:setup:p:token:global:abc', 'canary-secret-3']);
  const failing = createWindowsCredentialStore({ run: () => ({ status: 1, stdout: '', stderr: 'boom' }) });
  assert.throws(() => failing.set('k', 'canary-secret-4'), e => !e.message.includes('canary'));
});

test('macOS 讀取秘密值不修剪：只去掉 security 附加的單一結尾換行，前後空白與其餘字元原樣保留', () => {
  const respond = stdout => createMacKeychainStore({ run: () => ({ status: 0, stdout }) });
  assert.equal(respond('  spaced secret \t\n').get('k'), '  spaced secret \t');
  assert.equal(respond('plain\n').get('k'), 'plain');
  assert.equal(respond('no-newline').get('k'), 'no-newline');
  assert.equal(respond('\n').get('k'), '', '空字串值仍是存在的值');
  assert.equal(createMacKeychainStore({ run: () => ({ status: 44, stdout: '' }) }).get('k'), null);
});

test('macOS 透過 security 存取 Keychain：service 與 account 沿用 LC-AI-Pack，寫入秘密只經 stdin', () => {
  const calls = [];
  const keychain = new Map([['k1', 'stored-value']]);
  const store = createMacKeychainStore({ run: (file, args, input) => {
    calls.push({ file, args, input });
    if (args[0] === 'find-generic-password') return keychain.has(args[2]) ? { status: 0, stdout: keychain.get(args[2]) + '\n' } : { status: 44, stdout: '' };
    return { status: 0, stdout: '' };
  } });
  assert.equal(KeychainService, 'com.linkchain.lcaipack');
  assert.deepEqual(store.existsMany(['k1', 'k2']), [true, false]);
  // 存在性查詢不帶 -w：只看 exit code，秘密值不會被讀出（LC-AI-Pack 沒有較省的路徑，這裡刻意更保守）。
  assert.deepEqual(calls[0], { file: 'security', args: ['find-generic-password', '-a', 'k1', '-s', KeychainService], input: undefined });
  assert.equal(calls.slice(0, 2).some(c => c.args.includes('-w')), false);
  calls.length = 0;
  assert.equal(store.get('k1'), 'stored-value');
  assert.deepEqual(calls[0], { file: 'security', args: ['find-generic-password', '-a', 'k1', '-s', KeychainService, '-w'], input: undefined });
  store.set('lcaipack:setup:p:token:global:abc', 'can"ary\\5 x');
  const set = calls.at(-1);
  assert.deepEqual(set.args, ['-i']);
  assert.equal(set.input, 'add-generic-password -U -a "lcaipack:setup:p:token:global:abc" -s "com.linkchain.lcaipack" -w "can\\"ary\\\\5 x"\n');
  assert.throws(() => store.set('k', 'two\nlines'), /換行/);
  store.delete('k1');
  assert.deepEqual(calls.at(-1).args, ['delete-generic-password', '-a', 'k1', '-s', KeychainService]);
  assert.equal(calls.some(c => c.args.join(' ').includes('can"ary')), false);
});

test('不支援的平台沒有明文替代儲存', () => {
  assert.throws(() => createDefaultSecretStore({ platform: 'freebsd' }), /Windows Credential Manager 與 macOS Keychain/);
});

test('Windows 實機：Credential Manager 寫入、讀回、刪除合成秘密', { skip: process.platform !== 'win32' }, () => {
  const store = createDefaultSecretStore({ platform: 'win32' });
  const key = `lcaipack:setup:orca-rc-test:${process.pid}-${Date.now()}:global:000000000000000000000000`;
  try {
    assert.deepEqual(store.existsMany([key]), [false]);
    store.set(key, '合成-secret-✓');
    assert.deepEqual(store.existsMany([key]), [true]);
    assert.equal(store.get(key), '合成-secret-✓');
  } finally {
    store.delete(key);
  }
  assert.equal(store.get(key), null);
});
