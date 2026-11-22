import test from 'node:test';
import assert from 'node:assert/strict';
import { describeInstallProblems } from '../worker/install-problems.mjs';
import { hostLabel, toolId, targetSummary } from '../worker/host-labels.mjs';
import { HostIds, SurfaceIds } from '../worker/deploy/host-profiles.mjs';
test('問題顯示使用結構化擁有者、設定路徑及命令用途，不解析診斷文字',()=>{
 const owner={code:'deployment.ownership-collision',summary:"資源包 'wrong'",existingOwner:{ownerPackageKey:'right'}};
 assert.match(describeInstallProblems([owner]).reason,/right/);assert.doesNotMatch(describeInstallProblems([{...owner,existingOwner:undefined}]).reason,/wrong/);
 assert.equal(describeInstallProblems([{code:'deployment.config-conflict',summary:'任意診斷',configPath:'C:/data/settings.json#node'}]).reason,'這個位置的設定檔無法安全修改（settings.json）');
 assert.equal(describeInstallProblems([{code:'deployment.setup-command-failed',summary:"命令 'wrong'",commandName:'準備工具',failureSummary:'exit code 17'}]).reason,'設定命令「準備工具」執行失敗：結束代碼 17');
 assert.deepEqual(describeInstallProblems([owner]).detail,[owner]);
});
test('未知問題只翻譯獨立術語，含 package 字樣的單字與路徑保持不變',()=>{
 assert.equal(describeInstallProblems([{summary:'package packager packages /mypackage/config package.json'}]).reason,'資源包 packager packages /mypackage/設定檔 資源包.json');
});
test('Claude Desktop 的摘要身分獨立，所有工具共用同一份標籤',()=>{
 for(const [hostId,surfaceId,id,label] of [[HostIds.codex,SurfaceIds.codexCli,HostIds.codex,'Codex'],[HostIds.claudeCode,SurfaceIds.claudeCodeCli,HostIds.claudeCode,'Claude Code'],[HostIds.claudeCode,SurfaceIds.claudeDesktop,SurfaceIds.claudeDesktop,'Claude Desktop']]){
  const target={id:'target',hostId,surfaceId,rootPath:'/synthetic'};assert.equal(toolId(target),id);assert.equal(hostLabel(target),label);assert.deepEqual(targetSummary(target),{targetId:'target',hostId:id,label,rootPath:'/synthetic'});
 }
});
