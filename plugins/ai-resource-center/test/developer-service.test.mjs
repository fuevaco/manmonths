import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';

const version = (extra = {}) => ({ id: 1, version: '1.0.0', channel: 'preview', status: 'active', isEnabled: true,
  submittedAt: '2026-01-02T03:04:00Z', submittedBy: 'alice', reviewedAt: null, installCount: 2, ...extra });
const pack = (versions = [version()], extra = {}) => ({ packageKey: 'example.demo', name: '合成資源包', type: 'skill',
  description: '說明', category: '開發', tags: ['測試'], versions, ...extra });
async function fixture(t, opts = {}) {
  const market = await startFakeMarket({ users: { alice: { password: 'pw-alice', permissions: ['market:read', 'market:write'] } },
    myPackages: [pack()], ...opts });
  const worker = startWorker();
  t.after(() => { worker.dispose(); return market.close(); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { worker, market, call: (name, input) => worker.call(`rc.dev.${name}`, input) };
}
const list = async call => (await call('listMyPackages')).packages;

test('我的資源包投影 DTO、排序、加總、角色、停用狀態與上傳／送審者', async t => {
  const { call } = await fixture(t, { myPackages: [pack([
    version({ id: 1, version: '1.9.0', uploadedBy: 'alice', submittedBy: 'legacy', submitter: ' alice ' }),
    version({ id: 2, version: '1.10.0', isEnabled: false }),
    version({ id: 3, version: '2.0.0', channel: 'release', reviewedAt: '2026-02-03T04:05:00Z' })
  ], { currentUserRole: 'Maintainer', secret: 'not-projected' }), pack([], { packageKey: 'empty' }),
  pack([version({ isEnabled: false })], { packageKey: 'disabled' })] });
  const result = await list(call);
  assert.deepEqual(result[0], {
    packageKey: 'example.demo', name: '合成資源包', type: 'skill', description: '說明', category: '開發', tags: ['測試'],
    currentUserRole: 'maintainer', installCount: 6, allDisabled: false, versions: [
      { id: 3, version: '2.0.0', channel: 'release', status: 'active', isEnabled: true, uploadedAt: '2026-01-02T03:04:00Z',
        reviewedAt: '2026-02-03T04:05:00Z', reviewedBy: '', uploadedBy: 'alice', submittedBy: '', rejectReason: '', statusLabel: '已上架', primaryAction: null, canDelete: false },
      { id: 2, version: '1.10.0', channel: 'preview', status: 'active', isEnabled: false, uploadedAt: '2026-01-02T03:04:00Z',
        reviewedAt: null, reviewedBy: '', uploadedBy: 'alice', submittedBy: '', rejectReason: '', statusLabel: 'Preview 可測試', primaryAction: 'submit', canDelete: true },
      { id: 1, version: '1.9.0', channel: 'preview', status: 'active', isEnabled: true, uploadedAt: '2026-01-02T03:04:00Z',
        reviewedAt: null, reviewedBy: '', uploadedBy: 'alice', submittedBy: 'alice', rejectReason: '', statusLabel: 'Preview 可測試', primaryAction: 'submit', canDelete: true }
    ]
  });
  assert.equal(result[1].allDisabled, false);
  assert.equal(result[1].currentUserRole, 'owner');
  assert.equal(result[2].allDisabled, true);
});

for (const channel of ['preview', 'release']) for (const status of ['active', 'pending_review', 'rejected', 'future']) {
  test(`版本動作與狀態：${channel}/${status} 不受停用影響`, async t => {
    const { call } = await fixture(t, { myPackages: [pack([version({ channel, status, isEnabled: false })])] });
    const row = (await list(call))[0].versions[0];
    assert.equal(row.statusLabel, { active: channel === 'preview' ? 'Preview 可測試' : '已上架', pending_review: '送審中', rejected: '已駁回', future: '狀態未知' }[status]);
    assert.equal(row.primaryAction, status === 'pending_review' ? 'withdraw' : channel === 'preview' && ['active', 'rejected'].includes(status) ? 'submit' : null);
    assert.equal(row.canDelete, channel === 'preview');
    if (status === 'rejected') assert.equal(row.rejectReason, '審核者沒有留下原因；請洽市集管理者。');
  });
}

test('清單 403 是正常結果，空清單與未登入可分辨', async t => {
  const { call, worker } = await fixture(t, { users: { alice: { password: 'pw-alice', permissions: ['market:read'] } } });
  assert.deepEqual(await call('listMyPackages'), { forbidden: true, packages: [] });
  await worker.call('rc.session.signOut');
  await assert.rejects(call('listMyPackages'), { code: 'signed_out' });
  const empty = await fixture(t, { myPackages: [] });
  assert.deepEqual(await empty.call('listMyPackages'), { forbidden: false, packages: [] });
});

test('送審、取回、啟用端點方法與 body，重複操作回 conflict', async t => {
  const { call, market } = await fixture(t);
  assert.equal((await call('submitReview', { versionId: 1, comment: ' 附註 ' })).version.primaryAction, 'withdraw');
  await assert.rejects(call('submitReview', { versionId: 1 }), { code: 'conflict', status: 409 });
  assert.equal((await call('withdrawReview', { versionId: 1, comment: ' 取回 ' })).version.primaryAction, 'submit');
  assert.equal((await call('setEnabled', { versionId: 1, isEnabled: false })).version.isEnabled, false);
  assert.equal((await call('setEnabled', { versionId: 1, isEnabled: true })).version.isEnabled, true);
  assert.deepEqual(market.requests.filter(r => r.route.includes('/versions/')).map(r => [r.method, r.route, r.body]), [
    ['POST', '/api/market/versions/1/submit-review', { comment: '附註' }],
    ['POST', '/api/market/versions/1/submit-review', { comment: null }],
    ['POST', '/api/market/versions/1/withdraw-review', { comment: '取回' }],
    ['PUT', '/api/market/versions/1/enabled', { isEnabled: false }],
    ['PUT', '/api/market/versions/1/enabled', { isEnabled: true }]
  ]);
});

test('駁回版本可重新送審，自動核准回傳已上架且留下送審與核准歷程', async t => {
  const { call } = await fixture(t, { myPackages: [pack([version({ status: 'rejected', rejectReason: '請補說明' })], { autoApprovalEnabled: true })] });
  assert.equal((await list(call))[0].versions[0].rejectReason, '請補說明');
  const row = (await call('submitReview', { versionId: 1, comment: '  ' })).version;
  assert.equal(row.statusLabel, '已上架');
  assert.equal(row.primaryAction, null);
  assert.equal(row.canDelete, false);
  const history = (await call('history', { versionId: 1 })).history;
  assert.deepEqual(history.map(h => [h.actionLabel, h.actor, h.comment]), [['送審', 'alice', '—'], ['核准', '系統', '自動審核通過']]);
});

test('審核歷程投影全部中文標籤、未知動作、當地時間與空白意見', async t => {
  const actions = ['upload', 'submit_review', 'approve', 'reject', 'withdraw_review', 'enable', 'disable', 'promote', 'future'];
  const createdAt = '2026-01-02T03:04:00Z';
  const { call } = await fixture(t, { histories: { 1: actions.map((action, id) => ({ id, action, actorAdAccount: 'alice', comment: id ? '附註' : ' ', createdAt, hidden: true })) } });
  const rows = (await call('history', { versionId: 1 })).history;
  assert.deepEqual(rows.map(r => r.actionLabel), ['上傳', '送審', '核准', '駁回', '取回申請', '啟用', '停用', '管理員直接上架（舊流程）', 'future']);
  const date = new Date(createdAt), pad = n => String(n).padStart(2, '0');
  assert.deepEqual(rows[0], { id: 0, createdAt, timeText: `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`, action: 'upload', actionLabel: '上傳', actor: 'alice', comment: '—' });
  assert.equal(rows[1].comment, '附註');
});

test('刪除先驗證確認版本與 1–500 字原因，不發請求；204 成功', async t => {
  const { call, market } = await fixture(t);
  const input = { packageKey: 'example.demo', version: '1.0.0', confirmationVersion: '1.0.0', comment: '移除測試版本' };
  for (const extra of [{ confirmationVersion: '1.0' }, { confirmationVersion: 1 }, { comment: '' }, { comment: ' ' }, { comment: '字'.repeat(501) }, { comment: 1 }, { packageKey: '../demo' }, { version: '../version' }]) {
    const count = market.requests.length;
    await assert.rejects(call('deleteVersion', { ...input, ...extra }), { code: 'invalid_params' });
    assert.equal(market.requests.length, count);
  }
  assert.deepEqual(await call('deleteVersion', { ...input, comment: '字'.repeat(500) }), { deleted: true });
  assert.deepEqual(market.requests.at(-1).body, { comment: '字'.repeat(500), confirmationVersion: '1.0.0' });
  assert.equal(market.requests.at(-1).method, 'POST');
  assert.equal(market.requests.at(-1).route, '/api/market/packages/example.demo/versions/1.0.0');
  assert.deepEqual((await list(call))[0].versions, []);
});

test('編輯資訊修剪欄位與逗號標籤，不去重；空欄位轉 null', async t => {
  const { call, market } = await fixture(t);
  const input = { packageKey: 'example.demo', name: ' 新名稱 ', description: ' 說明 ', category: ' 分類 ', tags: ' a, , b, a , ' };
  const result = await call('updatePackage', input);
  assert.equal(result.package.name, '新名稱');
  assert.deepEqual(result.package.tags, ['a', 'b', 'a']);
  assert.equal(market.requests.at(-1).method, 'PUT');
  assert.deepEqual(market.requests.at(-1).body, { name: '新名稱', description: '說明', category: '分類', tags: 'a,b,a' });
  await call('updatePackage', { ...input, description: ' ', category: '', tags: ', ,' });
  assert.deepEqual(market.requests.at(-1).body, { name: '新名稱', description: null, category: null, tags: null });
  for (const extra of [{ name: ' ' }, { description: 1 }, { category: null }, { tags: ['a'] }]) {
    await assert.rejects(call('updatePackage', { ...input, ...extra }), { code: 'invalid_params' });
  }
});

test('版本操作輸入型別錯誤不發 HTTP 請求', async t => {
  const { call, market } = await fixture(t);
  for (const method of ['submitReview', 'withdrawReview', 'setEnabled', 'history']) {
    for (const versionId of [undefined, '1', 0, -1, 1.5, {}, Number.MAX_SAFE_INTEGER + 1]) {
      const count = market.requests.length;
      await assert.rejects(call(method, { versionId, isEnabled: true }), { code: 'invalid_params' });
      assert.equal(market.requests.length, count);
    }
  }
  for (const method of ['submitReview', 'withdrawReview']) await assert.rejects(call(method, { versionId: 1, comment: [] }), { code: 'invalid_params' });
  for (const isEnabled of [undefined, 'true', 1, null]) await assert.rejects(call('setEnabled', { versionId: 1, isEnabled }), { code: 'invalid_params' });
});

for (const [status, code] of [[400, 'invalid_params'], [403, 'forbidden'], [404, 'market_error'], [409, 'conflict'], [422, 'invalid_params'], [500, 'service_unavailable']]) {
  test(`市集錯誤 ${status} 優先 detail 並移除 HTTP 後綴`, async t => {
    const { call, market } = await fixture(t);
    market.override('POST /api/market/versions/1/submit-review', () => ({ status, body: { title: '標題', detail: '版本 example.demo 已變更（HTTP 409）' } }));
    await assert.rejects(call('submitReview', { versionId: 1 }), { code, status, message: '版本 example.demo 已變更' });
    market.override('POST /api/market/versions/1/submit-review', () => ({ status, body: { title: '操作失敗 (HTTP 500)' } }));
    await assert.rejects(call('submitReview', { versionId: 1 }), { message: '操作失敗' });
  });
}

test('失效 access token 自動續期；最終 401 沿用 session_expired', async t => {
  const { call, market } = await fixture(t);
  market.expireAccessTokens();
  assert.equal((await list(call)).length, 1);
  assert.ok(market.requests.some(r => r.route === '/api/auth/refresh'));
  market.override('GET /api/market/my/packages', () => ({ status: 401, body: {} }));
  await assert.rejects(call('listMyPackages'), { code: 'session_expired' });
});

test('網路錯誤轉 RcError；損壞的成功回應不可當作空清單', async t => {
  const { call, market } = await fixture(t);
  for (const body of [null, {}, { data: [{}] }, { data: [pack([{}])] }]) {
    market.override('GET /api/market/my/packages', () => ({ status: 200, body }));
    await assert.rejects(call('listMyPackages'), { code: 'market_error' });
  }
  market.override('GET /api/market/my/packages', () => ({ status: 200, raw: 'invalid json' }));
  await assert.rejects(call('listMyPackages'), { code: 'market_error' });
  market.override('GET /api/market/my/packages', () => ({ status: 204, raw: '' }));
  await assert.rejects(call('listMyPackages'), { code: 'market_error' });
  market.override('GET /api/market/versions/1/history', () => ({ status: 200, body: { data: [{ action: 'upload', createdAt: 'invalid' }] } }));
  await assert.rejects(call('history', { versionId: 1 }), { code: 'market_error' });
  await market.close();
  await assert.rejects(call('listMyPackages'), { code: 'unreachable' });
});


test('既有 SemVer build 版本可刪除，路徑編碼且確認值保持完整', async t => {
  const value = '1.0.0+build.1';
  const { call, market } = await fixture(t, { myPackages: [pack([version({ version: value })])] });
  assert.deepEqual(await call('deleteVersion', { packageKey: 'example.demo', version: value, confirmationVersion: value, comment: ' 移除 ' }), { deleted: true });
  assert.equal(market.requests.at(-1).route, '/api/market/packages/example.demo/versions/1.0.0%2Bbuild.1');
  assert.equal(market.requests.at(-1).body.confirmationVersion, value);
});

test('版本審核狀態與通道缺值採既有降級規則，舊上傳者與缺少安裝次數', async t => {
  const { call } = await fixture(t, { myPackages: [pack([version({ channel: 'Preview', status: null, uploadedBy: ' ', installCount: undefined })])] });
  const result = (await list(call))[0];
  assert.equal(result.installCount, 0);
  assert.equal(result.versions[0].channel, 'release');
  assert.equal(result.versions[0].statusLabel, '狀態未知');
  assert.equal(result.versions[0].uploadedBy, 'alice');
  assert.equal(result.versions[0].primaryAction, null);
  assert.equal(result.versions[0].canDelete, false);
});

test('審核者帳號（reviewedBy）帶到版本，去除空白；沒有時為空字串', async t => {
  const { call } = await fixture(t, { myPackages: [pack([version({ id: 2, version: '2.0.0', reviewedBy: ' carol ', reviewedAt: '2026-02-03T04:05:00Z' }), version({ id: 1, version: '1.0.0' })])] });
  const [newer, older] = (await list(call))[0].versions;
  assert.equal(newer.reviewedBy, 'carol');
  assert.equal(older.reviewedBy, '');
});
