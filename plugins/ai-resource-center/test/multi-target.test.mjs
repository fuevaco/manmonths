// 工項 12：多個部署目標的部分成功與結果明細（ADR 0002）。
// 從面板使用的 worker 請求契約進入。行為對照既有實作：每個部署目標是獨立交易（TargetApplyExecutor、
// RollbackCharacterisationTests）、他包擁有的目標受阻（OwnershipIndex）。差異（ADR 0002）：原計畫只要有
// 一個目標受阻就整份不可套用；資源中心改為可部署的目標照常套用、受阻的目標維持原狀並列出原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMulti, skillText, sha } from './multi-env.mjs';

const read = (p) => fs.readFileSync(p, 'utf8');
const snapshot = (root) => {
  const out = {};
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); e.isDirectory() ? walk(f) : (out[f] = sha(fs.readFileSync(f))); } };
  if (fs.existsSync(root)) walk(root);
  return out;
};


async function blocked(t) {
  const e = await setupMulti(t, { packages: { 'pkg-a': ['1.0.0'], 'pkg-b': ['1.0.0'] } });
  assert.equal((await e.seed('pkg-a', [e.roots.claudeWork])).ok, true);
  return e;
}
test('三個部署目標其中一個受阻：確認列出兩個可安裝與一個具體受阻原因', async t => {
  const e = await blocked(t);
  const review = await e.run('pkg-b');
  assert.equal(review.needsConfirmation, true);
  assert.equal(review.plan.deployableCount, 2);
  const [target] = review.plan.blockedTargets;
  assert.equal(target.rootPath, e.roots.claudeWork);
  assert.equal(target.label, 'Claude Code');
  assert.equal(target.detail[0].code, 'deployment.ownership-collision');
  assert.equal(target.detail[0].path, e.dest(e.roots.claudeWork));
  assert.match(target.reason, /pkg-a/);
});
test('一次確認後兩個部署目標完成；受阻部署目標檔案及收據逐欄不變', async t => {
  const e = await blocked(t);
  const before = { files: snapshot(e.roots.claudeWork), receipts: e.receipts() };
  const result = await e.confirm(await e.run('pkg-b'), 'pkg-b');
  assert.equal(result.ok, true); assert.equal(result.succeeded.length, 2); assert.deepEqual(result.failed, []);
  assert.equal(result.skipped.length, 1); assert.equal(result.skipped[0].rootPath, e.roots.claudeWork);
  assert.deepEqual(snapshot(e.roots.claudeWork), before.files);
  assert.deepEqual(e.receipts().filter(r => r.packageKey === 'pkg-a'), before.receipts);
  assert.equal(e.receipts().filter(r => r.packageKey === 'pkg-b').length, 2);
  for (const root of [e.roots.codex, e.roots.claude]) assert.equal(read(path.join(e.dest(root), 'SKILL.md')), skillText('1.0.0'));
});
test('全部部署目標受阻：各自列出原因、不可確認、檔案與收據零變更', async t => {
  const e = await setupMulti(t, { packages: { 'pkg-a': ['1.0.0'], 'pkg-b': ['1.0.0'] } });
  await e.run('pkg-a');
  const before = { files: Object.values(e.roots).map(snapshot), receipts: e.receipts() };
  const review = await e.run('pkg-b');
  assert.equal(review.allBlocked, true); assert.equal(review.needsConfirmation, false); assert.equal(review.planId, null);
  assert.equal(review.plan.blockedTargets.length, 3); assert.equal(review.plan.deployableCount, 0);
  assert.ok(review.plan.blockedTargets.every(t => t.detail.some(p => p.code === 'deployment.ownership-collision')));
  assert.deepEqual(Object.values(e.roots).map(snapshot), before.files); assert.deepEqual(e.receipts(), before.receipts);
});
test('各部署目標獨立交易：一個寫入失敗不影響其他目標，失敗目標還原原狀', async t => {
  const e = await setupMulti(t); await e.run();
  const before = snapshot(e.roots.claudeWork), receipts = e.receipts().filter(r => r.canonicalRoot.endsWith('.claude-work'));
  e.recommend('pkg-a', '1.1.0');
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (p, ...rest) => {
    if (String(p).replaceAll('\\', '/').toLowerCase().includes('.claude-work/skills/demo-skill/notes.md')) throw new Error('disk full');
    return write(p, ...rest);
  });
  const result = await e.run('pkg-a', 'update'); t.mock.restoreAll();
  assert.equal(result.ok, false); assert.equal(result.succeeded.length, 2); assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].detail[0].explanation, /disk full/);
  assert.deepEqual(snapshot(e.roots.claudeWork), before);
  assert.deepEqual(e.receipts().filter(r => r.canonicalRoot.endsWith('.claude-work')), receipts);
  for (const root of [e.roots.codex, e.roots.claude]) assert.equal(read(path.join(e.dest(root), 'SKILL.md')), skillText('1.1.0'));
});
