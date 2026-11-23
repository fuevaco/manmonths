// 使用者故事 34：確認前本機狀態變動時看到更新後的部署摘要並重新確認。
// 對照 BrowseViewModel：只要任一目標在套用時回報 Stale（即使其他目標已成功），
// 就以目前狀態重新產生摘要、要求重新確認，且不送出安裝回報（尚未完成使用者確認的那份計畫）。
// 套用前 orchestrator 會整份比對 digest；單一目標在那之後才過期是競態，這裡在第一個目標寫入時注入另一個目標的外部修改。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupMulti } from './multi-env.mjs';

test('套用期間另一部署目標變動時自動重規劃及備份，完成後才回報',async t=>{
 const e=await setupMulti(t);const codexDest=e.dest(e.roots.codex);const write=fs.writeFileSync;let injected=false;
 t.mock.method(fs,'writeFileSync',(p,...rest)=>{
  if(!injected&&String(p).replaceAll('\\','/').toLowerCase().includes('.claude/skills/demo-skill')){
   injected=true;fs.mkdirSync(codexDest,{recursive:true});write(path.join(codexDest,'SKILL.md'),'使用者自己的內容');
  }return write(p,...rest);
 });
 const result=await e.run();t.mock.restoreAll();
 assert.equal(injected,true);assert.equal(result.ok,true);assert.equal(result.succeeded.length,3);assert.equal(e.receipts().length,3);
 const backup=result.backups.find(t=>t.rootPath===e.userHome);assert.ok(backup);assert.equal(fs.readFileSync(path.join(backup.backupPath,'SKILL.md'),'utf8'),'使用者自己的內容');
 await delay(100);assert.equal(e.installs.length,1);
});
