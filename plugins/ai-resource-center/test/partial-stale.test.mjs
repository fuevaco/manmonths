// 使用者故事 34：確認前本機狀態變動時看到更新後的部署摘要並重新確認。
// 對照 LC-AI-Pack BrowseViewModel：只要任一目標在套用時回報 Stale（即使其他目標已成功），
// 就以目前狀態重新產生摘要、要求重新確認，且不送出安裝回報（尚未完成使用者確認的那份計畫）。
// 套用前 orchestrator 會整份比對 digest；單一目標在那之後才過期是競態，這裡在第一個目標寫入時注入另一個目標的外部修改。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupMulti } from './multi-env.mjs';

test('多個目標中只有一個過期：整份要求重新確認，回傳新摘要而不是 Partial，也不送回報', async t => {
  const e = await setupMulti(t);
  const targets = await e.targets();
  const ids = [targets.codex.id, targets.claude.id];
  const summary = await e.plan('pkg-a', '1.0.0', ids);
  assert.equal(summary.canApply, true);
  const codexDest = e.dest(e.roots.codex);
  const write = fs.writeFileSync;
  let injected = false;
  t.mock.method(fs, 'writeFileSync', (p, ...rest) => {
    const file = String(p).replaceAll('\\', '/').toLowerCase();
    if (!injected && file.includes('.claude/skills/demo-skill')) {
      injected = true; // Claude Code（targetKey 排序在前）第一次寫入時，Codex 目標被使用者改動。
      fs.mkdirSync(codexDest, { recursive: true });
      write(path.join(codexDest, 'SKILL.md'), '使用者自己的內容');
    }
    return write(p, ...rest);
  });
  const result = await e.apply(summary, ids);
  t.mock.restoreAll();

  assert.equal(injected, true);
  assert.equal(result.status, 'stale', '不是 partial');
  assert.match(result.message, /重新確認/);
  assert.notEqual(result.plan.planDigest, summary.planDigest);
  const codex = result.plan.targets.find(x => x.id === targets.codex.id);
  assert.equal(codex.changes[0].willBackup, true, '新摘要揭露備份');
  assert.equal(fs.readFileSync(path.join(codexDest, 'SKILL.md'), 'utf8'), '使用者自己的內容');
  await delay(100);
  assert.equal(e.installs.length, 0, '過期的那次確認不回報');
  // 舊的確認不能再用；新的摘要確認後才完成並回報。
  await assert.rejects(e.apply(summary, ids), { code: 'plan_stale' });
  assert.equal((await e.apply(result.plan, ids)).status, 'succeeded');
  assert.equal(e.receipts().length, 2);
});
