import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateCodexSkills } from '../worker/deploy/codex-skill-migration.mjs';
import { ReceiptStore, ownershipAddress } from '../worker/deploy/receipts.mjs';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';
import { ofBytes, ofTree } from '../worker/deploy/digest.mjs';
import { startWorker } from './harness.mjs';
import { manifest, zip } from './zip-fixture.mjs';

const host = { hostId: 'codex', surfaceId: 'codex-cli' };
function fixture(t) {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-migrate-'));
  t.after(() => fs.rmSync(userHome, { force: true, recursive: true }));
  const home = path.join(userHome, '.lcaipack'), rules = createPathRules();
  const store = ReceiptStore.forGlobal({ home, userProfile: userHome });
  function write(dir, content) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  }
  function receipt(root, version, content) {
    const canonicalRoot = rules.normalize(path.join(userHome, root));
    const destinationPath = path.join(canonicalRoot, 'skills', 'guide');
    const installedSha256 = ofTree([{ relativePath: 'SKILL.md', content: Buffer.from(content) }]);
    return { ...host, canonicalRoot, packageKey: 'demo', packageVersion: version, scope: 'global', kind: 'skill', mutationKind: 'SyncTree',
      normalizedAddress: ownershipAddress(rules, host, 'global', canonicalRoot, 'guide'), contentId: 'guide', installedSha256, destinationPath };
  }
  return { home, userHome, store, write, receipt, shared: path.join(userHome, '.agents', 'skills', 'guide') };
}
test('migrates highest installed version, archives edited and unmanaged copies, and reruns quietly', async t => {
  const f = fixture(t);
  const one = f.receipt('.codex', '1.2.0', 'old'), two = f.receipt('.codex-work', '1.10.0', 'new');
  f.store.upsert([one, two]);
  f.write(one.destinationPath, 'edited'); f.write(two.destinationPath, 'new'); f.write(f.shared, 'unmanaged');
  const personal = path.join(path.dirname(one.destinationPath), 'personal');
  f.write(personal, 'mine');
  const result = await migrateCodexSkills(f);
  assert.equal(result.migrated, 1);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.backups.map(dir => fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).sort(), ['edited', 'unmanaged']);
  assert.equal(fs.readFileSync(path.join(f.shared, 'SKILL.md'), 'utf8'), 'new');
  assert.ok(fs.existsSync(personal));
  assert.ok(!fs.existsSync(one.destinationPath) && !fs.existsSync(two.destinationPath));
  assert.deepEqual(f.store.load().receipts.map(r => [r.packageVersion, r.canonicalRoot]), [['1.10.0', f.store.canonicalRoot]]);
  assert.equal((await migrateCodexSkills(f)).migrated, 0);
});

test('a foreign owner blocks migration without writing or removing copies', async t => {
  const f = fixture(t), old = f.receipt('.codex', '1.0.0', 'old');
  const other = { ...f.receipt('.other', '1.0.0', 'foreign'), packageKey: 'other', destinationPath: f.shared };
  f.store.upsert([old, other]); f.write(old.destinationPath, 'old'); f.write(f.shared, 'foreign');
  const result = await migrateCodexSkills(f);
  assert.match(result.blocked[0], /other/);
  assert.equal(f.store.load().receipts.length, 2);
  assert.ok(fs.existsSync(old.destinationPath));
  assert.equal(fs.readFileSync(path.join(f.shared, 'SKILL.md'), 'utf8'), 'foreign');
});

test('a receipt-only root recovers only from the verified highest local source after retry', async t => {
  const f = fixture(t), old = f.receipt('.codex', '1.0.0', 'old');
  const newest = { ...f.receipt('.codex-gone', '2.0.0', 'new'), source: 'local', sourcePath: path.join(f.userHome, 'source') };
  f.store.upsert([old, newest]); f.write(old.destinationPath, 'old');
  assert.equal((await migrateCodexSkills(f)).blocked.length, 1);
  assert.ok(!fs.existsSync(f.shared) && fs.existsSync(old.destinationPath));
  f.write(path.join(newest.sourcePath, 'skills', 'guide'), 'new');
  fs.writeFileSync(path.join(newest.sourcePath, 'lcpack.json'), JSON.stringify({ key: 'demo', version: '2.0.0',
    contents: [{ kind: 'skill', id: 'guide', path: 'skills/guide' }] }));
  assert.equal((await migrateCodexSkills(f)).migrated, 1);
  assert.deepEqual(f.store.load().receipts.map(r => r.packageVersion), ['2.0.0']);
  assert.equal(fs.readFileSync(path.join(f.shared, 'SKILL.md'), 'utf8'), 'new');
  assert.ok(!fs.existsSync(newest.canonicalRoot));
});

test('v2 resumes old copy cleanup when the newer shared receipt already exists', async t => {
  const f = fixture(t), old = f.receipt('.codex', '1.0.0', 'old');
  const shared = { ...f.receipt('', '2.0.0', 'new'), destinationPath: f.shared };
  f.store.upsert([old, shared]); f.write(old.destinationPath, 'old'); f.write(f.shared, 'new');
  const result = await migrateCodexSkills(f);
  assert.equal(result.migrated, 1);
  assert.deepEqual(result.backups, []);
  assert.ok(!fs.existsSync(old.destinationPath));
  assert.deepEqual(f.store.load().receipts.map(r => r.packageVersion), ['2.0.0']);
});

test('worker recovers a missing highest version from the shared ZIP cache at startup and reports it once', async t => {
  const f = fixture(t), content = '---\nname: guide\ndescription: example\n---\nGuide';
  const row = f.receipt('.codex', '1.0.0', content);
  const bytes = zip({ 'lcpack.json': JSON.stringify({ ...manifest, contents: [{ id: 'guide', kind: 'skill', path: 'resources/guide' }] }),
    'README.md': '# Guide', 'resources/guide/SKILL.md': content });
  row.packageSha256 = ofBytes(bytes);
  const cache = path.join(f.home, 'cache', 'packages', 'demo', '1.0.0');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, row.packageSha256 + '.zip'), bytes);
  f.store.upsert([row]);
  const worker = startWorker({ deps: { lcaipackHome: f.home, userHome: f.userHome, env: {} } });
  t.after(worker.dispose);
  assert.deepEqual(await worker.call('rc.client.migration'), { message: 'Codex 共用技能已遷移 1 項。', blocked: false });
  assert.deepEqual(await worker.call('rc.client.migration'), {});
  assert.equal(fs.readFileSync(path.join(f.shared, 'SKILL.md'), 'utf8'), content);
});
