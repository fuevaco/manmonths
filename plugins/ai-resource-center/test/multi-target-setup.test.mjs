// 工項 12 × 工項 10：含設定命令的資源包部署到多個目標。設定命令只在確認後執行一次；命令失敗只讓依賴它的
// （可部署的）目標成為「未部署」，原本就因衝突受阻的目標仍顯示自己的原因，兩者不混為一談。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMulti, sha } from './multi-env.mjs';
import { zip } from './zip-fixture.mjs';

// 設定命令依執行平台選 runner：Windows 用 PowerShell；其他平台用 bash（Linux 不允許 PowerShell，ADR-0005）。
const host = process.platform === 'win32' ? { runner: 'powershell', script: 'setup/prepare.ps1', operatingSystem: 'windows' }
  : { runner: 'bash', script: 'setup/prepare.sh', operatingSystem: process.platform === 'darwin' ? 'macos' : 'linux' };
const fakeRunners = { resolve: runner => ({ runner, executable: `/fake/${runner}`, leadingArguments: [] }) };
const bundle = (version) => zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: 'bundle-s', name: 'Bundle S', type: 'bundle', version, description: 'Synthetic',
  contents: [{ id: 'demo-skill', kind: 'skill', path: 'resources/skills/demo-skill' }],
  setup: { parameters: [], commands: [{ commandId: 'prepare', name: '準備環境', runner: host.runner, script: host.script, arguments: [], timeoutMinutes: 1 }] } }),
  'README.md': '# 合成', 'resources/skills/demo-skill/SKILL.md': '---\nname: demo-skill\ndescription: Synthetic skill\n---\nBundle', [host.script]: 'exit 0\n' });

async function environment(t, { fail }) {
  const calls = [];
  const commandExecutor = { run: async request => {
    calls.push(request.command.commandId);
    request.log.writeCommandStart(request.command.commandId, request.command.runner, request.command.script, request.command.arguments);
    request.log.writeCommandEnd(request.command.commandId, fail ? 17 : 0, 1);
    return fail ? { commandId: request.command.commandId, outcome: 'Completed', exitCode: 17, durationMs: 1, failureSummary: '設定命令以非零 exit code 17 結束。', succeeded: false }
      : { commandId: request.command.commandId, outcome: 'Completed', exitCode: 0, durationMs: 1, failureSummary: null, succeeded: true };
  } };
  const e = await setupMulti(t, { packages: { 'pkg-a': ['1.0.0'], 'bundle-s': { '1.0.0': bundle('1.0.0') } },
    workerDeps: { commandExecutor, runners: fakeRunners, setupEnvironment: { operatingSystem: host.operatingSystem, architecture: 'x64' }, platform: process.platform } });
  assert.equal((await e.seed('pkg-a', [e.roots.claudeWork])).ok, true);
  return { ...e, calls };
}
for (const fail of [false, true]) test(`設定命令${fail ? '失敗' : '成功'}：只執行一次，受阻部署目標保持自己的原因`, async t => {
  const e = await environment(t, { fail }); const before = e.receipts();
  const review = await e.run('bundle-s');
  assert.equal(review.plan.deployableCount, 2); assert.equal(review.plan.blockedTargets.length, 1);
  assert.deepEqual(e.calls, []);
  const result = await e.confirm(review, 'bundle-s');
  assert.deepEqual(e.calls, ['prepare']);
  assert.equal(result.ok, !fail);
  assert.equal(result.succeeded.length, fail ? 0 : 2);
  assert.equal(result.failed.length, fail ? 2 : 0); assert.equal(result.skipped.length, 1);
  const blocked = result.skipped.find(t => t.rootPath === e.roots.claudeWork);
  assert.ok(blocked.detail.some(p => p.code === 'deployment.ownership-collision'));
  assert.ok(blocked.detail.every(p => p.code !== 'deployment.setup-command-failed'));
  if (fail) {
    for (const target of result.failed.filter(t => t !== blocked)) assert.ok(target.detail.some(p => p.code === 'deployment.setup-command-failed'));
    assert.deepEqual(e.receipts(), before);
    for (const root of [e.roots.codex, e.roots.claude]) assert.equal(fs.existsSync(path.join(e.dest(root), 'SKILL.md')), false);
  } else assert.equal(e.receipts().filter(r => r.packageKey === 'bundle-s').length, 2);
});
