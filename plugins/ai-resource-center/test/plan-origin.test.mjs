import { zip } from './zip-fixture.mjs';
// 等待確認的部署計畫綁定產生它的市集與工作階段（計畫的來源）：
// 登出、工作階段被拒絕、換市集網址後都不能套用舊計畫；安裝回報只送給計畫來源的市集。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { setupMulti } from './multi-env.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { INSTALL_REPORTS_KEY } from '../worker/install-reports.mjs';

const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await delay(10); } return false; };
const stalePlan = { code: 'plan_stale' };

// 設定命令只是讓計畫需要確認；runner 依平台選擇（Linux 不允許 PowerShell，ADR-0005）。
const [runner, script] = process.platform === 'win32' ? ['powershell', 'setup/init.ps1'] : ['bash', 'setup/init.sh'];
async function planned(t) {
  const bytes=zip({'lcpack.json':JSON.stringify({packageFormatVersion:1,key:'pkg-a',name:'Demo',type:'bundle',version:'1.0.0',description:'Synthetic',contents:[{id:'demo-skill',kind:'skill',path:'resources/skill'}],setup:{commands:[{commandId:'init',name:'準備',runner,script}]}}),
    'README.md':'# Demo','resources/skill/SKILL.md':'---\nname: demo-skill\ndescription: Synthetic\n---\nHello',[script]:'exit 0'});
  const e=await setupMulti(t,{packages:{'pkg-a':{'1.0.0':bytes}},workerDeps:{runners:{resolve:runner=>({runner,executable:`/fake/${runner}`,leadingArguments:[]})},commandExecutor:{run:async()=>({succeeded:true,outcome:'Completed',exitCode:0})}}});
  const summary=await e.run();assert.equal(summary.needsConfirmation,true);
  return {e,summary};
}
test('登出後重新登入同一帳號：登出前產生的計畫不能套用，也沒有寫入', async t => {
  const { e, summary, ids } = await planned(t);
  await e.worker.call('rc.session.signOut');
  await e.worker.call('rc.session.signIn', { marketUrl: e.market.url, username: 'alice', password: 'pw-alice' });
  await assert.rejects(e.confirm(summary), stalePlan);
  assert.deepEqual(e.receipts(), []);
});

test('工作階段被拒絕（續期失敗）後重新登入：舊計畫不能套用', async t => {
  const { e, summary, ids } = await planned(t);
  e.market.expireAccessTokens();
  e.market.override('POST /api/auth/refresh', () => ({ status: 401, body: { title: '已過期', status: 401 } }));
  await assert.rejects(e.worker.call('rc.catalog.list'), { code: 'session_expired' });
  assert.equal((await e.worker.call('rc.session.getState')).signedIn, false);
  e.market.clearOverrides();
  await e.worker.call('rc.session.signIn', { marketUrl: e.market.url, username: 'alice', password: 'pw-alice' });
  await assert.rejects(e.confirm(summary), stalePlan);
  assert.deepEqual(e.receipts(), []);
});

test('換到另一個市集網址登入：舊市集產生的計畫不能套用', async t => {
  const { e, summary, ids } = await planned(t);
  const other = await startFakeMarket();
  t.after(() => other.close());
  await e.worker.call('rc.session.signIn', { marketUrl: other.url, username: 'alice', password: 'pw-alice' });
  await assert.rejects(e.confirm(summary), stalePlan);
  assert.deepEqual(e.receipts(), []);
});

test('設定中的市集網址被直接改掉（沒有走登入流程）：套用前核對來源，拒絕舊計畫', async t => {
  const { e, summary, ids } = await planned(t);
  e.worker.state.settings.set('marketUrl', 'http://127.0.0.1:9');
  await assert.rejects(e.confirm(summary), stalePlan);
  assert.deepEqual(e.receipts(), []);
});

test('來源沒變時仍可套用（行為不變）', async t => {
  const { e, summary, ids } = await planned(t);
  assert.equal((await e.confirm(summary)).ok, true);
});

test('安裝回報只送給計畫來源的市集：換到另一個市集（同帳號名）後不會補送過去', async t => {
  const e = await setupMulti(t);
  const other = await startFakeMarket();
  t.after(() => other.close());
  e.market.override('POST /api/market/packages/pkg-a/versions/1.0.0/installs', () => ({ status: 503, body: { title: '暫時無法服務' } }));
  assert.equal((await e.run()).ok,true);
  assert.ok(await until(() => Object.keys(e.worker.state.storage.get(INSTALL_REPORTS_KEY)?.entries ?? {}).length === 1));

  await e.worker.call('rc.session.signIn', { marketUrl: other.url, username: 'alice', password: 'pw-alice' });
  await delay(100);
  assert.equal(other.requests.filter(r => r.path.endsWith('/installs')).length, 0, '另一個市集不得收到回報');
  assert.equal(Object.keys(e.worker.state.storage.get(INSTALL_REPORTS_KEY).entries).length, 1, '回報保留，等回到原市集');

  e.market.override('POST /api/market/packages/pkg-a/versions/1.0.0/installs', (_req, body) => { e.installs.push({ key: 'pkg-a', version: '1.0.0', body }); return { status: 200, body: {} }; });
  await e.worker.call('rc.session.signIn', { marketUrl: e.market.url, username: 'alice', password: 'pw-alice' });
  assert.ok(await until(() => e.installs.length === 1), '回到原市集後補送');
});
