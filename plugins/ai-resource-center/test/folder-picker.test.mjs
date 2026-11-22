import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFolderPickerService, FolderPickerTimeoutMs } from '../worker/folder-picker.mjs';
import { startWorker } from './harness.mjs';

function fakeSpawn(results, calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { calls.push('killed'); return true; };
    const result = results.shift();
    queueMicrotask(() => {
      if (result.error) child.emit('error', Object.assign(new Error('synthetic'), { code: result.error }));
      else if (!result.wait) { child.stdout.end(result.output ?? ''); child.emit('close', result.code ?? 0); }
    });
    return child;
  };
}

test('Windows 選擇器使用 STA、EncodedCommand 與 UTF-8，不把初始路徑當程式碼', async () => {
  const calls = [], initialPath = "C:\\資料\\a'; echo nope";
  const folders = createFolderPickerService({ platform: 'win32', spawn: fakeSpawn([{ output: 'C:\\資料\\選取 ' }], calls) });
  assert.deepEqual(await folders.pickFolder({ initialPath }), { path: 'C:\\資料\\選取 ' });
  const { file, args, options } = calls[0];
  assert.equal(file, 'powershell');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-STA', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.match(script, /System.Windows.Forms.FolderBrowserDialog/);
  assert.match(script, /OutputEncoding/);
  assert.ok(script.includes(Buffer.from(initialPath).toString('base64')));
  assert.ok(!script.includes(initialPath));
  assert.equal(options.shell, undefined);
});

test('macOS 選擇器以 argv 傳入路徑，解析 POSIX 輸出並保留空白', async () => {
  const calls = [];
  const folders = createFolderPickerService({ platform: 'darwin', spawn: fakeSpawn([{ output: '/tmp/資料 /\n' }], calls) });
  assert.deepEqual(await folders.pickFolder({ initialPath: '/tmp/a "b' }), { path: '/tmp/資料 /' });
  assert.equal(calls[0].file, 'osascript');
  assert.match(calls[0].args[1], /POSIX path of \(choose folder/);
  assert.equal(calls[0].args[2], '/tmp/a "b');
});

test('Linux 優先 zenity，缺少時使用 kdialog；路徑參數與輸出正確', async () => {
  const calls = [];
  const folders = createFolderPickerService({ platform: 'linux', spawn: fakeSpawn([{ error: 'ENOENT' }, { output: '/tmp/選取 \n' }], calls) });
  assert.deepEqual(await folders.pickFolder({ initialPath: '/tmp/資料' }), { path: '/tmp/選取 ' });
  assert.deepEqual(calls.map(c => [c.file, c.args]), [
    ['zenity', ['--file-selection', '--directory', '--filename=/tmp/資料/']], ['kdialog', ['--getexistingdirectory', '/tmp/資料']]
  ]);
  const direct = [];
  assert.deepEqual(await createFolderPickerService({ platform: 'linux', spawn: fakeSpawn([{ output: '/tmp/ok\n' }], direct) }).pickFolder(), { path: '/tmp/ok' });
  assert.equal(direct.length, 1);
});

test('缺少選擇器回 unavailable；取消不再開下一個對話框；失敗可辨識', async () => {
  const calls = [];
  assert.deepEqual(await createFolderPickerService({ platform: 'linux', spawn: fakeSpawn([{ error: 'ENOENT' }, { error: 'ENOENT' }], calls) }).pickFolder(), { unavailable: true });
  for (const platform of ['win32', 'darwin', 'linux']) {
    const cancelled = [];
    assert.deepEqual(await createFolderPickerService({ platform, spawn: fakeSpawn([{ code: 1 }], cancelled) }).pickFolder(), { cancelled: true });
    assert.equal(cancelled.length, 1);
  }
  await assert.rejects(createFolderPickerService({ platform: 'linux', spawn: fakeSpawn([{ code: 2 }], []) }).pickFolder(), { code: 'folder_picker_failed' });
});

test('選擇器 115 秒內返回；逾時與面板關閉都終止行程', async () => {
  assert.equal(FolderPickerTimeoutMs, 115000);
  const calls = [];
  assert.deepEqual(await createFolderPickerService({ platform: 'linux', timeoutMs: 5, spawn: fakeSpawn([{ wait: true }], calls) }).pickFolder(), { cancelled: true });
  assert.equal(calls.at(-1), 'killed');
  const controller = new AbortController(), aborted = [];
  const result = createFolderPickerService({ platform: 'linux', spawn: fakeSpawn([{ wait: true }], aborted) }).pickFolder({}, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await result, { cancelled: true });
  assert.equal(aborted.at(-1), 'killed');
});

test('資料夾 handlers 可共用；checkFolder 區分檔案、目錄與不存在並驗證輸入', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-picker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worker = startWorker({ deps: { folderPickerSpawn: fakeSpawn([{ output: dir }], []), platform: process.platform } });
  t.after(() => worker.dispose());
  assert.deepEqual(await worker.call('rc.dev.pickFolder'), { path: dir });
  assert.deepEqual(await worker.call('rc.dev.checkFolder', { path: dir }), { exists: true, isDirectory: true, absolutePath: path.resolve(dir) });
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'demo');
  assert.deepEqual(await worker.call('rc.dev.checkFolder', { path: file }), { exists: true, isDirectory: false, absolutePath: file });
  const missing = path.join(dir, 'missing');
  assert.deepEqual(await worker.call('rc.dev.checkFolder', { path: missing }), { exists: false, isDirectory: false, absolutePath: missing });
  await assert.rejects(worker.call('rc.dev.checkFolder', { path: 4 }), { code: 'invalid_params' });
  await assert.rejects(worker.call('rc.dev.pickFolder', { initialPath: false }), { code: 'invalid_params' });
});
