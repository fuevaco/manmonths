// 工項 12：安裝回報的端到端行為（對照 GuiRegistryInstallReportingTests、CliInstallReports 的 D7 規則）。
// 從面板使用的 worker 請求契約進入，假市集記錄收到的 POST …/installs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { setupMulti } from './multi-env.mjs';
import { leakedSecrets } from './harness.mjs';
import { INSTALL_REPORTS_KEY } from '../worker/install-reports.mjs';

const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await delay(10); } return false; };
const pending = (e) => Object.values(e.worker.state.storage.get(INSTALL_REPORTS_KEY)?.entries ?? {});
const pluginVersion = JSON.parse((await import('node:fs')).readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')).version;

async function blockedClaudeWork(t, packages = { 'pkg-a': ['1.0.0', '1.1.0'], 'pkg-b': ['1.0.0'] }) {
  const e = await setupMulti(t, { packages });
  const targets = await e.targets();
  const first = await e.plan('pkg-a', '1.0.0', [targets.claudeWork.id]);
  assert.equal((await e.apply(first, [targets.claudeWork.id])).status, 'succeeded');
  assert.ok(await until(() => e.installs.length === 1), '第一次安裝已回報');
  e.installs.length = 0;
  return { e, targets, ids: [targets.codex.id, targets.claude.id, targets.claudeWork.id] };
}

test('部分成功後回報：只含實際成功的位置，受阻的目標不計；內容不含路徑、秘密或本機帳戶', async (t) => {
  const { e, ids } = await blockedClaudeWork(t);
  const summary = await e.plan('pkg-b', '1.0.0', ids);
  const result = await e.apply(summary, ids);
  assert.equal(result.status, 'partial');

  assert.ok(await until(() => e.installs.length === 1));
  const [sent] = e.installs;
  assert.deepEqual([sent.key, sent.version], ['pkg-b', '1.0.0']);
  assert.deepEqual(Object.keys(sent.body).sort(), ['action', 'channel', 'clientProduct', 'clientVersion', 'fromVersion', 'installedAt', 'operationId', 'platforms', 'scope']);
  assert.deepEqual([sent.body.action, sent.body.fromVersion, sent.body.scope, sent.body.channel, sent.body.clientProduct, sent.body.clientVersion],
    ['install', null, 'global', 'release', 'gui', pluginVersion]);
  assert.equal(sent.body.operationId, result.operation.id);
  assert.deepEqual(sent.body.platforms.map(p => `${p.hostId}/${p.surfaceId}`).sort(), ['claude-code/claude-code-cli', 'codex/codex-cli']);
  assert.ok(Number.isFinite(Date.parse(sent.body.installedAt)));
  const text = JSON.stringify(sent.body);
  assert.equal(text.includes(e.userHome), false);
  assert.equal(text.includes('alice'), false);
  assert.deepEqual(leakedSecrets([text], ['pw-alice', 'fake-access', 'fake-refresh']), []);
  assert.ok(await until(() => pending(e).length === 0), '送出成功後待送項目已刪除');
});

test('更新：回報 update 與 fromVersion（Apply 前同一資源的其他市集版本）', async (t) => {
  const { e, ids } = await blockedClaudeWork(t);
  const install = await e.plan('pkg-b', '1.0.0', ids.slice(0, 2));
  assert.equal((await e.apply(install, ids.slice(0, 2))).status, 'succeeded');
  assert.ok(await until(() => e.installs.length === 1));
  e.installs.length = 0;

  const update = await e.plan('pkg-a', '1.1.0', [ids[2]], { action: 'update' });
  assert.equal((await e.apply(update, [ids[2]])).status, 'succeeded');
  assert.ok(await until(() => e.installs.length === 1));
  assert.deepEqual([e.installs[0].key, e.installs[0].version, e.installs[0].body.action, e.installs[0].body.fromVersion], ['pkg-a', '1.1.0', 'update', '1.0.0']);
});

test('市集暫時無法回應：安裝仍成功、回報留在外掛儲存；下次成功連線時補送一次', async (t) => {
  const { e, ids } = await blockedClaudeWork(t);
  e.market.override('POST /api/market/packages/pkg-b/versions/1.0.0/installs', () => ({ status: 503, body: { title: '暫時無法服務' } }));
  const summary = await e.plan('pkg-b', '1.0.0', ids);
  const result = await e.apply(summary, ids);
  assert.equal(result.status, 'partial');
  assert.ok(await until(() => pending(e).length === 1));
  await delay(50);
  assert.equal(pending(e).length, 1);
  assert.equal(pending(e)[0].operationId, result.operation.id);
  assert.equal(pending(e)[0].account, 'alice');

  // 市集恢復；面板重新讀取連線狀態（成功連線）時補送。
  const sentBefore = e.installs.length;
  e.market.override('POST /api/market/packages/pkg-b/versions/1.0.0/installs', (_req, body) => { e.installs.push({ key: 'pkg-b', version: '1.0.0', body }); return { status: 200, body: { installCount: 1 } }; });
  const state = await e.worker.call('rc.session.getState');
  assert.equal(state.signedIn, true);
  assert.ok(await until(() => pending(e).length === 0));
  assert.equal(e.installs.length - sentBefore, 1);
  assert.equal(e.installs.at(-1).body.operationId, result.operation.id);
});

test('全部目標受阻或沒有任何目標成功時不產生回報', async (t) => {
  const { e, targets } = await blockedClaudeWork(t);
  const blocked = await e.plan('pkg-b', '1.0.0', [targets.claudeWork.id]);
  assert.equal(blocked.canApply, false);
  assert.equal((await e.apply(blocked, [targets.claudeWork.id])).status, 'rejected');
  await delay(100);
  assert.equal(e.installs.length, 0);
  assert.deepEqual(pending(e), []);
});
