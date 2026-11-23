// 主要驗收：從面板使用的 worker 請求契約進入，以臨時使用者目錄與合成資源包，
// 依序走完登入、查詢、下載、規劃、確認套用及讀回（對照 GuiPlanSharingTests、PlanConsentRegenerationTests）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker, leakedSecrets } from './harness.mjs';
import { zip } from './zip-fixture.mjs';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const rules = createPathRules();
const pluginVersion = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')).version;
const SKILL = '---\nname: synthetic-hello\ndescription: Synthetic skill\n---\nSay hello.\n';
const manifest = { packageFormatVersion: 1, key: 'synthetic-skill', name: '合成 Skill', type: 'skill', version: '1.0.0',
  description: 'Synthetic', contents: [{ id: 'synthetic-hello', kind: 'skill', path: 'resources/skills/synthetic-hello' }] };
const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# 合成', 'resources/skills/synthetic-hello/SKILL.md': SKILL });

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-install-'));
  const userHome = path.join(dir, 'home');
  const codexRoot = path.join(userHome, '.codex');
  await mkdir(codexRoot, { recursive: true });
  await writeFile(path.join(codexRoot, 'config.toml'), 'model = "synthetic"\n');
  const lcaipackHome = path.join(dir, 'lcaipack');
  const market = await startFakeMarket({ packages: [{ packageKey: 'synthetic-skill', name: '合成 Skill', type: 'skill', description: 'Synthetic', latestReleaseVersion: '1.0.0' }] });
  market.override('GET /api/market/packages/synthetic-skill', () => ({ status: 200, body: { packageKey: 'synthetic-skill', name: '合成 Skill', type: 'skill',
    description: 'Synthetic', recommendedVersion: '1.0.0', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', status: 'active', hosts: ['codex'], sha256: sha(bytes) }] } }));
  market.override('GET /api/market/packages/synthetic-skill/versions/1.0.0/readme', () => ({ status: 200, body: { readme: '# 合成' } }));
  market.override('GET /api/market/packages/synthetic-skill/versions/1.0.0/download', () => ({ status: 200, raw: bytes, headers: { 'X-Checksum-Sha256': sha(bytes) }, contentType: 'application/zip' }));
  const worker = startWorker({ deps: { lcaipackHome, userHome, env: {} } });
  t.after(async () => { worker.dispose(); await market.close(); await rm(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const destination = path.join(rules.normalize(userHome), '.agents', 'skills', 'synthetic-hello');
  return { dir, userHome, codexRoot, lcaipackHome, market, worker, destination };
}

const run = e => e.worker.call('rc.install.run', { packageKey: 'synthetic-skill', action: 'install' });
test('全選多個 Codex 全域根，寫入共用 Skill 與唯一收據，再次安裝無額外備份', async t => {
  const e = await setup(t);
  for (const name of ['.codex-work', '.codex-third']) { await mkdir(path.join(e.userHome,name)); await writeFile(path.join(e.userHome,name,'auth.json'),'{}'); }
  const result = await run(e); assert.equal(result.ok,true); assert.equal(result.succeeded.length,1);
  const ledger = JSON.parse(await readFile(path.join(e.lcaipackHome,'receipts.json'),'utf8'));
  assert.equal(ledger.receiptFormatVersion,2); assert.equal(ledger.receipts.length,1);
  for (const r of ledger.receipts) {
    assert.equal(await readFile(path.join(r.destinationPath,'SKILL.md'),'utf8'),SKILL);
    assert.equal(r.destinationPath,path.join(r.canonicalRoot,'.agents','skills','synthetic-hello'));
    assert.equal(r.targetKey,`codex|codex-cli|global|${r.canonicalRoot}`);
    assert.deepEqual([r.packageKey,r.packageVersion,r.clientVersion,r.channel],['synthetic-skill','1.0.0',pluginVersion,'release']);
    assert.equal(result.succeeded.find(t => t.targetId === r.targetKey).label,'Codex');
  }
  assert.deepEqual((await run(e)).backups,[]);
  assert.equal(await readFile(path.join(e.codexRoot,'config.toml'),'utf8'),'model = "synthetic"\n');
  assert.deepEqual(leakedSecrets([...e.worker.state.transcript,...e.worker.state.logs],['pw-alice','fake-access','fake-refresh']),[]);
});
test('首次安裝後清單、明細立即讀回已安裝版本與友善工具名稱', async t => {
  const e = await setup(t); assert.equal((await e.worker.call('rc.catalog.list')).data[0].installationStatus,'notInstalled');
  assert.equal((await run(e)).ok,true);
  const detail = await e.worker.call('rc.package.getDetails',{packageKey:'synthetic-skill'});
  assert.equal(detail.deployments[0].version,'1.0.0'); assert.equal(detail.deployments[0].label,'Codex');
});
test('一鍵入口拒絕手選目標、專案範圍及未知確認，所有舊部署請求已移除', async t => {
  const e = await setup(t);
  for (const method of ['listTargets','plan','apply','saveSetup','cancel']) await assert.rejects(e.worker.call(`rc.deploy.${method}`,{}), /沒有註冊的請求/);
  for (const extra of [{scope:'project'},{projectRoot:e.dir},{version:'1.0.0'},{targets:[]},{targetIds:['x']}])
    await assert.rejects(e.worker.call('rc.install.run',{packageKey:'synthetic-skill',action:'install',...extra}),{code:'invalid_params'});
  await assert.rejects(e.worker.call('rc.install.run',{packageKey:'synthetic-skill',action:'install',confirmedPlanId:'unknown'}),{code:'plan_stale'});
  assert.equal(existsSync(e.destination),false);
});
test('部署寫入失敗回報詳細原因、保留原狀且不留下新版收據', async t => {
  const e = await setup(t); await writeFile(path.join(e.userHome,'.agents'),'佔用');
  const result = await run(e); assert.equal(result.allBlocked,true); assert.equal(result.plan.blockedTargets.length,1);
  assert.ok(result.plan.blockedTargets[0].detail.some(p=>p.code==='deployment.shared-skills-unavailable'));
  assert.equal(existsSync(path.join(e.lcaipackHome,'receipts.json')),false);
  assert.equal(await readFile(path.join(e.userHome,'.agents'),'utf8'),'佔用');
});
test('沒有相容工具時不建立根或收據', async t => {
  const e = await setup(t); await rm(path.join(e.codexRoot,'config.toml'));
  const result = await run(e); assert.equal(result.ok,true); assert.deepEqual(result.succeeded,[]);
  assert.equal(existsSync(e.destination),false);
});
test('ZIP 驗證失敗時一鍵安裝零寫入', async t => {
  const e = await setup(t); e.market.override('GET /api/market/packages/synthetic-skill/versions/1.0.0/download',()=>({status:200,raw:Buffer.from('corrupt'),contentType:'application/zip'}));
  await assert.rejects(run(e),{code:'checksum_mismatch'}); assert.equal(existsSync(e.destination),false);
});
test('全域偵測沿用手動增列、排除與環境根：去重、不遞迴、不建立缺失根', async t => {
  const e = await setup(t); const manual = path.join(e.dir,'outside','.codex'), active = path.join(e.userHome,'.codex-active');
  for (const root of [manual,active,path.join(e.userHome,'.codex-worktrees','nested'),path.join(e.userHome,'.codex.bak-lcaipack-123')]) { await mkdir(root,{recursive:true}); await writeFile(path.join(root,'config.toml'),''); }
  await mkdir(e.lcaipackHome,{recursive:true}); const missing = path.join(e.dir,'missing');
  await writeFile(path.join(e.lcaipackHome,'config.json'),JSON.stringify({manualClientRoots:{codex:[manual,active,missing]},excludedClientRoots:{codex:[e.codexRoot]}}));
  const worker = startWorker({state:e.worker.state,deps:{userHome:e.userHome,lcaipackHome:e.lcaipackHome,env:{CODEX_HOME:active+path.sep}}}); t.after(()=>worker.dispose());
  const result = await worker.call('rc.install.run',{packageKey:'synthetic-skill',action:'install'});
  assert.equal(result.ok,true); assert.deepEqual(result.succeeded.map(t=>rules.normalize(t.rootPath)).sort(),[rules.normalize(e.userHome)]);
  assert.equal(existsSync(missing),false); assert.equal(existsSync(path.join(e.codexRoot,'skills')),false);
});
