import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePackage } from '../worker/package-validator.mjs';
import { zip, manifest } from './zip-fixture.mjs';
const identity = { packageKey: 'demo', version: '1.0.0' };
const pack = m => zip({ 'lcpack.json': JSON.stringify(m), 'README.md': '# Demo', 'resources/hello/SKILL.md': 'hello' });

test('共用驗證入口拒絕 canonical 必填、舊欄位、重複身分、混合 kind 與 content 路徑逃逸', () => {
  const content = manifest.contents[0];
  const bad = [{ ...manifest, name: '' }, { ...manifest, customField: true }, { ...manifest, schemaVersion: 1 },
    { ...manifest, contents: [] }, { ...manifest, contents: [content, content] },
    { ...manifest, contents: [{ ...content, path: '../outside' }] },
    { ...manifest, contents: [{ ...content, tools: [] }] },
    { ...manifest, contents: [{ ...content, definition: {} }] },
    { ...manifest, contents: [{ ...content, id: 'Upper-Case' }] },
    { ...manifest, contents: [{ id: 'mcp', kind: 'mcp', name: 'MCP', definition: { command: 'npx' } }] },
    { ...manifest, dependencies: { cli: [{ name: 'node' }] } }];
  for (const m of bad) assert.throws(() => validatePackage(pack(m), identity), { code: 'invalid_package' });
});

test('共用驗證入口保留 JSONC、尾逗號與省略 skill metadata 的有效 manifest', () => {
  const jsonc = `// synthetic\n${JSON.stringify(manifest).replace(/}$/, ',}')}`;
  const result = validatePackage(zip({ 'lcpack.json': jsonc, 'README.md': 'x', 'resources/hello/SKILL.md': 'hello' }), identity);
  assert.equal(result.manifest.contents[0].name, undefined);
});

test('setup 依 canonical 規則拒絕秘密預設值、未知欄位、循環與命令參數秘密外洩', () => {
  const parameter = { parameterId: 'label', label: 'Label', type: 'string' };
  const command = { commandId: 'prepare', name: 'Prepare', runner: 'bash', script: 'setup/run.sh' };
  for (const setup of [{}, { custom: true, parameters: [parameter] },
    { parameters: [{ ...parameter, type: 'secret', secretUsage: 'runtime', default: 'synthetic' }] },
    { parameters: [{ ...parameter, visibleWhen: { parameterId: 'label', equals: 'x' } }] },
    { parameters: [{ ...parameter, type: 'choice', options: [] }] },
    { commands: [{ ...command, script: '../outside' }] },
    { commands: [{ ...command, runner: 'arbitrary-shell' }] },
    { commands: [{ ...command, arguments: ['{{parameter:missing}}'] }] },
    { parameters: [{ ...parameter, type: 'secret', secretUsage: 'runtime' }], commands: [{ ...command, arguments: ['{{parameter:label}}'] }] }]) {
    assert.throws(() => validatePackage(pack({ ...manifest, setup }), identity), { code: 'invalid_package' });
  }
});

test('Agent 平台指定接受 LC-AI-Pack 的 GitHub Copilot 鍵', () => {
  const m = { ...manifest, type: 'agent', contents: [{ id: 'hello', kind: 'agent', path: 'resources/hello.md', hosts: { 'github-copilot': { tools: ['read'], model: 'model-name' } } }] };
  assert.equal(validatePackage(pack(m), identity).manifest.type, 'agent');
});

test('後續安裝可直接用共用驗證器比對 metadata SHA-256 與下載標頭', () => {
  for (const field of ['sha256', 'downloadSha256']) {
    assert.throws(() => validatePackage(zip(), { ...identity, [field]: '0'.repeat(64) }), { code: 'checksum_mismatch' });
  }
});

test('ZIP 內的符號連結與損壞項目不可成為可用的下載', () => {
  const entries = { 'lcpack.json': JSON.stringify(manifest), 'README.md': 'x' };
  assert.throws(() => validatePackage(zip(entries, { 'README.md': 0xa1ff0000 }), identity), /符號連結/);
  const corrupt = zip(); corrupt[45] ^= 1;
  assert.throws(() => validatePackage(corrupt, identity), { code: 'invalid_package' });
});

test('共用驗證器接受 ZIP64 目錄，與 ZipArchive 可讀取的封裝一致', () => {
  const normal = zip(), end = Buffer.from(normal.subarray(-22)), record = Buffer.alloc(56), locator = Buffer.alloc(20);
  record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(end.readUInt16LE(8)), 24); record.writeBigUInt64LE(BigInt(end.readUInt16LE(10)), 32);
  record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40); record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48);
  locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(normal.length - 22), 8); locator.writeUInt32LE(1, 16);
  end.writeUInt16LE(65535, 8); end.writeUInt16LE(65535, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  const result = validatePackage(Buffer.concat([normal.subarray(0, -22), record, locator, end]), identity);
  assert.equal(result.manifest.key, 'demo');
});
