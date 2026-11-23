import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectSourceFolder, buildPackageZip } from '../worker/pack/index.mjs';
import { readPackageZip, validatePackage } from '../worker/package-validator.mjs';
import { openCanonicalPackage } from '../worker/deploy/canonical-package.mjs';
import { fixture, command } from './pack-fixture.mjs';

test('ZIP 收錄根層、非 MCP contents、setup 宣告；排除未宣告目錄並依 Ordinal 排序', async t => {
  const f = await fixture(t);
  f.manifest.contents.push({ id: 'agent', kind: 'agent', path: 'agents/example.md' },
    { id: 'prompt', kind: 'prompt', name: '提示', path: 'prompts/example.md' },
    { id: 'command', kind: 'command', name: '命令', path: 'commands/example.md' },
    { id: 'server', kind: 'mcp', name: '服務', definition: { command: 'node' } });
  f.manifest.setup = { commands: [command(), { ...command(), commandId: 'second' }] }; await f.save();
  for (const [name, bytes] of Object.entries({
    '.root-dotfile': 'dot', 'LICENSE': 'MIT', 'index.html': '<p>說明</p>',
    'agents/example.md': '代理\r\n', 'prompts/example.md': '提示\n', 'commands/example.md': '命令\r\n',
    'skills/example/Z.txt': 'Z', 'skills/example/a.txt': 'a', 'skills/example/資料.dat': Buffer.from([0, 128, 255, 13, 10]),
    'skills/example/.git/config': 'ignore', 'skills/example/nested/Node_Modules/dependency.exe': 'ignore',
    'setup/install.ps1': 'Write-Host ok\r\n', 'payload/nested/file': 'data', 'payload/.git/config': 'ignore',
    'setup/undeclared.txt': 'ignore', 'unrelated/file.txt': 'ignore', 'resources/mcp/unlisted/file': 'ignore',
  })) await f.write(name, bytes);
  await fs.mkdir(path.join(f.folder, 'skills/example/empty'), { recursive: true });
  const inspection = await inspectSourceFolder(f.folder, { mode: 'upload' });
  assert.equal(inspection.ok, true, JSON.stringify(inspection.blocking));
  assert.deepEqual(inspection.summary.contentCounts, { skill: 1, agent: 1, command: 1, prompt: 1, mcp: 1 });
  assert.equal(inspection.summary.hasFullGuide, true);
  const expected = ['.root-dotfile', 'LICENSE', 'README.md', 'agents/example.md', 'commands/example.md', 'index.html', 'lcpack.json',
    'payload/nested/file', 'prompts/example.md', 'setup/install.ps1', 'skills/example/SKILL.md', 'skills/example/Z.txt', 'skills/example/a.txt', 'skills/example/資料.dat'];
  assert.deepEqual(inspection.files, expected);
  const result = await buildPackageZip(f.folder, inspection, { outputDirectory: f.output });
  assert.equal(path.basename(result.zipPath), 'example.test-1.2.3.zip');
  const bytes = await fs.readFile(result.zipPath);
  assert.equal(result.bytes, bytes.length); assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  const files = readPackageZip(bytes); assert.deepEqual([...files.keys()], expected);
  const validated = validatePackage(bytes, { packageKey: 'example.test', version: '1.2.3', sha256: result.sha256 });
  const canonical = openCanonicalPackage({ bytes, expectedSha256: result.sha256 });
  let total = 0;
  for (const name of expected) {
    const original = await fs.readFile(path.join(f.folder, name)); total += original.length;
    assert.deepEqual(validated.files.get(name), original); assert.deepEqual(canonical.readFile(name), original);
  }
  assert.equal(inspection.summary.fileCount, expected.length); assert.equal(inspection.summary.totalBytes, total);
  const again = await buildPackageZip(f.folder, inspection, { outputDirectory: f.output });
  assert.equal(again.sha256, result.sha256);
  assert.deepEqual(await fs.readdir(f.output), [path.basename(result.zipPath)]);
});
test('重疊宣告及大小寫不同的路徑以不分大小寫去重', async t => {
  const f = await fixture(t); await f.write('skills/example/a.txt', 'data');
  f.manifest.contents.push({ id: 'overlap', kind: 'agent', path: 'skills/example/a.txt' });
  f.manifest.setup = { commands: [{ ...command(), script: 'skills/example/a.txt', payloads: ['skills/example'] }] }; await f.save();
  const inspection = await inspectSourceFolder(f.folder, { mode: 'install' }); assert.equal(inspection.ok, true);
  assert.equal(inspection.files.filter(p => p === 'skills/example/a.txt').length, 1);
  if (process.platform !== 'win32') {
    await f.write('skills/example/A.txt', 'other'); const second = await inspectSourceFolder(f.folder, { mode: 'install' });
    assert.equal(second.files.filter(p => /\/a.txt$/i.test(p)).length, 1);
  }
});
test('JSONC 的安裝 ZIP 原樣保留 manifest，既有驗證器可讀取', async t => {
  const f = await fixture(t); await f.write('lcpack.json', `/* note */${JSON.stringify(f.manifest).replace(/}$/, ',}')}`);
  const inspection = await inspectSourceFolder(f.folder, { mode: 'install' });
  const result = await buildPackageZip(f.folder, inspection, { outputDirectory: f.output });
  const p = validatePackage(await fs.readFile(result.zipPath), { packageKey: f.manifest.key, version: f.manifest.version });
  assert.deepEqual(p.files.get('lcpack.json'), await fs.readFile(path.join(f.folder, 'lcpack.json')));
});
test('未通過預檢時不產出 ZIP', async t => {
  const f = await fixture(t); await fs.rm(path.join(f.folder, 'README.md'));
  const inspection = await inspectSourceFolder(f.folder, { mode: 'install' });
  await assert.rejects(buildPackageZip(f.folder, inspection, { outputDirectory: f.output }), /預檢/);
  await assert.rejects(fs.access(f.output));
});
test('來源消失時清理暫存檔並保留既有 ZIP', async t => {
  const f = await fixture(t); const inspection = await inspectSourceFolder(f.folder, { mode: 'install' });
  const first = await buildPackageZip(f.folder, inspection, { outputDirectory: f.output });
  await fs.rm(path.join(f.folder, 'skills/example/SKILL.md'));
  await assert.rejects(buildPackageZip(f.folder, inspection, { outputDirectory: f.output }));
  assert.deepEqual(await fs.readdir(f.output), [path.basename(first.zipPath)]);
  assert.equal(createHash('sha256').update(await fs.readFile(first.zipPath)).digest('hex'), first.sha256);
});
