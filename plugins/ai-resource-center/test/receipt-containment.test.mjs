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
  assert.equal((await e.seed('pkg-a',[e.roots.codex])).ok,true);
  const victim = victimOf(e.dir);
  tamper(e, doc => {
    const base = doc.receipts[0];
    doc.receipts.push({ ...base, contentId: 'evil', normalizedAddress: `${base.normalizedAddress}|evil`, destinationPath: victim.path, mutationKind: kind });
  });
  fs.rmSync(e.roots.claude,{recursive:true});fs.rmSync(e.roots.claudeWork,{recursive:true});
  e.recommend('pkg-a','1.1.0');
  return { e, victim };
}

for (const [kind, victimOf] of [
  ['SyncTree', dir => { const p = path.join(dir, 'outside-tree'); fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'keep.txt'), 'precious'); return { path: p, file: path.join(p, 'keep.txt') }; }],
  ['WriteFile', dir => { const p = path.join(dir, 'outside-file.txt'); fs.writeFileSync(p, 'precious'); return { path: p, file: p }; }]
]) {
  test(`收據指向目標根目錄以外時（${kind}），套用拒絕刪除、還原該目標並保留收據`, async t => {
    const { e, victim } = await installThenPoison(t, kind, victimOf);
    const receiptsBefore = fs.readFileSync(path.join(e.lcaipackHome, 'receipts.json'), 'utf8');
    const result = await e.run('pkg-a','update');
    assert.equal(result.ok,false);
    assert.match(result.failed[0].detail[0].explanation,/目標根目錄/);
    assert.equal(fs.readFileSync(victim.file, 'utf8'), 'precious');
    assert.equal(fs.readFileSync(path.join(e.lcaipackHome, 'receipts.json'), 'utf8'), receiptsBefore);
  });
}

test('共用目標只能清除收據對應的技能，家目錄內其他目錄仍保留', async t => {
  const { e, victim } = await installThenPoison(t, 'SyncTree', dir => {
    const unrelated = path.join(dir, 'home', 'personal');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'note.md'), 'keep');
    return { path: unrelated, file: path.join(unrelated, 'note.md') };
  });
  assert.equal((await e.run('pkg-a', 'update')).ok, false);
  assert.equal(fs.readFileSync(victim.file, 'utf8'), 'keep');
});

test('收據的路徑仍在目標根目錄內時，過期內容照常移除（行為不變）', async t => {
  const e = await setupMulti(t);
  assert.equal((await e.seed('pkg-a',[e.roots.codex])).ok,true);
  const stale = path.join(e.userHome, '.agents', 'skills', 'old-skill');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'SKILL.md'), 'old');
  tamper(e, doc => {
    const base = doc.receipts[0];
    doc.receipts.push({ ...base, contentId: 'old-skill', normalizedAddress: `${base.normalizedAddress}|old`, destinationPath: stale, mutationKind: 'SyncTree' });
  });
  fs.rmSync(e.roots.claude,{recursive:true});fs.rmSync(e.roots.claudeWork,{recursive:true});
  e.recommend('pkg-a','1.1.0');
  assert.equal((await e.run('pkg-a','update')).ok,true);
  assert.equal(fs.existsSync(stale), false);
});
