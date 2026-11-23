// 工項 12：安裝回報（對照 InstallReportBuilderTests、InstallReportOutboxTests、GuiRegistryInstallReportingTests）。
// builder 與 outbox 以公開介面測試；outbox 持久在外掛儲存（orca.storage），差異：原實作以檔案儲存。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInstallReport, createInstallReportOutbox, INSTALL_REPORTS_KEY } from '../worker/install-reports.mjs';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const OP = 'op-20260923T110000Z-1234abcd';
const OTHER = 'op-20260923T110000Z-5678abcd';
const DAY = 24 * 60 * 60 * 1000;
const target = (hostId, surfaceId, status) => ({ host: { hostId, surfaceId }, status });
const plan = (extra = {}) => ({ intent: { scope: 'project', ...extra } });
const create = (over = {}) => buildInstallReport({ plan: plan(over.intent), applied: 'applied' in over ? over.applied : { targets: [target('claude-code', 'claude-code-cli', 'Succeeded')] },
  packageKey: 'example.demo', version: '2.0.0', action: 'update', fromVersion: '1.9.0', channel: 'release', clientProduct: 'gui', clientVersion: '1.4.2',
  account: 'alice', installedAt: new Date('2026-09-23T01:02:03Z'), operationId: 'op-20260923T010203Z-1a2b3c4d', ...over.args });

// ---------- builder（InstallReportBuilderTests） ----------

test('builder：由成功的目標攤平成回報，平台去重並以 UTC 時間回報', () => {
  const report = create({ applied: { targets: [target('claude-code', 'claude-code-cli', 'Succeeded'), target('claude-code', 'claude-code-cli', 'Succeeded'),
    target('codex', 'codex-cli', 'Succeeded'), target('claude-code', 'claude-code-cli', 'Failed')] } });
  assert.deepEqual(report, { packageKey: 'example.demo', version: '2.0.0', operationId: 'op-20260923T010203Z-1a2b3c4d', action: 'update', fromVersion: '1.9.0',
    platforms: [{ hostId: 'claude-code', surfaceId: 'claude-code-cli' }, { hostId: 'codex', surfaceId: 'codex-cli' }], scope: 'project', channel: 'release',
    clientProduct: 'gui', clientVersion: '1.4.2', installedAt: '2026-09-23T01:02:03.000Z', account: 'alice', createdAt: '2026-09-23T01:02:03.000Z' });
});

test('builder：本機來源、空通道、沒有成功的目標或沒有套用結果都不回報；失敗與已還原不算成功', () => {
  assert.equal(create({ intent: { localSourcePath: 'C:\\src\\demo' } }), null);
  assert.equal(create({ args: { channel: '' } }), null);
  assert.equal(create({ applied: { targets: [target('claude-code', 'claude-code-cli', 'Failed'), target('codex', 'codex-cli', 'RolledBack'), target('codex', 'codex-desktop', 'Skipped')] } }), null);
  assert.equal(create({ applied: null }), null);
});

test('builder：受阻（Skipped）的目標不計入平台，只回報實際成功的位置', () => {
  const report = create({ applied: { targets: [target('claude-code', 'claude-code-cli', 'Succeeded'), target('codex', 'codex-cli', 'Skipped')] } });
  assert.deepEqual(report.platforms, [{ hostId: 'claude-code', surfaceId: 'claude-code-cli' }]);
});

// ---------- outbox（InstallReportOutboxTests） ----------

function storageFor({ failOn } = {}) {
  const data = new Map();
  const faults = [];
  const check = (op) => { if (failOn === op) { faults.push(op); throw new Error(`Injected ${op} failure`); } };
  return { data, faults, async get(k) { check('get'); return data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null; }, async set(k, v) { check('set'); data.set(k, JSON.parse(JSON.stringify(v))); }, async delete(k) { data.delete(k); } };
}
const report = (over = {}) => ({ packageKey: 'pdf-toolkit', version: '1.3.0', operationId: OP, action: 'update', fromVersion: '1.2.0', platforms: [{ hostId: 'claude-code', surfaceId: 'claude-code-cli' }],
  scope: 'project', channel: 'release', clientProduct: 'gui', clientVersion: '1.4.2', installedAt: new Date(NOW - 3600000).toISOString(), account: 'alice', createdAt: new Date(NOW - 3600000).toISOString(), ...over });
const entries = (storage) => storage.data.get(INSTALL_REPORTS_KEY)?.entries ?? {};

function harness({ storage = storageFor(), respond = () => ({ status: 200, text: '{"installCount":7}' }), clientError = null, now = () => NOW } = {}) {
  const sent = [];
  const client = { request: async (req) => { sent.push(req); const r = await respond(req); if (r instanceof Error) throw r; return r; } };
  const outbox = createInstallReportOutbox({ storage, getClient: async () => { if (clientError) throw clientError; return client; }, now });
  return { storage, sent, outbox };
}

test('enqueue：寫入外掛儲存，不連線；同一 operation 只聯集平台並保留最初欄位', async () => {
  const h = harness();
  await h.outbox.enqueue(report({ platforms: [{ hostId: 'codex', surfaceId: 'codex-cli' }] }));
  await h.outbox.enqueue(report({ account: 'someone-else', createdAt: new Date(NOW).toISOString(),
    platforms: [{ hostId: 'codex', surfaceId: 'codex-cli' }, { hostId: 'codex', surfaceId: 'codex-desktop' }, { hostId: 'claude-code', surfaceId: 'claude-code-cli' }] }));
  assert.equal(h.sent.length, 0);
  assert.deepEqual(Object.keys(entries(h.storage)), [OP]);
  assert.deepEqual(entries(h.storage)[OP].platforms.map(p => `${p.hostId}/${p.surfaceId}`).sort(), ['claude-code/claude-code-cli', 'codex/codex-cli', 'codex/codex-desktop']);
  assert.equal(entries(h.storage)[OP].account, 'alice');
  assert.equal(entries(h.storage)[OP].createdAt, new Date(NOW - 3600000).toISOString());
});

test('enqueue：不同 operation 各自儲存；operationId 不合法或產品不符時不儲存', async () => {
  const h = harness();
  await h.outbox.enqueue(report());
  await h.outbox.enqueue(report({ operationId: OTHER }));
  await h.outbox.enqueue(report({ operationId: 'x'.repeat(65) }));
  await h.outbox.enqueue(report({ operationId: 'a/b' }));
  await h.outbox.enqueue(report({ operationId: '..' }));
  await h.outbox.enqueue(report({ operationId: 'op-cli', clientProduct: 'cli' }));
  assert.deepEqual(Object.keys(entries(h.storage)).sort(), [OP, OTHER].sort());
});

for (const failOn of ['get', 'set']) {
  test(`enqueue：儲存失敗（${failOn}）不外洩例外，也不破壞既有項目`, async () => {
    const storage = storageFor({ failOn });
    storage.data.set(INSTALL_REPORTS_KEY, { entries: { [OP]: report() } });
    const before = JSON.stringify(storage.data.get(INSTALL_REPORTS_KEY));
    const h = harness({ storage, respond: () => assert.fail('不得連線') });
    await assert.doesNotReject(h.outbox.enqueue(report({ platforms: [{ hostId: 'codex', surfaceId: 'codex-cli' }] })));
    assert.equal(JSON.stringify(storage.data.get(INSTALL_REPORTS_KEY)), before);
  });
}

for (const status of [200, 201, 204]) {
  test(`flush：成功（${status}）只送出 body 欄位並刪除項目`, async () => {
    const h = harness({ respond: () => ({ status, text: status === 204 ? '' : '{"installCount":7}' }) });
    await h.outbox.enqueue(report());
    await h.outbox.flush('alice');
    assert.deepEqual(entries(h.storage), {});
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].method, 'POST');
    assert.equal(h.sent[0].path, 'api/market/packages/pdf-toolkit/versions/1.3.0/installs');
    assert.deepEqual(Object.keys(h.sent[0].json).sort(), ['action', 'channel', 'clientProduct', 'clientVersion', 'fromVersion', 'installedAt', 'operationId', 'platforms', 'scope']);
    assert.equal(h.sent[0].json.operationId, OP);
    assert.equal('account' in h.sent[0].json, false);
  });
}

for (const status of [400, 403, 404, 409, 422, 429, 499]) {
  test(`flush：永久 4xx（${status}）丟棄項目並記一行有界的紀錄`, async () => {
    const h = harness({ respond: () => ({ status, text: 'x'.repeat(20000) + '\r\nsecond line' }) });
    await h.outbox.enqueue(report());
    await assert.doesNotReject(h.outbox.flush('alice'));
    assert.equal(h.sent.length, 1);
    assert.deepEqual(entries(h.storage), {});
    const lines = h.storage.data.get(INSTALL_REPORTS_KEY).log;
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`2026-09-23T12:00:00.*${OP}.*${status}`));
    assert.ok(lines[0].length < 4096);
  });
}

test('flush：401 代表憑證暫時失效，保留項目、不寫丟棄紀錄，待登入恢復後補送', async () => {
  const h = harness({ respond: () => ({ status: 401, text: '' }) });
  await h.outbox.enqueue(report());
  await h.outbox.flush('alice');
  assert.equal(h.sent.length, 1);
  assert.deepEqual(Object.keys(entries(h.storage)), [OP]);
  assert.equal(h.storage.data.get(INSTALL_REPORTS_KEY).log ?? undefined, undefined);
});

for (const status of [500, 503, 599]) {
  test(`flush：${status} 保留項目待重試`, async () => {
    const h = harness({ respond: () => ({ status, text: '' }) });
    await h.outbox.enqueue(report());
    await h.outbox.flush('alice');
    assert.deepEqual(Object.keys(entries(h.storage)), [OP]);
  });
}

for (const [name, error] of [['network', new Error('Disconnected')], ['timeout', Object.assign(new Error('Timed out'), { code: 'unreachable' })]]) {
  test(`flush：傳輸例外（${name}）保留項目且不外洩`, async () => {
    const h = harness({ respond: () => error });
    await h.outbox.enqueue(report());
    await assert.doesNotReject(h.outbox.flush('alice'));
    assert.equal(h.sent.length, 1);
    assert.deepEqual(Object.keys(entries(h.storage)), [OP]);
  });
}

test('flush：尚未登入（取不到市集用戶端）時保留項目；逾期項目不需連線即淘汰並記錄', async () => {
  const h = harness({ clientError: new Error('signed_out') });
  await h.outbox.enqueue(report());
  await h.outbox.enqueue(report({ operationId: OTHER, createdAt: new Date(NOW - 30 * DAY - 1).toISOString() }));
  await assert.doesNotReject(h.outbox.flush('alice'));
  assert.deepEqual(Object.keys(entries(h.storage)), [OP]);
  assert.match(h.storage.data.get(INSTALL_REPORTS_KEY).log[0], new RegExp(`${OTHER}.*(expired|30)`));
});

test('flush：剛好 30 天仍嘗試送出，5xx 時保留', async () => {
  const h = harness({ respond: () => ({ status: 503, text: '' }) });
  await h.outbox.enqueue(report({ createdAt: new Date(NOW - 30 * DAY).toISOString() }));
  await h.outbox.flush('alice');
  assert.equal(h.sent.length, 1);
  assert.deepEqual(Object.keys(entries(h.storage)), [OP]);
});

for (const current of ['other-account', null]) {
  test(`flush：目前帳號（${current}）與回報帳號不符時保留項目、不送出`, async () => {
    const h = harness();
    await h.outbox.enqueue(report());
    await h.outbox.flush(current);
    assert.equal(h.sent.length, 0);
    assert.deepEqual(Object.keys(entries(h.storage)), [OP]);
  });
}

test('flush：一筆送出失敗不影響其他筆', async () => {
  const h = harness({ respond: (req) => req.json.operationId === OP ? new Error('Offline for first entry') : { status: 200, text: '{}' } });
  await h.outbox.enqueue(report());
  await h.outbox.enqueue(report({ operationId: OTHER }));
  await assert.doesNotReject(h.outbox.flush('alice'));
  assert.equal(h.sent.length, 2);
  assert.deepEqual(Object.keys(entries(h.storage)), [OP]);
});

test('flush：儲存讀取失敗不外洩例外；送出期間新 enqueue 的平台增補不會被誤刪', async () => {
  const failing = harness({ storage: storageFor({ failOn: 'get' }) });
  await assert.doesNotReject(failing.outbox.flush('alice'));

  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness({ respond: async () => { await gate; return { status: 503, text: '' }; } });
  await h.outbox.enqueue(report());
  const flushing = h.outbox.flush('alice');
  const enqueuing = h.outbox.enqueue(report({ platforms: [{ hostId: 'codex', surfaceId: 'codex-cli' }] }));
  release();
  await Promise.all([flushing, enqueuing]);
  assert.deepEqual(entries(h.storage)[OP].platforms.map(p => p.hostId).sort(), ['claude-code', 'codex']);
});

test('flush：送出成功的同時有新增平台時，保留項目連同新增平台下次補送，不被這次刪除帶走', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness({ respond: async () => { await gate; return { status: 200, text: '{}' }; } });
  await h.outbox.enqueue(report());
  const flushing = h.outbox.flush('alice');
  await new Promise(r => setImmediate(r));
  await h.outbox.enqueue(report({ platforms: [{ hostId: 'codex', surfaceId: 'codex-cli' }] }));
  release();
  await flushing;
  assert.deepEqual(entries(h.storage)[OP].platforms.map(p => p.hostId).sort(), ['claude-code', 'codex']);
  await h.outbox.flush('alice');
  assert.deepEqual(entries(h.storage), {});
  assert.deepEqual(h.sent.map(r => r.json.platforms.length), [1, 2]);
});
