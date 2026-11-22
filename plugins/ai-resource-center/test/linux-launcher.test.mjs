import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { installMcpLauncher } from '../worker/setup/find-mcp-launcher.mjs';
import { resolveSetupRoot } from '../worker/setup/planning.mjs';
import { createWindowsCredentialStore, setupSecretReference, KeychainService } from '../worker/setup/secrets.mjs';

const source = fileURLToPath(new URL('../worker/setup/mcp-launcher/lcaipack-mcp-launch.mjs', import.meta.url));
const secret = '  synthetic-秘密\n\n';
function fixture(t, platform = 'linux') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'node-launch-'));
  const dir = process.platform === 'win32' ? temporary.toLowerCase() : temporary;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'data'), root = path.join(dir, 'root');
  fs.mkdirSync(root);
  const packageKey = 'example.demo';
  // 模擬平台只改大小寫規則；路徑與檔案系統仍由實際 Node 平台處理。
  const rules = { path, normalize: value => platform === 'linux' ? path.resolve(value) : path.resolve(value).toLowerCase() };
  const setupRoot = resolveSetupRoot(home, packageKey, 'global', root, rules);
  fs.mkdirSync(path.join(setupRoot, 'mcp'), { recursive: true });
  const script = path.join(dir, 'mcp.cjs');
  fs.writeFileSync(script, `process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({input,cwd:process.cwd(),mode:process.env.MODE}));process.stderr.write('fake-mcp-error');process.exitCode=17;});`);
  const descriptor = { launchFormatVersion: 1, packageKey, packageVersion: '1.0.0', contentId: 'echo', scope: 'global', canonicalRoot: root,
    setupRoot, command: process.execPath, args: [script], cwd: null, env: { MODE: 'demo' }, runtimeSecrets: [{ parameterId: 'pat', required: true }] };
  const descriptorPath = path.join(setupRoot, 'mcp', 'echo.json');
  const save = () => fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
  save();
  // 子行程 preloader 注入假的 secret-tool；launcher 與假 MCP 都是實際 Node 子行程。
  const preload = path.join(dir, 'fake-secret-tool.cjs');
  const key = setupSecretReference({ packageKey, parameterId: 'pat', scope: 'global', canonicalRoot: root }, rules).key;
  fs.writeFileSync(preload, `Object.defineProperty(process,'platform',{value:'linux'});const cp=require('node:child_process');const original=cp.spawnSync;cp.spawnSync=(file,args,options)=>{if(file!=='secret-tool')return original(file,args,options);require('node:assert/strict').deepEqual(args,['lookup','service',${JSON.stringify(KeychainService)},'account',${JSON.stringify(key)}]);return {status:0,stdout:${JSON.stringify(secret)},stderr:''};};require('node:module').syncBuiltinESMExports();`);
  const args = ['mcp-launch', '--package', packageKey, '--content', 'echo', '--scope', 'global', '--root', root];
  const run = (launcher = source) => spawnSync(process.execPath, ['--require', preload, launcher, ...args], { env: { ...process.env, LCAIPACK_HOME: home }, input: 'host-bytes\n', encoding: 'utf8', timeout: 10000 });
  return { packageKey, key, dir, home, root, setupRoot, descriptor, descriptorPath, preload, args, save, run };
}

test('Node launcher 支援原生 probe；安裝為獨立檔案且相同內容不重寫', t => {
  const f = fixture(t);
  const installed = installMcpLauncher({ userHome: f.dir, env: {} });
  const bytes = fs.readFileSync(installed, 'utf8');
  assert.ok(bytes.startsWith('#!/usr/bin/env node\n'));
  const stamp = fs.statSync(installed).mtimeMs;
  assert.equal(installMcpLauncher({ userHome: f.dir, env: {} }), installed);
  assert.equal(fs.statSync(installed).mtimeMs, stamp);
  if (process.platform !== 'win32') assert.equal(fs.statSync(installed).mode & 0o777, 0o755);
  const probe = spawnSync(process.execPath, [installed, 'mcp-launch', '--probe'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, 'lcaipack-mcp-launch/1\n');
  if (process.platform === 'linux') {
    const direct = spawnSync(installed, ['mcp-launch', '--probe'], { encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout, probe.stdout);
  }
  fs.writeFileSync(installed, 'old content');
  installMcpLauncher({ userHome: f.dir, env: {} });
  assert.equal(fs.readFileSync(installed, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(installed)), ['lcaipack-mcp-launch.mjs']);
});

test('真實 Node launcher 讀取描述、取秘密、先寫原生秘密框架，再轉送 stdio 與結束碼', t => {
  const f = fixture(t);
  const result = f.run(installMcpLauncher({ userHome: f.dir, env: {} }));
  assert.equal(result.status, 17, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.input, `LCAIPACK-SECRET-BEGIN 1\npat ${Buffer.from(secret).toString('base64')}\nLCAIPACK-SECRET-END\nhost-bytes\n`);
  assert.equal(output.cwd.toLowerCase(), path.join(f.setupRoot, 'runtime').toLowerCase());
  assert.equal(output.mode, 'demo');
  assert.equal(result.stderr, 'fake-mcp-error');
  assert.ok(!fs.readFileSync(f.descriptorPath, 'utf8').includes(secret));
  const customCwd = path.join(f.dir, 'custom');
  f.descriptor.cwd = customCwd; f.save();
  assert.equal(JSON.parse(f.run().stdout).cwd.toLowerCase(), customCwd.toLowerCase());
});

test('Node launcher 缺必填秘密、keyring 失敗、格式錯誤時不啟動 MCP，也不洩漏診斷', t => {
  const f = fixture(t);
  for (const result of [{ status: 1, stdout: '', stderr: '' }, { status: 1, stdout: '', stderr: secret }]) {
    fs.writeFileSync(f.preload, `Object.defineProperty(process,'platform',{value:'linux'});require('node:child_process').spawnSync=()=>(${JSON.stringify(result)});require('node:module').syncBuiltinESMExports();`);
    const failed = f.run();
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.ok(!failed.stderr.includes(secret));
  }
  f.descriptor.launchFormatVersion = 99; f.save();
  assert.equal(f.run().status, 1);
  const invalid = spawnSync(process.execPath, [source, 'mcp-launch', '--probe', 'extra'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
});

test('Node launcher 可省略非必填秘密，並為空秘密清單交付空框架', t => {
  const f = fixture(t);
  fs.writeFileSync(f.preload, `Object.defineProperty(process,'platform',{value:'linux'});require('node:child_process').spawnSync=(_,args)=>({status:args[0]==='search'?0:1,stdout:'',stderr:''});require('node:module').syncBuiltinESMExports();`);
  f.descriptor.runtimeSecrets[0].required = false; f.save();
  assert.equal(JSON.parse(f.run().stdout).input, 'LCAIPACK-SECRET-BEGIN 1\nLCAIPACK-SECRET-END\nhost-bytes\n');
  f.descriptor.runtimeSecrets = []; f.save();
  assert.equal(f.run().status, 17);
});

test('Linux 真實 secret-tool 腳本可透過 PATH 注入，秘密不在 argv', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t);
  const tool = path.join(f.dir, 'secret-tool');
  const key = f.key;
  fs.writeFileSync(tool, `#!/usr/bin/env node\nrequire('node:assert/strict').deepEqual(process.argv.slice(2),['lookup','service',${JSON.stringify(KeychainService)},'account',${JSON.stringify(key)}]);process.stdout.write(${JSON.stringify(secret)});\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [source, ...f.args], { input: 'host\n', encoding: 'utf8', timeout: 10000,
    env: { ...process.env, LCAIPACK_HOME: f.home, PATH: `${f.dir}:${path.dirname(process.execPath)}` } });
  assert.equal(result.status, 17, result.stderr);
  assert.equal(JSON.parse(result.stdout).input, `LCAIPACK-SECRET-BEGIN 1\npat ${Buffer.from(secret).toString('base64')}\nLCAIPACK-SECRET-END\nhost\n`);
});

test('Linux launcher 將終止訊號轉送 MCP 行程群組', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  f.descriptor.runtimeSecrets = [];
  f.descriptor.args = ['-e', "process.on('SIGTERM',()=>{process.stderr.write('terminated');process.exit(23)});process.stdout.write('ready');setInterval(()=>{},1000)"];
  f.save();
  const child = spawn(process.execPath, [source, ...f.args], { env: { ...process.env, LCAIPACK_HOME: f.home }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await once(child.stdout, 'data');
  let error = '';
  child.stderr.on('data', chunk => error += chunk);
  child.kill('SIGTERM');
  const [code] = await once(child, 'close');
  assert.equal(code, 23);
  assert.equal(error, 'terminated');
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} 秘密讀取保留空白與 UTF-8，系統命令不帶秘密`, t => {
    const f = fixture(t, platform);
    const value = platform === 'darwin' ? '  synthetic-秘密  ' : secret;
    const stdout = platform === 'win32' ? Buffer.from(value).toString('base64') + '\r\n' : platform === 'darwin' ? value + '\n' : value;
    fs.writeFileSync(f.preload, `Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});
      const assert=require('node:assert/strict');
      require('node:child_process').spawnSync=(file,args,options)=>{
        assert.ok(!JSON.stringify(args).includes(${JSON.stringify(value)}));
        if(process.platform==='win32') {
          assert.ok(file.endsWith('powershell.exe'));
          assert.equal(args.at(-2),'-EncodedCommand');
          const script=Buffer.from(args.at(-1),'base64').toString('utf16le');
          assert.ok(script.includes('CredRead')); assert.ok(script.includes('Encoding.UTF8'));
          assert.equal(options.input,['get',Buffer.from(${JSON.stringify(f.key)}).toString('base64'),''].join(String.fromCharCode(10)));
        } else if(process.platform==='darwin') {
          assert.equal(file,'security'); assert.deepEqual(args,['find-generic-password','-a',${JSON.stringify(f.key)},'-s',${JSON.stringify(KeychainService)},'-w']);
        } else {
          assert.equal(file,'secret-tool'); assert.deepEqual(args,['lookup','service',${JSON.stringify(KeychainService)},'account',${JSON.stringify(f.key)}]);
        }
        return {status:0,stdout:${JSON.stringify(stdout)},stderr:''};
      }; require('node:module').syncBuiltinESMExports();`);
    const result = f.run();
    assert.equal(result.status, 17, result.stderr);
    assert.equal(JSON.parse(result.stdout).input, `LCAIPACK-SECRET-BEGIN 1\npat ${Buffer.from(value).toString('base64')}\nLCAIPACK-SECRET-END\nhost-bytes\n`);
  });
}

test('Windows 真實認證管理員寫入後由獨立 launcher 讀取，結束必刪除測試鍵', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, 'win32');
  const store = createWindowsCredentialStore();
  try {
    store.set(f.key, secret);
    const installed = installMcpLauncher({ userHome: f.dir, env: {} });
    const result = spawnSync(process.execPath, [installed, ...f.args.slice(0, -1), f.root.toUpperCase()], { env: { ...process.env, LCAIPACK_HOME: f.home },
      input: 'host-bytes\n', encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 17, result.stderr);
    assert.equal(JSON.parse(result.stdout).input, `LCAIPACK-SECRET-BEGIN 1\npat ${Buffer.from(secret).toString('base64')}\nLCAIPACK-SECRET-END\nhost-bytes\n`);
  } finally { store.delete(f.key); }
  assert.equal(store.get(f.key), null);
});
