// 規劃與套用入口（對照 LC-AI-Pack DeploymentPlannerTests、RollbackCharacterisationTests）。
// 全部使用隔離的暫存目錄，不接觸使用者真實家目錄。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createDeploymentPlanner } from '../worker/deploy/planner.mjs';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';
import { ReceiptStore } from '../worker/deploy/receipts.mjs';
import { zip } from './zip-fixture.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const rules = createPathRules();
const codex = { hostId: 'codex', surfaceId: 'codex-cli' };
const SKILL = '---\nname: hello\ndescription: Synthetic\n---\nHello\r\n';
function skillPackage({ key = 'demo', version = '1.0.0', id = 'hello', extra = {} } = {}) {
  const manifest = { packageFormatVersion: 1, key, name: 'Demo', type: 'skill', version, description: 'Synthetic',
    contents: [{ id, kind: 'skill', path: `resources/${id}` }] };
  const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo', [`resources/${id}/SKILL.md`]: SKILL,
    [`resources/${id}/references/notes.md`]: `notes ${version}`, ...extra });
  return { bytes, expectedSha256: sha(bytes) };
}

async function env(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-planner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, 'userhome');
  const root = path.join(userHome, '.codex');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'config.toml'), '');
  const home = path.join(dir, 'lcaipack');
  const planner = createDeploymentPlanner({ home, userHome, clientVersion: '9.9.9-orca', channel: 'release' });
  const intent = (pkg, roots = [root], extra = {}) => ({ package: pkg, scope: 'global', projectRoot: null, hosts: [codex],
    existingContent: 'Block', hostRoots: [{ host: codex, canonicalRoots: roots }], ...extra });
  return { dir, userHome, root, home, planner, intent, destination: path.join(rules.normalize(userHome), '.agents', 'skills', 'hello') };
}

async function tree(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { recursive: true })).sort();
}

test('更新移除仍有本機修改的技能時，先將修改存入集中備份', async t => {
  const e = await env(t);
  const install = e.planner.plan(e.intent(skillPackage()));
  assert.equal(e.planner.apply(install, { planDigest: install.planDigest }).status, 'Succeeded');
  await writeFile(path.join(e.destination, 'SKILL.md'), 'Local edit');
  const bytes = zip({ 'lcpack.json': JSON.stringify({
    packageFormatVersion: 1, key: 'demo', name: 'Demo', type: 'mcp', version: '2.0.0', description: 'Synthetic',
    contents: [{ id: 'new-server', kind: 'mcp', name: 'New server', definition: { transport: 'stdio', command: 'echo' } }]
  }), 'README.md': '# Demo' });
  const update = e.planner.plan(e.intent({ bytes, expectedSha256: sha(bytes) }, [e.root], { existingContent: 'BackupAndReplace' }));
  const applied = e.planner.apply(update, { planDigest: update.planDigest });
  assert.equal(applied.status, 'Succeeded');
  assert.ok(!existsSync(e.destination));
  const backups = applied.targets.flatMap(t => t.backupPaths);
  assert.equal(backups.length, 1);
  assert.ok(backups[0].startsWith(path.join(e.home, 'backups') + path.sep));
  assert.equal(await readFile(path.join(backups[0], 'SKILL.md'), 'utf8'), 'Local edit');
});

test('規劃階段對目標零寫入，多個 Codex 根共用同一份 Skill', async (t) => {
  const e = await env(t);
  const before = await tree(e.dir);
  const plan = e.planner.plan(e.intent(skillPackage(), [e.root, path.join(e.userHome, '.codex-work')]));
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.canApply, true, JSON.stringify(plan.problems));
  assert.deepEqual(await tree(e.dir), before);
  const target = plan.targets[0];
  assert.equal(target.targetKey, `codex|codex-cli|global|${rules.normalize(e.userHome)}`);
  assert.equal(target.hostProfileVersion, 'codex/2026.11.1');
  const [m] = target.mutations;
  assert.deepEqual([m.contentId, m.kind, m.mutationKind, m.change, m.destinationPath, m.willBackup], ['hello', 'skill', 'SyncTree', 'Create', e.destination, false]);
  assert.equal(m.mutationId.length, 16);
});

test('套用後 Skill 逐位元組寫入並記錄相容收據；再次規劃為無變更', async (t) => {
  const e = await env(t);
  const pkg = skillPackage();
  const plan = e.planner.plan(e.intent(pkg));
  const result = e.planner.apply(plan, { planDigest: plan.planDigest });
  assert.equal(result.status, 'Succeeded', JSON.stringify(result));
  assert.equal(await readFile(path.join(e.destination, 'SKILL.md'), 'utf8'), SKILL);
  assert.equal(await readFile(path.join(e.destination, 'references', 'notes.md'), 'utf8'), 'notes 1.0.0');
  const store = ReceiptStore.forGlobal({ home: e.home, userProfile: e.userHome });
  const [r] = store.load().receipts;
  assert.equal(store.filePath, path.join(e.home, 'receipts.json'));
  assert.deepEqual({ ...r, installedAt: undefined, installedSha256: undefined }, {
    packageKey: 'demo', packageVersion: '1.0.0', packageSha256: pkg.expectedSha256, channel: 'release', contentId: 'hello', kind: 'skill',
    hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', canonicalRoot: rules.normalize(e.userHome),
    normalizedAddress: `codex|codex-cli|global|${rules.normalize(e.userHome)}|hello`, destinationPath: e.destination, mutationKind: 'SyncTree',
    sourceSha256: pkg.expectedSha256, ownedConfigFields: [], baseValueHashes: [], clientVersion: '9.9.9-orca', hostProfileVersion: 'codex/2026.11.1',
    installedAt: undefined, installedSha256: undefined
  });
  // 樹雜湊：排序後「相對路徑:內容雜湊\n」再雜湊（獨立計算）。
  const expectedTree = sha(`SKILL.md:${sha(SKILL)}\nreferences/notes.md:${sha('notes 1.0.0')}\n`);
  assert.equal(r.installedSha256, expectedTree);
  assert.match(r.installedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?\+00:00$/);
  const again = e.planner.plan(e.intent(pkg));
  assert.equal(again.targets[0].mutations[0].change, 'NoOp');
  assert.equal(again.targets[0].mutations[0].ownership.isSameOwner, true);
});

test('根目錄就是使用者家目錄的舊式 Codex 根，Skill 落在家目錄的 .agents/skills', async (t) => {
  const e = await env(t);
  const plan = e.planner.plan(e.intent(skillPackage(), [e.userHome]));
  assert.equal(plan.targets[0].mutations[0].destinationPath, path.join(rules.normalize(e.userHome), '.agents', 'skills', 'hello'));
});

test('共用 skills 是使用者的目錄連結時，跨設定根安裝與再次規劃沿用該位置', async t => {
  const e = await env(t);
  const outside = path.join(e.dir, 'shared-skills');
  await mkdir(outside);
  await mkdir(path.join(e.userHome, '.agents'));
  await symlink(outside, path.join(e.userHome, '.agents', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const intent = e.intent(skillPackage());
  const plan = e.planner.plan(intent);
  assert.equal(plan.canApply, true, JSON.stringify(plan.targets));
  assert.equal(e.planner.apply(plan, { planDigest: plan.planDigest }).status, 'Succeeded');
  assert.equal(await readFile(path.join(outside, 'hello', 'SKILL.md'), 'utf8'), SKILL);
  assert.equal(e.planner.plan(intent).targets[0].mutations[0].change, 'NoOp');
});

test('Windows 目錄 ACL 禁止新增技能時，規劃顯示受阻原因且零寫入', { skip: process.platform !== 'win32' }, async t => {
  const e = await env(t);
  const skills = path.join(e.userHome, '.agents', 'skills');
  await mkdir(skills, { recursive: true });
  // WD / AD deny adding files or subdirectories, while the directory remains readable.
  execFileSync('icacls.exe', [skills, '/deny', '*S-1-1-0:(WD,AD)']);
  try {
    const plan = e.planner.plan(e.intent(skillPackage()));
    assert.equal(plan.canApply, false);
    assert.ok(plan.targets[0].problems.some(p => p.code === 'deployment.shared-skills-unavailable'));
    assert.equal(existsSync(e.destination), false);
  } finally {
    execFileSync('icacls.exe', [skills, '/remove:d', '*S-1-1-0']);
  }
});

test('需要偵測根目錄的 Codex 沒有偵測結果時阻擋，不退回使用者家目錄', async (t) => {
  const e = await env(t);
  const plan = e.planner.plan(e.intent(skillPackage(), [], { hostRoots: [] }));
  assert.equal(plan.canApply, false);
  assert.equal(plan.targets.length, 0);
  const [p] = plan.problems;
  assert.equal(p.code, 'deployment.unsupported-host');
  assert.match(p.summary, /偵測/);
});

test('審核後目的地被外部建立時套用回報過期且零寫入', async (t) => {
  const e = await env(t);
  const plan = e.planner.plan(e.intent(skillPackage()));
  await mkdir(e.destination, { recursive: true });
  await writeFile(path.join(e.destination, 'SKILL.md'), '外部程序寫入的內容\n');
  const result = e.planner.apply(plan, { planDigest: plan.planDigest });
  assert.equal(result.status, 'Stale');
  assert.equal(result.targets[0].status, 'Stale');
  assert.ok(result.targets[0].problems.some(p => p.code === 'deployment.plan-stale'));
  assert.deepEqual(result.targets[0].writtenPaths, []);
  assert.equal(await readFile(path.join(e.destination, 'SKILL.md'), 'utf8'), '外部程序寫入的內容\n');
  assert.equal(existsSync(path.join(e.home, 'receipts.json')), false);
});

test('套用綁定審核過的計畫摘要；相同意圖重複規劃摘要穩定，既有內容政策改變摘要', async (t) => {
  const e = await env(t);
  const pkg = skillPackage();
  const plan = e.planner.plan(e.intent(pkg));
  assert.equal(e.planner.plan(e.intent(pkg)).planDigest, plan.planDigest);
  assert.notEqual(e.planner.plan(e.intent(pkg, undefined, { existingContent: 'BackupAndReplace' })).planDigest, plan.planDigest);
  const rejected = e.planner.apply(plan, { planDigest: 'not-the-digest' });
  assert.equal(rejected.status, 'Rejected');
  assert.ok(rejected.problems.some(p => p.code === 'deployment.plan-stale'));
  assert.deepEqual(rejected.targets, []);
  assert.equal(existsSync(e.destination), false);
});

test('計畫內的部署目標不屬於使用者選定的根目錄集合時拒絕套用', async (t) => {
  const e = await env(t);
  const injected = path.join(e.dir, 'injected');
  await mkdir(injected);
  const plan = e.planner.plan(e.intent(skillPackage()));
  const tampered = { ...plan, targets: [{ ...plan.targets[0], canonicalRoot: rules.normalize(injected) }] };
  const result = e.planner.apply(tampered, { planDigest: tampered.planDigest });
  assert.equal(result.status, 'Rejected');
  assert.ok(result.problems.some(p => p.code === 'deployment.plan-stale'));
});

test('規劃後共用技能路徑受阻時回報過期，不留下收據', async (t) => {
  const e = await env(t);
  const plan = e.planner.plan(e.intent(skillPackage()));
  await writeFile(path.join(e.userHome, '.agents'), '不是目錄');
  const result = e.planner.apply(plan, { planDigest: plan.planDigest });
  assert.equal(result.status, 'Stale');
  assert.ok(result.targets[0].problems.some(p => p.code === 'deployment.plan-stale'));
  assert.equal(await readFile(path.join(e.userHome, '.agents'), 'utf8'), '不是目錄');
  assert.equal(existsSync(path.join(e.home, 'receipts.json')), false);
});

test('收據寫入失敗時還原已寫入的 Skill，不留下指向新版的收據', async (t) => {
  const e = await env(t);
  const plan = e.planner.plan(e.intent(skillPackage()));
  await mkdir(path.join(e.home, 'receipts.json'), { recursive: true });
  const result = e.planner.apply(plan, { planDigest: plan.planDigest });
  assert.equal(result.targets[0].status, 'RolledBack', JSON.stringify(result));
  assert.equal(existsSync(e.destination), false);
  assert.deepEqual(await readdir(path.join(e.home, 'receipts.json')), []);
});

test('同一內容已由其他資源包擁有時，任何既有內容政策都阻擋', async (t) => {
  const e = await env(t);
  const first = e.planner.plan(e.intent(skillPackage({ key: 'first' })));
  assert.equal(e.planner.apply(first, { planDigest: first.planDigest }).status, 'Succeeded');
  for (const existingContent of ['Block', 'BackupAndReplace']) {
    const second = e.planner.plan(e.intent(skillPackage({ key: 'second' }), undefined, { existingContent }));
    assert.equal(second.canApply, false);
    const problem = second.targets[0].problems.find(p => p.code === 'deployment.ownership-collision');
    assert.equal(problem.severity, 'Blocking');
    assert.equal(problem.existingOwner.ownerPackageKey, 'first');
    assert.equal(e.planner.apply(second, { planDigest: second.planDigest, replaceUnmanagedFiles: true }).status, 'Rejected');
  }
});

test('目的地已有未受管內容時預設阻擋', async (t) => {
  const e = await env(t);
  await mkdir(e.destination, { recursive: true });
  await writeFile(path.join(e.destination, 'SKILL.md'), '使用者自己的 skill');
  const plan = e.planner.plan(e.intent(skillPackage()));
  assert.equal(plan.canApply, false);
  assert.ok(plan.targets[0].problems.some(p => p.code === 'deployment.unmanaged-collision' && p.severity === 'Blocking'));
});

test('資源包 SHA-256 與預期不符時在規劃任何目標前拒絕', async (t) => {
  const e = await env(t);
  const plan = e.planner.plan(e.intent({ ...skillPackage(), expectedSha256: '0'.repeat(64) }));
  assert.equal(plan.canApply, false);
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.problems[0].code, 'deployment.source-changed');
});

test('Skill 缺少 SKILL.md 必要欄位時以資源包格式問題阻擋', async (t) => {
  const e = await env(t);
  const plan = e.planner.plan(e.intent(skillPackage({ extra: { 'resources/hello/SKILL.md': '---\nname: hello\n---\nbody' } })));
  assert.equal(plan.canApply, false);
  assert.equal(plan.problems[0].code, 'deployment.invalid-package');
});
