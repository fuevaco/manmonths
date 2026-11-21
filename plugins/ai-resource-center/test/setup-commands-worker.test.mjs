// 含設定命令的組合包（工項 10）：從面板實際使用的 worker 請求契約進入，以真實子行程執行設定命令
// （對照 LcAiPack.Tests CliSetupEndToEndTests、SetupPerOsPackageTests、SetupSecretDeliveryTests、SetupCancellationTests 的端到端部分）。
// Windows 以 PowerShell、macOS 以 bash；腳本只在臨時目錄寫入無害的證據檔。
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
import { setupSecretReference } from '../worker/setup/secrets.mjs';
import { SetupValueStore } from '../worker/setup/values.mjs';

const WINDOWS = process.platform === 'win32';
const sha = b => createHash('sha256').update(b).digest('hex');
const CANARY = 'canary-setup-time-secret-10';
const KEY = 'demo-setup-bundle';
const SKILL = '---\nname: setup-skill\ndescription: Synthetic\n---\nHello';

// 腳本先讀完 stdin 的秘密框架（平台一律寫入），再把一行證據寫到 <dir>/runs.txt；<dir>/fail.flag 存在時以 exit 17 失敗。
const POWERSHELL = `param([string]$Dir, [string]$Label)
$received = @()
while (($line = [Console]::In.ReadLine()) -ne $null) { if ($line -eq 'LCAIPACK-SECRET-END') { break }; if ($line -notlike 'LCAIPACK-SECRET-BEGIN*') { $received += $line } }
Add-Content -LiteralPath (Join-Path $Dir 'runs.txt') -Value ('os=windows label=' + $Label)
if (Test-Path -LiteralPath (Join-Path $Dir 'echo-secret.flag')) { foreach ($entry in $received) { [Console]::Out.WriteLine('secret-entry=' + [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($entry.Split(' ')[1]))) } }
if (Test-Path -LiteralPath (Join-Path $Dir 'sleep.flag')) { Add-Content -LiteralPath (Join-Path $Dir 'sleeping.txt') -Value $PID; Start-Sleep -Seconds 300 }
if (Test-Path -LiteralPath (Join-Path $Dir 'fail.flag')) { [Console]::Error.WriteLine('precondition missing: fail.flag'); exit 17 }
Write-Output ('wrote=' + (Join-Path $Dir 'runs.txt'))
exit 0
`;
const BASH = `#!/usr/bin/env bash
dir=""; label=""
while [ "$#" -gt 0 ]; do case "$1" in --dir) dir="$2"; shift 2 ;; --label) label="$2"; shift 2 ;; *) exit 3 ;; esac; done
received=()
while IFS= read -r line; do [ "$line" = "LCAIPACK-SECRET-END" ] && break; case "$line" in LCAIPACK-SECRET-BEGIN*) ;; *) received+=("$line") ;; esac; done
echo "os=macos label=$label" >> "$dir/runs.txt"
if [ -f "$dir/echo-secret.flag" ]; then for entry in "\${received[@]}"; do echo "secret-entry=$(printf '%s' "\${entry#* }" | base64 -d)"; done; fi
if [ -f "$dir/sleep.flag" ]; then echo $$ >> "$dir/sleeping.txt"; sleep 300; fi
if [ -f "$dir/fail.flag" ]; then echo "precondition missing: fail.flag" >&2; exit 17; fi
echo "wrote=$dir/runs.txt"
exit 0
`;

function bundleZip({ version = '1.0.0', runOnUpdate = false, secret = false, markerDir }) {
  const parameters = [{ parameterId: 'marker-label', label: 'Marker label', type: 'string', required: true, default: 'orca-rc-demo' },
    ...(secret ? [{ parameterId: 'setup-pat', label: 'Setup PAT', type: 'secret', required: true, secretUsage: 'setup-time' }] : [])];
  const manifest = { packageFormatVersion: 1, key: KEY, name: 'Demo Setup Bundle', type: 'bundle', version, description: 'Synthetic', contents: [{ id: 'setup-skill', kind: 'skill', path: 'resources/skills/setup-skill' }],
    setup: { parameters, commands: [
      { commandId: 'write-marker-windows', name: '寫入證據檔（Windows）', runner: 'powershell', script: 'setup/write-marker.ps1', arguments: ['-Dir', markerDir, '-Label', '{{parameter:marker-label}}'], operatingSystems: ['windows'], architectures: ['x64', 'arm64'], timeoutMinutes: 1, runOnUpdate },
      { commandId: 'write-marker-macos', name: '寫入證據檔（macOS）', runner: 'bash', script: 'setup/write-marker.sh', arguments: ['--dir', markerDir, '--label', '{{parameter:marker-label}}'], operatingSystems: ['macos'], architectures: ['x64', 'arm64'], timeoutMinutes: 1, runOnUpdate }] } };
  return zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo', 'resources/skills/setup-skill/SKILL.md': SKILL,
    'setup/write-marker.ps1': String.fromCharCode(0xfeff) + POWERSHELL, 'setup/write-marker.sh': BASH });
}

async function environment(t, { secret = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-setup-cmd-'));
  const userHome = path.join(dir, 'home'), lcaipackHome = path.join(dir, 'lcaipack'), project = path.join(dir, 'project'), markerDir = path.join(dir, 'markers');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true }); fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), '{}');
  fs.mkdirSync(project); fs.mkdirSync(markerDir);
  const versions = { '1.0.0': bundleZip({ secret, markerDir }), '1.1.0': bundleZip({ version: '1.1.0', secret, markerDir, runOnUpdate: true }), '1.2.0': bundleZip({ version: '1.2.0', secret, markerDir, runOnUpdate: false }) };
  const item = { packageKey: KEY, name: 'Demo Setup Bundle', type: 'bundle', description: 'Synthetic', latestReleaseVersion: '1.2.0' };
  const market = await startFakeMarket({ packages: [item] });
  let recommended = '1.0.0';
  market.override(`GET /api/market/packages/${KEY}`, () => ({ status: 200, body: { ...item, recommendedVersion: recommended,
    versions: Object.entries(versions).filter(([version])=>version<=recommended).map(([version, bytes]) => ({ version, isEnabled: true, channel: 'release', status: 'active', hosts: ['claude-code'], sha256: sha(bytes) })) } }));
  for (const [version, bytes] of Object.entries(versions)) market.override(`GET /api/market/packages/${KEY}/versions/${version}/download`, () => ({ status: 200, raw: bytes, contentType: 'application/zip' }));
  const secretStore = memoryStore();
  const worker = startWorker({ deps: { lcaipackHome, userHome, env: {}, secretStore } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const marker = name => path.join(markerDir, name);
  const runs = () => { try { return fs.readFileSync(marker('runs.txt'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } };
  const skill = path.join(userHome, '.claude', 'skills', 'setup-skill', 'SKILL.md');
  const receipts = path.join(lcaipackHome,'receipts.json');
  const run = (action='install',extra={})=>worker.call('rc.install.run',{packageKey:KEY,action,...extra});
  const confirm = (review,action='install')=>run(action,{confirmedPlanId:review.planId});
  return { dir,userHome,lcaipackHome,project,markerDir,worker,secretStore,marker,runs,skill,receipts,run,confirm,recommend:v=>{recommended=v;} };
}
const allFiles = dir => { const out=[];const walk=d=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory())walk(p);else out.push(p);}};walk(dir);return out; };
const commands = review => review.plan.setupCommands;
const executable = review => commands(review).find(c=>c.willExecute);
const operations = e => fs.readdirSync(path.join(e.lcaipackHome,'operations')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(e.lcaipackHome,'operations',n),'utf8')));

test('一鍵確認列出設定命令用途及系統相容性；確認前零執行與零部署', async t=>{
 const e=await environment(t);const review=await e.run();
 assert.equal(review.needsConfirmation,true);assert.deepEqual(review.reasons,['setupCommands']);assert.equal(commands(review).length,2);
 assert.equal(executable(review).commandId,WINDOWS?'write-marker-windows':'write-marker-macos');
 assert.deepEqual(executable(review).arguments.slice(-1),['orca-rc-demo']);assert.equal(executable(review).reason,'FirstRun');
 assert.equal(commands(review).find(c=>!c.willExecute).eligibility,'UnsupportedOperatingSystem');
 assert.deepEqual(e.runs(),[]);assert.equal(fs.existsSync(e.skill),false);assert.equal(fs.existsSync(path.join(e.lcaipackHome,'operations')),false);
});
test('確認後真實設定命令只執行一次，寫入全域內容、operation 與完成狀態；同版重裝略過',async t=>{
 const e=await environment(t);const review=await e.run();const result=await e.confirm(review);
 assert.equal(result.ok,true);assert.equal(e.runs().length,1);assert.ok(e.runs()[0].includes('label=orca-rc-demo'));
 assert.equal(fs.existsSync(e.skill),true);assert.equal(fs.existsSync(e.receipts),true);
 const op=operations(e)[0];assert.equal(op.state,'succeeded');assert.equal(op.scope,'global');assert.equal(fs.existsSync(op.logPath),true);
 const again=await e.run();assert.equal(again.needsConfirmation,undefined);
 assert.equal(again.ok,true);assert.equal(e.runs().length,1);
});
test('設定命令失敗：目標零寫入，保留命令用途與結束代碼；修正後可重試成功',async t=>{
 const e=await environment(t);fs.writeFileSync(e.marker('fail.flag'),'');const review=await e.run();const result=await e.confirm(review);
 assert.equal(result.ok,false);assert.equal(result.failed.length,1);assert.equal(fs.existsSync(e.skill),false);assert.equal(fs.existsSync(e.receipts),false);
 const p=result.failed[0].detail.find(p=>p.code==='deployment.setup-command-failed');assert.equal(p.commandName,executable(review).name);assert.match(p.failureSummary,/17/);
 const op=operations(e)[0];assert.equal(op.state,'failed');assert.match(op.checkpoint,/setup-command:/);assert.match(fs.readFileSync(op.logPath,'utf8'),/precondition missing: fail.flag/);
 fs.rmSync(e.marker('fail.flag'));const retry=await e.run();assert.equal(executable(retry).reason,'PreviousFailure');
 assert.equal((await e.confirm(retry)).ok,true);assert.equal(e.runs().length,2);
});
test('腳本回吐 setup-time 秘密時，所有檔案、結果及 worker 日誌皆遮罩；秘密只進全域安全儲存區',async t=>{
 const e=await environment(t,{secret:true});fs.writeFileSync(e.marker('echo-secret.flag'),'');fs.writeFileSync(e.marker('fail.flag'),'');
 const first=await e.run();assert.ok(first.reasons.includes('missingParameters'));
 await e.worker.call('rc.install.saveSetup',{packageKey:KEY,secrets:{'setup-pat':CANARY}});
 const review=await e.run();const result=await e.confirm(review);assert.equal(result.ok,false);
 assert.ok(operations(e).some(op=>fs.readFileSync(op.logPath,'utf8').includes('secret-entry=<redacted>')));
 assert.deepEqual(leakedSecrets([...allFiles(e.dir).map(f=>fs.readFileSync(f,'utf8')),...e.worker.state.transcript,...e.worker.state.logs,JSON.stringify(result)],[CANARY,Buffer.from(CANARY).toString('base64')]),[]);
 const ref=setupSecretReference({packageKey:KEY,parameterId:'setup-pat',scope:'global',canonicalRoot:e.userHome});assert.equal(e.secretStore.values.get(ref.key),CANARY);
});
test('確認前全域參數改變會重新確認，命令尚未執行；新確認後使用新值',async t=>{
 const e=await environment(t);const review=await e.run();SetupValueStore.forGlobal({home:e.lcaipackHome,userProfile:e.userHome}).setValues(KEY,{'marker-label':'changed-after-review'});
 const fresh=await e.confirm(review);assert.equal(fresh.needsConfirmation,true);assert.notEqual(fresh.planId,review.planId);assert.equal(executable(fresh).arguments.at(-1),'changed-after-review');
 assert.deepEqual(e.runs(),[]);assert.equal(fs.existsSync(e.skill),false);assert.equal((await e.confirm(fresh)).ok,true);
});
test('更新僅重跑 runOnUpdate 命令，其他版本略過仍更新內容與收據',async t=>{
 const e=await environment(t);assert.equal((await e.confirm(await e.run())).ok,true);
 e.recommend('1.1.0');const update=await e.run('update');assert.equal(executable(update).reason,'UpdateRunOnUpdate');assert.equal((await e.confirm(update,'update')).ok,true);assert.equal(e.runs().length,2);
 e.recommend('1.2.0');const quiet=await e.run('update');assert.equal(quiet.needsConfirmation,undefined);assert.equal(quiet.ok,true);assert.equal(e.runs().length,2);
 assert.equal(JSON.parse(fs.readFileSync(e.receipts,'utf8')).receipts[0].packageVersion,'1.2.0');
 await assert.rejects(e.run('teleport'),{code:'invalid_params'});
});
test('取消真實設定命令會終止子行程樹，未部署且 operation 保留可重試',async t=>{
 const e=await environment(t);fs.writeFileSync(e.marker('sleep.flag'),'');const review=await e.run();const pending=e.confirm(review);
 const deadline=Date.now()+60000;while(!fs.existsSync(e.marker('sleeping.txt'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
 const pid=Number(fs.readFileSync(e.marker('sleeping.txt'),'utf8').trim().split(/\r?\n/)[0]);t.after(()=>{try{process.kill(pid,'SIGKILL');}catch{}});
 assert.equal((await e.worker.call('rc.install.cancel',{packageKey:KEY})).cancelled,true);
 const result=await pending;assert.equal(result.ok,false);assert.ok(result.failed.every(t=>t.detail.some(p=>p.code==='deployment.setup-cancelled')));
 assert.equal(fs.existsSync(e.skill),false);assert.equal(fs.existsSync(e.receipts),false);assert.equal(operations(e)[0].state,'cancelled');
 let alive=true;for(let i=0;i<100&&alive;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,50));}catch{alive=false;}}assert.equal(alive,false);
 assert.equal((await e.worker.call('rc.install.cancel',{packageKey:KEY})).cancelled,false);
});
