// 主要驗收：從面板使用的 worker 請求契約進入，以臨時使用者目錄與合成資源包，
// 依序走完登入、查詢、下載、規劃、確認套用及讀回（對照 LC-AI-Pack GuiPlanSharingTests、PlanConsentRegenerationTests）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker, leakedSecrets } from './harness.mjs';
import { zip } from './zip-fixture.mjs';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const rules = createPathRules();
const pluginVersion = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')).version;
const SKILL = '---\nname: synthetic-hello\ndescription: Synthetic skill\n---\nSay hello.\n';
const manifest = { packageFormatVersion: 1, key: 'synthetic-skill', name: '合成 Skill', type: 'skill', version: '1.0.0',
  description: 'Synthetic', contents: [{ id: 'synthetic-hello', kind: 'skill', path: 'resources/skills/synthetic-hello' }] };
const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# 合成', 'resources/skills/synthetic-hello/SKILL.md': SKILL });

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-install-'));
  const userHome = path.join(dir, 'home');
  const codexRoot = path.join(userHome, '.codex');
  await mkdir(codexRoot, { recursive: true });
  await writeFile(path.join(codexRoot, 'config.toml'), 'model = "synthetic"\n');
  const lcaipackHome = path.join(dir, 'lcaipack');
  const market = await startFakeMarket({ packages: [{ packageKey: 'synthetic-skill', name: '合成 Skill', type: 'skill', description: 'Synthetic', latestReleaseVersion: '1.0.0' }] });
  market.override('GET /api/market/packages/synthetic-skill', () => ({ status: 200, body: { packageKey: 'synthetic-skill', name: '合成 Skill', type: 'skill',
    description: 'Synthetic', recommendedVersion: '1.0.0', versions: [{ version: '1.0.0', isEnabled: true, channel: 'release', status: 'active', hosts: ['codex'], sha256: sha(bytes) }] } }));
  market.override('GET /api/market/packages/synthetic-skill/versions/1.0.0/readme', () => ({ status: 200, body: { readme: '# 合成' } }));
  market.override('GET /api/market/packages/synthetic-skill/versions/1.0.0/download', () => ({ status: 200, raw: bytes, headers: { 'X-Checksum-Sha256': sha(bytes) }, contentType: 'application/zip' }));
  const worker = startWorker({ deps: { lcaipackHome, userHome, env: {} } });
  t.after(async () => { worker.dispose(); await market.close(); await rm(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const destination = path.join(rules.normalize(codexRoot), 'skills', 'synthetic-hello');
  return { dir, userHome, codexRoot, lcaipackHome, market, worker, destination };
}

const planInput = (targetId) => ({ packageKey: 'synthetic-skill', version: '1.0.0', targets: [targetId] });

test('一次確認部署兩個 Codex 根，未勾選根不變，收據逐根記錄正規化落點', async (t) => {
  const e = await setup(t);
  for (const name of ['.codex-work', '.codex-unselected']) {
    await mkdir(path.join(e.userHome, name));
    await writeFile(path.join(e.userHome, name, 'auth.json'), '{}');
  }
  const { targets } = await e.worker.call('rc.deploy.listTargets', {});
  assert.equal(targets.length, 3);
  const selected = targets.filter(t => !t.rootPath.endsWith('.codex-unselected'));
  const ids = selected.map(t => t.id);
  const plan = await e.worker.call('rc.deploy.plan', { ...planInput(ids[0]), targets: ids });
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.canApply, true);
  await assert.rejects(e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [ids[0], ids[0]] }), { code: 'plan_stale' });
  const result = await e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: ids.toReversed() });
  assert.equal(result.status, 'succeeded');
  const receipts = JSON.parse(await readFile(path.join(e.lcaipackHome, 'receipts.json'), 'utf8')).receipts;
  assert.equal(receipts.length, 2);
  for (const target of selected) {
    const destination = path.join(target.canonicalRoot, 'skills', 'synthetic-hello');
    assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), SKILL);
    const receipt = receipts.find(r => r.targetKey === target.id);
    assert.equal(receipt.canonicalRoot, target.canonicalRoot);
    assert.equal(receipt.destinationPath, destination);
  }
  assert.equal(existsSync(path.join(e.userHome, '.codex-unselected', 'skills')), false);
  const again = await e.worker.call('rc.deploy.plan', planInput(ids[0]));
  assert.equal(again.targets.length, 1);
  assert.equal(again.targets[0].changes[0].change, 'NoOp');
});

test('首次安裝 Codex Skill：登入、查詢、下載、規劃、確認一次後寫入 Skill 與相容收據並可讀回', async (t) => {
  const e = await setup(t);
  const list = await e.worker.call('rc.catalog.list', {});
  assert.equal(list.data[0].packageKey, 'synthetic-skill');
  const detail = await e.worker.call('rc.package.getDetails', { packageKey: 'synthetic-skill' });
  assert.equal(detail.selectedVersion, '1.0.0');

  const { targets } = await e.worker.call('rc.deploy.listTargets', { packageKey: 'synthetic-skill' });
  assert.equal(targets.length, 1);
  assert.deepEqual([targets[0].hostId, targets[0].surfaceId, targets[0].scope, targets[0].rootPath, targets[0].isPrimary], ['codex', 'codex-cli', 'global', e.codexRoot, true]);
  assert.match(targets[0].label, /Codex/);

  const plan = await e.worker.call('rc.deploy.plan', planInput(targets[0].id));
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.package, { packageKey: 'synthetic-skill', name: '合成 Skill', version: '1.0.0', channel: 'release' });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].id, targets[0].id);
  assert.equal(plan.targets[0].label, targets[0].label);
  assert.deepEqual(plan.targets[0].changes, [{ contentId: 'synthetic-hello', kind: 'skill', change: 'Create', changeLabel: '新增', destinationPath: e.destination, willBackup: false }]);
  assert.equal(existsSync(e.destination), false, '規劃不得寫入');

  const result = await e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [targets[0].id] });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.targets[0].status, 'succeeded');
  assert.equal(await readFile(path.join(e.destination, 'SKILL.md'), 'utf8'), SKILL);

  const receipts = JSON.parse(await readFile(path.join(e.lcaipackHome, 'receipts.json'), 'utf8'));
  assert.equal(receipts.receiptFormatVersion, 1);
  const [r] = receipts.receipts;
  assert.deepEqual([r.packageKey, r.packageVersion, r.contentId, r.canonicalRoot, r.destinationPath, r.clientVersion, r.channel],
    ['synthetic-skill', '1.0.0', 'synthetic-hello', rules.normalize(e.codexRoot), e.destination, pluginVersion, 'release']);
  assert.equal(r.targetKey, targets[0].id);
  assert.equal(await readFile(path.join(e.codexRoot, 'config.toml'), 'utf8'), 'model = "synthetic"\n', '不改動 Codex 設定檔');

  const again = await e.worker.call('rc.deploy.plan', planInput(targets[0].id));
  assert.equal(again.targets[0].changes[0].change, 'NoOp');
  assert.deepEqual(leakedSecrets([...e.worker.state.transcript, ...e.worker.state.logs], ['pw-alice', 'fake-access', 'fake-refresh']), []);
});

test('確認前本機狀態變動時不套用舊計畫，回傳新的部署摘要並要求重新確認', async (t) => {
  const e = await setup(t);
  const { targets } = await e.worker.call('rc.deploy.listTargets', {});
  const plan = await e.worker.call('rc.deploy.plan', planInput(targets[0].id));
  await mkdir(e.destination, { recursive: true });
  await writeFile(path.join(e.destination, 'SKILL.md'), '使用者自己的內容');

  const result = await e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [targets[0].id] });
  assert.equal(result.status, 'stale');
  assert.match(result.message, /重新確認/);
  assert.notEqual(result.plan.planDigest, plan.planDigest);
  // 工項 11：未受管的同名內容改為自動備份後套用（ADR 0002）；新摘要揭露備份，仍須重新確認。
  assert.equal(result.plan.canApply, true);
  assert.ok(result.plan.targets[0].problems.some(p => p.code === 'deployment.unmanaged-collision' && p.severity === 'Warning'));
  assert.equal(result.plan.targets[0].changes[0].willBackup, true);
  assert.equal(await readFile(path.join(e.destination, 'SKILL.md'), 'utf8'), '使用者自己的內容');
  assert.equal(existsSync(path.join(e.lcaipackHome, 'receipts.json')), false);
  await assert.rejects(e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [targets[0].id] }), { code: 'plan_stale' });
});

test('套用綁定使用者確認的計畫與目標集合；未審核的摘要或不同目標一律拒絕且零寫入', async (t) => {
  const e = await setup(t);
  const { targets } = await e.worker.call('rc.deploy.listTargets', {});
  const plan = await e.worker.call('rc.deploy.plan', planInput(targets[0].id));
  await assert.rejects(e.worker.call('rc.deploy.apply', { planDigest: 'f'.repeat(64), targets: [targets[0].id] }), { code: 'plan_stale' });
  await assert.rejects(e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [] }), { code: 'plan_stale' });
  await assert.rejects(e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: ['codex|codex-cli|global|x'] }), { code: 'plan_stale' });
  assert.equal(existsSync(e.destination), false);
  const ok = await e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [targets[0].id] });
  assert.equal(ok.status, 'succeeded');
});

test('寫入失敗時回報原因、保留原狀態，不留下指向新版的部署收據', async (t) => {
  const e = await setup(t);
  const { targets } = await e.worker.call('rc.deploy.listTargets', {});
  const plan = await e.worker.call('rc.deploy.plan', planInput(targets[0].id));
  await writeFile(path.join(e.codexRoot, 'skills'), '佔用');
  const result = await e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: [targets[0].id] });
  assert.equal(result.status, 'failed');
  assert.equal(result.targets[0].status, 'rolledBack');
  assert.match(result.targets[0].problems[0].summary, /已完整還原/);
  assert.equal(existsSync(path.join(e.lcaipackHome, 'receipts.json')), false);
  assert.equal(await readFile(path.join(e.codexRoot, 'skills'), 'utf8'), '佔用');
});

test('沒有偵測到 Codex 根目錄時沒有可選目標，指定不存在的目標被拒絕', async (t) => {
  const e = await setup(t);
  await rm(path.join(e.codexRoot, 'config.toml'));
  assert.deepEqual((await e.worker.call('rc.deploy.listTargets', {})).targets, []);
  await assert.rejects(e.worker.call('rc.deploy.plan', planInput('codex|codex-cli|global|nowhere')), { code: 'invalid_params' });
  await assert.rejects(e.worker.call('rc.deploy.plan', { packageKey: 'synthetic-skill', version: '1.0.0', targets: [] }), { code: 'invalid_params' });
});

test('ZIP 驗證失敗時不產生部署計畫', async (t) => {
  const e = await setup(t);
  const { targets } = await e.worker.call('rc.deploy.listTargets', {});
  e.market.override('GET /api/market/packages/synthetic-skill/versions/1.0.0/download', () => ({ status: 200, raw: Buffer.from('corrupt'), contentType: 'application/zip' }));
  await assert.rejects(e.worker.call('rc.deploy.plan', planInput(targets[0].id)), { code: 'checksum_mismatch' });
  assert.equal(existsSync(e.destination), false);
});

test('指定本機專案範圍：不依賴全域 Codex 根，Skill 與收據只落在專案', async (t) => {
  const e = await setup(t);
  const project = path.join(e.dir, 'Project');
  await mkdir(project);
  await rm(path.join(e.codexRoot, 'config.toml'));
  const selection = { scope: 'project', projectRoot: path.join(project, '.') + path.sep };
  const { targets } = await e.worker.call('rc.deploy.listTargets', selection);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].scope, 'project');
  assert.equal(targets[0].canonicalRoot, rules.normalize(project));
  const input = { ...planInput(targets[0].id), ...selection };
  const plan = await e.worker.call('rc.deploy.plan', input);
  const destination = path.join(rules.normalize(project), '.agents', 'skills', 'synthetic-hello');
  assert.equal(plan.targets[0].changes[0].destinationPath, destination);
  assert.equal(plan.canApply, true);
  assert.equal((await e.worker.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: input.targets })).status, 'succeeded');
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), SKILL);
  const [receipt] = JSON.parse(await readFile(path.join(project, '.lcaipack', 'receipts.json'), 'utf8')).receipts;
  assert.equal(receipt.scope, 'project');
  assert.equal(receipt.canonicalRoot, rules.normalize(project));
  assert.equal(receipt.targetKey, targets[0].id);
  assert.equal(receipt.destinationPath, destination);
  assert.equal(existsSync(path.join(e.lcaipackHome, 'receipts.json')), false);
  assert.equal(existsSync(path.join(e.codexRoot, 'skills')), false);
  for (const bad of [{ scope: 'remote' }, { scope: 'project', projectRoot: 1 }, { scope: 'project', projectRoot: 'relative' }, { scope: 'project', projectRoot: path.join(project, 'missing') }, { scope: 'project', projectRoot: e.destination }]) {
    await assert.rejects(e.worker.call('rc.deploy.listTargets', bad), { code: 'invalid_params' });
  }
  await assert.rejects(e.worker.call('rc.deploy.plan', { ...input, targets: ['codex|codex-cli|global|elsewhere'] }), { code: 'invalid_params' });
});

test('偵測沿用 LC-AI-Pack 增列與排除：環境來源優先、正規化去重、不遞迴、不建立缺失根', async (t) => {
  const e = await setup(t);
  const manual = path.join(e.dir, 'outside', '.codex');
  const active = path.join(e.userHome, '.codex-active');
  const nested = path.join(e.userHome, '.codex-worktrees', 'nested');
  for (const root of [manual, active, nested, path.join(e.userHome, '.codex.bak-lcaipack-123')]) {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'config.toml'), '');
  }
  await mkdir(path.join(e.lcaipackHome), { recursive: true });
  const missing = path.join(e.dir, 'missing');
  await writeFile(path.join(e.lcaipackHome, 'config.json'), JSON.stringify({ manualClientRoots: { codex: [manual, active, missing] }, excludedClientRoots: { codex: [e.codexRoot] } }));
  const worker = startWorker({ deps: { userHome: e.userHome, lcaipackHome: e.lcaipackHome, env: { CODEX_HOME: active + path.sep } } });
  t.after(() => worker.dispose());
  const { targets } = await worker.call('rc.deploy.listTargets', {});
  assert.deepEqual(targets.map(t => [t.canonicalRoot, t.origin]), [[rules.normalize(manual), 'ManualInclude'], [rules.normalize(active), 'ConfigDirEnvironment']]);
  assert.equal(new Set(targets.map(t => t.id)).size, 2);
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(path.join(e.userHome, '.codex-worktrees', 'config.toml')), false);
  await writeFile(path.join(e.lcaipackHome, 'config.json'), JSON.stringify({ manualClientRoots: { codex: [manual] }, excludedClientRoots: { codex: [manual, active] } }));
  assert.deepEqual((await worker.call('rc.deploy.listTargets', {})).targets.map(t => t.canonicalRoot), [rules.normalize(e.codexRoot)]);
});
