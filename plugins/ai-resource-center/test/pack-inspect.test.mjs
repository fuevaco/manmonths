import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { inspectSourceFolder } from '../worker/pack/index.mjs';
import { collectManifestProblems, validateManifest } from '../worker/manifest-validator.mjs';
import { fixture, skill, command } from './pack-fixture.mjs';
const inspect = (f, mode = 'install') => inspectSourceFolder(f.folder, { mode });

const mutations = [
  ['格式版本必填', m => delete m.packageFormatVersion, 'unsupported-package-format'],
  ['格式版本固定', m => m.packageFormatVersion = 2, 'unsupported-package-format'],
  ...['schemaVersion', 'platforms', 'overrides', 'instructions', 'mcpServers', 'unknown'].map(k => [`頂層拒收 ${k}`, m => m[k] = [], k === 'schemaVersion' ? 'unsupported-package-format' : 'invalid-package']),
  ...['key', 'name', 'description', 'type', 'version'].map(k => [`必填 ${k}`, m => delete m[k], 'invalid-package']),
  ['key 格式', m => m.key = 'Bad/key', 'invalid-package'],
  ['type 格式', m => m.type = 'prompt', 'invalid-package'],
  ['version 格式', m => m.version = '../1', 'invalid-package'],
  ['minClientVersion 格式', m => m.minClientVersion = '*', 'invalid-package'],
  ['contents 不可空白', m => m.contents = [], 'invalid-package'],
  ['content id 必填', m => delete m.contents[0].id, 'invalid-package'],
  ['content id 格式', m => m.contents[0].id = 'Bad', 'invalid-package'],
  ['content id 重複', m => m.contents.push({ ...m.contents[0] }), 'duplicate-content-id'],
  ['content kind', m => m.contents[0].kind = 'unknown', 'unsupported-content-kind'],
  ['content name 顯式空白', m => m.contents[0].name = '', 'invalid-package'],
  ['content name 必填', m => { m.contents[0].kind = 'prompt'; }, 'invalid-package'],
  ...['serverId', 'platforms', 'overrides', 'tools', 'toolPolicy', 'model', 'unknown'].map(k => [`content 拒收 ${k}`, m => m.contents[0][k] = [], 'invalid-package']),
  ['type 一致', m => m.type = 'agent', 'invalid-package'],
  ['檔案 definition', m => m.contents[0].definition = {}, 'invalid-package'],
  ['path 必填', m => delete m.contents[0].path, 'invalid-package'],
  ...['../outside', '/outside', 'C:\\outside', '\\outside'].map(p => [`path 逃逸 ${p}`, m => m.contents[0].path = p, 'path-escape']),
  ['hosts 僅 agent', m => m.contents[0].hosts = { codex: {} }, 'invalid-package'],
  ['hosts 平台鍵', m => { m.contents[0].kind = 'agent'; m.contents[0].hosts = { unknown: {} }; }, 'invalid-package'],
  ['hosts 未知欄位', m => { m.contents[0].kind = 'agent'; m.contents[0].hosts = { codex: { permissions: [] } }; }, 'invalid-package'],
  ['hosts tools 形狀', m => { m.contents[0].kind = 'agent'; m.contents[0].hosts = { codex: { tools: [1] } }; }, 'invalid-package'],
  ['hosts model 形狀', m => { m.contents[0].kind = 'agent'; m.contents[0].hosts = { codex: { model: 1 } }; }, 'invalid-package'],
  ['相依揭露', m => m.dependencies = { cli: [{}] }, 'invalid-package'],
  ['MCP path', m => m.contents = [{ id: 'server', kind: 'mcp', name: '服務', path: 'file', definition: { command: 'node' } }], 'invalid-package'],
  ...[
    ['definition 缺少', undefined], ['definition 形狀', []], ['transport', { command: 'node', transport: 'http' }],
    ['command', {}], ['args', { command: 'node', args: '' }], ['parameters', { command: 'node', parameters: '' }],
    ['parameter id', { command: 'node', parameters: [{}] }], ['parameter 重複', { command: 'node', parameters: [{ id: 'a' }, { id: 'a' }] }],
  ].map(([name, definition]) => [`MCP ${name}`, m => m.contents = [{ id: 'server', kind: 'mcp', name: '服務', definition }], 'invalid-package']),
  ['MCP 內嵌秘密', m => m.contents = [{ id: 'server', kind: 'mcp', name: '服務', definition: { command: 'node', env: { API_TOKEN: 'synthetic' } } }], 'secret-unresolved'],
];
for (const [name, mutate, code] of mutations) test(`預檢 manifest：${name}`, async t => {
  const f = await fixture(t); mutate(f.manifest); await f.save();
  const result = await inspect(f);
  assert.equal(result.ok, false); assert.ok(result.blocking.some(p => p.code === `deployment.${code}`), JSON.stringify(result.blocking));
});

const setupCases = [
  ['空 setup', {}, 'invalid-setup'], ['未知欄位', { unknown: 1 }, 'invalid-setup'],
  ...[
    ['parameter 必填', {}], ['parameter 型別', { parameterId: 'a', label: 'A', type: 'number' }],
    ['secretUsage 必填', { parameterId: 'a', label: 'A', type: 'secret' }],
    ['secretUsage 不適用', { parameterId: 'a', label: 'A', type: 'string', secretUsage: 'runtime' }],
    ['choice options 必填', { parameterId: 'a', label: 'A', type: 'choice' }],
    ['options 不適用', { parameterId: 'a', label: 'A', type: 'string', options: [{ value: 'a', label: 'A' }] }],
    ['option 必填', { parameterId: 'a', label: 'A', type: 'choice', options: [{}] }],
    ['option 重複', { parameterId: 'a', label: 'A', type: 'choice', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'A' }] }],
    ['default 型別', { parameterId: 'a', label: 'A', type: 'boolean', default: '' }],
    ['default choice', { parameterId: 'a', label: 'A', type: 'choice', options: [{ value: 'a', label: 'A' }], default: 'b' }],
    ['required 型別', { parameterId: 'a', label: 'A', type: 'string', required: '' }],
  ].map(([name, p]) => [name, { parameters: [p] }, 'invalid-setup']),
  ['秘密 default', { parameters: [{ parameterId: 'a', label: 'A', type: 'secret', secretUsage: 'runtime', default: 'synthetic' }] }, 'setup-secret-exposure'],
  ['parameter 重複', { parameters: [{ parameterId: 'a', label: 'A', type: 'string' }, { parameterId: 'a', label: 'A', type: 'string' }] }, 'duplicate-setup-id'],
  ['visibleWhen 引用', { parameters: [{ parameterId: 'a', label: 'A', type: 'string', visibleWhen: { parameterId: 'missing', equals: '' } }] }, 'invalid-setup-reference'],
  ['visibleWhen 自己', { parameters: [{ parameterId: 'a', label: 'A', type: 'string', visibleWhen: { parameterId: 'a', equals: '' } }] }, 'invalid-setup-reference'],
  ['visibleWhen 循環', { parameters: ['a', 'b'].map((id, i) => ({ parameterId: id, label: id, type: 'string', visibleWhen: { parameterId: i ? 'a' : 'b', equals: '' } })) }, 'invalid-setup-reference'],
  ...[
    ['command 必填', { commandId: '', name: '', runner: '', script: '' }], ['runner', { runner: 'node' }], ['script 副檔名', { script: 'bad.exe' }],
    ['payload 重複', { payloads: ['payload', 'payload'] }], ['arguments 型別', { arguments: [1] }],
    ['OS', { operatingSystems: ['linux'] }], ['OS 重複', { operatingSystems: ['windows', 'windows'] }],
    ['架構', { architectures: ['x86'] }], ['架構重複', { architectures: ['x64', 'x64'] }],
    ['timeout 下限', { timeoutMinutes: 0 }], ['timeout 上限', { timeoutMinutes: 121 }], ['runOnUpdate', { runOnUpdate: '' }],
  ].map(([name, patch]) => [name, { commands: [{ ...command(), ...patch }] }, 'invalid-setup']),
  ['script 逃逸', { commands: [{ ...command(), script: '../outside' }] }, 'path-escape'],
  ['payload 逃逸', { commands: [{ ...command(), payloads: ['../outside'] }] }, 'path-escape'],
  ['command 重複', { commands: [command(), command()] }, 'duplicate-setup-id'],
  ['argument 未知 token', { commands: [{ ...command(), arguments: ['{{unknown}}'] }] }, 'invalid-setup-reference'],
  ['argument setupRoot', { commands: [{ ...command(), arguments: ['{{setupRoot}}'] }] }, 'invalid-setup-reference'],
  ['argument 秘密', { parameters: [{ parameterId: 'a', label: 'A', type: 'secret', secretUsage: 'setup-time' }], commands: [{ ...command(), arguments: ['{{parameter:a}}'] }] }, 'setup-secret-exposure'],
];
for (const [name, setup, code] of setupCases) test(`預檢 setup：${name}`, async t => {
  const f = await fixture(t); f.manifest.setup = setup; await f.save();
  await f.write('setup/install.ps1', 'Write-Host ok'); await f.write('payload/file', 'data');
  const result = await inspect(f);
  assert.equal(result.ok, false); assert.ok(result.blocking.some(p => p.code === `deployment.${code}`), JSON.stringify(result.blocking));
});

test('一次收集 manifest、README、來源路徑、frontmatter、拒收副檔名與編碼問題', async t => {
  const f = await fixture(t); f.manifest.name = ''; f.manifest.setup = { commands: [command()] };
  f.manifest.contents.push({ id: 'missing', kind: 'agent', path: 'missing.md' }); await f.save();
  await fs.rm(path.join(f.folder, 'README.md')); await f.write('skills/example/SKILL.md', '---\n---\n');
  await f.write('bad.EXE', 'data'); await f.write('setup/install.ps1', '中文'); await f.write('payload/file', 'data');
  const result = await inspect(f);
  for (const term of ['name', 'README.md', 'missing.md', 'description', 'bad.EXE', 'UTF-8 with BOM']) assert.ok(result.blocking.some(p => p.message.includes(term)), term);
});

for (const [name, source] of [['缺少 frontmatter', 'body'], ['無法解析', '---\ninvalid\n---\nbody'], ['重複欄位', '---\nname: a\nname: b\ndescription: D\n---\nbody'], ['name 空白', '---\nname:\ndescription: D\n---\nbody'], ['description 空白', '---\nname: a\ndescription:\n---\nbody'], ['body 空白', '---\nname: a\ndescription: D\n---\n']]) test(`Skill：${name}`, async t => {
  const f = await fixture(t); await f.write('skills/example/SKILL.md', source); assert.equal((await inspect(f)).ok, false);
});
for (const name of ['skill.md', 'missing']) test(`Skill 入口：${name}`, async t => {
  const f = await fixture(t); await fs.rm(path.join(f.folder, 'skills/example/SKILL.md')); if (name !== 'missing') await f.write(`skills/example/${name}`, skill);
  assert.ok((await inspect(f)).blocking.some(p => /SKILL.md/.test(p.message)));
});
test('非標準欄位只揭露，標準選填欄位不阻擋', async t => {
  const f = await fixture(t); await f.write('skills/example/SKILL.md', skill.replace('description:', 'license: MIT\nallowed-tools: Read\nargument-hint: input\ndisable-model-invocation: true\nz-custom: yes\na-custom: yes\ndescription:'));
  const r = await inspect(f); assert.equal(r.ok, true); assert.equal(r.disclosures.length, 1); assert.equal(r.disclosures[0].code, 'deployment.non-standard-content-fields'); assert.match(r.disclosures[0].message, /a-custom, z-custom/);
});
for (const ext of ['exe', 'dll', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1xml', 'zip', '7z', 'rar']) test(`拒收副檔名 ${ext}`, async t => {
  const f = await fixture(t); await f.write(`skills/example/file.${ext.toUpperCase()}`, 'data'); assert.equal((await inspect(f)).ok, false);
});
for (const name of ['readme.md', 'missing', 'directory']) test(`README：${name}`, async t => {
  const f = await fixture(t); await fs.rm(path.join(f.folder, 'README.md')); if (name === 'readme.md') await f.write(name, 'readme'); if (name === 'directory') await fs.mkdir(path.join(f.folder, 'README.md'));
  assert.ok((await inspect(f)).blocking.some(p => p.path?.toLowerCase() === 'readme.md'));
});
for (const source of ['{broken', 'null', '[]', '1']) test(`無效 manifest ${source}`, async t => {
  const f = await fixture(t); await f.write('lcpack.json', source); assert.equal((await inspect(f)).ok, false);
});
test('缺少 manifest 仍回報 README 問題', async t => {
  const f = await fixture(t); await fs.rm(f.folder, { recursive: true }); const r = await inspect(f); assert.equal(r.ok, false); assert.ok(r.blocking.length >= 2);
});
test('結構化收集不改變舊呼叫端的拋錯行為', () => {
  const m = { contents: [null], dependencies: [] }; const p = collectManifestProblems(m);
  assert.ok(p.length > 4); assert.throws(() => validateManifest(m), /資源包格式錯誤/);
});

for (const runner of ['powershell', 'bash']) for (const encoding of ['ascii', 'utf8', 'bom', 'utf16le', 'utf16be']) test(`設定編碼 ${runner}/${encoding}`, async t => {
  const f = await fixture(t); f.manifest.setup = { commands: [{ ...command(), runner }] }; await f.save();
  const bytes = encoding === 'ascii' ? Buffer.from('echo ok') : encoding === 'utf8' ? Buffer.from('中文') : encoding === 'bom' ? Buffer.from('\uFEFF中文') : encoding === 'utf16le' ? Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文', 'utf16le')]) : Buffer.from([254, 255, 78, 45]);
  await f.write('setup/install.ps1', bytes); await f.write('payload/nested/helper.PSM1', bytes); await f.write('unrelated.ps1', '中文');
  const r = await inspect(f); assert.equal(r.ok, runner !== 'powershell' || encoding !== 'utf8');
  if (!r.ok) assert.equal(r.blocking.filter(p => p.code === 'deployment.setup-script-encoding').length, 2);
});
for (const field of ['script', 'payloads']) test(`setup ${field} 來源不存在`, async t => {
  const f = await fixture(t); f.manifest.setup = { commands: [command()] }; await f.save();
  if (field === 'script') await f.write('payload/file', 'data'); else await f.write('setup/install.ps1', 'echo ok');
  assert.ok((await inspect(f)).blocking.some(p => p.message.includes(field === 'script' ? 'script' : 'payload')));
});

for (const suffix of ['comments', 'trailing', 'version']) test(`只有 upload 阻擋：${suffix}`, async t => {
  const f = await fixture(t);
  if (suffix === 'version') { f.manifest.version = '1.2.3-preview'; await f.save(); }
  else await f.write('lcpack.json', suffix === 'comments' ? `/* note */${JSON.stringify(f.manifest)}` : JSON.stringify(f.manifest).replace(/}$/, ',}'));
  assert.equal((await inspect(f)).ok, true); assert.equal((await inspect(f, 'upload')).ok, false);
});
test('只有 upload 阻擋收錄的 symlink；忽略未收錄資料夾', async t => {
  const f = await fixture(t); await f.write('target/file', 'data');
  await fs.symlink(path.join(f.folder, 'target'), path.join(f.folder, 'skills/example/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const local = await inspect(f); assert.equal(local.ok, true); assert.ok(local.files.includes('skills/example/linked/file'));
  const upload = await inspect(f, 'upload'); assert.equal(upload.ok, false); assert.ok(upload.blocking.some(p => /symlink/.test(p.message)));
});
test('upload 以實際壓縮後 ZIP 大小判斷 100 MB', async t => {
  const f = await fixture(t); await f.write('large.dat', Buffer.alloc(101 * 1024 * 1024));
  assert.equal((await inspect(f, 'upload')).ok, true);
  await f.write('large.dat', randomBytes(101 * 1024 * 1024));
  assert.equal((await inspect(f)).ok, true);
  assert.ok((await inspect(f, 'upload')).blocking.some(p => /100 MB/.test(p.message)));
});

for (const [name, definition, parameters, code] of [
  ['setupRoot 缺少命令', { command: '{{setupRoot}}/run' }, [], 'invalid-setup-reference'],
  ['setupRoot 欄位', { command: 'node', env: { ROOT: '{{setupRoot}}' } }, [], 'invalid-setup-reference'],
  ['未知 token', { command: 'node', args: ['{{unknown}}'] }, [], 'invalid-setup-reference'],
  ['setup-time runtime 身分', { command: 'node', parameters: [{ id: 'a' }] }, [{ parameterId: 'a', label: 'A', type: 'secret', secretUsage: 'setup-time' }], 'setup-secret-exposure'],
  ['secret runtime 宣告', { command: 'node', parameters: [{ id: 'a', secret: true }] }, [], 'invalid-setup-reference'],
]) test(`MCP setup：${name}`, async t => {
  const f = await fixture(t); f.manifest.contents = [{ id: 'server', kind: 'mcp', name: '服務', definition }];
  f.manifest.setup = { parameters }; await f.save();
  assert.ok((await inspect(f)).blocking.some(p => p.code === `deployment.${code}`));
});
test('visibleWhen 不得比對秘密；equals 必須符合參數型別', async t => {
  const f = await fixture(t); f.manifest.setup = { parameters: [
    { parameterId: 'secret', label: '秘密', type: 'secret', secretUsage: 'runtime' },
    { parameterId: 'boolean', label: '布林', type: 'boolean' },
    { parameterId: 'a', label: 'A', type: 'string', visibleWhen: { parameterId: 'secret', equals: '' } },
    { parameterId: 'b', label: 'B', type: 'string', visibleWhen: { parameterId: 'boolean', equals: '' } },
  ] }; await f.save(); const r = await inspect(f);
  assert.ok(r.blocking.some(p => p.code === 'deployment.setup-secret-exposure'));
  assert.ok(r.blocking.some(p => /visibleWhen/.test(p.message)));
});
test('upload 拒收宣告路徑中間層的 symlink', async t => {
  const f = await fixture(t); await f.write('target/file.md', 'data');
  await fs.symlink(path.join(f.folder, 'target'), path.join(f.folder, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  f.manifest.contents = [{ id: 'agent', kind: 'agent', path: 'alias/file.md' }]; await f.save();
  assert.equal((await inspect(f)).ok, true); assert.ok((await inspect(f, 'upload')).blocking.some(p => /symlink/.test(p.message)));
});
test('無效物件形狀仍逐項收集問題', () => {
  for (const patch of [{ contents: [null] }, { contents: [1] }, { dependencies: [] }, { setup: { parameters: [null], commands: [null] } }, { setup: { parameters: [{ parameterId: 'a', visibleWhen: 1 }] } }]) {
    assert.ok(collectManifestProblems(patch).length > 0);
  }
});
