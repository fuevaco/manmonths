// 工項 11：安裝與更新自動處理可解決的衝突（ADR 0002）。
// 從面板使用的 worker 請求契約進入：本機修改與未受管同名內容先備份再套用，不需要使用者額外勾選；
// 他包擁有、備份失敗與設定檔無法安全變更時該目標受阻或復原。備份命名、阻擋條件與回復行為對照
// LC-AI-Pack（McpLocalModificationTests、RollbackCharacterisationTests、PlanProblemAttributionTests）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker } from './harness.mjs';
import { zip } from './zip-fixture.mjs';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const rules = createPathRules();
const BACKUP = /\.bak-lcaipack-\d{14}(-\d+)?$/;
const skillText = (version) => `---\nname: demo-skill\ndescription: Synthetic skill\n---\nVersion ${version}\n`;

function build(key, version, { kind = 'skill' } = {}) {
  const manifest = kind === 'mcp'
    ? { packageFormatVersion: 1, key, name: key, type: 'mcp', version, description: 'Synthetic',
        contents: [{ id: 'echo', name: 'Echo', kind: 'mcp', definition: { transport: 'stdio', command: 'npx', args: ['-y', 'example'], env: { REV: version } } }] }
    : { packageFormatVersion: 1, key, name: key, type: 'skill', version, description: 'Synthetic',
        contents: [{ id: 'demo-skill', kind: 'skill', path: 'resources/skills/demo-skill' }] };
  return zip(kind === 'mcp' ? { 'lcpack.json': JSON.stringify(manifest), 'README.md': '# 合成' }
    : { 'lcpack.json': JSON.stringify(manifest), 'README.md': '# 合成', 'resources/skills/demo-skill/SKILL.md': skillText(version),
        'resources/skills/demo-skill/notes.md': `notes ${version}` });
}

/** packages: { key: { kind, versions: [..] } } */
async function setup(t, packages = { 'pkg-a': { versions: ['1.0.0', '1.1.0'] } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-conflict-'));
  const userHome = path.join(dir, 'home');
  const codexRoot = path.join(userHome, '.codex');
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.writeFileSync(path.join(codexRoot, 'config.toml'), 'model = "synthetic"\n');
  const lcaipackHome = path.join(dir, 'lcaipack');
  const market = await startFakeMarket({ packages: Object.keys(packages).map(k => ({ packageKey: k, name: k, type: packages[k].kind ?? 'skill', description: 'Synthetic', latestReleaseVersion: packages[k].versions.at(-1) })) });
  for (const [key, spec] of Object.entries(packages)) {
    const zips = Object.fromEntries(spec.versions.map(v => [v, build(key, v, spec)]));
    market.override(`GET /api/market/packages/${key}`, () => ({ status: 200, body: { packageKey: key, name: key, type: spec.kind ?? 'skill', description: 'Synthetic',
      recommendedVersion: spec.versions.at(-1), versions: spec.versions.map(v => ({ version: v, isEnabled: true, channel: 'release', status: 'active', hosts: ['codex', 'claude-code'], sha256: sha(zips[v]) })) } }));
    for (const v of spec.versions) {
      market.override(`GET /api/market/packages/${key}/versions/${v}/readme`, () => ({ status: 200, body: { readme: '# 合成' } }));
      market.override(`GET /api/market/packages/${key}/versions/${v}/download`, () => ({ status: 200, raw: zips[v], headers: { 'X-Checksum-Sha256': sha(zips[v]) }, contentType: 'application/zip' }));
    }
  }
  const worker = startWorker({ deps: { lcaipackHome, userHome, env: {} } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const skillDir = path.join(rules.normalize(codexRoot), 'skills', 'demo-skill');
  const receipts = () => JSON.parse(fs.readFileSync(path.join(lcaipackHome, 'receipts.json'), 'utf8')).receipts;
  async function deploy(packageKey, version, extra = {}) {
    const { targets } = await worker.call('rc.deploy.listTargets', extra.scope ? { scope: extra.scope, projectRoot: extra.projectRoot } : {});
    const target = extra.targetId ? targets.find(x => x.id === extra.targetId) : targets.find(x => x.hostId === (extra.hostId ?? 'codex') && x.surfaceId !== 'claude-desktop');
    const plan = await worker.call('rc.deploy.plan', { packageKey, version, ...(extra.scope ? { scope: extra.scope, projectRoot: extra.projectRoot } : {}), targets: [target.id] });
    return { plan, target, apply: () => worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [target.id] }) };
  }
  return { dir, userHome, codexRoot, lcaipackHome, worker, skillDir, receipts, deploy };
}

test('更新時受管 Skill 被本機修改：自動備份後套用，結果顯示備份位置，不需額外勾選', async (t) => {
  const e = await setup(t);
  const first = await e.deploy('pkg-a', '1.0.0');
  assert.equal((await first.apply()).status, 'succeeded');
  fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '使用者改過的內容\n');

  const update = await e.deploy('pkg-a', '1.1.0');
  assert.equal(update.plan.canApply, true, JSON.stringify(update.plan.targets[0].problems));
  const [change] = update.plan.targets[0].changes;
  assert.equal(change.willBackup, true);
  assert.equal(change.backupReason, 'localModification');
  const note = update.plan.targets[0].problems.find(p => p.code === 'deployment.local-modification');
  assert.equal(note.severity, 'Warning');
  assert.match(note.explanation, /自動先備份/);
  assert.doesNotMatch(note.explanation, /授權|重新以/);

  const result = await update.apply();
  assert.equal(result.status, 'succeeded');
  const [backup] = result.targets[0].backupPaths;
  assert.equal(result.targets[0].backupPaths.length, 1);
  assert.match(backup, BACKUP);
  assert.equal(backup.startsWith(`${update.plan.targets[0].changes[0].destinationPath}.bak-lcaipack-`), true);
  assert.equal(fs.readFileSync(path.join(backup, 'SKILL.md'), 'utf8'), '使用者改過的內容\n');
  assert.equal(fs.readFileSync(path.join(e.skillDir, 'SKILL.md'), 'utf8'), skillText('1.1.0'));
  assert.equal(e.receipts()[0].packageVersion, '1.1.0');
});

test('安裝時目標已有未受管同名內容：自動備份後完成部署，備份保留原內容', async (t) => {
  const e = await setup(t);
  fs.mkdirSync(e.skillDir, { recursive: true });
  fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '使用者自己的 skill\n');
  fs.writeFileSync(path.join(e.skillDir, 'mine.txt'), '只有我有\n');

  const install = await e.deploy('pkg-a', '1.0.0');
  assert.equal(install.plan.canApply, true, JSON.stringify(install.plan.targets[0].problems));
  assert.equal(install.plan.targets[0].changes[0].backupReason, 'unmanaged');
  assert.ok(install.plan.targets[0].problems.some(p => p.code === 'deployment.unmanaged-collision' && p.severity === 'Warning'));

  const result = await install.apply();
  assert.equal(result.status, 'succeeded');
  const [backup] = result.targets[0].backupPaths;
  assert.match(backup, BACKUP);
  assert.equal(fs.readFileSync(path.join(backup, 'SKILL.md'), 'utf8'), '使用者自己的 skill\n');
  assert.equal(fs.readFileSync(path.join(backup, 'mine.txt'), 'utf8'), '只有我有\n');
  assert.equal(fs.readFileSync(path.join(e.skillDir, 'SKILL.md'), 'utf8'), skillText('1.0.0'));
  assert.equal(fs.existsSync(path.join(e.skillDir, 'mine.txt')), false);
});

test('目標已由其他資源包擁有：該目標受阻並說明位置與原因，原內容不被改動', async (t) => {
  const e = await setup(t, { 'pkg-a': { versions: ['1.0.0'] }, 'pkg-b': { versions: ['1.0.0'] } });
  assert.equal((await (await e.deploy('pkg-a', '1.0.0')).apply()).status, 'succeeded');
  fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '使用者改過的內容\n');
  const before = fs.readdirSync(path.dirname(e.skillDir)).sort();

  const other = await e.deploy('pkg-b', '1.0.0');
  assert.equal(other.plan.canApply, false);
  assert.equal(other.plan.targets[0].canApply, false);
  const p = other.plan.targets[0].problems.find(x => x.code === 'deployment.ownership-collision');
  assert.equal(p.severity, 'Blocking');
  assert.match(p.summary, /pkg-a/);
  assert.equal(p.path, e.skillDir);
  assert.equal(other.plan.targets[0].changes[0].willBackup, false);
  assert.equal((await other.apply()).status, 'rejected');
  assert.equal(fs.readFileSync(path.join(e.skillDir, 'SKILL.md'), 'utf8'), '使用者改過的內容\n');
  assert.deepEqual(fs.readdirSync(path.dirname(e.skillDir)).sort(), before);
  assert.equal(e.receipts().length, 1);
  assert.equal(e.receipts()[0].packageKey, 'pkg-a');
});

test('無法備份時該目標復原原狀態，不寫入指向新版的收據', async (t) => {
  const e = await setup(t);
  assert.equal((await (await e.deploy('pkg-a', '1.0.0')).apply()).status, 'succeeded');
  fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '使用者改過的內容\n');
  fs.writeFileSync(path.join(e.skillDir, 'notes.md'), '使用者的筆記');
  const update = await e.deploy('pkg-a', '1.1.0');
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (from, to, ...rest) => {
    if (String(to).includes('.bak-lcaipack-') && String(from).endsWith('notes.md')) throw new Error('disk full');
    return copy(from, to, ...rest);
  });
  const result = await update.apply();
  t.mock.restoreAll();
  assert.equal(result.status, 'failed');
  assert.equal(result.targets[0].status, 'rolledBack');
  assert.match(result.targets[0].problems[0].summary, /已完整還原/);
  assert.match(result.targets[0].problems[0].explanation, /disk full/);
  assert.equal(fs.readFileSync(path.join(e.skillDir, 'SKILL.md'), 'utf8'), '使用者改過的內容\n');
  assert.equal(fs.readFileSync(path.join(e.skillDir, 'notes.md'), 'utf8'), '使用者的筆記');
  assert.equal(e.receipts()[0].packageVersion, '1.0.0');
});

test('備份後寫入失敗且復原也失敗：回報 rollbackIncomplete、殘留路徑與已建立的備份，不寫入新版收據', async (t) => {
  const e = await setup(t);
  assert.equal((await (await e.deploy('pkg-a', '1.0.0')).apply()).status, 'succeeded');
  fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '使用者改過的內容\n');
  const update = await e.deploy('pkg-a', '1.1.0');
  const write = fs.writeFileSync, remove = fs.rmSync;
  t.mock.method(fs, 'writeFileSync', (p, ...rest) => { if (/receipts\.json\..*\.part$/.test(String(p))) throw new Error('receipt denied'); return write(p, ...rest); });
  t.mock.method(fs, 'rmSync', (p, opts) => { if (opts?.recursive && path.resolve(String(p)).toLowerCase() === path.resolve(e.skillDir).toLowerCase()) throw new Error('locked'); return remove(p, opts); });
  const result = await update.apply();
  t.mock.restoreAll();
  assert.equal(result.status, 'failed');
  const [target] = result.targets;
  assert.equal(target.status, 'rollbackIncomplete');
  assert.ok(target.problems.some(p => p.code === 'deployment.rollback-failed'));
  assert.deepEqual(target.residualPaths.map(p => path.resolve(p).toLowerCase()), [path.resolve(e.skillDir).toLowerCase()]);
  assert.equal(target.backupPaths.length, 1);
  assert.equal(fs.readFileSync(path.join(target.backupPaths[0], 'SKILL.md'), 'utf8'), '使用者改過的內容\n');
  assert.equal(e.receipts()[0].packageVersion, '1.0.0');
});

test('受管 MCP 欄位被本機修改：自動備份設定檔後套用，無關節點保留', async (t) => {
  const e = await setup(t, { 'mcp-a': { kind: 'mcp', versions: ['1.0.0', '1.1.0'] } });
  const config = path.join(e.codexRoot, 'config.toml');
  fs.writeFileSync(config, '# keep\nmodel = "synthetic"\n[mcp_servers.other]\ncommand = "user"\n');
  const first = await e.deploy('mcp-a', '1.0.0');
  assert.equal((await first.apply()).status, 'succeeded');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(/(\[mcp_servers\.echo\][^]*?command = )"[^"]*"/, '$1"my-own-launcher"'));
  const edited = fs.readFileSync(config);

  const update = await e.deploy('mcp-a', '1.1.0');
  assert.equal(update.plan.canApply, true, JSON.stringify(update.plan.targets[0].problems));
  assert.equal(update.plan.targets[0].changes[0].backupReason, 'localModification');
  const result = await update.apply();
  assert.equal(result.status, 'succeeded');
  const [backup] = result.targets[0].backupPaths;
  assert.match(backup, BACKUP);
  assert.deepEqual(fs.readFileSync(backup), edited);
  const now = fs.readFileSync(config, 'utf8');
  assert.match(now, /\[mcp_servers\.other\]\ncommand = "user"/);
  assert.match(now, /# keep/);
  assert.match(now, /REV = "1\.1\.0"/);
});

test('設定檔無法安全解析時該目標受阻，原檔不被改動、不備份', async (t) => {
  const e = await setup(t, { 'mcp-a': { kind: 'mcp', versions: ['1.0.0'] } });
  const config = path.join(e.codexRoot, 'config.toml');
  fs.writeFileSync(config, 'model = [');
  const plan = (await e.deploy('mcp-a', '1.0.0')).plan;
  assert.equal(plan.canApply, false);
  assert.ok(plan.targets[0].problems.some(p => p.code === 'deployment.config-conflict' && p.severity === 'Blocking'));
  assert.equal(fs.readFileSync(config, 'utf8'), 'model = [');
  assert.deepEqual(fs.readdirSync(e.codexRoot).filter(n => n.includes('.bak-lcaipack-')), []);
});

test('備份永不覆蓋既有備份：同名時間戳已被占用時改用不重複的名稱，既有備份逐位元不變', async (t) => {
  const e = await setup(t);
  assert.equal((await (await e.deploy('pkg-a', '1.0.0')).apply()).status, 'succeeded');
  fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '本機修改\n');
  const decoys = [];
  const stamp = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const update = await e.deploy('pkg-a', '1.1.0');
  for (let s = -2; s <= 40; s++) {
    const decoy = `${e.skillDir}.bak-lcaipack-${stamp(new Date(Date.now() + s * 1000))}`;
    fs.mkdirSync(decoy); fs.writeFileSync(path.join(decoy, 'SKILL.md'), `誘餌 ${s}`);
    decoys.push(decoy);
  }
  const result = await update.apply();
  assert.equal(result.status, 'succeeded');
  const [backup] = result.targets[0].backupPaths;
  assert.equal(decoys.includes(backup), false);
  assert.match(backup, BACKUP);
  assert.equal(fs.readFileSync(path.join(backup, 'SKILL.md'), 'utf8'), '本機修改\n');
  decoys.forEach((d, i) => assert.equal(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'), `誘餌 ${i - 2}`));
});

test('全域與專案同時有同一資源：不需勾選即可部署，明細顯示兩處位置與載入優先順序', async (t) => {
  const e = await setup(t);
  assert.equal((await (await e.deploy('pkg-a', '1.0.0')).apply()).status, 'succeeded');
  const projectRoot = path.join(e.dir, 'project'); fs.mkdirSync(projectRoot);

  const project = await e.deploy('pkg-a', '1.1.0', { scope: 'project', projectRoot });
  assert.equal(project.plan.canApply, true, JSON.stringify(project.plan.targets[0].problems));
  const [entry] = project.plan.targets[0].loadPrecedence;
  assert.deepEqual([entry.contentId, entry.kind, entry.rule, entry.winner], ['demo-skill', 'skill', 'bothLoaded', 'both']);
  assert.match(entry.text, /不會合併/);
  assert.deepEqual(entry.locations.map(l => [l.scope, l.version, l.current]), [['global', '1.0.0', false], ['project', '1.1.0', true]]);
  assert.equal(entry.locations[0].path, e.skillDir);
  assert.equal(entry.locations[1].path, path.join(rules.normalize(projectRoot), '.agents', 'skills', 'demo-skill'));
  assert.ok(project.plan.targets[0].problems.some(p => p.code === 'deployment.scope-shadowing' && p.severity === 'Warning'));
  assert.equal((await project.apply()).status, 'succeeded');
});

test('在全域更新時，共用專案清單內已有同一資源的專案也會揭露載入優先順序', async (t) => {
  const e = await setup(t);
  const projectRoot = path.join(e.dir, 'project'); fs.mkdirSync(projectRoot);
  assert.equal((await (await e.deploy('pkg-a', '1.0.0', { scope: 'project', projectRoot })).apply()).status, 'succeeded');
  fs.mkdirSync(e.lcaipackHome, { recursive: true });
  fs.writeFileSync(path.join(e.lcaipackHome, 'config.json'), JSON.stringify({ registeredProjects: [projectRoot] }));

  const global = await e.deploy('pkg-a', '1.1.0');
  assert.equal(global.plan.canApply, true, JSON.stringify(global.plan.targets[0].problems));
  const [entry] = global.plan.targets[0].loadPrecedence;
  assert.deepEqual(entry.locations.map(l => [l.scope, l.version, l.current]), [['global', '1.1.0', true], ['project', '1.0.0', false]]);
  assert.equal((await global.apply()).status, 'succeeded');
});

test('沒有同名內容跨範圍並存時，摘要不含載入優先順序', async (t) => {
  const e = await setup(t);
  const plan = (await e.deploy('pkg-a', '1.0.0')).plan;
  assert.equal(plan.targets[0].loadPrecedence, undefined);
});
