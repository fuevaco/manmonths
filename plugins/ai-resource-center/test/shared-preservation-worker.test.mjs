import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMulti } from './multi-env.mjs';
import { zip } from './zip-fixture.mjs';
import { ReceiptStore, parseReceiptFile, serializeReceiptFile } from '../worker/deploy/receipts.mjs';
import { SetupValueStore } from '../worker/setup/values.mjs';

const build = version => zip({
 'lcpack.json':JSON.stringify({packageFormatVersion:1,key:'pkg-a',name:'Demo',type:'skill',version,description:'Synthetic',contents:[{id:'demo-skill',kind:'skill',path:'resources/skill'}],setup:{parameters:[{parameterId:'endpoint',label:'服務',type:'string',required:true}]}}),
 'README.md':'# Demo','resources/skill/SKILL.md':`---\nname: demo-skill\ndescription: Synthetic\n---\n${version}`
});
test('一鍵全域安裝、儲存與更新逐欄保留共用收據的專案項目及專案覆寫參數',async t=>{
 const e=await setupMulti(t,{packages:{'pkg-a':{'1.0.0':build('1.0.0'),'1.1.0':build('1.1.0')}}});
 const golden=JSON.parse(fs.readFileSync(new URL('./fixtures/lcaipack-receipts.windows.golden.json',import.meta.url),'utf8'));
 const projectRoot=path.join(e.dir,'project');fs.mkdirSync(path.join(projectRoot,'.lcaipack'),{recursive:true});
 const original={...golden.receipts[2],packageKey:'pkg-a',contentId:'demo-skill',scope:'project',canonicalRoot:projectRoot,normalizedAddress:`codex|codex-cli|project|${projectRoot}|hello`,targetKey:`codex|codex-cli|project|${projectRoot}`,source:null,sourcePath:null,clientVersion:'LC-reference',extension:{future:['keep',null]}};
 const receiptFile=path.join(e.lcaipackHome,'receipts.json');fs.mkdirSync(e.lcaipackHome,{recursive:true});
 fs.writeFileSync(receiptFile,JSON.stringify({receiptFormatVersion:1,receipts:[original]}));
 const projectSetup=JSON.parse(fs.readFileSync(new URL('./fixtures/lcaipack-setup.project.windows.golden.json',import.meta.url),'utf8'));
 projectSetup.packages[0].packageKey='pkg-a';projectSetup.packages[0].projectRoot=projectRoot;
 const override={...projectSetup.packages[0],values:{endpoint:'project-only',nullable:null},extension:{keep:true}};
 const setupFile=path.join(e.lcaipackHome,'setup.json');fs.writeFileSync(setupFile,JSON.stringify({setupFormatVersion:1,packages:[override]}));
 const emptyOverride={...override,packageKey:'empty-project',values:{}};const setupDoc=JSON.parse(fs.readFileSync(setupFile));setupDoc.packages.push(emptyOverride);fs.writeFileSync(setupFile,JSON.stringify(setupDoc));
 for(const name of ['receipts.json','setup.json'])fs.writeFileSync(path.join(projectRoot,'.lcaipack',name),name==='receipts.json'?JSON.stringify({receiptFormatVersion:1,receipts:[original]}):JSON.stringify(projectSetup));
 const config=JSON.stringify({registeredProjects:[projectRoot],unrelated:{keep:true}});fs.writeFileSync(path.join(e.lcaipackHome,'config.json'),config);
 const projectBytes=['receipts.json','setup.json'].map(name=>fs.readFileSync(path.join(projectRoot,'.lcaipack',name)));
 const preserved=()=>{
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile)).receipts.filter(r=>r.scope==='project'),[original]);
  assert.deepEqual(JSON.parse(fs.readFileSync(setupFile)).packages.filter(p=>p.scope==='project'),[override,emptyOverride]);
  ['receipts.json','setup.json'].forEach((name,i)=>assert.deepEqual(fs.readFileSync(path.join(projectRoot,'.lcaipack',name)),projectBytes[i]));
  assert.equal(fs.readFileSync(path.join(e.lcaipackHome,'config.json'),'utf8'),config);
 };
 assert.deepEqual((await e.worker.call('rc.catalog.list')).data.filter(p=>p.packageKey==='pkg-a')[0].deployments,[]);
 await e.worker.call('rc.install.saveSetup',{packageKey:'pkg-a',values:{endpoint:'global-value'}});preserved();
 assert.equal((await e.run()).ok,true);preserved();
 e.recommend('pkg-a','1.1.0');assert.equal((await e.run('pkg-a','update')).ok,true);preserved();
 assert.equal(SetupValueStore.forGlobal({home:e.lcaipackHome,userProfile:e.userHome}).getValues('pkg-a').endpoint,'global-value');
 const globals=JSON.parse(fs.readFileSync(receiptFile)).receipts.filter(r=>r.scope==='global');assert.equal(globals.length,3);assert.ok(globals.every(r=>r.packageVersion==='1.1.0'));
});
test('LC-AI-Pack golden 收據與 Orca 全域收據依共用格式接續更新，版本與 clientVersion 分開記錄',async t=>{
 const e=await setupMulti(t);const golden=JSON.parse(fs.readFileSync(new URL('./fixtures/lcaipack-receipts.windows.golden.json',import.meta.url),'utf8'));
 fs.mkdirSync(e.lcaipackHome,{recursive:true});const file=path.join(e.lcaipackHome,'receipts.json');fs.writeFileSync(file,JSON.stringify(golden));
 assert.equal((await e.run()).ok,true);
 const first=parseReceiptFile(fs.readFileSync(file,'utf8'),file);assert.equal(first.receipts.filter(r=>r.packageKey==='pkg-a').length,3);
 // 以 LC-AI-Pack 相同的 Upsert／序列化契約模擬另一用戶端接續寫入；不啟動真實使用者環境。
 const store=ReceiptStore.forGlobal({home:e.lcaipackHome,userProfile:e.userHome});
 store.upsert(first.receipts.filter(r=>r.packageKey==='pkg-a').map(r=>({...r,clientVersion:'9.8.7-reference'})));
 const lcBytes=serializeReceiptFile(store.load(),'\r\n');fs.writeFileSync(file,lcBytes);
 e.recommend('pkg-a','1.1.0');assert.equal((await e.run('pkg-a','update')).ok,true);
 const updated=parseReceiptFile(fs.readFileSync(file,'utf8'),file).receipts;
 assert.deepEqual(updated.filter(r=>r.packageKey!=='pkg-a'),first.receipts.filter(r=>r.packageKey!=='pkg-a'));
 const plugin=JSON.parse(fs.readFileSync(new URL('../orca-plugin.json',import.meta.url),'utf8')).version;
 assert.ok(updated.filter(r=>r.packageKey==='pkg-a').every(r=>r.packageVersion==='1.1.0'&&r.clientVersion===plugin));
 const referenceRead=parseReceiptFile(serializeReceiptFile(store.load(),'\r\n'),file);assert.deepEqual(referenceRead.receipts,updated);
});
