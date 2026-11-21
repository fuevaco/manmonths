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
    if (norm(p).includes('.agents/skills/demo-skill/notes.md')) throw new Error('disk full');
    return write(p, ...rest);
  });
  return () => t.mock.restoreAll();
}

test('重試只處理失敗部署目標；成功檔案及收據不變，安裝回報不重複',async t=>{
 const e=await setupMulti(t,{packages:{'pkg-b':['1.0.0']}});const fix=breakCodexWrites(t);const result=await e.run('pkg-b');fix();
 assert.equal(result.ok,false);assert.equal(result.failed.length,1);assert.equal(result.succeeded.length,2);assert.ok(await until(()=>e.installs.length===1));assert.deepEqual(platformsOf(e.installs[0]),['claude-code/claude-code-cli']);
 assert.equal(fs.existsSync(path.join(e.dest(e.roots.codex),'SKILL.md')),false);
 const before=e.receipts();const files=[e.roots.claude,e.roots.claudeWork].map(root=>fs.readFileSync(path.join(e.dest(root),'SKILL.md'),'utf8'));
 const retry=await e.run('pkg-b','retry',{targetIds:result.failed.map(t=>t.targetId)});assert.equal(retry.ok,true);assert.equal(retry.succeeded.length,1);assert.equal(retry.succeeded[0].hostId,'codex');
 assert.equal(fs.readFileSync(path.join(e.dest(e.roots.codex),'SKILL.md'),'utf8'),skillText('1.0.0'));
 assert.deepEqual(e.receipts().filter(r=>r.hostId!=='codex'),before);
 assert.deepEqual([e.roots.claude,e.roots.claudeWork].map(root=>fs.readFileSync(path.join(e.dest(root),'SKILL.md'),'utf8')),files);
 assert.ok(await until(()=>e.installs.length===2));await delay(50);assert.equal(e.installs.length,2);assert.deepEqual(platformsOf(e.installs[1]),['codex/codex-cli']);assert.notEqual(e.installs[1].body.operationId,e.installs[0].body.operationId);
});
test('重試遇到未受管同名內容時自動備份，成功目標不再部署',async t=>{
 const e=await setupMulti(t,{packages:{'pkg-b':['1.0.0']}});const fix=breakCodexWrites(t);const first=await e.run('pkg-b');fix();
 fs.mkdirSync(e.dest(e.roots.codex),{recursive:true});fs.writeFileSync(path.join(e.dest(e.roots.codex),'SKILL.md'),'someone else');
 const retry=await e.run('pkg-b','retry',{targetIds:first.failed.map(t=>t.targetId)});assert.equal(retry.ok,true);assert.equal(retry.succeeded.length,1);
 assert.equal(fs.readFileSync(path.join(retry.backups[0].backupPath,'SKILL.md'),'utf8'),'someone else');
});
