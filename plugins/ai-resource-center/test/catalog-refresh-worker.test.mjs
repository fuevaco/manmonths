import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { send } from '../worker/http.mjs';
import { zip } from './zip-fixture.mjs';
import { createHash } from 'node:crypto';

const summary = (packageKey = 'demo', extra = {}) => ({ packageKey, name: packageKey, type: 'skill', latestReleaseVersion: '1.0.0', ...extra });
async function fixture(t, packages = [summary()], deps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-refresh-'));
  const home = path.join(dir, 'state'), userHome = path.join(dir, 'user');
  fs.mkdirSync(home); fs.mkdirSync(userHome);
  const market = await startFakeMarket({ packages });
  const worker = startWorker({ deps: { lcaipackHome: home, userHome, env: {}, platform: 'win32', ...deps } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const save = receipts => fs.writeFileSync(path.join(home, 'receipts.json'), JSON.stringify({ receiptFormatVersion: 1, receipts }));
  const receipt = (extra = {}) => ({ packageKey: 'demo', packageVersion: '1.0.0', kind: 'skill', hostId: 'codex', surfaceId: 'codex-cli', scope: 'global', canonicalRoot: path.join(userHome, '.codex'), ...extra });
  const details = (key = 'demo', versions = [{ version: '1.0.0', channel: 'release', isEnabled: true, hosts: ['codex'] }]) => {
    market.override(`GET /api/market/packages/${key}`, () => ({ status: 200, body: { ...packages.find(p => p.packageKey === key), recommendedVersion: '1.0.0', versions } }));
    for (const v of versions) market.override(`GET /api/market/packages/${key}/versions/${v.version}/readme`, () => ({ status: 200, body: { readme: '' } }));
  };
  return { dir, home, userHome, worker, market, save, receipt, details, packages };
}

test('清單四種排序：缺值最後、同值名稱與識別碼固定升序，採已儲存偏好與 Preview', async t => {
  const e = await fixture(t, [
    summary('z', { name: 'Beta', ownerAdAccount: 'Zulu', installCount: 8, lastUploadedAt: '2026-10-01T00:00:00Z' }),
    summary('a', { name: 'alpha', ownerAdAccount: 'adam', installCount: 8, lastUploadedAt: '2026-11-01T00:00:00Z' }),
    summary('b', { name: 'ALPHA', ownerAdAccount: 'ADAM', installCount: 8, lastUploadedAt: '2026-11-01T00:00:00Z' }),
    summary('n', { name: 'Missing', ownerAdAccount: ' ', installCount: null, latestReleaseVersion: null, latestPreviewVersion: '2.0.0' })
  ]);
  const keys = async input => (await e.worker.call('rc.catalog.list', input)).data.map(p => p.packageKey);
  assert.deepEqual(await keys(), ['a', 'b', 'z', 'n']);
  assert.deepEqual(await keys({ sortField: 'installCount', sortDirection: 'asc' }), ['a', 'b', 'z', 'n']);
  assert.deepEqual(await keys({ sortField: 'name', sortDirection: 'desc' }), ['n', 'z', 'a', 'b']);
  assert.deepEqual(await keys({ sortField: 'owner', sortDirection: 'desc' }), ['z', 'a', 'b', 'n']);
  assert.deepEqual(await keys({ sortField: 'owner', sortDirection: 'asc' }), ['a', 'b', 'z', 'n']);
  assert.deepEqual(await keys({ sortField: 'uploadedAt', sortDirection: 'desc' }), ['a', 'b', 'z', 'n']);
  assert.deepEqual(await keys({ sortField: 'uploadedAt', sortDirection: 'asc' }), ['z', 'a', 'b', 'n']);
  await e.worker.call('rc.preferences.set', { sortField: 'name', sortDirection: 'desc', showPreview: true });
  assert.deepEqual(await keys(), ['n', 'z', 'a', 'b']);
  assert.equal((await e.worker.call('rc.catalog.list')).data[0].latestVisibleVersion, '2.0.0');
  assert.equal((await e.worker.call('rc.catalog.list', { previewMode: false })).data[0].latestVisibleVersion, null);
  for (const input of [{ sortField: 'bad' }, { sortDirection: 'down' }]) await assert.rejects(e.worker.call('rc.catalog.list', input), { code: 'invalid_params' });
});

test('清單與明細只計全域部署，專案收據不列入已安裝篩選', async t => {
  const e = await fixture(t);
  e.details();
  const project = path.join(e.dir, 'project');
  fs.mkdirSync(path.join(project, '.lcaipack'), { recursive: true });
  fs.writeFileSync(path.join(e.home, 'config.json'), JSON.stringify({ registeredProjects: [project] }));
  fs.writeFileSync(path.join(project, '.lcaipack/receipts.json'), JSON.stringify({ receiptFormatVersion: 1, receipts: [e.receipt({ scope: 'project', canonicalRoot: project })] }));
  for (const method of ['rc.catalog.list', 'rc.package.getDetails']) {
    const result = await e.worker.call(method, { packageKey: 'demo' });
    const p = method === 'rc.catalog.list' ? result.data[0] : result;
    assert.equal(p.installationStatus, 'notInstalled');
    assert.deepEqual(p.deployments, []);
  }
  assert.deepEqual((await e.worker.call('rc.catalog.list', { installation: 'installed' })).data, []);
  e.save([e.receipt()]);
  assert.equal((await e.worker.call('rc.package.getDetails', { packageKey: 'demo' })).deployments.length, 1);
});

test('清單與明細區分較新版、下架、已是最新；任一舊目標優先可更新', async t => {
  const e = await fixture(t);
  e.details();
  for (const [version, expected] of [['2.0.0', 'newer'], ['1.0.0', 'current'], ['0.5.0', 'updateAvailable']]) {
    e.save([e.receipt({ packageVersion: version })]);
    assert.equal((await e.worker.call('rc.catalog.list')).data[0].installationStatus, expected);
    assert.equal((await e.worker.call('rc.package.getDetails', { packageKey: 'demo' })).installationStatus, expected);
  }
  e.save([e.receipt({ packageVersion: '2.0.0' }), e.receipt({ packageVersion: '0.5.0', canonicalRoot: path.join(e.userHome, '.codex-other') })]);
  assert.equal((await e.worker.call('rc.catalog.list')).data[0].installationStatus, 'updateAvailable');
  e.packages[0].latestReleaseVersion = null;
  assert.equal((await e.worker.call('rc.catalog.list')).data[0].installationStatus, 'unavailable');
  e.packages.length = 0;
  assert.equal((await e.worker.call('rc.catalog.list', { installation: 'installed' })).data[0].installationStatus, 'unavailable');
  // 版號相等但部署版本不在可見版本集合時也屬已下架。
  e.packages.push(summary());
  e.save([e.receipt({ packageVersion: '1.0.0+old' })]);
  assert.equal((await e.worker.call('rc.package.getDetails', { packageKey: 'demo' })).installationStatus, 'unavailable');
});

test('清單提供卡片欄位、相容工具與全域部署旗標，版本詳情失敗退回本機工具', async t => {
  const e = await fixture(t, [summary('demo', { ownerAdAccount: 'alice', installCount: 12, category: 'Workflow', lastUploadedAt: '2026-11-20T08:00:00+08:00', recommendedVersionHasFullGuide: true }), summary('mcp', { type: 'mcp' }), summary('fallback')]);
  e.details('demo', [{ version: '1.0.0', channel: 'release', isEnabled: true, hosts: ['codex', 'claude-code'] }]);
  e.details('mcp', [{ version: '1.0.0', channel: 'release', isEnabled: true, hosts: ['claude-code'] }]);
  fs.mkdirSync(path.join(e.userHome, '.codex')); fs.writeFileSync(path.join(e.userHome, '.codex/config.toml'), '');
  e.save([e.receipt(), e.receipt({ hostId: 'claude-code', surfaceId: 'claude-desktop', packageKey: 'mcp', kind: 'mcp' })]);
  const rows = (await e.worker.call('rc.catalog.list')).data;
  const demo = rows.find(p => p.packageKey === 'demo');
  assert.deepEqual([demo.owner, demo.installCount, demo.lastUploadedAt, demo.category, demo.hasFullGuide], ['alice', 12, '2026-11-20T00:00:00.000Z', 'Workflow', true]);
  assert.deepEqual(demo.hosts, ['codex', 'claude-code']);
  assert.deepEqual(demo.tools, [{ hostId: 'codex', label: 'Codex', deployed: true }, { hostId: 'claude-code', label: 'Claude Code', deployed: false }]);
  assert.deepEqual(rows.find(p => p.packageKey === 'mcp').tools, [{ hostId: 'claude-code', label: 'Claude Code', deployed: false }, { hostId: 'claude-desktop', label: 'Claude Desktop', deployed: true }]);
  const fallback = rows.find(p => p.packageKey === 'fallback');
  assert.equal(fallback.hosts, null);
  assert.equal(fallback.hasFullGuide, false);
  assert.equal(fallback.lastUploadedAt, null);
  assert.deepEqual(fallback.tools, [{ hostId: 'codex', label: 'Codex', deployed: false }]);
});

test('相容性詳情依 packageKey@version 快取，所有同時清單共用最多四個請求', async t => {
  let active = 0, peak = 0, requests = 0;
  const e = await fixture(t, Array.from({ length: 9 }, (_, i) => summary(`demo-${i}`)), { transport: async req => {
    if (!/\/packages\/demo-\d+$/.test(new URL(req.url).pathname)) return send(req);
    requests++; peak = Math.max(peak, ++active);
    try { await new Promise(resolve => setTimeout(resolve, 15)); return await send(req); }
    finally { active--; }
  } });
  for (const p of e.packages) e.market.override(`GET /api/market/packages/${p.packageKey}`, () => {
    return { status: 200, body: { ...p, versions: [{ version: p.latestReleaseVersion, channel: 'release', isEnabled: true, hosts: ['codex'] }] } };
  });
  const first = await Promise.all([e.worker.call('rc.catalog.list'), e.worker.call('rc.catalog.list')]);
  assert.deepEqual(first[0].data[0].hosts, ['codex']);
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.equal(requests, 9);
  await e.worker.call('rc.catalog.list'); assert.equal(requests, 9);
  e.packages[0].latestReleaseVersion = '1.1.0';
  await e.worker.call('rc.catalog.list'); assert.equal(requests, 10);
});

test('用戶端版本只回傳 Orca 外掛版本，不查詢 LC-AI-Pack 發行資料', async t => {
  const e = await fixture(t);
  const result = await e.worker.call('rc.client.getVersions');
  assert.deepEqual(Object.keys(result), ['orca']);
  assert.equal(result.orca.source, 'plugin');
  assert.equal(e.market.requests.some(r => r.path.includes('/api/market/client/latest')), false);
});

test('收據格式版本不支援時提供可辨識錯誤與友善提示，損壞錯誤維持原樣', async t => {
  const e = await fixture(t);
  e.details();
  const message = '共用資料由較新的 LC-AI-Pack 寫入，請更新 Orca 外掛';
  fs.writeFileSync(path.join(e.home, 'receipts.json'), JSON.stringify({ receiptFormatVersion: 99 }));
  assert.deepEqual((await e.worker.call('rc.catalog.list')).installedError, { code: 'sharedDataTooNew', message });
  assert.deepEqual((await e.worker.call('rc.package.getDetails', { packageKey: 'demo' })).installedError, { code: 'sharedDataTooNew', message });
  await assert.rejects(e.worker.call('rc.catalog.list', { installation: 'installed' }), { code: 'sharedDataTooNew', message });
  assert.ok(e.worker.state.logs.some(l => l.includes('99') && l.includes('receipts.json')));
  fs.writeFileSync(path.join(e.home, 'receipts.json'), '{broken');
  assert.equal((await e.worker.call('rc.catalog.list')).installedError.code, 'receipt_invalid');
});

test('setup 值與完成狀態的格式版本不支援時轉成友善錯誤，原始細節只進 log', async t => {
  const e = await fixture(t);
  fs.mkdirSync(path.join(e.userHome, '.codex')); fs.writeFileSync(path.join(e.userHome, '.codex/config.toml'), '');
  const bytes = zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key: 'demo', name: 'Demo', description: 'Synthetic', type: 'skill', version: '1.0.0',
    contents: [{ id: 'hello', kind: 'skill', path: 'resources/skills/hello' }],
    setup: { parameters: [{ parameterId: 'endpoint', label: 'Endpoint', type: 'string' }], commands: [{ commandId: 'init', name: 'Init', runner: 'bash', script: 'setup/init.sh' }] } }),
    'README.md': '# Demo', 'resources/skills/hello/SKILL.md': '---\nname: hello\ndescription: Synthetic\n---\nHello', 'setup/init.sh': 'echo ok' });
  e.details('demo', [{ version: '1.0.0', channel: 'release', isEnabled: true, hosts: ['codex'], sha256: createHash('sha256').update(bytes).digest('hex') }]);
  e.market.override('GET /api/market/packages/demo/versions/1.0.0/download', () => ({ status: 200, raw: bytes, contentType: 'application/zip' }));
  const input = { packageKey: 'demo', action: 'install' };
  // 基準規劃成功，確保錯誤來自共用檔案格式。
  await e.worker.call('rc.install.run', input);
  for (const name of ['setup.json', 'setup-commands.json']) {
    const file = path.join(e.home, name);
    fs.writeFileSync(file, JSON.stringify({ setupFormatVersion: 99 }));
    await assert.rejects(e.worker.call('rc.install.run', input), { code: 'sharedDataTooNew', message: '共用資料由較新的 LC-AI-Pack 寫入，請更新 Orca 外掛' });
    assert.ok(e.worker.state.logs.some(l => l.includes('99') && l.includes(name)));
    fs.writeFileSync(file, '{broken');
    await assert.rejects(e.worker.call('rc.install.run', input), { code: 'setup_invalid' });
    fs.unlinkSync(file);
  }
});

test('bundle 工具摘要僅在驗證過的確切 ZIP 含 MCP 時列入 Claude Desktop', async t => {
  const e = await fixture(t, [summary('with-mcp', { type: 'bundle' }), summary('without-mcp', { type: 'bundle' })]);
  for (const key of ['with-mcp', 'without-mcp']) {
    const contents = [{ id: 'hello', kind: 'skill', path: 'resources/skills/hello' }];
    if (key === 'with-mcp') contents.push({ id: 'echo', name: 'Echo', kind: 'mcp', definition: { transport: 'stdio', command: 'echo', args: ['hello'] } });
    const bytes = zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key, name: 'Bundle', type: 'bundle', version: '1.0.0', description: 'Synthetic', contents }),
      'README.md': '# Bundle', 'resources/skills/hello/SKILL.md': '---\nname: hello\ndescription: Synthetic\n---\nHello' });
    e.details(key, [{ version: '1.0.0', isEnabled: true, channel: 'release', hosts: ['claude-code'], sha256: createHash('sha256').update(bytes).digest('hex') }]);
    e.market.override(`GET /api/market/packages/${key}/versions/1.0.0/download`, () => ({ status: 200, raw: bytes, contentType: 'application/zip' }));
  }
  const result = await e.worker.call('rc.catalog.list');
  assert.deepEqual(result.data.find(p => p.packageKey === 'with-mcp').tools.map(t => t.label), ['Claude Code', 'Claude Desktop']);
  assert.deepEqual(result.data.find(p => p.packageKey === 'without-mcp').tools.map(t => t.label), ['Claude Code']);
});

