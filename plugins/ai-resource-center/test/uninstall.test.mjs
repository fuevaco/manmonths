import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorker } from './harness.mjs';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';
import { observe, observeTree } from '../worker/deploy/observer.mjs';
import { build, setupMulti } from './multi-env.mjs';
import { zip } from './zip-fixture.mjs';
import { newBackupStamp } from '../worker/deploy/target-transaction.mjs';
import { resolveOrcaAppData } from '../worker/deploy/orca-claude-mcp-cleanup.mjs';

const rules = createPathRules();
const key = 'synthetic-remove';
const targetId = r => `${r.hostId}|${r.surfaceId}|${r.scope}|${r.canonicalRoot}`;
function fixture(t, createDeps = () => ({})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-uninstall-'));
  const userHome = path.join(dir, 'home'), home = path.join(dir, 'lcaipack');
  fs.mkdirSync(userHome); fs.mkdirSync(home);
  const receipts = [];
  const worker = startWorker({ deps: { userHome, lcaipackHome: home, env: {}, transport: () => { throw new Error('解除安裝不可呼叫市集'); }, commandExecutor: { run() { throw new Error('不可執行命令'); } }, ...createDeps(dir) } });
  t.after(() => { worker.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  function add(rootName, relative, mutationKind, text, extra = {}) {
    const root = rules.normalize(path.join(userHome, rootName));
    const destinationPath = path.join(root, relative);
    const file = mutationKind === 'SyncTree' ? path.join(destinationPath, 'SKILL.md') : destinationPath;
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    const hostId = rootName.startsWith('.codex') ? 'codex' : 'claude-code';
    const surfaceId = rootName === 'desktop' ? 'claude-desktop' : hostId === 'codex' ? 'codex-cli' : 'claude-code-cli';
    const contentId = path.basename(relative);
    const r = { packageKey: key, packageVersion: '1.0.0', contentId, kind: mutationKind === 'PatchConfig' ? 'mcp' : 'skill', hostId, surfaceId,
      scope: 'global', canonicalRoot: root, destinationPath, mutationKind, installedSha256: mutationKind === 'SyncTree' ? observeTree(destinationPath).treeSha256 : observe(destinationPath).sha256,
      ownedConfigFields: [], normalizedAddress: `${hostId}|${surfaceId}|global|${root}|${contentId}`, ...extra };
    receipts.push(r); return r;
  }
  function save() { fs.writeFileSync(path.join(home, 'receipts.json'), JSON.stringify({ receiptFormatVersion: 1, receipts })); }
  const load = () => JSON.parse(fs.readFileSync(path.join(home, 'receipts.json'))).receipts;
  const run = (extra = {}) => worker.call('rc.install.run', { packageKey: key, action: 'uninstall', ...extra });
  return { dir, userHome, home, worker, receipts, add, save, load, run };
}

const mcpId = 'synthetic.owned';
const matchingText = '{"mcpServers":{"synthetic.owned":{"command":"demo","args":["first","second"]}}}';

function writeOrcaProfile(appData, name, value) {
  const file = path.join(appData, 'orca', 'claude-profiles', name, 'home', '.claude.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}

function orcaRemovalFixture(t, platform = 'win32') {
  const appDataFor = dir => path.join(dir, 'roaming');
  const e = fixture(t, dir => ({ platform, env: { APPDATA: appDataFor(dir), XDG_CONFIG_HOME: appDataFor(dir) } }));
  const main = e.add('.claude', 'settings.json', 'PatchConfig', '{}', { contentId: mcpId, ownedConfigFields: [`mcpServers.${mcpId}`] });
  main.destinationPath = path.join(e.userHome, '.claude.json');
  fs.writeFileSync(main.destinationPath, matchingText);
  e.save();
  const appData = appDataFor(e.dir);
  return { ...e, appData, main: main.destinationPath, write: (name, text) => writeOrcaProfile(appData, name, text) };
}

test('removing a primary Claude Code MCP deletes only matching Orca residue', async t => {
  const e = orcaRemovalFixture(t);
  const matching = e.write('matching', '{"mcpServers":{"synthetic.owned":{"args":["first","second"],"command":"demo"},"other":{"command":"keep"}},"project":{"ui":true},"large":9007199254740993}');
  const differentText = '{"mcpServers":{"synthetic.owned":{"command":"demo","args":["second","first"]}}}';
  const different = e.write('different', differentText);

  const result = await e.run();

  assert.equal(result.ok, true);
  const { large, ...retained } = JSON.parse(fs.readFileSync(matching, 'utf8'));
  assert.deepEqual(retained, { mcpServers: { other: { command: 'keep' } }, project: { ui: true } });
  assert.match(fs.readFileSync(matching, 'utf8'), /9007199254740993(?:e0)?/);
  assert.equal(fs.readFileSync(different, 'utf8'), differentText);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].summary, /保留/);
  assert.deepEqual(e.load(), []);
});

test('Windows skips unknown, missing and linked Orca profile configuration without warnings', async t => {
  const e = orcaRemovalFixture(t);
  const preserved = ['{invalid', '[]', '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":{"other":{}}}'];
  const files = preserved.map((text, index) => e.write(`profile-${index}`, text));
  const missing = path.join(e.appData, 'orca', 'claude-profiles', 'missing', 'home', '.claude.json');
  fs.mkdirSync(path.dirname(missing), { recursive: true });
  const outsideFile = path.join(e.dir, 'outside', '.claude.json');
  fs.mkdirSync(path.dirname(outsideFile));
  fs.writeFileSync(outsideFile, matchingText);
  const profile = path.join(e.appData, 'orca', 'claude-profiles', 'linked');
  fs.mkdirSync(profile);
  fs.symlinkSync(path.dirname(outsideFile), path.join(profile, 'home'), process.platform === 'win32' ? 'junction' : 'dir');

  const result = await e.run();

  assert.equal(result.ok, true);
  assert.equal(result.warnings, undefined);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), preserved);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), matchingText);
});

test('absent Windows Orca profiles are not created', async t => {
  const e = orcaRemovalFixture(t);
  const result = await e.run();
  assert.equal(result.ok, true);
  assert.equal(result.warnings, undefined);
  assert.equal(fs.existsSync(e.appData), false);
});

test('Windows Orca cleanup ignores relative AppData paths', () => {
  assert.equal(resolveOrcaAppData('win32', { APPDATA: 'relative-roaming' }, os.tmpdir()), null);
});

test('Linux 解除安裝時清理 XDG 設定資料夾下 Orca 帳號中相同的 MCP 殘留', async t => {
  const e = orcaRemovalFixture(t, 'linux');
  const matching = e.write('matching', '{"mcpServers":{"synthetic.owned":{"command":"demo","args":["first","second"]},"other":{"command":"keep"}}}');
  const differentText = '{"mcpServers":{"synthetic.owned":{"command":"custom"}}}';
  const different = e.write('different', differentText);
  const result = await e.run();
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(matching, 'utf8')).mcpServers, { other: { command: 'keep' } });
  assert.equal(fs.readFileSync(different, 'utf8'), differentText);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(fs.readdirSync(e.appData), ['orca']);
  assert.deepEqual(e.load(), []);
});

test('Linux Orca 資料夾取 XDG_CONFIG_HOME，未設定或為相對路徑時用 ~/.config', () => {
  const home = path.join(os.tmpdir(), 'rc-home');
  const config = path.join(os.tmpdir(), 'rc-xdg');
  assert.equal(resolveOrcaAppData('linux', { XDG_CONFIG_HOME: config }, home), config);
  assert.equal(resolveOrcaAppData('linux', {}, home), path.join(home, '.config'));
  assert.equal(resolveOrcaAppData('linux', { XDG_CONFIG_HOME: 'relative' }, home), path.join(home, '.config'));
  assert.equal(resolveOrcaAppData('darwin', { XDG_CONFIG_HOME: config }, home), null);
});

test('macOS leaves Orca profiles untouched', async t => {
  const e = orcaRemovalFixture(t, 'darwin');
  const profile = e.write('account', matchingText);
  const result = await e.run();
  assert.equal(result.ok, true);
  assert.equal(result.warnings, undefined);
  assert.equal(fs.readFileSync(profile, 'utf8'), matchingText);
});

for (const changesAgain of [false, true]) test(`a concurrent Orca edit is retried once (repeated: ${changesAgain})`, async t => {
  const e = orcaRemovalFixture(t);
  const profile = e.write('account', matchingText);
  const readFile = fs.readFileSync;
  let reads = 0;
  const mock = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === profile) {
      reads++;
      if (reads === 2 || (changesAgain && reads === 4)) {
        fs.writeFileSync(profile, JSON.stringify({ ...JSON.parse(matchingText), external: reads }));
      }
    }
    return readFile(file, ...args);
  });
  const result = await e.run();
  mock.mock.restore();
  assert.equal(result.ok, true);
  const after = JSON.parse(fs.readFileSync(profile));
  assert.equal(after.external, changesAgain ? 4 : 2);
  assert.equal(Object.hasOwn(after.mcpServers, mcpId), changesAgain);
  assert.equal(result.warnings?.length ?? 0, changesAgain ? 1 : 0);
  assert.deepEqual(fs.readdirSync(e.appData), ['orca']);
});

test('Orca profile I/O failures leave removal successful and add a warning', async t => {
  const e = orcaRemovalFixture(t);
  const profile = e.write('account', matchingText);
  const readFile = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === profile) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    return readFile(file, ...args);
  });
  const result = await e.run();
  mock.mock.restore();
  assert.equal(result.ok, true);
  assert.match(result.warnings[0].summary, /無法清理/);
  assert.deepEqual(JSON.parse(fs.readFileSync(e.main)).mcpServers, {});
  assert.equal(fs.readFileSync(profile, 'utf8'), matchingText);
});

test('updating a package without its former MCP cleans matching Orca residue and reports customized profiles', { skip: process.platform !== 'win32' }, async t => {
  const packageKey = 'synthetic-update';
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-orca-appdata-'));
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  const manifest = { packageFormatVersion: 1, key: packageKey, name: 'Synthetic', description: 'Synthetic', type: 'mcp', version: '1.0.0',
    contents: [{ id: mcpId, name: 'Synthetic MCP', kind: 'mcp', definition: { command: 'demo', args: ['first', 'second'] } }] };
  const e = await setupMulti(t, { packages: { [packageKey]: {
    '1.0.0': zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Synthetic' }),
    '2.0.0': build(packageKey, '2.0.0')
  } }, workerDeps: { platform: 'win32', env: { APPDATA: appData } } });
  assert.equal((await e.run(packageKey)).ok, true);
  const main = path.join(e.userHome, '.claude.json');
  const matching = writeOrcaProfile(appData, 'matching', fs.readFileSync(main, 'utf8'));
  const editedText = '{"mcpServers":{"synthetic.owned":{"command":"custom"}}}';
  const edited = writeOrcaProfile(appData, 'edited', editedText);
  e.recommend(packageKey, '2.0.0');

  const result = await e.run(packageKey, 'update');

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(matching)).mcpServers, {});
  assert.equal(fs.readFileSync(edited, 'utf8'), editedText);
  assert.equal(result.warnings.length, 1);
});

test('停止管理只清除指定解除安裝失敗位置的收據，保留 Skill、MCP、其他包與專案', async t => {
  const e = fixture(t);
  const skill = e.add('.claude', 'skills/keep', 'SyncTree', 'retain');
  const mcp = e.add('.claude', 'broken.json', 'PatchConfig', '{broken', { contentId: 'owned', ownedConfigFields: ['mcpServers.owned'] });
  const other = e.add('.claude-work', 'broken.json', 'PatchConfig', '{broken');
  const project = { ...skill, scope: 'project', extraFuture: 'retain' };
  const another = { ...skill, packageKey: 'another', normalizedAddress: skill.normalizedAddress + '|another' };
  e.receipts.push(project, another); e.save();
  const failed = await e.run(); assert.equal(failed.failed.length, 2);
  const result = await e.worker.call('rc.install.run', { packageKey: key, action: 'detach', targetIds: [targetId(skill)] });
  assert.equal(result.ok, true); assert.equal(result.succeeded.length, 1);
  assert.deepEqual(result.failed, []); assert.deepEqual(result.backups, []); assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.detached, [{ ...result.succeeded[0], keptPaths: [skill.destinationPath, `${mcp.destinationPath}（MCP：owned）`] }]);
  assert.equal(fs.readFileSync(path.join(skill.destinationPath, 'SKILL.md'), 'utf8'), 'retain');
  assert.equal(fs.readFileSync(mcp.destinationPath, 'utf8'), '{broken');
  assert.equal(e.load().filter(r => r.packageKey === key && r.scope === 'global').length, 1);
  assert.deepEqual(e.load().find(r => r.scope === 'project'), project);
  assert.ok(e.load().some(r => r.packageKey === 'another'));
  assert.deepEqual(e.worker.state.storage.get(`resource-center.lastFailure.${key}`).targets.map(t => t.targetId), [targetId(other)]);
  await e.worker.call('rc.install.run', { packageKey: key, action: 'detach', targetIds: [targetId(other)] });
  assert.equal(e.worker.state.storage.has(`resource-center.lastFailure.${key}`), false);
  const operations = fs.readdirSync(path.join(e.home, 'operations')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(e.home, 'operations', f))));
  const detached = operations.filter(o => fs.readFileSync(o.logPath, 'utf8').includes('keep-and-detach'));
  assert.equal(detached.length, 2); assert.ok(detached.every(o => o.kind === 'remove' && o.state === 'succeeded'));
});

test('停止管理拒絕非解除安裝失敗、未指定、重複與專案目標；鎖定失敗保留收據與失敗紀錄', async t => {
  const e = fixture(t); const r = e.add('.claude', 'skills/keep', 'SyncTree', 'retain'); e.save();
  const id = targetId(r), before = fs.readFileSync(path.join(e.home, 'receipts.json'));
  const detach = targetIds => e.worker.call('rc.install.run', { packageKey: key, action: 'detach', targetIds });
  await assert.rejects(detach([id]), /上一次解除安裝失敗/);
  e.worker.state.storage.set(`resource-center.lastFailure.${key}`, { action: 'install', targets: [{ targetId: id }] });
  await assert.rejects(detach([id]), /上一次解除安裝失敗/);
  e.worker.state.storage.set(`resource-center.lastFailure.${key}`, { action: 'uninstall', targets: [{ targetId: id }] });
  for (const ids of [undefined, [], [id, id], ['unknown'], [id.replace('|global|', '|project|')]]) await assert.rejects(detach(ids), { code: 'invalid_params' });
  const { tryAcquireTargetLock } = await import('../worker/deploy/target-lock.mjs');
  const lock = tryAcquireTargetLock(path.join(e.home, 'locks'), id);
  try { const result = await detach([id]); assert.equal(result.ok, false); assert.equal(result.failed.length, 1); assert.deepEqual(result.detached, []); }
  finally { lock.release(); }
  assert.deepEqual(fs.readFileSync(path.join(e.home, 'receipts.json')), before);
  assert.equal(e.worker.state.storage.get(`resource-center.lastFailure.${key}`).targets.length, 1);
});

test('停止管理的位置不列待補裝；全部停止管理顯示未安裝，重新安裝可管理原位置', async t => {
  const e = await setupMulti(t); await e.run();
  const records = e.receipts(), id = targetId(records.find(r => r.hostId === 'claude-code'));
  e.worker.state.storage.set('resource-center.lastFailure.pkg-a', { action: 'uninstall', targets: [{ targetId: id }] });
  const before = e.market.requests.length;
  await e.run('pkg-a', 'detach', { targetIds: [id] }); assert.equal(e.market.requests.length, before);
  assert.equal((await e.worker.call('rc.catalog.list')).data[0].pendingTargets.count, 0);
  assert.equal((await e.worker.call('rc.package.getDetails', { packageKey: 'pkg-a' })).pendingTargets.count, 0);
  assert.equal((await e.run('pkg-a', 'fillPending')).succeeded.length, 0);
  assert.ok((await e.run()).succeeded.some(t => t.targetId === id));
  const ids = [...new Set(e.receipts().map(targetId))];
  e.worker.state.storage.set('resource-center.lastFailure.pkg-a', { action: 'uninstall', targets: ids.map(targetId => ({ targetId })) });
  await e.run('pkg-a', 'detach', { targetIds: ids });
  const item = (await e.worker.call('rc.catalog.list')).data[0];
  assert.equal(item.installationStatus, 'notInstalled'); assert.equal(item.pendingTargets.count, 0);
});

test('解除安裝所有全域根的 Skill 與檔案，逐欄保留專案收據、設定與秘密，無市集或命令呼叫', async t => {
  const e = fixture(t);
  for (const root of ['.claude', '.claude-work', '.codex', '.codex-work']) {
    e.add(root, 'skills/hello', 'SyncTree', 'skill');
    for (const kind of ['agent', 'prompt', 'command']) e.add(root, `${kind}s/hello.md`, 'WriteFile', kind, { kind });
  }
  const projectRoot = path.join(e.dir, 'project'), projectDestination = path.join(projectRoot, '.claude', 'skills', 'hello');
  fs.mkdirSync(projectDestination, { recursive: true }); fs.writeFileSync(path.join(projectDestination, 'SKILL.md'), 'project skill');
  const project = { ...e.receipts[0], scope: 'project', canonicalRoot: projectRoot, destinationPath: projectDestination, customFutureField: { keep: true }, targetKey: 'preserve-verbatim' };
  e.receipts.push(project); e.save();
  for (const file of ['setup.json', 'setup-state.json', 'setup-root/keep.txt']) {
    fs.mkdirSync(path.dirname(path.join(e.home, file)), { recursive: true }); fs.writeFileSync(path.join(e.home, file), 'retain');
  }
  e.worker.state.secrets.set('synthetic-secret', 'retain-secret');
  const result = await e.run();
  assert.equal(result.ok, true); assert.equal(result.succeeded.length, 4); assert.deepEqual(result.backups, []);
  for (const r of e.receipts.slice(0, -1)) assert.equal(fs.existsSync(r.destinationPath), false);
  assert.deepEqual(e.load(), [project]);
  assert.equal(fs.readFileSync(path.join(projectDestination, 'SKILL.md'), 'utf8'), 'project skill');
  for (const file of ['setup.json', 'setup-state.json', 'setup-root/keep.txt']) assert.equal(fs.readFileSync(path.join(e.home, file), 'utf8'), 'retain');
  assert.equal(e.worker.state.secrets.get('synthetic-secret'), 'retain-secret');
  const operations = fs.readdirSync(path.join(e.home, 'operations')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(e.home, 'operations', f))));
  assert.equal(operations.length, 1); assert.equal(operations[0].kind, 'remove'); assert.equal(operations[0].state, 'succeeded');
  assert.equal(operations[0].packageVersion, '1.0.0'); assert.equal(operations[0].checkpoint, 'removed');
  assert.ok(operations[0].targets.every(t => t.result === 'succeeded'));
  assert.match(fs.readFileSync(operations[0].logPath, 'utf8'), /removal purge: none/);
  await assert.rejects(e.run(), /找不到這個資源包的安裝紀錄/);
});

test('MCP 移除 Codex TOML 節點時保留 BOM、CRLF、註解與其他表格；JSON 保留其他節點', async t => {
  const e = fixture(t);
  const before = '\uFEFF# keep\r\nmodel = "synthetic"\r\n[mcp_servers.owned]\r\ncommand = "remove"\r\n\r\n# unrelated\r\n[mcp_servers.other]\r\ncommand = "keep"\r\n[other]\r\nx = 1\r\n';
  const toml = e.add('.codex', 'config.toml', 'PatchConfig', before, { contentId: 'owned', ownedConfigFields: ['mcp_servers.owned'] });
  for (const root of ['.claude', 'desktop']) {
    const r = e.add(root, root === 'desktop' ? 'claude_desktop_config.json' : 'placeholder.json', 'PatchConfig', '{}', { contentId: 'owned', ownedConfigFields: ['mcpServers.owned'] });
    if (root === '.claude') r.destinationPath = path.join(e.userHome, '.claude.json');
    fs.writeFileSync(r.destinationPath, JSON.stringify({ mcpServers: { owned: { command: 'remove' }, other: { command: 'keep' } }, unrelated: [1, 2] }));
  }
  e.save(); assert.equal((await e.run()).ok, true);
  assert.equal(fs.readFileSync(toml.destinationPath, 'utf8'), '\uFEFF# keep\r\nmodel = "synthetic"\r\n\r\n# unrelated\r\n[mcp_servers.other]\r\ncommand = "keep"\r\n[other]\r\nx = 1\r\n');
  for (const r of e.receipts.slice(1)) assert.deepEqual(JSON.parse(fs.readFileSync(r.destinationPath)), { mcpServers: { other: { command: 'keep' } }, unrelated: [1, 2] });
});

test('本機修改的檔案與 Skill 樹先備份，既有備份永不覆蓋', async t => {
  const e = fixture(t);
  const file = e.add('.claude', 'agents/hello.md', 'WriteFile', 'original');
  const tree = e.add('.codex', 'skills/hello', 'SyncTree', 'original');
  fs.writeFileSync(file.destinationPath, 'local file'); fs.writeFileSync(path.join(tree.destinationPath, 'SKILL.md'), 'local tree');
  const decoys = [];
  for (const r of [file, tree]) for (let i = 0; i < 60; i++) {
    const stamp = newBackupStamp(new Date(Date.now() + i * 1000));
    const dest = r === file ? `${r.destinationPath}.bak-lcaipack-${stamp}`
      : path.join(e.home, 'backups', stamp, 'home', '.codex', 'skills', 'hello');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'existing'); decoys.push(dest);
  }
  e.save(); const result = await e.run(); assert.equal(result.ok, true); assert.equal(result.backups.length, 2);
  for (const b of result.backups) {
    if (b.label === 'Codex') {
      const [stamp, ...source] = path.relative(path.join(e.home, 'backups'), b.backupPath).split(path.sep);
      assert.match(stamp, /^\d{14}$/);
      assert.deepEqual(source, ['home', '.codex', 'skills', 'hello']);
      assert.deepEqual(fs.readdirSync(path.dirname(tree.destinationPath)), []);
    } else {
      assert.match(b.backupPath, /\.bak-lcaipack-\d{14}$/);
      assert.equal(path.dirname(b.backupPath), path.dirname(file.destinationPath));
    }
    assert.equal(decoys.includes(b.backupPath), false);
    assert.equal(fs.readFileSync(b.label === 'Codex' ? path.join(b.backupPath, 'SKILL.md') : b.backupPath, 'utf8'), b.label === 'Codex' ? 'local tree' : 'local file');
  }
  for (const dest of decoys) assert.equal(fs.readFileSync(dest, 'utf8'), 'existing');
});

test('根目錄消失或項目遺失只清收據，不重建根、不改根外 Claude 設定', async t => {
  const e = fixture(t);
  const tree = e.add('.codex', 'skills/hello', 'SyncTree', 'original');
  const mcp = e.add('.claude', 'config.json', 'PatchConfig', '{}', { ownedConfigFields: ['mcpServers.owned'] });
  mcp.destinationPath = path.join(e.userHome, '.claude.json'); fs.writeFileSync(mcp.destinationPath, '{"mcpServers":{"owned":{}}}');
  const missing = e.add('.claude-work', 'agents/missing.md', 'WriteFile', 'missing'); fs.rmSync(missing.destinationPath);
  for (const r of [tree, mcp]) fs.rmSync(r.canonicalRoot, { recursive: true });
  e.save(); const result = await e.run(); assert.equal(result.ok, true); assert.equal(result.succeeded.length, 3); assert.deepEqual(e.load(), []);
  for (const r of [tree, mcp]) assert.equal(fs.existsSync(r.canonicalRoot), false);
  assert.equal(fs.readFileSync(mcp.destinationPath, 'utf8'), '{"mcpServers":{"owned":{}}}');
});

test('同目標先刪檔再遇到損壞設定時完整還原，其他目標成功，重開後 retry 只移除失敗目標', async t => {
  const e = fixture(t);
  const file = e.add('.claude', 'agents/a.md', 'WriteFile', 'restore me');
  const broken = e.add('.claude', 'z.json', 'PatchConfig', '{broken', { ownedConfigFields: ['mcpServers.owned'] });
  fs.writeFileSync(file.destinationPath, 'modified restore me');
  e.add('.codex', 'skills/hello', 'SyncTree', 'remove me'); e.save();
  const result = await e.run(); assert.equal(result.ok, false); assert.equal(result.succeeded.length, 1); assert.equal(result.failed.length, 1);
  assert.equal(fs.readFileSync(file.destinationPath, 'utf8'), 'modified restore me'); assert.equal(fs.readFileSync(broken.destinationPath, 'utf8'), '{broken');
  assert.equal(result.backups.length, 1); assert.equal(fs.readFileSync(result.backups[0].backupPath, 'utf8'), 'modified restore me');
  assert.equal(e.load().length, 2); assert.match(result.failed[0].reason, /解除安裝失敗/);
  assert.equal(e.worker.state.storage.get(`resource-center.lastFailure.${key}`).action, 'uninstall');
  fs.writeFileSync(broken.destinationPath, '{"mcpServers":{"owned":{},"keep":{}}}');
  const worker = startWorker({ state: e.worker.state, deps: { userHome: e.userHome, lcaipackHome: e.home, env: {} } }); t.after(() => worker.dispose());
  const retried = await worker.call('rc.install.run', { packageKey: key, action: 'retry', targetIds: [result.failed[0].targetId] });
  assert.equal(retried.ok, true); assert.equal(retried.succeeded.length, 1); assert.equal(e.worker.state.storage.has(`resource-center.lastFailure.${key}`), false);
  assert.deepEqual(e.load(), []); assert.deepEqual(JSON.parse(fs.readFileSync(broken.destinationPath)), { mcpServers: { keep: {} } });
});

test('解除安裝立即刷新清單、明細、待補裝與更新摘要，移除過程沒有市集呼叫', async t => {
  const e = await setupMulti(t);
  await e.run();
  const receiptFile = path.join(e.lcaipackHome, 'receipts.json');
  const doc = JSON.parse(fs.readFileSync(receiptFile)); doc.receipts.push({ ...doc.receipts[0], scope: 'project', future: 'retain' }); fs.writeFileSync(receiptFile, JSON.stringify(doc));
  e.recommend('pkg-a', '1.1.0');
  assert.equal((await e.worker.call('rc.updates.checkNow')).count, 1);
  const before = e.market.requests.length;
  assert.equal((await e.run('pkg-a', 'uninstall')).ok, true); assert.equal(e.market.requests.length, before);
  assert.equal((await e.worker.call('rc.updates.summary')).count, 0);
  const list = await e.worker.call('rc.catalog.list'); assert.equal(list.data[0].installationStatus, 'notInstalled'); assert.equal(list.data[0].pendingTargets.count, 0);
  const detail = await e.worker.call('rc.package.getDetails', { packageKey: 'pkg-a' }); assert.equal(detail.installationStatus, 'notInstalled'); assert.deepEqual(detail.deployments, []); assert.equal(detail.pendingTargets.count, 0);
  assert.equal((await e.worker.call('rc.updates.checkNow')).count, 0);
});

test('MCP 節點已遺失只清收據，設定檔逐位元保留；損壞 TOML 則失敗並還原', async t => {
  const e = fixture(t);
  const absent = e.add('.claude', 'config.json', 'PatchConfig', '{ "unrelated" : true }\n', { ownedConfigFields: ['mcpServers.owned'] });
  const broken = e.add('.codex', 'config.toml', 'PatchConfig', '[broken', { ownedConfigFields: ['mcp_servers.owned'] });
  e.save(); const result = await e.run();
  assert.equal(result.succeeded.length, 1); assert.equal(result.failed.length, 1);
  assert.equal(fs.readFileSync(absent.destinationPath, 'utf8'), '{ "unrelated" : true }\n');
  assert.equal(fs.readFileSync(broken.destinationPath, 'utf8'), '[broken'); assert.equal(e.load().length, 1);
});

test('拒絕收據越界路徑，該目標內容與收據完整保留', async t => {
  const e = fixture(t);
  const r = e.add('.codex', 'skills/hello', 'SyncTree', 'owned');
  const outside = path.join(e.dir, 'precious'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  e.receipts.push({ ...r, contentId: 'escape', normalizedAddress: r.normalizedAddress + '|escape', destinationPath: outside }); e.save();
  const before = fs.readFileSync(path.join(e.home, 'receipts.json'));
  const result = await e.run(); assert.equal(result.ok, false); assert.match(result.failed[0].detail[0].explanation, /目標根目錄/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep'); assert.equal(fs.readFileSync(path.join(r.destinationPath, 'SKILL.md'), 'utf8'), 'owned');
  assert.deepEqual(fs.readFileSync(path.join(e.home, 'receipts.json')), before);
});

test('golden 收據部署可移除（僅將 fixture 路徑搬到 harness 臨時根）', async t => {
  const e = fixture(t);
  const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/lcaipack-receipts.windows.golden.json', import.meta.url))).receipts.find(r => r.packageKey === 'demo.pkg');
  const local = e.add('.codex', 'skills/hello', 'SyncTree', 'golden deployment');
  e.receipts[0] = { ...golden, canonicalRoot: local.canonicalRoot, destinationPath: local.destinationPath,
    normalizedAddress: local.normalizedAddress, targetKey: `codex|codex-cli|global|${local.canonicalRoot}` };
  e.save(); const result = await e.worker.call('rc.install.run', { packageKey: 'demo.pkg', action: 'uninstall' });
  assert.equal(result.ok, true); assert.equal(result.succeeded.length, 1); assert.equal(result.backups.length, 1);
  assert.equal(fs.existsSync(local.destinationPath), false); assert.deepEqual(e.load(), []);
});

test('TOML 引號節點、子表格與不相關的多行字串完整保留', async t => {
  const e = fixture(t);
  const prefix = '\uFEFFnote = """\r\n[mcp_servers."owned.with.dot"]\r\nkeep this text\r\n"""\r\n';
  const suffix = '# keep comment\r\n[mcp_servers.other]\r\ncommand = "keep"\r\n';
  const r = e.add('.codex', 'config.toml', 'PatchConfig', prefix + '[mcp_servers."owned.with.dot"]\r\ncommand = "remove"\r\n[mcp_servers."owned.with.dot".env]\r\nKEY = "value"\r\n' + suffix,
    { contentId: 'owned.with.dot', ownedConfigFields: ['mcp_servers.owned.with.dot'] });
  e.save(); assert.equal((await e.run()).ok, true); assert.equal(fs.readFileSync(r.destinationPath, 'utf8'), prefix + suffix);
});

test('刪除中途發生 IO 失敗完整還原該目標，其他目標繼續成功', async t => {
  const e = fixture(t);
  const first = e.add('.claude', 'agents/a.md', 'WriteFile', 'first');
  const last = e.add('.claude', 'commands/z.md', 'WriteFile', 'last');
  const other = e.add('.codex', 'skills/hello', 'SyncTree', 'other'); e.save();
  const original = fs.rmSync; let blocked = false;
  t.mock.method(fs, 'rmSync', (dest, ...args) => {
    if (dest === last.destinationPath && !blocked) { blocked = true; throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' }); }
    return original(dest, ...args);
  });
  const result = await e.run(); assert.equal(blocked, true); assert.equal(result.failed.length, 1); assert.equal(result.succeeded.length, 1);
  assert.equal(fs.readFileSync(first.destinationPath, 'utf8'), 'first'); assert.equal(fs.readFileSync(last.destinationPath, 'utf8'), 'last');
  assert.equal(fs.existsSync(other.destinationPath), false); assert.equal(e.load().length, 2);
  assert.equal(result.failed[0].detail[0].code, 'deployment.apply-failed'); assert.match(result.failed[0].detail[0].explanation, /synthetic EACCES/);
});

test('五個位置解除安裝時唯讀 Skill 刪除失敗，內容完整還原應回報已還原', async t => {
  const e = fixture(t);
  const locked = e.add('.claude', 'skills/locked', 'SyncTree', 'locked original');
  const restored = path.join(locked.destinationPath, 'a.md'); fs.writeFileSync(restored, 'restore original');
  for (const root of ['.claude-a', '.claude-b', '.codex', '.codex-a']) e.add(root, 'skills/hello', 'SyncTree', 'remove');
  e.save();
  const before = observeTree(locked.destinationPath).treeSha256;
  const rm = fs.rmSync, copy = fs.copyFileSync;
  const lockedFile = path.join(locked.destinationPath, 'SKILL.md');
  t.mock.method(fs, 'rmSync', (dest, ...args) => {
    if (dest === locked.destinationPath) {
      if (fs.existsSync(restored)) rm(restored);
      throw Object.assign(new Error('檔案正在使用中'), { code: 'EACCES' });
    }
    return rm(dest, ...args);
  });
  t.mock.method(fs, 'copyFileSync', (source, dest, ...args) => {
    if (dest === lockedFile) throw Object.assign(new Error('檔案正在使用中'), { code: 'EACCES' });
    return copy(source, dest, ...args);
  });
  const result = await e.run();
  assert.equal(result.succeeded.length, 4); assert.equal(result.failed.length, 1);
  assert.equal(observeTree(locked.destinationPath).treeSha256, before);
  assert.equal(result.failed[0].reason, '解除安裝失敗，這個位置已還原為原本的內容：檔案正在使用中');
  assert.equal(result.failed[0].detail[0].code, 'deployment.apply-failed');
  assert.doesNotMatch(JSON.stringify(result.failed[0].detail), /寫入失敗|rollback/i);
  assert.equal(e.load().length, 1);
});

test('解除安裝確實未還原時回報殘留路徑，詳細紀錄僅使用解除安裝用語', async t => {
  const e = fixture(t);
  const owned = e.add('.claude', 'skills/locked', 'SyncTree', 'original'); e.save();
  const file = path.join(owned.destinationPath, 'SKILL.md');
  const rm = fs.rmSync, copy = fs.copyFileSync;
  t.mock.method(fs, 'rmSync', (dest, ...args) => {
    if (dest === owned.destinationPath) { fs.writeFileSync(file, 'cannot restore'); throw new Error('檔案正在使用中'); }
    return rm(dest, ...args);
  });
  t.mock.method(fs, 'copyFileSync', (source, dest, ...args) => {
    if (dest === file) throw new Error('檔案正在使用中');
    return copy(source, dest, ...args);
  });
  const result = await e.run();
  assert.equal(result.failed[0].detail[0].code, 'deployment.rollback-failed');
  assert.equal(result.failed[0].reason, `解除安裝失敗，部分內容無法還原：${file}`);
  assert.deepEqual(result.failed[0].detail[0].residualPaths, [file]);
  assert.doesNotMatch(JSON.stringify(result.failed[0].detail), /寫入失敗|rollback(?!-failed)/i);
  assert.equal(e.load().length, 1);
});

test('解除安裝結果優先顯示偵測根的大小寫，偵測不到則保留收據路徑', async t => {
  const e = fixture(t);
  const root = path.join(e.userHome, '.claude-Work'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  const known = e.add('.claude-Work', 'skills/hello', 'SyncTree', 'known');
  const unknown = e.add('.codex-old', 'skills/hello', 'SyncTree', 'unknown');
  e.save(); const result = await e.run();
  assert.equal(result.succeeded.find(t => t.targetId.endsWith(known.canonicalRoot)).rootPath, root);
  assert.equal(result.succeeded.find(t => t.targetId.endsWith(unknown.canonicalRoot)).rootPath, unknown.canonicalRoot);
});

test('停止管理留在原處的路徑也沿用偵測根的大小寫（收據存的是正規化小寫）', async t => {
  const e = fixture(t);
  const root = path.join(e.userHome, '.claude-Work'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  const skill = e.add('.claude-Work', 'skills/Keep', 'SyncTree', 'retain');
  const mcp = e.add('.claude-Work', 'Broken.json', 'PatchConfig', '{broken', { contentId: 'owned', ownedConfigFields: ['mcpServers.owned'] });
  e.save();
  assert.equal((await e.run()).failed.length, 1);
  const result = await e.worker.call('rc.install.run', { packageKey: key, action: 'detach', targetIds: [targetId(skill)] });
  assert.equal(result.detached[0].rootPath, root);
  assert.deepEqual(result.detached[0].keptPaths, [path.join(root, 'skills', 'Keep'), `${path.join(root, 'Broken.json')}（MCP：owned）`]);
  assert.ok(mcp.destinationPath.startsWith(rules.normalize(root)));
});

test('根偵測設定損壞仍可依收據解除安裝並清除略過紀錄', async t => {
  const e = fixture(t); e.add('.claude', 'skills/hello', 'SyncTree', 'remove'); e.save();
  fs.writeFileSync(path.join(e.home, 'config.json'), '{broken');
  e.worker.state.storage.set(`resource-center.lastSkipped.${key}`, { targets: [{ targetId: 'old' }] });
  assert.equal((await e.run()).ok, true);
  assert.equal(e.worker.state.storage.has(`resource-center.lastSkipped.${key}`), false);
});

test('解除安裝快照備份失敗也使用解除安裝與原內容已還原的訊息', async t => {
  const e = fixture(t); const r = e.add('.claude', 'skills/hello', 'SyncTree', 'retain'); e.save();
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, dest, ...args) => {
    if (String(dest).includes('lcaipack-transactions')) throw new Error('無法讀取原檔');
    return copy(source, dest, ...args);
  });
  const result = await e.run();
  assert.equal(result.failed[0].reason, '解除安裝失敗，這個位置已還原為原本的內容：無法讀取原檔');
  assert.equal(fs.readFileSync(path.join(r.destinationPath, 'SKILL.md'), 'utf8'), 'retain');
});

test('停止管理列出的保留路徑每個檔案或資料夾只有一行：同一設定檔的多個 MCP 欄位與伺服器合併成一行', async t => {
  const e = fixture(t);
  const skill = e.add('.claude-work', 'skills/keep', 'SyncTree', 'retain');
  const fields = ['mcpServers.alpha', 'mcpServers.alpha.command', 'mcpServers.alpha.args', 'mcpServers.alpha.env'];
  const a = e.add('.claude-work', 'broken.json', 'PatchConfig', '{broken', { contentId: 'alpha', ownedConfigFields: fields });
  e.receipts.push({ ...a, contentId: 'beta', ownedConfigFields: ['mcpServers.beta', 'mcpServers.beta.command'], normalizedAddress: a.normalizedAddress + '|beta' });
  e.save();
  assert.equal((await e.run()).failed.length, 1);
  const result = await e.worker.call('rc.install.run', { packageKey: key, action: 'detach', targetIds: [targetId(skill)] });
  assert.deepEqual(result.detached[0].keptPaths, [skill.destinationPath, `${a.destinationPath}（MCP：alpha、beta）`]);
});
