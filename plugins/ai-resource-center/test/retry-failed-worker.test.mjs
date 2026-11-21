// 工項 15：只重試失敗目標的 worker 契約（對照 LC-AI-Pack RetryFailedTargetsAsync 與 GuiPlanSharingTests）。
// 面板重試＝只把失敗目標重新規劃再確認：已成功目標的檔案與收據不變，安裝回報只含重試成功的目標，且是新的 operation。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupMulti, skillText } from './multi-env.mjs';

const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await delay(10); } return false; };
const norm = (p) => String(p).replaceAll('\\', '/').toLowerCase();
const platformsOf = (sent) => sent.body.platforms.map(p => `${p.hostId}/${p.surfaceId}`).sort();

/** Codex 目標的 notes.md 寫入失敗（模擬目的地不可寫），其他目標正常。回傳還原函式。 */
function breakCodexWrites(t) {
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (p, ...rest) => {
    if (norm(p).includes('.codex/skills/demo-skill/notes.md')) throw new Error('disk full');
    return write(p, ...rest);
  });
  return () => t.mock.restoreAll();
}

test('只重試失敗的目標：修正原因後重新規劃只含失敗目標，已成功目標的檔案與收據不變，回報不重複', async (t) => {
  const e = await setupMulti(t, { packages: { 'pkg-b': ['1.0.0'] } });
  const targets = await e.targets();
  const ids = [targets.codex.id, targets.claude.id, targets.claudeWork.id];

  const fix = breakCodexWrites(t);
  const first = await e.plan('pkg-b', '1.0.0', ids);
  const result = await e.apply(first, ids);
  fix();
  assert.equal(result.status, 'partial');
  const byId = Object.fromEntries(result.targets.map(x => [x.id, x]));
  assert.deepEqual(ids.map(id => byId[id].status), ['rolledBack', 'succeeded', 'succeeded']);
  assert.ok(await until(() => e.installs.length === 1));
  assert.deepEqual(platformsOf(e.installs[0]), ['claude-code/claude-code-cli']);
  assert.equal(fs.existsSync(path.join(e.dest(e.roots.codex), 'SKILL.md')), false, '失敗的目標已還原');

  // 面板的重試：只取失敗（非成功）的目標 id 重新規劃。
  const failedIds = result.targets.filter(x => ['failed', 'rolledBack', 'rollbackIncomplete', 'stale'].includes(x.status)).map(x => x.id);
  assert.deepEqual(failedIds, [targets.codex.id]);
  const succeededFiles = [e.roots.claude, e.roots.claudeWork].map(root => fs.readFileSync(path.join(e.dest(root), 'SKILL.md'), 'utf8'));
  const receiptsBefore = e.receipts().filter(r => !norm(r.canonicalRoot).endsWith('.codex'));
  assert.equal(receiptsBefore.length, 2);

  const retryPlan = await e.plan('pkg-b', '1.0.0', failedIds);
  assert.deepEqual(retryPlan.targets.map(x => x.id), failedIds, '重試的摘要只含失敗目標');
  assert.equal(retryPlan.canApply, true);
  const retry = await e.apply(retryPlan, failedIds);
  assert.equal(retry.status, 'succeeded');
  assert.deepEqual(retry.targets.map(x => [x.id, x.status]), [[targets.codex.id, 'succeeded']]);

  assert.equal(fs.readFileSync(path.join(e.dest(e.roots.codex), 'SKILL.md'), 'utf8'), skillText('1.0.0'));
  assert.deepEqual([e.roots.claude, e.roots.claudeWork].map(root => fs.readFileSync(path.join(e.dest(root), 'SKILL.md'), 'utf8')), succeededFiles);
  assert.deepEqual(e.receipts().filter(r => !norm(r.canonicalRoot).endsWith('.codex')), receiptsBefore, '已成功目標的收據不變');
  assert.equal(e.receipts().length, 3);

  // 回報：重試是新的操作，只含重試成功的目標；先前成功的目標不重複回報。
  assert.ok(await until(() => e.installs.length === 2));
  await delay(50);
  assert.equal(e.installs.length, 2);
  assert.deepEqual(platformsOf(e.installs[1]), ['codex/codex-cli']);
  assert.equal(e.installs[1].body.operationId, retry.operation.id);
  assert.notEqual(e.installs[1].body.operationId, e.installs[0].body.operationId);
  assert.equal(e.installs[1].body.action, 'install');
});

test('重試仍遵守計畫過期須重新確認：重試的計畫在確認前目標改變時回報 stale，不寫入', async (t) => {
  const e = await setupMulti(t, { packages: { 'pkg-b': ['1.0.0'] } });
  const targets = await e.targets();
  const ids = [targets.codex.id, targets.claude.id];
  const fix = breakCodexWrites(t);
  const result = await e.apply(await e.plan('pkg-b', '1.0.0', ids), ids);
  fix();
  assert.equal(result.status, 'partial');

  const retryPlan = await e.plan('pkg-b', '1.0.0', [targets.codex.id]);
  // 確認前，目的地被別人建立了同名內容（未受管）：計畫的觀測已過期。
  fs.mkdirSync(e.dest(e.roots.codex), { recursive: true });
  fs.writeFileSync(path.join(e.dest(e.roots.codex), 'SKILL.md'), 'someone else');
  const stale = await e.apply(retryPlan, [targets.codex.id]);
  assert.equal(stale.status, 'stale');
  assert.equal(fs.readFileSync(path.join(e.dest(e.roots.codex), 'SKILL.md'), 'utf8'), 'someone else', '過期時零寫入');
});
