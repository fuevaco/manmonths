// 工項 12（工項 05 待辦 2）：專案範圍的既有部署自動列入部署目標。
// 對照 LC-AI-Pack：成功（或部分成功）的專案安裝會把專案根註冊到共用 config.json 的 registeredProjects
// （CliContext.RegisterProject、GUI ProjectTargetRegistration），其後的狀態與更新掃描才看得到該專案。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMulti } from './multi-env.mjs';

const readConfig = (e) => JSON.parse(fs.readFileSync(path.join(e.lcaipackHome, 'config.json'), 'utf8'));
const project = (e, name) => { const p = path.join(e.dir, name); fs.mkdirSync(p, { recursive: true }); return p; };
async function installInto(e, packageKey, version, root) {
  const { targets } = await e.worker.call('rc.deploy.listTargets', { scope: 'project', projectRoot: root });
  const ids = targets.filter(x => x.surfaceId === 'claude-code-cli').map(x => x.id);
  const summary = await e.worker.call('rc.deploy.plan', { packageKey, version, scope: 'project', projectRoot: root, targets: ids });
  return { summary, ids, result: await e.worker.call('rc.deploy.apply', { planDigest: summary.planDigest, targets: ids }) };
}

test('專案安裝成功後把專案根註冊到共用 config.json（完整路徑、不重複、保留其他設定）', async (t) => {
  const e = await setupMulti(t);
  const root = project(e, 'proj-one');
  fs.mkdirSync(e.lcaipackHome, { recursive: true });
  fs.writeFileSync(path.join(e.lcaipackHome, 'config.json'), JSON.stringify({ registryUrl: 'https://market.example.com/', manualClientRoots: { codex: ['/x'] }, registeredProjects: ['/already'] }, null, 2));

  assert.equal((await installInto(e, 'pkg-a', '1.0.0', root)).result.status, 'succeeded');
  assert.equal((await installInto(e, 'pkg-a', '1.1.0', root)).result.status, 'succeeded');

  const config = readConfig(e);
  assert.deepEqual(config.registeredProjects, ['/already', path.resolve(root)]);
  assert.equal(config.registryUrl, 'https://market.example.com/');
  assert.deepEqual(config.manualClientRoots, { codex: ['/x'] });
});

test('沒有 config.json 時建立只含專案清單的設定（不寫入任何預設市集網址）；全域安裝與失敗的套用不註冊', async (t) => {
  const e = await setupMulti(t, { packages: { 'pkg-a': ['1.0.0'], 'pkg-b': ['1.0.0'] } });
  const targets = await e.targets();
  const global = await e.plan('pkg-a', '1.0.0', [targets.claude.id]);
  assert.equal((await e.apply(global, [targets.claude.id])).status, 'succeeded');
  assert.equal(fs.existsSync(path.join(e.lcaipackHome, 'config.json')), false);

  const root = project(e, 'proj-one');
  assert.equal((await installInto(e, 'pkg-a', '1.0.0', root)).result.status, 'succeeded');
  assert.deepEqual(readConfig(e), { registeredProjects: [path.resolve(root)] });
  const other = project(e, 'proj-two');
  assert.equal((await installInto(e, 'pkg-a', '1.0.0', other)).result.status, 'succeeded');
  // 同一個專案位置已由 pkg-a 擁有：pkg-b 全部受阻、被拒絕套用，不改變專案清單。
  const conflict = await installInto(e, 'pkg-b', '1.0.0', root);
  assert.equal(conflict.summary.canApply, false);
  assert.equal(conflict.result.status, 'rejected');
  assert.deepEqual(readConfig(e).registeredProjects, [path.resolve(root), path.resolve(other)]);
});

test('列出專案目標時不指定路徑：自動列出已有該資源部署的專案，沒有部署或資料夾不存在的不列', async (t) => {
  const e = await setupMulti(t);
  const one = project(e, 'proj-one'), two = project(e, 'proj-two'), gone = project(e, 'proj-gone');
  for (const root of [one, gone]) assert.equal((await installInto(e, 'pkg-a', '1.0.0', root)).result.status, 'succeeded');
  fs.mkdirSync(path.join(two, '.claude'), { recursive: true });
  fs.rmSync(gone, { recursive: true, force: true });

  const { targets } = await e.worker.call('rc.deploy.listTargets', { scope: 'project', packageKey: 'pkg-a' });
  assert.ok(targets.length > 0);
  assert.deepEqual([...new Set(targets.map(x => x.projectRoot))], [path.resolve(one)]);
  assert.ok(targets.every(x => x.scope === 'project'));
  assert.ok(targets.some(x => x.surfaceId === 'claude-code-cli'));
  // 與指定路徑讀取的目標識別一致，可直接用來規劃更新。
  const typed = await e.worker.call('rc.deploy.listTargets', { scope: 'project', projectRoot: one });
  assert.deepEqual(targets.map(x => x.id).sort(), typed.targets.map(x => x.id).sort());

  const summary = await e.worker.call('rc.deploy.plan', { packageKey: 'pkg-a', version: '1.1.0', action: 'update', scope: 'project', targets: [targets.find(x => x.surfaceId === 'claude-code-cli').id] });
  assert.equal(summary.canApply, true);
  assert.deepEqual(summary.targets[0].installedVersions, ['1.0.0']);
});

test('不指定路徑且沒有資源包時仍要求專案路徑；一次規劃只能包含同一個範圍與專案的目標', async (t) => {
  const e = await setupMulti(t);
  await assert.rejects(e.worker.call('rc.deploy.listTargets', { scope: 'project' }), /專案資料夾/);
  const one = project(e, 'proj-one'), two = project(e, 'proj-two');
  const a = (await e.worker.call('rc.deploy.listTargets', { scope: 'project', projectRoot: one })).targets[0];
  const b = (await e.worker.call('rc.deploy.listTargets', { scope: 'project', projectRoot: two })).targets[0];
  const global = (await e.targets()).claude;
  await assert.rejects(e.worker.call('rc.deploy.plan', { packageKey: 'pkg-a', version: '1.0.0', scope: 'project', projectRoot: one, targets: [a.id, b.id] }), /找不到所選的部署目標|同一個專案/);
  await assert.rejects(e.worker.call('rc.deploy.plan', { packageKey: 'pkg-a', version: '1.0.0', targets: [global.id, a.id] }), /找不到所選的部署目標|同一個範圍/);

  // 自動列出的目標來自多個專案時，混選不同專案同樣被拒絕（不默默只取第一個專案）。
  for (const root of [one, two]) assert.equal((await installInto(e, 'pkg-a', '1.0.0', root)).result.status, 'succeeded');
  const listed = (await e.worker.call('rc.deploy.listTargets', { scope: 'project', packageKey: 'pkg-a' })).targets.filter(x => x.surfaceId === 'claude-code-cli');
  assert.equal(listed.length, 2);
  await assert.rejects(e.worker.call('rc.deploy.plan', { packageKey: 'pkg-a', version: '1.1.0', scope: 'project', targets: listed.map(x => x.id) }), /同一個範圍、同一個專案/);
});

test('部署摘要的「維持原版」只列同範圍的部署：專案計畫＝全域部署＋該專案，不含其他專案；全域計畫不含任何專案部署', async (t) => {
  const e = await setupMulti(t);
  const one = project(e, 'proj-one'), two = project(e, 'proj-two');
  const globalTargets = await e.targets();
  const globalIds = [globalTargets.claude.id, globalTargets.codex.id];
  assert.equal((await e.apply(await e.plan('pkg-a', '1.0.0', globalIds), globalIds)).status, 'succeeded');
  for (const root of [one, two]) assert.equal((await installInto(e, 'pkg-a', '1.0.0', root)).result.status, 'succeeded');

  // 更新專案 one 的 Claude Code：維持原版只含全域部署與 one 的其他部署，絕不含 proj-two。
  const { targets } = await e.worker.call('rc.deploy.listTargets', { scope: 'project', projectRoot: one });
  const claudeOne = targets.find(x => x.surfaceId === 'claude-code-cli');
  const projectPlan = await e.worker.call('rc.deploy.plan', { packageKey: 'pkg-a', version: '1.1.0', action: 'update', scope: 'project', projectRoot: one, targets: [claudeOne.id] });
  const unchanged = projectPlan.unchangedDeployments;
  assert.ok(unchanged.some(d => d.scope === 'global'));
  assert.ok(unchanged.every(d => d.scope === 'global' || d.rootPath.toLowerCase() === claudeOne.canonicalRoot.toLowerCase()), JSON.stringify(unchanged));
  assert.ok(!unchanged.some(d => d.rootPath.toLowerCase().includes('proj-two')));

  // 全域計畫：只列全域的其他部署，專案部署不屬於這份計畫的範圍。
  const again = await e.plan('pkg-a', '1.1.0', [globalTargets.claude.id], { action: 'update' });
  assert.ok(again.unchangedDeployments.length >= 1);
  assert.ok(again.unchangedDeployments.every(d => d.scope === 'global'), JSON.stringify(again.unchangedDeployments));
});
