// 對照 StoreLayoutCharacterisationTests 與 RealFileSystemContractTests（狀態檔原子寫入），
// 並以 ReceiptStore.Upsert 實際產生的收據檔確認位元組相容。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReceiptStore, serializeReceiptFile, parseReceiptFile, ownershipAddress, formatInstalledAt } from '../worker/deploy/receipts.mjs';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';

const golden = new URL('./fixtures/lcaipack-receipts.windows.golden.json', import.meta.url);
async function temp(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-receipts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const receipt = (overrides = {}) => ({
  packageKey: 'demo', packageVersion: '1.0.0', packageSha256: 'a'.repeat(64), channel: 'release', contentId: 'hello', kind: 'skill',
  hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', canonicalRoot: 'c:\\users\\alice\\.codex',
  normalizedAddress: 'codex|codex-cli|global|c:\\users\\alice\\.codex|hello', destinationPath: 'c:\\users\\alice\\.codex\\skills\\hello',
  mutationKind: 'SyncTree', sourceSha256: 'a'.repeat(64), installedSha256: 'b'.repeat(64), ownedConfigFields: [], baseValueHashes: [],
  installedAt: '2026-11-21T03:04:05.12+00:00', clientVersion: '1.0.0', hostProfileVersion: 'codex/2026.10.1', ...overrides
});

test('共用 Codex 技能的 v2 收據與既有 Windows 收據檔逐位元組相容', async () => {
  const bytes = await readFile(new URL('./fixtures/lcaipack-shared-skill-v2.windows.golden.json', import.meta.url));
  const root = 'c:\\synthetic\\home';
  const shared = receipt({ packageKey: 'demo.skill', canonicalRoot: root, destinationPath: root + '\\.agents\\skills\\hello',
    normalizedAddress: 'codex|codex-cli|global|' + root + '|hello', clientVersion: '1.6.0', hostProfileVersion: 'codex/2026.11.1' });
  assert.deepEqual(parseReceiptFile(bytes.toString('utf8'), 'golden'), { receiptFormatVersion: 2, receipts: [shared] });
  assert.deepEqual(Buffer.from(serializeReceiptFile({ receiptFormatVersion: 2, receipts: [shared] }, '\r\n')), bytes);
});

test('既有收據檔可讀回，原樣再序列化後逐位元組相同（Windows 換行）', async () => {
  const bytes = await readFile(golden);
  const file = parseReceiptFile(bytes.toString('utf8'), 'golden');
  assert.equal(file.receipts.length, 3);
  assert.equal(file.receipts[2].canonicalRoot, 'c:\\users\\使用者\\.codex');
  assert.equal(file.receipts[0].source, 'local');
  assert.equal(file.receipts[1].sourcePath, undefined);
  assert.deepEqual(Buffer.from(serializeReceiptFile(file, '\r\n'), 'utf8'), bytes);
});

test('Orca 建立的收據與既有收據的格式一致：欄位順序、跳脫、targetKey 與時間格式', async () => {
  const expected = (await readFile(golden)).toString('utf8');
  const file = { receiptFormatVersion: 1, receipts: [
    { ...receipt({ packageKey: 'demo.pkg', packageSha256: 'ab', sourceSha256: 'ab', installedSha256: 'cd', canonicalRoot: 'c:\\users\\使用者\\.codex',
      normalizedAddress: 'codex|codex-cli|global|c:\\users\\使用者\\.codex|hello', destinationPath: 'c:\\a<b>&\'"+`\t\u0001é😀\\x\n\r/',
      ownedConfigFields: ['mcpServers.x'], installedAt: formatInstalledAt(new Date(Date.UTC(2026, 10, 21, 3, 4, 5, 120))) }) }
  ] };
  const text = serializeReceiptFile(file, '\r\n');
  const lastBlock = expected.slice(expected.lastIndexOf('    {\r\n      "packageKey": "demo.pkg"'));
  assert.ok(text.includes(lastBlock.slice(0, lastBlock.lastIndexOf('\r\n  ]'))));
  assert.equal(formatInstalledAt(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 0))), '2026-01-02T03:04:05+00:00');
});

test('全域收據檔直接位於資料目錄下，正規化根目錄是使用者家目錄；專案收據在專案的 .lcaipack', async (t) => {
  const dir = await temp(t);
  const rules = createPathRules();
  const global = ReceiptStore.forGlobal({ home: path.join(dir, 'home'), userProfile: path.join(dir, 'User'), rules });
  assert.equal(global.filePath, path.join(dir, 'home', 'receipts.json'));
  assert.equal(global.canonicalRoot, rules.normalize(path.join(dir, 'User')));
  assert.equal(global.scope, 'global');
  const project = ReceiptStore.forProject({ projectRoot: path.join(dir, 'repo'), rules });
  assert.equal(project.filePath, path.join(dir, 'repo', '.lcaipack', 'receipts.json'));
});

test('收據檔不存在時視為空且不建立任何檔案；存檔後讀回並標記格式版本、不留下暫存檔', async (t) => {
  const dir = await temp(t);
  const store = ReceiptStore.forGlobal({ home: path.join(dir, 'home'), userProfile: dir });
  assert.deepEqual(store.load(), { receiptFormatVersion: 2, receipts: [] });
  assert.equal(existsSync(path.join(dir, 'home')), false);
  store.save({ receiptFormatVersion: 7, receipts: [receipt()] });
  const loaded = store.load();
  assert.equal(loaded.receiptFormatVersion, 2);
  assert.deepEqual(loaded.receipts, [receipt()]);
  assert.deepEqual(await readdir(path.join(dir, 'home')), ['receipts.json']);
  const raw = await readFile(store.filePath);
  assert.notEqual(raw[0], 0xef, '不得有 BOM');
});

test('保留舊格式讀取能力，首次寫入改用格式 2', async (t) => {
  const dir = await temp(t);
  const store = ReceiptStore.forGlobal({ home: dir, userProfile: dir });
  const legacy = '{"receiptFormatVersion":1,"receipts":[]}';
  await writeFile(store.filePath, legacy);
  const loaded = store.load();
  assert.equal(loaded.receiptFormatVersion, 1);
  assert.equal(await readFile(store.filePath, 'utf8'), legacy);
  store.save(loaded);
  assert.equal(store.load().receiptFormatVersion, 2);
});

for (const [name, content] of [['不支援的格式版本', '{"receiptFormatVersion":99,"receipts":[]}'], ['字面 null', 'null'], ['空白', '  \n'], ['損壞的 JSON', '{"receipts":[']]) {
  test(`收據檔為${name}時明確失敗且不改動檔案，不當成全新狀態`, async (t) => {
    const dir = await temp(t);
    await mkdir(path.join(dir, 'home'));
    await writeFile(path.join(dir, 'home', 'receipts.json'), content);
    const store = ReceiptStore.forGlobal({ home: path.join(dir, 'home'), userProfile: dir });
    assert.throws(() => store.load(), { code: 'receipt_invalid' });
    assert.throws(() => store.upsert([receipt()]), { code: 'receipt_invalid' });
    assert.throws(() => store.save({ receipts: [] }), { code: 'receipt_invalid' });
    assert.equal(await readFile(path.join(dir, 'home', 'receipts.json'), 'utf8'), content);
  });
}

test('以部署位址覆寫同一筆收據，其他收據原樣保留並依位址排序', async (t) => {
  const dir = await temp(t);
  const store = ReceiptStore.forGlobal({ home: dir, userProfile: dir });
  const other = receipt({ packageKey: 'other', contentId: 'zzz', normalizedAddress: 'codex|codex-cli|global|c:\\users\\alice\\.codex|zzz', installedAt: '2025-01-01T00:00:00.1234567+08:00' });
  store.upsert([other, receipt()]);
  store.upsert([receipt({ packageVersion: '1.1.0' })]);
  const { receipts } = store.load();
  assert.deepEqual(receipts.map(r => [r.contentId, r.packageVersion]), [['hello', '1.1.0'], ['zzz', '1.0.0']]);
  assert.equal(receipts[1].installedAt, '2025-01-01T00:00:00.1234567+08:00');
  assert.equal(store.forTarget({ hostId: 'codex', surfaceId: 'codex-cli' }, 'global', 'C:\\Users\\Alice\\.codex\\').length, process.platform === 'win32' ? 2 : 0);
  store.removeAddresses([receipt().normalizedAddress]);
  assert.deepEqual(store.load().receipts.map(r => r.contentId), ['zzz']);
});

test('部署位址由 Host、載入面、範圍、正規化根目錄與內容身分組成；設定欄位另附設定檔路徑', () => {
  const rules = createPathRules({ platform: 'win32', resolveLinks: false });
  const host = { hostId: 'codex', surfaceId: 'codex-cli' };
  assert.equal(ownershipAddress(rules, host, 'global', 'C:\\Users\\Alice\\.codex\\', 'hello'), 'codex|codex-cli|global|c:\\users\\alice\\.codex|hello');
  assert.equal(ownershipAddress(rules, host, 'global', 'C:\\Users\\Alice\\.codex', 'mcp', 'C:\\Users\\Alice\\.codex\\Config.toml'),
    'codex|codex-cli|global|c:\\users\\alice\\.codex|mcp|c:\\users\\alice\\.codex\\config.toml');
});
