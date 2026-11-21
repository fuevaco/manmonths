// 收據驅動的遞迴刪除必須受限在目標根目錄內。LC-AI-Pack 的 TargetApplyExecutor 直接信任收據路徑；
// 資源中心額外加上包含檢查，竄改或損壞的 receipts.json 不得讓套用刪到根目錄以外的檔案。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMulti } from './multi-env.mjs';

const tamper = (e, mutate) => {
  const file = path.join(e.lcaipackHome, 'receipts.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(doc);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
};

async function installThenPoison(t, kind, victimOf) {
  const e = await setupMulti(t);
  const { codex } = await e.targets();
  const first = await e.plan('pkg-a', '1.0.0', [codex.id]);
  assert.equal((await e.apply(first, [codex.id])).status, 'succeeded');
  const victim = victimOf(e.dir);
  tamper(e, doc => {
    const base = doc.receipts[0];
    doc.receipts.push({ ...base, contentId: 'evil', normalizedAddress: `${base.normalizedAddress}|evil`, destinationPath: victim.path, mutationKind: kind });
  });
  const update = await e.plan('pkg-a', '1.1.0', [codex.id], { action: 'update' });
  return { e, codex, update, victim };
}

for (const [kind, victimOf] of [
  ['SyncTree', dir => { const p = path.join(dir, 'outside-tree'); fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'keep.txt'), 'precious'); return { path: p, file: path.join(p, 'keep.txt') }; }],
  ['WriteFile', dir => { const p = path.join(dir, 'outside-file.txt'); fs.writeFileSync(p, 'precious'); return { path: p, file: p }; }]
]) {
  test(`收據指向目標根目錄以外時（${kind}），套用拒絕刪除、還原該目標並保留收據`, async t => {
    const { e, codex, update, victim } = await installThenPoison(t, kind, victimOf);
    const receiptsBefore = fs.readFileSync(path.join(e.lcaipackHome, 'receipts.json'), 'utf8');
    const result = await e.apply(update, [codex.id]);
    assert.notEqual(result.status, 'succeeded');
    assert.equal(result.targets[0].status, 'rolledBack');
    assert.match(result.targets[0].problems[0].explanation, /目標根目錄/);
    assert.equal(fs.readFileSync(victim.file, 'utf8'), 'precious');
    assert.equal(fs.readFileSync(path.join(e.lcaipackHome, 'receipts.json'), 'utf8'), receiptsBefore);
  });
}

test('收據的路徑仍在目標根目錄內時，過期內容照常移除（行為不變）', async t => {
  const e = await setupMulti(t);
  const { codex } = await e.targets();
  const first = await e.plan('pkg-a', '1.0.0', [codex.id]);
  assert.equal((await e.apply(first, [codex.id])).status, 'succeeded');
  const stale = path.join(e.roots.codex, 'skills', 'old-skill');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'SKILL.md'), 'old');
  tamper(e, doc => {
    const base = doc.receipts[0];
    doc.receipts.push({ ...base, contentId: 'old-skill', normalizedAddress: `${base.normalizedAddress}|old`, destinationPath: stale, mutationKind: 'SyncTree' });
  });
  const update = await e.plan('pkg-a', '1.1.0', [codex.id], { action: 'update' });
  assert.equal((await e.apply(update, [codex.id])).status, 'succeeded');
  assert.equal(fs.existsSync(stale), false);
});
