// 設定參數的 worker 請求契約（對照 MarketplaceSetupInputTests、GuiSetupFieldTests、SecretCanaryScanTests）：
// 部署摘要揭露缺少的參數；面板送回的值依安裝範圍落地到共用的 setup.json，秘密只進安全儲存區，之後重新規劃。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker, leakedSecrets } from './harness.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';
import { SetupValueStore } from '../worker/setup/values.mjs';
import { setupSecretReference } from '../worker/setup/secrets.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const CANARY = 'canary-runtime-secret-09';
const parameters = [
  { parameterId: 'endpoint', label: 'Endpoint', type: 'string', required: true },
  { parameterId: 'region', label: 'Region', type: 'choice', required: true, default: 'north', options: [{ value: 'north', label: 'North' }, { value: 'south', label: 'South' }] },
  { parameterId: 'verbose', label: 'Verbose', type: 'boolean', required: false, default: false }
];
const apiKey = { parameterId: 'api-key', label: 'API key', type: 'secret', required: true, secretUsage: 'runtime' };
function pkgBytes({ secret }) {
  const definition = { transport: 'stdio', command: 'npx', args: ['-y', 'example'], env: { MODE: 'params' },
    ...(secret ? { parameters: [{ id: 'api-key', type: 'secret', secret: true, required: true }] } : {}) };
  return zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: 'demo-params', name: 'Demo Params', type: 'mcp', version: '1.0.0',
    description: 'Synthetic', contents: [{ id: 'echo', kind: 'mcp', name: 'Echo', definition }],
    setup: { parameters: secret ? [...parameters, apiKey] : parameters } }), 'README.md': '# Demo' });
}

async function environment(t, { secret = true, launcher = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-setup-'));
  const userHome = path.join(dir, 'home'), lcaipackHome = path.join(dir, 'lcaipack'), project = path.join(dir, 'project');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true }); fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), '{}');
  fs.mkdirSync(project);
  const bytes = pkgBytes({ secret });
  const item = { packageKey: 'demo-params', name: 'Demo Params', type: 'mcp', description: 'Synthetic', latestReleaseVersion: '1.0.0' };
  const market = await startFakeMarket({ packages: [item] });
  market.override('GET /api/market/packages/demo-params', () => ({ status: 200, body: { ...item, recommendedVersion: '1.0.0',
    versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', status: 'active', hosts: ['claude-code'], sha256: sha(bytes) }] } }));
  market.override('GET /api/market/packages/demo-params/versions/1.0.0/readme',()=>({status:200,body:{readme:'# Demo'}}));
  market.override('GET /api/market/packages/demo-params/versions/1.0.0/download', () => ({ status: 200, raw: bytes, contentType: 'application/zip' }));
  const secretStore = memoryStore();
  const worker = startWorker({ deps: { lcaipackHome, userHome, env: {}, secretStore, mcpLauncherPath: launcher } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { dir, userHome, lcaipackHome, project, worker, secretStore };
}
const run = e => e.worker.call('rc.install.run', { packageKey:'demo-params', action:'install' });
const save = (e, input) => e.worker.call('rc.install.saveSetup', { packageKey:'demo-params', ...input });
test('一鍵安裝要求必要設定參數；秘密只有 isSet，缺值不寫入部署', async t => {
  const e = await environment(t,{secret:false}); const review = await run(e);
  assert.equal(review.needsConfirmation,true); assert.deepEqual(review.reasons,['missingParameters']);
  assert.deepEqual(review.plan.missingParameters.map(p=>p.parameterId),['endpoint']);
  const detail = await e.worker.call('rc.package.getDetails',{packageKey:'demo-params'});
  assert.deepEqual(detail.parameters.find(p=>p.parameterId==='region').options,[{value:'north',label:'North'},{value:'south',label:'South'}]);
  assert.equal(fs.existsSync(path.join(e.userHome,'.claude.json')),false);
});
test('儲存全域參數及秘密可供其他用戶端沿用；執行期秘密缺 launcher 仍受阻且不外洩', async t => {
  const e = await environment(t); await run(e);
  const saved = await save(e,{values:{endpoint:' https://edited.example ',region:'south',verbose:true},secrets:{'api-key':CANARY}});
  const field = id=>saved.parameters.find(p=>p.parameterId===id);
  assert.deepEqual([field('endpoint').value,field('endpoint').source],['https://edited.example','Global']);
  assert.equal(field('api-key').isSet,true); assert.equal('value' in field('api-key'),false);
  assert.deepEqual(SetupValueStore.forGlobal({home:e.lcaipackHome,userProfile:e.userHome}).getValues('demo-params'),{endpoint:'https://edited.example',region:'south',verbose:'true'});
  const ref = setupSecretReference({packageKey:'demo-params',parameterId:'api-key',scope:'global',canonicalRoot:e.userHome}); assert.equal(e.secretStore.values.get(ref.key),CANARY);
  const result = await run(e); assert.equal(result.allBlocked,true);
  assert.ok(result.plan.blockedTargets[0].detail.some(p=>p.code==='deployment.unsupported-content-kind'));
  const files=[]; const walk=d=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory())walk(p);else files.push(p);}};walk(e.dir);
  assert.deepEqual(leakedSecrets([...files.map(f=>fs.readFileSync(f,'utf8')),...e.worker.state.transcript,...e.worker.state.logs],[CANARY]),[]);
});
test('設定參數型別、選項、未知參數及秘密通道驗證拒絕整批輸入且零寫入', async t => {
  const e=await environment(t);
  for(const input of [{values:{nope:'x'}},{values:{verbose:'yes'}},{values:{region:'west'}},{values:{'api-key':CANARY}},{secrets:{endpoint:CANARY}},{secrets:{'api-key':''}}]) await assert.rejects(save(e,input),{code:'invalid_params'});
  assert.equal(fs.existsSync(path.join(e.lcaipackHome,'setup.json')),false);assert.equal(e.secretStore.values.size,0);
});
test('全域安裝前的設定參數沿用既有儲存值；Orca 儲存並重新套用後內容及值可讀回',async t=>{
 const e=await environment(t,{secret:false});SetupValueStore.forGlobal({home:e.lcaipackHome,userProfile:e.userHome}).setValues('demo-params',{endpoint:'https://global.example',region:'south'});
 assert.equal((await run(e)).ok,true);
 await save(e,{values:{endpoint:'https://edited.example',region:'north',verbose:false}});
 assert.equal((await e.worker.call('rc.install.run',{packageKey:'demo-params',action:'reapply'})).ok,true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(e.userHome,'.claude.json'),'utf8')).mcpServers.echo.env.MODE,'params');
 assert.equal(SetupValueStore.forGlobal({home:e.lcaipackHome,userProfile:e.userHome}).getValues('demo-params').endpoint,'https://edited.example');
});
