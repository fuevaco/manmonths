import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createFakeSpawner, startWorker } from './harness.mjs';

test('假啟動器逐行輸出、回傳結束代碼並記錄 argv、env、cwd 與 UTF-8 stdin', async () => {
  const spawn = createFakeSpawner([{ lines: ['第一行', '{"result":"完成"}'], stderr: '診斷\n', code: 7 }]);
  const env = { SYNTHETIC_ACCOUNT: 'alice' }, args = ['--json', '有 空白'];
  const child = spawn('synthetic-cli', args, { env, cwd: '/synthetic/work' });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const closed = once(child, 'close');
  const input = Buffer.from('繁體中文\n');
  child.stdin.write(input.subarray(0, 2));
  child.stdin.end(input.subarray(2));
  env.SYNTHETIC_ACCOUNT = 'changed'; args.push('changed');
  assert.deepEqual(await closed, [7, null]);
  assert.equal(stdout, '第一行\n{"result":"完成"}\n');
  assert.equal(stderr, '診斷\n');
  assert.deepEqual(spawn.calls[0].argv, ['synthetic-cli', '--json', '有 空白']);
  assert.deepEqual(spawn.calls[0].env, { SYNTHETIC_ACCOUNT: 'alice' });
  assert.equal(spawn.calls[0].cwd, '/synthetic/work');
  assert.equal(spawn.calls[0].stdin, '繁體中文\n');
});

test('假啟動器可卡住，收到 kill 才結束且不再輸出', async () => {
  const spawn = createFakeSpawner([{ lines: ['部分回答'], hang: true }]);
  const child = spawn('synthetic-cli');
  let stdout = '', closed = false;
  child.stdout.on('data', text => { stdout += text; });
  child.on('close', () => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stdout, '部分回答\n');
  assert.equal(closed, false);
  const done = once(child, 'close');
  assert.equal(child.kill(), true);
  assert.deepEqual(await done, [null, 'SIGTERM']);
  assert.equal(child.killed, true);
  assert.equal(child.exitCode, null);
  assert.equal(child.kill(), false);
  assert.equal(stdout, '部分回答\n');
});

test('假啟動器模擬 ENOENT 啟動失敗，不輸出預先寫好的回答', { timeout: 1000 }, async () => {
  const spawn = createFakeSpawner([{ error: 'ENOENT', lines: ['不應輸出'] }]);
  const child = spawn('missing-synthetic-cli');
  let stdout = '';
  child.stdout.on('data', text => { stdout += text; });
  const failed = once(child, 'error');
  // events.once(close) 遇到 error 會拒絕，這裡分別觀察兩種事件。
  const closed = new Promise(resolve => child.once('close', (...args) => resolve(args)));
  const [error] = await failed;
  assert.equal(error.code, 'ENOENT');
  assert.deepEqual(await closed, [-2, null]);
  assert.equal(stdout, '');
});

test('假啟動器可經 worker deps 注入，程序不經 shell 並隱藏視窗', async t => {
  const spawn = createFakeSpawner([{ lines: ['/synthetic/selected'] }]);
  const worker = startWorker({ deps: { spawn, platform: 'linux' } });
  t.after(() => worker.dispose());
  assert.deepEqual(await worker.call('rc.dev.pickFolder'), { path: '/synthetic/selected' });
  assert.equal(spawn.calls[0].file, 'zenity');
  assert.equal(spawn.calls[0].options.shell, false);
  assert.equal(spawn.calls[0].options.windowsHide, true);
});

test('假啟動器在輸出途中收到 kill，後續行不會送達', async () => {
  const spawn = createFakeSpawner([{ lines: ['第一段', '不應送達'] }]);
  const child = spawn('synthetic-cli');
  const closed = once(child, 'close');
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; child.kill(); });
  assert.deepEqual(await closed, [null, 'SIGTERM']);
  assert.equal(text, '第一段\n');
});
