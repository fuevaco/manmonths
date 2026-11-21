// 工項 12：安裝回報的端到端行為（對照 GuiRegistryInstallReportingTests、CliInstallReports 的 D7 規則）。
// 從面板使用的 worker 請求契約進入，假市集記錄收到的 POST …/installs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { setupMulti } from './multi-env.mjs';
import { leakedSecrets } from './harness.mjs';
import { INSTALL_REPORTS_KEY } from '../worker/install-reports.mjs';

const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await delay(10); } return false; };
const pending = (e) => Object.values(e.worker.state.storage.get(INSTALL_REPORTS_KEY)?.entries ?? {});
const pluginVersion = JSON.parse((await import('node:fs')).readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')).version;

async function blockedClaudeWork(t) {
 const e=await setupMulti(t,{packages:{'pkg-a':['1.0.0','1.1.0'],'pkg-b':['1.0.0']}});
 await e.seed('pkg-a',[e.roots.claudeWork]);assert.ok(await until(()=>e.installs.length===1));e.installs.length=0;return e;
}
test('部分成功只回報成功工具，含外掛版本且不含本機路徑、帳戶或秘密',async t=>{
 const e=await blockedClaudeWork(t);const result=await e.confirm(await e.run('pkg-b'),'pkg-b');
 assert.equal(result.ok,true);assert.equal(result.succeeded.length,2);assert.equal(result.skipped.length,1);assert.deepEqual(result.failed,[]);assert.ok(await until(()=>e.installs.length===1));
 const sent=e.installs[0];assert.deepEqual([sent.key,sent.version],['pkg-b','1.0.0']);
 assert.deepEqual(Object.keys(sent.body).sort(),['action','channel','clientProduct','clientVersion','fromVersion','installedAt','operationId','platforms','scope']);
 assert.deepEqual([sent.body.action,sent.body.fromVersion,sent.body.scope,sent.body.channel,sent.body.clientProduct,sent.body.clientVersion],['install',null,'global','release','gui',pluginVersion]);
 assert.deepEqual(sent.body.platforms.map(p=>`${p.hostId}/${p.surfaceId}`).sort(),['claude-code/claude-code-cli','codex/codex-cli']);
 assert.ok(Number.isFinite(Date.parse(sent.body.installedAt)));assert.match(sent.body.operationId,/^op-/);
 const text=JSON.stringify(sent.body);assert.ok(!text.includes(e.userHome)&&!text.includes('alice'));assert.deepEqual(leakedSecrets([text],['pw-alice','fake-access','fake-refresh']),[]);
 assert.ok(await until(()=>pending(e).length===0));
});
test('更新回報 update 及套用前的 fromVersion；受阻目標不計入',async t=>{
 const e=await setupMulti(t);await e.run();assert.ok(await until(()=>e.installs.length===1));e.installs.length=0;
 e.recommend('pkg-a','1.1.0');assert.equal((await e.run('pkg-a','update')).ok,true);assert.ok(await until(()=>e.installs.length===1));
 assert.deepEqual([e.installs[0].version,e.installs[0].body.action,e.installs[0].body.fromVersion],['1.1.0','update','1.0.0']);
});
test('市集回報暫時失敗仍完成部署、保留佇列，重新連線後只補送一次',async t=>{
 const e=await blockedClaudeWork(t);e.market.override('POST /api/market/packages/pkg-b/versions/1.0.0/installs',()=>({status:503,body:{title:'暫時無法服務'}}));
 const result=await e.confirm(await e.run('pkg-b'),'pkg-b');assert.equal(result.succeeded.length,2);assert.ok(await until(()=>pending(e).length===1));await delay(50);
 const id=pending(e)[0].operationId;assert.equal(pending(e)[0].account,'alice');
 e.market.override('POST /api/market/packages/pkg-b/versions/1.0.0/installs',(_req,body)=>{e.installs.push({body});return{status:200,body:{installCount:1}};});
 await e.worker.call('rc.session.getState');assert.ok(await until(()=>pending(e).length===0));assert.equal(e.installs.length,1);assert.equal(e.installs[0].body.operationId,id);
});
test('全部部署目標受阻時不產生回報或待送紀錄',async t=>{
 const e=await setupMulti(t,{packages:{'pkg-a':['1.0.0'],'pkg-b':['1.0.0']}});await e.run();assert.ok(await until(()=>e.installs.length===1));e.installs.length=0;
 const result=await e.run('pkg-b');assert.equal(result.allBlocked,true);await delay(100);assert.equal(e.installs.length,0);assert.deepEqual(pending(e),[]);
});
