// 工項 11：安裝與更新自動處理可解決的衝突（ADR 0002）。
// 從面板使用的 worker 請求契約進入：本機修改與未受管同名內容先備份再套用，不需要使用者額外勾選；
// 他包擁有、備份失敗與設定檔無法安全變更時該目標受阻或復原。備份命名、阻擋條件與回復行為對照
// （McpLocalModificationTests、RollbackCharacterisationTests、PlanProblemAttributionTests）。
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
function assertSkillBackup(e, backup) {
  const [stamp, ...source] = path.relative(path.join(e.lcaipackHome, 'backups'), backup).split(path.sep);
  assert.match(stamp, /^\d{14}$/);
  assert.deepEqual(source, ['home', ...path.relative(e.userHome, e.skillDir).split(path.sep)]);
  assert.ok(!fs.readdirSync(path.dirname(e.skillDir)).some(name => name.includes('.bak-lcaipack-')));
}
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
  const recommended = {};
  for (const [key, spec] of Object.entries(packages)) {
    recommended[key] = spec.versions[0];
    const zips = Object.fromEntries(spec.versions.map(v => [v, build(key, v, spec)]));
    market.override(`GET /api/market/packages/${key}`, () => ({ status: 200, body: { packageKey: key, name: key, type: spec.kind ?? 'skill', description: 'Synthetic',
      recommendedVersion: recommended[key], versions: spec.versions.filter(v => v <= recommended[key]).map(v => ({ version: v, isEnabled: true, channel: 'release', status: 'active', hosts: ['codex', 'claude-code'], sha256: sha(zips[v]) })) } }));
    for (const v of spec.versions) {
      market.override(`GET /api/market/packages/${key}/versions/${v}/readme`, () => ({ status: 200, body: { readme: '# 合成' } }));
      market.override(`GET /api/market/packages/${key}/versions/${v}/download`, () => ({ status: 200, raw: zips[v], headers: { 'X-Checksum-Sha256': sha(zips[v]) }, contentType: 'application/zip' }));
    }
  }
  const worker = startWorker({ deps: { lcaipackHome, userHome, env: {} } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const skillDir = path.join(rules.normalize(userHome), '.agents', 'skills', 'demo-skill');
  const receipts = () => JSON.parse(fs.readFileSync(path.join(lcaipackHome, 'receipts.json'), 'utf8')).receipts;
  const run = (packageKey = 'pkg-a', action = 'install') => worker.call('rc.install.run', { packageKey, action });
  return { dir, userHome, codexRoot, lcaipackHome, worker, skillDir, receipts, run, recommend: (key, v) => { recommended[key] = v; } };
}

test('更新受管 Skill 本機修改：先備份再套用，備份與收據記錄正確', async t => {
  const e = await setup(t); await e.run();
  fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '本機修改');
  e.recommend('pkg-a', '1.1.0');
  const result = await e.run('pkg-a', 'update');
  assert.equal(result.ok, true); assert.equal(result.backups.length, 1);
  const backup = result.backups[0].backupPath;
  assertSkillBackup(e, backup); assert.equal(fs.readFileSync(path.join(backup, 'SKILL.md'), 'utf8'), '本機修改');
  assert.equal(fs.readFileSync(path.join(e.skillDir, 'SKILL.md'), 'utf8'), skillText('1.1.0'));
  assert.equal(e.receipts()[0].packageVersion, '1.1.0');
});
test('未受管同名 Skill 自動備份整棵目錄，原本額外檔案保留在備份', async t => {
  const e = await setup(t); fs.mkdirSync(e.skillDir, { recursive: true });
  fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '自己的 skill'); fs.writeFileSync(path.join(e.skillDir, 'mine.txt'), '自己的筆記');
  const result = await e.run(); assert.equal(result.ok, true);
  const backup = result.backups[0].backupPath; assertSkillBackup(e, backup);
  assert.equal(fs.readFileSync(path.join(backup, 'SKILL.md'), 'utf8'), '自己的 skill');
  assert.equal(fs.readFileSync(path.join(backup, 'mine.txt'), 'utf8'), '自己的筆記');
  assert.equal(fs.existsSync(path.join(e.skillDir, 'mine.txt')), false);
});
test('他包擁有 Skill 時全部受阻：列出擁有者、內容位置且不備份或寫入', async t => {
  const e = await setup(t, { 'pkg-a': { versions: ['1.0.0'] }, 'pkg-b': { versions: ['1.0.0'] } }); await e.run();
  const before = fs.readFileSync(path.join(e.lcaipackHome, 'receipts.json'));
  const files = fs.readdirSync(path.dirname(e.skillDir));
  const result = await e.run('pkg-b'); assert.equal(result.allBlocked, true);
  const target = result.plan.blockedTargets[0]; assert.match(target.reason, /pkg-a/);
  assert.equal(target.detail[0].path, e.skillDir); assert.equal(target.detail[0].existingOwner.ownerPackageKey, 'pkg-a');
  assert.deepEqual(fs.readdirSync(path.dirname(e.skillDir)), files);
  assert.deepEqual(fs.readFileSync(path.join(e.lcaipackHome, 'receipts.json')), before);
});
test('備份失敗會還原原內容，收據不指向新版', async t => {
  const e = await setup(t); await e.run();
  fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '本機修改'); fs.writeFileSync(path.join(e.skillDir, 'notes.md'), '筆記');
  e.recommend('pkg-a', '1.1.0'); const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (from, to, ...rest) => {
    if (String(to).startsWith(path.join(e.lcaipackHome, 'backups') + path.sep) && String(from).endsWith('notes.md')) throw new Error('disk full');
    return copy(from, to, ...rest);
  });
  const result = await e.run('pkg-a', 'update'); t.mock.restoreAll();
  assert.equal(result.ok, false); assert.equal(result.failed[0].detail[0].failureStage, 'backup');
  assert.match(result.failed[0].detail[0].explanation, /disk full/);
  assert.equal(fs.readFileSync(path.join(e.skillDir, 'SKILL.md'), 'utf8'), '本機修改');
  assert.equal(fs.readFileSync(path.join(e.skillDir, 'notes.md'), 'utf8'), '筆記');
  assert.equal(e.receipts()[0].packageVersion, '1.0.0');
});
test('收據寫入與復原皆失敗：顯示還原不完整並保留備份及舊版收據', async t => {
  const e = await setup(t); await e.run(); fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '本機修改');
  e.recommend('pkg-a', '1.1.0'); const write = fs.writeFileSync, remove = fs.rmSync, copy = fs.copyFileSync;
  t.mock.method(fs, 'writeFileSync', (p, ...rest) => { if (/receipts\.json\..*\.part$/.test(String(p))) throw new Error('receipt denied'); return write(p, ...rest); });
  t.mock.method(fs, 'rmSync', (p, opts) => { if (opts?.recursive && path.resolve(String(p)).toLowerCase() === path.resolve(e.skillDir).toLowerCase()) throw new Error('locked'); return remove(p, opts); });
  t.mock.method(fs, 'copyFileSync', (from, to, ...rest) => {
    if (String(from).includes('lcaipack-transactions') && path.resolve(String(to)).toLowerCase() === path.join(e.skillDir, 'SKILL.md').toLowerCase()) throw new Error('restore denied');
    return copy(from, to, ...rest);
  });
  const result = await e.run('pkg-a', 'update'); t.mock.restoreAll();
  assert.equal(result.ok, false); assert.ok(result.failed[0].detail.some(p => p.code === 'deployment.rollback-failed'));
  assert.match(result.failed[0].reason, /部分內容無法還原/); assert.equal(result.backups.length, 1);
  assert.equal(fs.readFileSync(path.join(result.backups[0].backupPath, 'SKILL.md'), 'utf8'), '本機修改');
  assert.equal(e.receipts()[0].packageVersion, '1.0.0');
});
test('MCP 本機修改先備份設定檔，更新保留無關節點與註解', async t => {
  const e = await setup(t, { 'mcp-a': { kind: 'mcp', versions: ['1.0.0', '1.1.0'] } });
  const config = path.join(e.codexRoot, 'config.toml'); fs.writeFileSync(config, '# keep\nmodel = "synthetic"\n[mcp_servers.other]\ncommand = "user"\n');
  await e.run('mcp-a'); fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(/(\[mcp_servers\.echo\][^]*?command = )"[^"]*"/, '$1"my-own-launcher"'));
  const edited = fs.readFileSync(config); e.recommend('mcp-a', '1.1.0');
  const result = await e.run('mcp-a', 'update'); assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(result.backups[0].backupPath), edited);
  const now = fs.readFileSync(config, 'utf8'); assert.match(now, /# keep/); assert.match(now, /\[mcp_servers\.other\]\ncommand = "user"/); assert.match(now, /REV = "1\.1\.0"/);
});
test('無法安全解析 MCP 設定檔時受阻，原檔不改動、不備份', async t => {
  const e = await setup(t, { 'mcp-a': { kind: 'mcp', versions: ['1.0.0'] } });
  const config = path.join(e.codexRoot, 'config.toml'); fs.writeFileSync(config, 'model = [');
  const result = await e.run('mcp-a'); assert.equal(result.allBlocked, true);
  assert.equal(result.plan.blockedTargets[0].detail[0].configPath, rules.normalize(config));
  assert.equal(fs.readFileSync(config, 'utf8'), 'model = ['); assert.ok(!fs.readdirSync(e.codexRoot).some(n => n.includes('.bak-lcaipack-')));
});
test('備份永不覆蓋既有備份：被占用的時間戳使用不同名稱，舊備份逐位元不變', async t => {
  const e = await setup(t); await e.run(); fs.writeFileSync(path.join(e.skillDir, 'SKILL.md'), '本機修改');
  const stamp = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
  const decoys = [];
  for (let s = -2; s <= 40; s++) {
    const p = path.join(e.lcaipackHome, 'backups', stamp(new Date(Date.now() + s * 1000)), 'home', path.relative(e.userHome, e.skillDir));
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'SKILL.md'), `誘餌 ${s}`);
    decoys.push(p);
  }
  e.recommend('pkg-a','1.1.0'); const result = await e.run('pkg-a','update');
  assert.equal(result.ok, true); assert.ok(!decoys.includes(result.backups[0].backupPath)); assertSkillBackup(e, result.backups[0].backupPath);
  decoys.forEach((p,i) => assert.equal(fs.readFileSync(path.join(p,'SKILL.md'),'utf8'),`誘餌 ${i-2}`));
});
