// 工項 12：多個部署目標的部分成功與結果明細（ADR 0002）。
// 從面板使用的 worker 請求契約進入。行為對照 LC-AI-Pack：每個部署目標是獨立交易（TargetApplyExecutor、
// RollbackCharacterisationTests）、他包擁有的目標受阻（OwnershipIndex）。差異（ADR 0002）：LC-AI-Pack 計畫只要有
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

/** 先由 pkg-a 占用 Claude Code 第二根的 demo-skill，使 pkg-b 在該目標因他包擁有而受阻。 */
async function withBlockedClaudeWork(t) {
  const e = await setupMulti(t, { packages: { 'pkg-a': ['1.0.0'], 'pkg-b': ['1.0.0'] } });
  const targets = await e.targets();
  const first = await e.plan('pkg-a', '1.0.0', [targets.claudeWork.id]);
  assert.equal((await e.apply(first, [targets.claudeWork.id])).status, 'succeeded');
  return { e, targets, ids: [targets.codex.id, targets.claude.id, targets.claudeWork.id] };
}

test('三個目標其中一個受阻：摘要顯示兩個可安裝與一個受阻的具體原因，仍可確認', async (t) => {
  const { e, ids } = await withBlockedClaudeWork(t);
  const summary = await e.plan('pkg-b', '1.0.0', ids);

  assert.equal(summary.canApply, true);
  assert.deepEqual([summary.deployableCount, summary.blockedCount], [2, 1]);
  const blocked = summary.targets.filter(x => !x.canApply);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, ids[2]);
  const reason = blocked[0].problems.find(p => p.code === 'deployment.ownership-collision');
  assert.equal(reason.severity, 'Blocking');
  assert.match(reason.summary, /pkg-a/);
  assert.equal(reason.path, e.dest(e.roots.claudeWork));
  assert.deepEqual(summary.targets.filter(x => x.canApply).map(x => x.id).sort(), [ids[0], ids[1]].sort());
});

test('一次確認：恰有兩個目標完成並寫入收據，受阻目標的檔案與收據不變；結果逐一列出狀態', async (t) => {
  const { e, ids } = await withBlockedClaudeWork(t);
  const before = { files: snapshot(e.roots.claudeWork), receipts: e.receipts() };
  const summary = await e.plan('pkg-b', '1.0.0', ids);

  const result = await e.apply(summary, ids);

  assert.equal(result.status, 'partial');
  const byId = Object.fromEntries(result.targets.map(x => [x.id, x]));
  assert.equal(result.targets.length, 3);
  assert.equal(byId[ids[0]].status, 'succeeded');
  assert.equal(byId[ids[1]].status, 'succeeded');
  assert.equal(byId[ids[2]].status, 'skipped');
  assert.ok(byId[ids[2]].problems.some(p => p.code === 'deployment.ownership-collision'));
  assert.deepEqual(byId[ids[2]].writtenPaths, []);
  for (const id of [ids[0], ids[1]]) assert.ok(byId[id].writtenPaths.length > 0);
  assert.equal(read(path.join(e.dest(e.roots.codex), 'SKILL.md')), skillText('1.0.0'));
  assert.equal(read(path.join(e.dest(e.roots.claude), 'SKILL.md')), skillText('1.0.0'));
  assert.deepEqual(snapshot(e.roots.claudeWork), before.files);
  const receipts = e.receipts();
  assert.equal(receipts.filter(r => r.packageKey === 'pkg-b').length, 2);
  assert.deepEqual(receipts.filter(r => r.packageKey === 'pkg-a'), before.receipts.filter(r => r.packageKey === 'pkg-a'));
  assert.deepEqual(receipts.filter(r => r.packageKey === 'pkg-b').map(r => r.canonicalRoot).sort(),
    [e.dest(e.roots.codex), e.dest(e.roots.claude)].map(p => path.dirname(path.dirname(p))).sort());
});

test('全部目標受阻：摘要列出各自的原因且不可確認；強行套用也被拒絕、零寫入', async (t) => {
  const e = await setupMulti(t, { packages: { 'pkg-a': ['1.0.0'], 'pkg-b': ['1.0.0'] } });
  const targets = await e.targets();
  const ids = [targets.claude.id, targets.claudeWork.id];
  const first = await e.plan('pkg-a', '1.0.0', ids);
  assert.equal((await e.apply(first, ids)).status, 'succeeded');
  const before = { files: [snapshot(e.roots.claude), snapshot(e.roots.claudeWork)], receipts: e.receipts() };

  const summary = await e.plan('pkg-b', '1.0.0', ids);

  assert.equal(summary.canApply, false);
  assert.deepEqual([summary.deployableCount, summary.blockedCount], [0, 2]);
  for (const target of summary.targets) {
    assert.equal(target.canApply, false);
    assert.ok(target.problems.some(p => p.code === 'deployment.ownership-collision' && /pkg-a/.test(p.summary)));
  }
  assert.equal((await e.apply(summary, ids)).status, 'rejected');
  assert.deepEqual([snapshot(e.roots.claude), snapshot(e.roots.claudeWork)], before.files);
  assert.deepEqual(e.receipts(), before.receipts);
});

test('每個目標是獨立交易：一個目標寫入失敗時，已成功與其後的目標不受影響，失敗的目標還原原狀態', async (t) => {
  const e = await setupMulti(t);
  const targets = await e.targets();
  const ids = [targets.codex.id, targets.claude.id, targets.claudeWork.id];
  const first = await e.plan('pkg-a', '1.0.0', ids);
  assert.equal((await e.apply(first, ids)).status, 'succeeded');
  const before = snapshot(e.roots.claudeWork);
  const beforeReceipts = e.receipts().filter(r => r.canonicalRoot.toLowerCase().endsWith('.claude-work'));
  const update = await e.plan('pkg-a', '1.1.0', ids, { action: 'update' });
  assert.deepEqual([update.deployableCount, update.blockedCount], [3, 0]);

  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (p, ...rest) => {
    if (String(p).replaceAll('\\', '/').toLowerCase().includes('.claude-work/skills/demo-skill/notes.md')) throw new Error('disk full');
    return write(p, ...rest);
  });
  const result = await e.apply(update, ids);
  t.mock.restoreAll();

  assert.equal(result.status, 'partial');
  const byId = Object.fromEntries(result.targets.map(x => [x.id, x]));
  assert.deepEqual([byId[ids[0]].status, byId[ids[1]].status, byId[ids[2]].status], ['succeeded', 'succeeded', 'rolledBack']);
  assert.match(byId[ids[2]].problems[0].explanation, /disk full/);
  assert.equal(read(path.join(e.dest(e.roots.codex), 'SKILL.md')), skillText('1.1.0'));
  assert.equal(read(path.join(e.dest(e.roots.claude), 'SKILL.md')), skillText('1.1.0'));
  assert.deepEqual(snapshot(e.roots.claudeWork), before);
  const receipts = e.receipts();
  assert.deepEqual(receipts.filter(r => r.canonicalRoot.toLowerCase().endsWith('.claude-work')), beforeReceipts);
  assert.deepEqual(receipts.filter(r => !r.canonicalRoot.toLowerCase().endsWith('.claude-work')).map(r => r.packageVersion), ['1.1.0', '1.1.0']);
});
