// 從資料夾安裝（開發中版本）：預檢、打包、一鍵規劃、收據（對照 LC-AI-Pack LocalSourceReceiptFieldTests）、
// 本機開發中清單、資源中心卡片的開發中版本、改用市集版、待補裝依來源 manifest 與補裝從來源重新打包。
// 全部是合成資料；來源資料夾、家目錄與暫存目錄都在測試臨時目錄。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { zip } from './zip-fixture.mjs';
import { memoryStore } from './fake-secret-store.mjs';
import { INSTALL_REPORTS_KEY } from '../worker/install-reports.mjs';

const KEY = 'example.dev-bundle';
const SKILL = name => `---\nname: ${name}\ndescription: Synthetic\n---\nHello ${name}\n`;
const setup = {
  parameters: [{ parameterId: 'endpoint', label: '服務網址', type: 'string', required: true },
    { parameterId: 'token', label: '權杖', type: 'secret', secretUsage: 'setup-time', required: true }],
  commands: [{ commandId: 'init', name: '準備環境', runner: 'powershell', script: 'setup/init.ps1' }]
};
const contents = (extra = []) => [{ id: 'hello', kind: 'skill', path: 'skills/hello' },
  { id: 'echo', name: 'Echo', kind: 'mcp', definition: { transport: 'stdio', command: 'echo', args: ['hello'] } }, ...extra];
const manifestOf = ({ version = '0.1.0', name = '開發中合成包', extra = [], withSetup = true } = {}) =>
  ({ packageFormatVersion: 1, key: KEY, name, type: 'bundle', version, description: '合成測試資料', contents: contents(extra), ...(withSetup ? { setup } : {}) });

function writeSource(folder, options = {}) {
  const write = (name, text) => { const file = path.join(folder, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write('lcpack.json', `// 開發中\n${JSON.stringify(manifestOf(options), null, 2)}\n`);
  write('README.md', '# 合成\n');
  write('skills/hello/SKILL.md', SKILL('hello'));
  write('setup/init.ps1', 'exit 0\n');
  for (const c of options.extra ?? []) if (c.kind === 'skill') write(`${c.path}/SKILL.md`, SKILL(c.id));
  return write;
}

async function environment(t, { marketVersions = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sideload-'));
  const userHome = path.join(dir, 'user'), lcaipackHome = path.join(dir, 'shared'), tempRoot = path.join(dir, 'tmp');
  const source = path.join(dir, 'src', 'dev-bundle');
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = name => { const p = path.join(userHome, name); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, name.startsWith('.codex') ? 'config.toml' : 'settings.json'), ''); return p; };
  root('.codex'); root('.claude');
  const write = writeSource(source);
  const executions = [];
  const control = { failCommands: false };
  const market = await startFakeMarket();
  const installs = [];
  if (marketVersions) {
    const built = marketVersions.map(version => {
      const bytes = zip({ 'lcpack.json': JSON.stringify(manifestOf({ version, name: '市集合成包', withSetup: false })), 'README.md': '# 市集', 'skills/hello/SKILL.md': SKILL('hello') });
      return { version, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), hosts: ['codex', 'claude-code'], isEnabled: true, channel: 'release' };
    });
    const latest = marketVersions.at(-1);
    market.override('GET /api/market/packages', () => ({ status: 200, body: { data: [{ packageKey: KEY, name: '市集合成包', type: 'bundle', latestReleaseVersion: latest }], meta: { total: 1 } } }));
    market.override(`GET /api/market/packages/${KEY}`, () => ({ status: 200, body: { packageKey: KEY, name: '市集合成包', type: 'bundle', recommendedVersion: latest, versions: built.map(({ bytes, ...v }) => v) } }));
    for (const v of built) {
      market.override(`GET /api/market/packages/${KEY}/versions/${v.version}/download`, () => ({ status: 200, raw: v.bytes, contentType: 'application/zip' }));
      market.override(`GET /api/market/packages/${KEY}/versions/${v.version}/readme`, () => ({ status: 200, body: { readme: '# 市集' } }));
      market.override(`POST /api/market/packages/${KEY}/versions/${v.version}/installs`, (_req, body) => { installs.push(body); return { status: 200, body: { installCount: installs.length } }; });
    }
  }
  const secretStore = memoryStore();
  const worker = startWorker({ deps: { userHome, lcaipackHome, env: {}, secretStore, tempRoot,
    runners: { resolve: runner => ({ runner, executable: '/fake/powershell', leadingArguments: [] }) },
    setupEnvironment: { operatingSystem: 'windows', architecture: 'x64' },
    commandExecutor: { run: async request => { executions.push(request); return control.failCommands
      ? { succeeded: false, outcome: 'Failed', exitCode: 17, durationMs: 1, failureSummary: '合成失敗' } : { succeeded: true, outcome: 'succeeded', exitCode: 0 }; } } } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const receiptsText = () => { try { return fs.readFileSync(path.join(lcaipackHome, 'receipts.json'), 'utf8'); } catch { return ''; } };
  const receipts = () => receiptsText() ? JSON.parse(receiptsText()).receipts : [];
  const temps = () => fs.readdirSync(tempRoot);
  const prepare = (folder = source) => worker.call('rc.dev.install.prepare', { folder });
  const run = input => worker.call('rc.install.run', { packageKey: KEY, ...input });
  // 面板流程：填寫設定參數（帶 planId）→ 按「安裝」；設定改變計畫後若仍有例外，再確認一次。
  async function install(review, { values = { endpoint: 'https://synthetic.example.invalid' }, secrets = { token: 'canary-sideload-token' } } = {}) {
    if (review.plan.missingParameters.length) await worker.call('rc.install.saveSetup', { packageKey: KEY, planId: review.planId, values, secrets });
    let result = await run({ action: 'install', confirmedPlanId: review.planId });
    if (result.needsConfirmation) result = await run({ action: 'install', confirmedPlanId: result.planId });
    return result;
  }
  const list = async input => (await worker.call('rc.catalog.list', input ?? {})).data;
  return { dir, userHome, lcaipackHome, tempRoot, source, write, root, market, installs, worker, secretStore, executions, control, receipts, receiptsText, temps, prepare, run, install, list };
}

test('預檢有阻擋項時只回傳阻擋清單，不打包也不規劃', async t => {
  const e = await environment(t);
  fs.rmSync(path.join(e.source, 'README.md'));
  const result = await e.prepare();
  assert.equal(result.precheckFailed, true);
  assert.ok(result.blocking.some(b => b.path === 'README.md'));
  assert.equal(result.summary.key, KEY);
  assert.equal(result.planId, undefined);
  assert.deepEqual(e.temps(), []);
  assert.deepEqual(e.receipts(), []);
  await assert.rejects(e.worker.call('rc.dev.install.prepare', { folder: 'relative/path' }), { code: 'invalid_params' });
});

test('一律先回傳摘要；設定參數與命令在同一份確認，套用後收據為本機來源且不送回報', async t => {
  const e = await environment(t, { marketVersions: ['0.0.9'] });
  const review = await e.prepare();
  assert.equal(review.needsConfirmation, true);
  assert.deepEqual(review.reasons, ['missingParameters', 'setupCommands']);
  assert.deepEqual(review.plan.missingParameters.map(p => p.parameterId), ['endpoint', 'token']);
  assert.equal(review.plan.setupCommands[0].name, '準備環境');
  assert.deepEqual(review.tools, [{ hostId: 'codex', label: 'Codex' }, { hostId: 'claude-code', label: 'Claude Code' }]);
  assert.equal(review.replacesMarketVersion, null);
  assert.equal(review.packageKey, KEY); assert.equal(review.version, '0.1.0'); assert.equal(review.sourcePath, e.source);
  assert.equal(review.summary.name, '開發中合成包'); assert.equal(review.summary.contentCounts.mcp, 1);
  assert.equal(e.temps().length, 1);
  assert.ok(e.temps()[0].startsWith('lcaipack-sideload-'));
  assert.equal(e.executions.length, 0);
  assert.deepEqual(e.receipts(), []);

  const result = await e.install(review);
  assert.equal(result.ok, true);
  assert.deepEqual(result.succeeded.map(t => t.hostId).sort(), ['claude-code', 'codex', 'codex']);
  assert.equal(e.executions.length, 1);
  assert.deepEqual(e.temps(), [], '暫存 ZIP 在完成後刪除');
  const receipts = e.receipts();
  assert.ok(receipts.length > 0);
  // LocalSourceReceiptFieldTests 黃金值：source 為 "local"、sourcePath 原樣記錄；channel 為空字串（SideloadInstallViewModel channel: ""）。
  for (const r of receipts) { assert.equal(r.source, 'local'); assert.equal(r.sourcePath, e.source); assert.equal(r.channel, ''); assert.equal(r.packageVersion, '0.1.0'); }
  assert.match(e.receiptsText(), /"source": "local"/);
  assert.equal(e.installs.length, 0);
  assert.equal(e.worker.state.storage.get(INSTALL_REPORTS_KEY)?.items?.length ?? 0, 0);
  assert.ok(fs.existsSync(path.join(e.userHome, '.claude', 'skills', 'hello', 'SKILL.md')));
  assert.ok([...e.secretStore.values.values()].includes('canary-sideload-token'));
  assert.ok(!e.worker.state.transcript.join('\n').includes('canary-sideload-token'));
});

test('關閉確認畫面時丟棄計畫並刪除暫存 ZIP；記住上次的資料夾', async t => {
  const e = await environment(t);
  assert.deepEqual(await e.worker.call('rc.dev.install.lastFolder'), { folder: null });
  const review = await e.prepare();
  assert.equal(e.temps().length, 1);
  assert.deepEqual(await e.worker.call('rc.install.discard', { planId: review.planId }), { discarded: true });
  assert.deepEqual(e.temps(), []);
  assert.deepEqual(await e.worker.call('rc.install.discard', { planId: review.planId }), { discarded: false });
  await assert.rejects(e.run({ action: 'install', confirmedPlanId: review.planId }), { code: 'plan_stale' });
  assert.deepEqual(await e.worker.call('rc.dev.install.lastFolder'), { folder: e.source });
  // 同一資源包重新預檢時，前一份尚未確認的計畫失效並刪除暫存 ZIP。
  const first = await e.prepare();
  const second = await e.prepare();
  assert.equal(e.temps().length, 1);
  await assert.rejects(e.run({ action: 'install', confirmedPlanId: first.planId }), { code: 'plan_stale' });
  assert.equal((await e.install(second)).ok, true);
  assert.deepEqual(e.temps(), []);
});

test('取代已安裝的市集版時提示版號；同一個開發中版本重新安裝不提示', async t => {
  const e = await environment(t, { marketVersions: ['0.0.9'] });
  assert.equal((await e.run({ action: 'install' })).ok, true);
  assert.ok(e.receipts().every(r => r.source === undefined && r.channel === 'release'));
  const review = await e.prepare();
  assert.equal(review.replacesMarketVersion, '0.0.9');
  assert.equal((await e.install(review)).ok, true);
  assert.ok(e.receipts().every(r => r.source === 'local' && r.packageVersion === '0.1.0'));
  const again = await e.worker.call('rc.dev.reinstallLocal', { packageKey: KEY });
  assert.equal(again.replacesMarketVersion, null);
  assert.equal(again.needsConfirmation, true);
  assert.deepEqual(again.reasons, [], '設定參數已儲存、命令已完成時只剩摘要確認');
  assert.equal((await e.run({ action: 'install', confirmedPlanId: again.planId })).ok, true);
  assert.equal(e.installs.length, 1, '只有市集安裝送出回報');
});

test('本機開發中清單讀來源 lcpack.json；來源資料夾不存在時只能解除安裝', async t => {
  const e = await environment(t);
  assert.deepEqual(await e.worker.call('rc.dev.listLocal'), { packages: [] });
  assert.equal((await e.install(await e.prepare())).ok, true);
  assert.deepEqual(await e.worker.call('rc.dev.listLocal'), { packages: [{ packageKey: KEY, name: '開發中合成包', version: '0.1.0', sourcePath: e.source,
    sourceExists: true, tools: [{ hostId: 'codex', label: 'Codex' }, { hostId: 'claude-code', label: 'Claude Code' }] }] });
  fs.renameSync(e.source, `${e.source}-moved`);
  const [local] = (await e.worker.call('rc.dev.listLocal')).packages;
  assert.equal(local.name, KEY); assert.equal(local.sourceExists, false);
  await assert.rejects(e.worker.call('rc.dev.reinstallLocal', { packageKey: KEY }), { code: 'source_missing' });
  await assert.rejects(e.worker.call('rc.dev.reinstallLocal', { packageKey: 'example.other' }), { code: 'invalid_params' });
  const removed = await e.run({ action: 'uninstall' });
  assert.equal(removed.ok, true);
  assert.deepEqual(e.receipts(), []);
  assert.deepEqual(await e.worker.call('rc.dev.listLocal'), { packages: [] });
});

test('資源中心卡片：開發中版本不算可更新，市集有此資源包時可改用市集版，覆蓋後收據回到市集語意', async t => {
  const e = await environment(t, { marketVersions: ['0.0.9', '0.2.0'] });
  assert.equal((await e.install(await e.prepare())).ok, true);
  const [card] = await e.list();
  assert.equal(card.devVersion, '0.1.0'); assert.equal(card.devSourceExists, true); assert.equal(card.devSourcePath, e.source);
  assert.equal(card.canSwitchToMarket, true);
  assert.equal(card.installationStatus, 'current');
  assert.ok(card.deployments.every(d => d.source === 'local' && d.updateVersion === null));
  assert.equal(card.pendingTargets.count, 0); assert.equal(card.fillUnavailableReason, null);
  assert.deepEqual(await e.list({ installation: 'updates' }), []);
  assert.equal((await e.worker.call('rc.updates.checkNow')).count, 0);
  assert.equal((await e.run({ action: 'update' })).succeeded.length, 0, '更新不動開發中版本');
  const switched = await e.run({ action: 'install' });
  assert.equal(switched.ok, true);
  assert.ok(e.receipts().every(r => r.packageVersion === '0.2.0' && r.channel === 'release' && r.source === undefined));
  assert.doesNotMatch(e.receiptsText(), /"source"|"sourcePath"/);
  const [after] = await e.list();
  assert.equal(after.devVersion, null); assert.equal(after.canSwitchToMarket, false);
  assert.equal(e.installs.length, 1);
});

test('市集沒有此資源包時只出現在「已安裝」篩選，名稱讀來源 lcpack.json', async t => {
  const e = await environment(t);
  assert.equal((await e.install(await e.prepare())).ok, true);
  assert.deepEqual(await e.list(), []);
  const [card] = await e.list({ installation: 'installed' });
  assert.equal(card.packageKey, KEY); assert.equal(card.name, '開發中合成包'); assert.equal(card.type, 'bundle');
  assert.equal(card.devVersion, '0.1.0'); assert.equal(card.canSwitchToMarket, false);
  assert.equal(card.statusHint, '市集上沒有這個資源包');
  // 與從資料夾安裝相同：所有支援的 AI 工具；含 MCP 時列入 Claude Desktop（此環境未偵測到，未部署）。
  assert.deepEqual(card.tools.map(tool => [tool.hostId, tool.deployed]), [['codex', true], ['claude-code', true], ['claude-desktop', false]]);
  assert.equal((await e.list({ installation: 'installed', search: '開發中' })).length, 1);
  assert.equal((await e.list({ installation: 'installed', type: 'skill' })).length, 0);
  const detail = await e.worker.call('rc.package.getDetails', { packageKey: KEY });
  assert.equal(detail.devVersion, '0.1.0');
});

test('待補裝依來源 lcpack.json 判斷；補裝從來源資料夾重新打包並寫入本機來源收據', async t => {
  const e = await environment(t);
  assert.equal((await e.install(await e.prepare())).ok, true);
  let [card] = await e.list({ installation: 'installed' });
  assert.equal(card.pendingTargets.count, 0);
  // 來源新增一個 Skill：收據推算不出缺少內容，來源 manifest 才看得到（對照 RootContent）。
  e.write('lcpack.json', JSON.stringify(manifestOf({ extra: [{ id: 'extra', kind: 'skill', path: 'skills/extra' }] })));
  e.write('skills/extra/SKILL.md', SKILL('extra'));
  [card] = await e.list({ installation: 'installed' });
  assert.deepEqual(card.pendingTargets.targets.map(target => target.hostId), ['claude-code']);
  let fill = await e.run({ action: 'fillPending' });
  if (fill.needsConfirmation) fill = await e.run({ action: 'fillPending', confirmedPlanId: fill.planId });
  assert.equal(fill.ok, true); assert.equal(fill.succeeded.length, 1);
  assert.ok(fs.existsSync(path.join(e.userHome, '.claude', 'skills', 'extra', 'SKILL.md')));
  const extra = e.receipts().filter(r => r.contentId === 'extra');
  assert.ok(extra.length && extra.every(r => r.source === 'local' && r.sourcePath === e.source && r.channel === ''));
  assert.deepEqual(e.temps(), []);
  assert.equal((await e.list({ installation: 'installed' }))[0].pendingTargets.count, 0);
  // 新出現的 AI 工具根目錄同樣可補裝。
  e.root('.claude-work');
  [card] = await e.list({ installation: 'installed' });
  assert.equal(card.pendingTargets.count, 1);
  fill = await e.run({ action: 'fillPending' });
  if (fill.needsConfirmation) fill = await e.run({ action: 'fillPending', confirmedPlanId: fill.planId });
  assert.equal(fill.ok, true);
  assert.ok(fs.existsSync(path.join(e.userHome, '.claude-work', 'skills', 'extra', 'SKILL.md')));
  assert.equal(e.installs.length, 0);
});

test('來源資料夾不存在時卡片標記無法補裝，補裝回錯誤', async t => {
  const e = await environment(t);
  assert.equal((await e.install(await e.prepare())).ok, true);
  fs.renameSync(e.source, `${e.source}-moved`);
  e.root('.claude-work');
  const [card] = await e.list({ installation: 'installed' });
  assert.equal(card.devSourceExists, false);
  assert.equal(card.pendingTargets.count, 1, '來源讀不到時以同版本收據判斷待補裝');
  assert.match(card.fillUnavailableReason, /來源資料夾已不存在/);
  await assert.rejects(e.run({ action: 'fillPending' }), { code: 'source_missing' });
  assert.deepEqual(e.temps(), []);
});

test('來源識別碼改變時補裝回錯誤，不安裝另一個資源包', async t => {
  const e = await environment(t);
  assert.equal((await e.install(await e.prepare())).ok, true);
  e.write('lcpack.json', JSON.stringify({ ...manifestOf(), key: 'example.renamed' }));
  e.root('.claude-work');
  await assert.rejects(e.run({ action: 'fillPending' }), { code: 'invalid_params', message: /example\.renamed/ });
  assert.deepEqual(e.temps(), []);
  assert.ok(e.receipts().every(r => r.packageKey === KEY));
});

test('開發中版本的失敗重試、設定參數與重新套用都從來源資料夾重新打包，不向市集下載', async t => {
  const e = await environment(t, { marketVersions: ['0.1.0'] });
  e.market.override(`GET /api/market/packages/${KEY}/versions/0.1.0/download`, () => ({ status: 500, body: { detail: '開發中版本不應下載市集 ZIP' } }));
  e.control.failCommands = true;
  const failed = await e.install(await e.prepare());
  assert.equal(failed.ok, false);
  assert.ok(failed.failed.length > 0);
  assert.deepEqual(e.receipts(), []);
  assert.deepEqual(e.temps(), []);
  e.control.failCommands = false;
  const retryInput = { action: 'retry', targetIds: failed.failed.map(t => t.targetId) };
  let retry = await e.run(retryInput);
  if (retry.needsConfirmation) retry = await e.run({ ...retryInput, confirmedPlanId: retry.planId });
  assert.equal(retry.ok, true);
  assert.ok(e.receipts().length && e.receipts().every(r => r.source === 'local' && r.sourcePath === e.source && r.channel === ''));
  const parameters = (await e.worker.call('rc.install.saveSetup', { packageKey: KEY, values: { endpoint: 'https://changed.example.invalid' } })).parameters;
  assert.equal(parameters.find(p => p.parameterId === 'endpoint').value, 'https://changed.example.invalid');
  let reapply = await e.run({ action: 'reapply' });
  if (reapply.needsConfirmation) reapply = await e.run({ action: 'reapply', confirmedPlanId: reapply.planId });
  assert.equal(reapply.ok, true);
  assert.ok(e.receipts().every(r => r.source === 'local' && r.sourcePath === e.source));
  assert.deepEqual(e.temps(), []);
  assert.equal(e.installs.length, 0);
});
