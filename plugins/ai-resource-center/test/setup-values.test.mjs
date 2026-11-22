// 設定參數值（對照 LcAiPack.Tests SetupStateTests、SetupScopeIsolationTests、SetupAtomicWriteTests）。
// 與 LC-AI-Pack 共用 {home}/setup.json 與 {project}/.lcaipack/setup.json，格式必須逐位元組相容。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SetupValueStore, resolveSetupValues, SetupFileError } from '../worker/setup/values.mjs';

function dirs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-values-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), userProfile = path.join(dir, 'profile'), projectRoot = path.join(dir, 'project');
  fs.mkdirSync(projectRoot);
  return { dir, home, userProfile, projectRoot,
    global: () => SetupValueStore.forGlobal({ home, userProfile }),
    project: () => SetupValueStore.forProject({ projectRoot }) };
}
const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test('設定值檔路徑沿用家目錄與專案慣例', t => {
  const d = dirs(t);
  assert.equal(d.global().filePath, path.join(d.home, 'setup.json'));
  assert.equal(d.project().filePath, path.join(d.projectRoot, '.lcaipack', 'setup.json'));
  assert.equal(SetupValueStore.forScope({ scope: 'project', projectRoot: d.projectRoot }).filePath, d.project().filePath);
  assert.throws(() => SetupValueStore.forScope({ scope: 'project', projectRoot: null }));
});

test('檔案不存在時讀成空值且不建立任何檔案', t => {
  const d = dirs(t);
  assert.deepEqual(d.global().getValues('demo'), {});
  assert.equal(fs.existsSync(d.home), false);
});

test('LC-AI-Pack 產生的全域與專案設定值可讀取，原樣再寫回逐位元組相同', t => {
  const d = dirs(t);
  for (const [name, store] of [['lcaipack-setup.global.windows.golden.json', d.global()], ['lcaipack-setup.project.windows.golden.json', d.project()]]) {
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, fixture(name));
    store.save(store.load(), '\r\n');
    assert.deepEqual(fs.readFileSync(store.filePath), fixture(name), name);
  }
  assert.deepEqual(d.global().getValues('orca-rc-demo-mcp-params'), {
    'demo-endpoint': 'https://global.example.invalid/a?b=1&c=<d>', 'demo-region': 'south', label: '研發環境 \'x\' + "y"' });
});

test('專案覆寫優先，未覆寫的參數回落到全域；清除覆寫後回到全域值', t => {
  const d = dirs(t);
  d.global().setValues('demo', { url: 'https://global.example', mode: 'short' });
  d.project().setValues('demo', { url: 'https://project.example' });
  let r = resolveSetupValues(d.global(), d.project(), 'demo');
  assert.deepEqual(r, { url: { value: 'https://project.example', origin: 'ProjectOverride' }, mode: { value: 'short', origin: 'Global' } });
  d.project().setValues('demo', { url: null });
  r = resolveSetupValues(d.global(), d.project(), 'demo');
  assert.deepEqual(r.url, { value: 'https://global.example', origin: 'Global' });
  assert.deepEqual(resolveSetupValues(d.global(), null, 'demo').url.origin, 'Global');
});

test('寫入時保留其他資源包與未知欄位，項目依 packageKey 排序並記錄 scope 與正規化根目錄', t => {
  const d = dirs(t);
  fs.mkdirSync(d.home, { recursive: true });
  fs.writeFileSync(d.global().filePath, JSON.stringify({ setupFormatVersion: 1, extra: { keep: [1, 'x'] },
    packages: [{ packageKey: 'zeta', scope: 'global', projectRoot: 'x', values: { a: 'b' }, updatedAt: '2026-01-02T03:04:05.1234567+00:00', note: 'keep' }] }));
  d.global().setValues('alpha', { k: 'v' });
  const saved = JSON.parse(fs.readFileSync(d.global().filePath, 'utf8'));
  assert.deepEqual(saved.packages.map(p => p.packageKey), ['alpha', 'zeta']);
  assert.deepEqual(saved.extra, { keep: [1, 'x'] });
  assert.equal(saved.packages[1].note, 'keep');
  assert.equal(saved.packages[1].updatedAt, '2026-01-02T03:04:05.1234567+00:00');
  assert.equal(saved.packages[0].scope, 'global');
  assert.equal(saved.packages[0].projectRoot, d.global().canonicalRoot);
  assert.match(saved.packages[0].updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/);
});

test('秘密參數在任何 I/O 之前被拒絕，訊息只含參數身分', t => {
  const d = dirs(t);
  assert.throws(() => d.global().setValues('demo', { token: 'canary-value', url: 'x' }, ['token']),
    e => /token/.test(e.message) && !e.message.includes('canary-value'));
  assert.equal(fs.existsSync(d.global().filePath), false);
});

test('壞掉的 JSON 或不支援的格式版本明確失敗且不覆寫原檔', t => {
  const d = dirs(t);
  fs.mkdirSync(d.home, { recursive: true });
  fs.writeFileSync(d.global().filePath, '{ this is not json');
  assert.throws(() => d.global().setValues('demo', { a: 'b' }), SetupFileError);
  assert.equal(fs.readFileSync(d.global().filePath, 'utf8'), '{ this is not json');
  fs.writeFileSync(d.global().filePath, '{"setupFormatVersion":99,"packages":[]}');
  assert.throws(() => d.global().getValues('demo'), /99/);
  fs.writeFileSync(d.global().filePath, '   ');
  assert.throws(() => d.global().getValues('demo'), SetupFileError);
});

test('寫入為 UTF-8 無 BOM、不留暫存檔；專案寫入不碰全域檔', t => {
  const d = dirs(t);
  d.global().setValues('demo', { label: '研發環境' });
  const globalBytes = fs.readFileSync(d.global().filePath);
  assert.notEqual(globalBytes[0], 0xef);
  assert.match(globalBytes.toString(), /\\u7814\\u767C/);
  assert.deepEqual(fs.readdirSync(d.home).filter(f => f.endsWith('.part')), []);
  d.project().setValues('demo', { label: 'project' });
  d.project().clearPackage('demo');
  assert.deepEqual(fs.readFileSync(d.global().filePath), globalBytes);
  assert.deepEqual(d.project().getValues('demo'), {});
});

test('移除最後一個值時整個資源包項目一併移除；全部為 null 的新項目不寫檔', t => {
  const d = dirs(t);
  d.global().setValues('demo', { a: null });
  assert.equal(fs.existsSync(d.global().filePath), false);
  d.global().setValues('demo', { a: 'x' });
  d.global().setValues('demo', { a: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(d.global().filePath, 'utf8')).packages, []);
});
