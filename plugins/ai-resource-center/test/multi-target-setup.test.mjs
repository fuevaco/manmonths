// 工項 12 × 工項 10：含設定命令的資源包部署到多個目標。設定命令只在確認後執行一次；命令失敗只讓依賴它的
// （可部署的）目標成為「未部署」，原本就因衝突受阻的目標仍顯示自己的原因，兩者不混為一談。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMulti, sha } from './multi-env.mjs';
import { zip } from './zip-fixture.mjs';

const fakeRunners = { resolve: runner => ({ runner, executable: `/fake/${runner}`, leadingArguments: [] }) };
const bundle = (version) => zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: 'bundle-s', name: 'Bundle S', type: 'bundle', version, description: 'Synthetic',
  contents: [{ id: 'demo-skill', kind: 'skill', path: 'resources/skills/demo-skill' }],
  setup: { parameters: [], commands: [{ commandId: 'prepare', name: '準備環境', runner: 'powershell', script: 'setup/prepare.ps1', arguments: [], timeoutMinutes: 1 }] } }),
  'README.md': '# 合成', 'resources/skills/demo-skill/SKILL.md': '---\nname: demo-skill\ndescription: Synthetic skill\n---\nBundle', 'setup/prepare.ps1': 'exit 0\n' });

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
    workerDeps: { commandExecutor, runners: fakeRunners, setupEnvironment: { operatingSystem: 'windows', architecture: 'x64' }, platform: 'win32' } });
  const targets = await e.targets();
  // pkg-a 先占用第二個 Claude Code 根的 demo-skill，使組合包在該目標因他包擁有而受阻。
  const first = await e.plan('pkg-a', '1.0.0', [targets.claudeWork.id]);
  assert.equal((await e.apply(first, [targets.claudeWork.id])).status, 'succeeded');
  const ids = [targets.codex.id, targets.claude.id, targets.claudeWork.id];
  return { ...e, calls, ids };
}

test('設定命令成功：命令只執行一次，兩個可部署目標完成、受阻目標維持原狀', async (t) => {
  const e = await environment(t, { fail: false });
  const summary = await e.plan('bundle-s', '1.0.0', e.ids);
  assert.equal(summary.canApply, true, JSON.stringify(summary.problems));
  assert.deepEqual([summary.deployableCount, summary.blockedCount], [2, 1]);
  assert.equal(e.calls.length, 0);

  const result = await e.apply(summary, e.ids);

  assert.equal(result.status, 'partial');
  assert.deepEqual(e.calls, ['prepare']);
  assert.deepEqual(result.targets.map(x => x.status).sort(), ['skipped', 'succeeded', 'succeeded']);
  assert.equal(e.receipts().filter(r => r.packageKey === 'bundle-s').length, 2);
});

test('設定命令失敗：只有依賴它的可部署目標成為未部署（原因為命令失敗）；受阻目標仍列出自己的衝突原因', async (t) => {
  const e = await environment(t, { fail: true });
  const before = e.receipts();
  const summary = await e.plan('bundle-s', '1.0.0', e.ids);
  const result = await e.apply(summary, e.ids);

  assert.equal(result.status, 'failed');
  assert.deepEqual(e.calls, ['prepare']);
  const byId = Object.fromEntries(result.targets.map(x => [x.id, x]));
  for (const id of [e.ids[0], e.ids[1]]) {
    assert.equal(byId[id].status, 'notDeployed');
    assert.match(byId[id].problems[0].summary, /設定命令 '準備環境' 未成功/);
  }
  assert.equal(byId[e.ids[2]].status, 'skipped');
  assert.ok(byId[e.ids[2]].problems.some(p => p.code === 'deployment.ownership-collision'));
  assert.ok(byId[e.ids[2]].problems.every(p => !/設定命令/.test(p.summary)));
  assert.deepEqual(e.receipts(), before);
  assert.equal(fs.existsSync(path.join(e.dest(e.roots.codex), 'SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(e.dest(e.roots.claude), 'SKILL.md')), false);
  assert.equal(sha(fs.readFileSync(path.join(e.dest(e.roots.claudeWork), 'SKILL.md'))).length, 64);
});
