// rc-package-dev 工項 02：我的資源包清單、版本列、「⋯」選單、審核歷程就地展開與各操作的 sheet（vm 面板 harness）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

const signedIn = { signedIn: true, marketUrl: 'https://market.example.com', account: 'alice' };
// 以本地時間組出 ISO，面板顯示的 MM/DD HH:mm 才不受測試機時區影響；年份用今年（今年的時間不顯示年份）
const THIS_YEAR = new Date().getFullYear();
const at = (month, day, hour, minute, year = THIS_YEAR) => new Date(year, month - 1, day, hour, minute).toISOString();
const version = (id, v, extra = {}) => ({ id, version: v, channel: 'release', status: 'active', isEnabled: true, uploadedAt: at(11, 20, 8, 0), reviewedAt: null,
  uploadedBy: 'alice', reviewedBy: '', submittedBy: '', rejectReason: '', statusLabel: '已上架', primaryAction: null, canDelete: false, ...extra });
const preview = (id, v, extra = {}) => version(id, v, { channel: 'preview', statusLabel: 'Preview 可測試', primaryAction: 'submit', canDelete: true, ...extra });

const kit = () => ({ packageKey: 'example.kit', name: '示範工具包', type: 'bundle', description: '示範說明', category: '文件工具', tags: ['備標', 'Word'],
  currentUserRole: 'owner', installCount: 19, allDisabled: false, versions: [
    preview(14, '1.1.0', { status: 'rejected', statusLabel: '已駁回', rejectReason: 'README 缺少驗證步驟', uploadedAt: at(11, 21, 10, 12) }),
    preview(13, '1.0.2', { status: 'pending_review', statusLabel: '送審中', primaryAction: 'withdraw', uploadedAt: at(11, 21, 21, 5) }),
    preview(12, '1.0.1', { isEnabled: false, uploadedAt: at(11, 20, 15, 40) }),
    version(11, '1.0.0', { reviewedAt: at(11, 19, 18, 24), uploadedAt: at(11, 19, 9, 0), uploadedBy: 'alice' })] });
const second = () => ({ packageKey: 'example.second', name: '第二個資源包', type: 'skill', description: '', category: '', tags: [], currentUserRole: 'maintainer',
  installCount: 0, allDisabled: true, versions: [version(21, '2.0.0', { isEnabled: false, reviewedAt: at(10, 3, 9, 30) })] });

/** 版本很多的資源包：1.<n>.0 由新到舊共 total 個；第 releaseAt 新（從 1 起算）的是目前的正式版，其餘都是 Preview。 */
const bulk = (total, releaseAt, extra = {}) => ({ ...kit(), packageKey: 'example.bulk', name: '版本很多的資源包', ...extra,
  versions: Array.from({ length: total }, (_, i) => {
    const n = total - i;
    const id = 1000 + n;
    return i + 1 === releaseAt ? version(id, `1.${n}.0`, { reviewedAt: at(9, 26, 12, 35) }) : preview(id, `1.${n}.0`, { uploadedAt: at(11, 21, 21, 5) });
  }) });

async function start({ list = { forbidden: false, packages: [kit(), second()] }, extra = {}, wait = true } = {}) {
  const calls = [];
  let current = list;
  const state = { get list() { return current; }, set list(value) { current = value; } };
  const handler = async (method, input) => {
    calls.push({ method, input });
    if (extra[method]) return extra[method](input, state);
    if (method === 'rc.session.getState') return signedIn;
    if (method === 'rc.catalog.list') return { data: [] };
    if (method === 'rc.dev.listMyPackages') { if (current instanceof Error) throw current; return structuredClone(current); }
    return {};
  };
  const panel = await startPanel(handler);
  const dev = (method) => calls.filter(c => c.method === method).map(c => ({ ...c, input: JSON.parse(JSON.stringify(c.input ?? null)) }));
  const open = async () => { await panel.get('btn-settings').fire('click'); await panel.get('btn-my-packages').fire('click'); await settle(); };
  if (wait) await open(); else { open(); await settle(); }
  return { panel, calls, dev, state, open };
}

const cards = (panel) => findAllByData(panel.get('developer-list'), 'role', 'dev-package');
const card = (panel, key) => cards(panel).find(c => c.getAttribute('data-package-key') === key);
const rows = (node) => findAllByData(node, 'role', 'version-row');
const rowOf = (panel, id) => rows(panel.get('developer-list')).find(r => r.getAttribute('data-version-id') === String(id));
const descendants = (node) => [node, ...node.children.flatMap(descendants)];
const byClass = (node, cls) => descendants(node).filter(n => n.classList?.contains(cls));
const badges = (node) => byClass(node, 'badge').map(b => textOf(b).trim());
const buttons = (node) => descendants(node).filter(n => n.tagName === 'button');
const toggleMore = (row) => byClass(row, 'dev-more')[0];
const menuLabels = (panel) => panel.get('popover').children.map(n => n.tagName === 'hr' ? '---' : textOf(n).trim());
const choose = async (panel, label) => { await panel.get('popover').children.find(n => textOf(n).trim() === label).fire('click'); await settle(); };
const hidden = (panel, id) => panel.get(id).classList.contains('hidden');
const toastOf = (panel) => ({ text: textOf(panel.get('toast')).trim(), kind: panel.get('toast').className });
const sheetText = (panel) => `${textOf(panel.get('sheet-title'))} ${textOf(panel.get('sheet-body'))}`;
const fieldControl = (panel, label) => {
  const field = descendants(panel.get('sheet-body')).find(n => n.classList?.contains('field') && textOf(n).includes(label));
  return descendants(field).find(n => ['input', 'textarea'].includes(n.tagName));
};
const versionsOf = (panel, key) => rows(card(panel, key)).map(r => r.getAttribute('data-version'));
const footerOf = (panel, key) => findByData(card(panel, key), 'role', 'version-footer');
const link = (panel, key, action) => buttons(card(panel, key)).find(b => b.getAttribute('data-action') === action);
const countOf = (panel, key) => textOf(findByData(card(panel, key), 'role', 'version-count')).trim();
const gapOf = (panel, key) => findByData(card(panel, key), 'role', 'version-gap');
const timeOf = (panel, id) => textOf(findByData(rowOf(panel, id), 'role', 'version-time')).replace(/\s+/g, ' ').trim();
const type = async (panel, control, value) => { control.value = value; await control.dispatch('input'); };

test('進入視圖會讀取清單：標題「我的資源包（N）」，卡片依序為名稱、識別碼、角色與安裝次數與分類；預設不顯示標籤', async () => {
  const { panel, dev } = await start();
  assert.equal(dev('rc.dev.listMyPackages').length, 1);
  assert.equal(textOf(findByData(panel.get('developer-list'), 'role', 'developer-heading')).trim(), '我的資源包（2）');
  const first = card(panel, 'example.kit');
  assert.equal(textOf(findByData(first, 'role', 'package-name')).trim(), '示範工具包');
  const key = findByData(first, 'role', 'package-key');
  assert.equal(textOf(key).trim(), 'example.kit');
  assert.ok(key.classList.contains('mono') && key.classList.contains('ell'), '識別碼為等寬單行截斷');
  assert.equal(key.getAttribute('title'), 'example.kit');
  assert.deepEqual(findByData(first, 'role', 'package-meta').children.map(n => n.textContent), ['擁有者', '· ↓ 19 次', '· 文件工具']);
  assert.doesNotMatch(textOf(first), /備標|Word/, '不顯示標籤');
  assert.deepEqual(findByData(card(panel, 'example.second'), 'role', 'package-meta').children.map(n => n.textContent), ['維護者', '· ↓ 0 次', '· 全部版本已停用'], '沒有分類時不留空段');
  assert.equal(panel.get('developer-local').children.length, 0, '本機開發中容器留給工項 04，空白（樣式預設隱藏）');
  assert.equal(panel.get('btn-dev-upload').disabled, false);
});

test('已停用（修訂 1）：沒有「已停用」徽章；部分停用只有該版本列灰色色條與時間後的「· 已停用」，全部停用只有卡片灰色色條與資訊行「· 全部版本已停用」，版本列不再重複', async () => {
  const { panel } = await start();
  const partial = card(panel, 'example.kit'), all = card(panel, 'example.second');
  for (const c of [partial, all]) assert.ok(!badges(c).includes('已停用'), '不再用徽章表示停用');
  assert.ok(!partial.classList.contains('is-off'), '部分停用時卡片本身沒有色條');
  assert.ok(!findByData(partial, 'role', 'all-off'));
  assert.deepEqual(rows(partial).map(r => r.classList.contains('is-off')), [false, false, true, false], '只有停用的版本列有色條（1.0.1）');
  assert.equal(timeOf(panel, 12), '上傳 11/20 15:40 · 已停用');
  assert.equal(findByData(rowOf(panel, 12), 'role', 'version-off').classList.contains('dev-off'), true);
  assert.equal(timeOf(panel, 13), '上傳 11/21 21:05', '沒停用的版本列沒有多餘文字');
  assert.ok(all.classList.contains('is-off'), '全部停用：卡片左側灰色色條');
  assert.equal(textOf(findByData(all, 'role', 'all-off')).trim(), '· 全部版本已停用');
  assert.ok(findByData(all, 'role', 'package-meta').children.at(-1).classList.contains('dev-off'));
  const only = rows(all)[0];
  assert.ok(!only.classList.contains('is-off'), '同一張卡片只有一層色條：版本列不再各自加色條');
  assert.equal(findByData(only, 'role', 'version-off'), null, '版本列不加「已停用」文字');
  assert.equal(timeOf(panel, 21), '審核 10/03 09:30');
});

test('版本列只佔一行：版號、通道、狀態徽章、時間、⋯ 依序排在同一個 flex-wrap 容器，沒有按鈕與第二行', async () => {
  const { panel } = await start();
  const row = rowOf(panel, 14);
  const top = byClass(row, 'dev-vtop')[0];
  assert.deepEqual(top.children.map(n => [...n.classes].find(c => ['dev-ver', 'badge', 'dev-vtime', 'dev-more'].includes(c))), ['dev-ver', 'badge', 'badge', 'dev-vtime', 'dev-more']);
  assert.deepEqual(buttons(row).map(b => [...b.classes].filter(c => c.startsWith('dev-')).join()), ['dev-more'], '版本列沒有按鈕，只有 ⋯');
  assert.equal(descendants(row).filter(n => n.getAttribute?.('data-action')).length, 0, '沒有任何動作按鈕');
  assert.equal(byClass(row, 'dev-vsub').length, 0, '沒有第二行');
  assert.equal(byClass(row, 'dev-vact').length, 0);
});

test('版本列徽章：通道（Preview／正式版）加狀態（已駁回紅、送審中黃、可測試藍、已上架綠），Preview 可測試顯示「可測試」', async () => {
  const { panel } = await start();
  const labelsOf = (id) => badges(rowOf(panel, id));
  assert.deepEqual(labelsOf(14), ['Preview', '已駁回']);
  assert.deepEqual(labelsOf(13), ['Preview', '送審中']);
  assert.deepEqual(labelsOf(12), ['Preview', '可測試']);
  const cls = (id) => byClass(rowOf(panel, id), 'badge').map(b => [...b.classes].find(c => c.startsWith('b-')));
  assert.deepEqual(cls(14), ['b-pre', 'b-rej']);
  assert.deepEqual(cls(13), ['b-pre', 'b-rev']);
  assert.deepEqual(cls(12), ['b-pre', 'b-pre']);
  assert.equal(textOf(byClass(rowOf(panel, 14), 'dev-ver')[0]).trim(), '1.1.0');
  const more = await start({ list: { forbidden: false, packages: [{ ...kit(), versions: [kit().versions[3]] }] } });
  assert.deepEqual(badges(rowOf(more.panel, 11)), ['正式版', '已上架']);
  assert.deepEqual(byClass(rowOf(more.panel, 11), 'badge').map(b => [...b.classes].find(c => c.startsWith('b-'))), ['b-rel', 'b-rel']);
});

test('時間：有審核時間顯示「審核」，否則「上傳」，格式 MM/DD HH:mm；操作者放在時間的滑過提示；已駁回多一行紅字原因', async () => {
  const withReviewer = kit();
  withReviewer.versions[3] = { ...withReviewer.versions[3], reviewedBy: 'carol' };
  const { panel } = await start({ list: { forbidden: false, packages: [withReviewer, second()] } });
  assert.equal(timeOf(panel, 13), '上傳 11/21 21:05');
  assert.equal(findByData(rowOf(panel, 13), 'role', 'version-time').getAttribute('title'), '上傳者 alice');
  assert.equal(findByData(rowOf(panel, 12), 'role', 'version-time').getAttribute('title'), '上傳者 alice');
  assert.equal(findByData(rowOf(panel, 14), 'role', 'reject-reason').parent, rowOf(panel, 14), '駁回原因在版本列內、時間之下');
  assert.equal(textOf(findByData(rowOf(panel, 14), 'role', 'reject-reason')).trim(), '駁回原因：README 缺少驗證步驟');
  assert.equal(findByData(rowOf(panel, 13), 'role', 'reject-reason'), null, '只有已駁回才有原因行');
  assert.ok(findByData(rowOf(panel, 14), 'role', 'reject-reason').classList.contains('dev-vrej'));
  const flat = await start({ list: { forbidden: false, packages: [{ ...withReviewer, versions: [withReviewer.versions[3]] }] } });
  assert.equal(timeOf(flat.panel, 11), '審核 11/19 18:24');
  assert.equal(findByData(rowOf(flat.panel, 11), 'role', 'version-time').getAttribute('title'), '審核者 carol');
  const anonymous = await start({ list: { forbidden: false, packages: [{ ...kit(), versions: [{ ...kit().versions[3], reviewedBy: '', uploadedBy: '' }] }] } });
  assert.ok(!findByData(rowOf(anonymous.panel, 11), 'role', 'version-time').getAttribute('title'), '沒有操作者就沒有滑過提示');
});

test('跨年的時間顯示完整日期 YYYY/MM/DD（不含時分），今年的省略年份', async () => {
  const list = kit();
  list.versions.push(version(10, '0.9.9', { channel: 'preview', uploadedAt: at(8, 30, 14, 5, THIS_YEAR - 1), primaryAction: 'submit', canDelete: true }),
    version(9, '0.9.8', { reviewedAt: at(1, 2, 3, 4, THIS_YEAR - 2) }));
  const { panel } = await start({ list: { forbidden: false, packages: [list] } });
  await link(panel, 'example.kit', 'more-versions').fire('click');
  assert.equal(timeOf(panel, 10), `上傳 ${THIS_YEAR - 1}/08/30`);
  assert.equal(timeOf(panel, 9), `審核 ${THIS_YEAR - 2}/01/02`);
  assert.equal(timeOf(panel, 11), '審核 11/19 18:24');
});

test('版本由新到舊，預設最新 3 個；3 個以內（含正式版緊接其後）沒有頁尾；「再顯示 10 個版本」每次多 10 個，「收合」回到預設', async () => {
  const { panel } = await start({ list: { forbidden: false, packages: [kit(), second(), bulk(5, 99), bulk(25, 99, { packageKey: 'example.more' })] } });
  assert.deepEqual(versionsOf(panel, 'example.kit'), ['1.1.0', '1.0.2', '1.0.1', '1.0.0'], '最新 3 個，正式版緊接在後，全部都看得到');
  assert.equal(footerOf(panel, 'example.kit'), null, '看得到全部版本時沒有頁尾');
  assert.equal(footerOf(panel, 'example.second'), null, '3 個以內沒有頁尾');
  assert.deepEqual(versionsOf(panel, 'example.bulk'), ['1.5.0', '1.4.0', '1.3.0']);
  assert.equal(countOf(panel, 'example.bulk'), '共 5 個');
  assert.equal(textOf(link(panel, 'example.bulk', 'more-versions')).trim(), '再顯示 2 個版本', '剩不到 10 個時顯示實際數量');
  assert.equal(link(panel, 'example.bulk', 'collapse-versions'), undefined, '沒展開過沒有「收合」');
  await link(panel, 'example.bulk', 'more-versions').fire('click');
  assert.deepEqual(versionsOf(panel, 'example.bulk'), ['1.5.0', '1.4.0', '1.3.0', '1.2.0', '1.1.0']);
  assert.equal(countOf(panel, 'example.bulk'), '已顯示 5／5');
  assert.equal(link(panel, 'example.bulk', 'more-versions'), undefined, '全部顯示後只剩「收合」');
  assert.equal(textOf(link(panel, 'example.bulk', 'collapse-versions')).trim(), '收合');
  await link(panel, 'example.bulk', 'collapse-versions').fire('click');
  assert.equal(versionsOf(panel, 'example.bulk').length, 3);
  assert.equal(countOf(panel, 'example.bulk'), '共 5 個');
  // 每次多 10 個，卡片之間互不影響
  assert.equal(versionsOf(panel, 'example.more').length, 3);
  await link(panel, 'example.more', 'more-versions').fire('click');
  assert.equal(versionsOf(panel, 'example.more').length, 13);
  assert.equal(countOf(panel, 'example.more'), '已顯示 13／25');
  await link(panel, 'example.more', 'more-versions').fire('click');
  assert.equal(versionsOf(panel, 'example.more').length, 23);
  await link(panel, 'example.more', 'more-versions').fire('click');
  assert.equal(versionsOf(panel, 'example.more').length, 25);
  assert.equal(link(panel, 'example.more', 'more-versions'), undefined);
  assert.equal(versionsOf(panel, 'example.bulk').length, 3);
});

test('目前的正式版不在最新 3 個時固定顯示在最後，之間以虛線標出「⋯ 中間還有 N 個版本 ⋯」；展開時 N 遞減、計數含固定的那一個', async () => {
  const { panel } = await start({ list: { forbidden: false, packages: [bulk(103, 40)] } });
  const key = 'example.bulk';
  assert.deepEqual(versionsOf(panel, key), ['1.103.0', '1.102.0', '1.101.0', '1.64.0'], '最新 3 個＋第 40 新的正式版');
  assert.equal(textOf(gapOf(panel, key)).trim(), '⋯ 中間還有 36 個版本 ⋯');
  assert.ok(gapOf(panel, key).classList.contains('dev-vgap'));
  assert.deepEqual(card(panel, key).children.slice(-3).map(n => n.getAttribute('data-role')), ['version-gap', 'version-row', 'version-footer'], '虛線在固定的正式版之前、頁尾之前');
  assert.equal(countOf(panel, key), '共 103 個');
  await link(panel, key, 'more-versions').fire('click');
  assert.equal(versionsOf(panel, key).length, 14, '13 個加固定的正式版');
  assert.equal(versionsOf(panel, key).at(-1), '1.64.0');
  assert.equal(textOf(gapOf(panel, key)).trim(), '⋯ 中間還有 26 個版本 ⋯');
  assert.equal(countOf(panel, key), '已顯示 14／103');
  assert.equal(textOf(link(panel, key, 'more-versions')).trim(), '再顯示 10 個版本');
  assert.equal(textOf(link(panel, key, 'collapse-versions')).trim(), '收合');
  const labels = footerOf(panel, key).children[0].children.map(n => textOf(n).trim());
  assert.deepEqual(labels, ['再顯示 10 個版本', '收合'], '左邊兩個連結，右邊是計數');
  await link(panel, key, 'more-versions').fire('click');
  assert.equal(textOf(gapOf(panel, key)).trim(), '⋯ 中間還有 16 個版本 ⋯');
  assert.equal(countOf(panel, key), '已顯示 24／103');
  await link(panel, key, 'more-versions').fire('click');
  await link(panel, key, 'more-versions').fire('click');
  assert.equal(gapOf(panel, key), null, '展開到 43 個之後正式版回到原本的位置，虛線消失');
  assert.equal(versionsOf(panel, key).length, 43);
  assert.equal(versionsOf(panel, key)[39], '1.64.0');
  assert.equal(countOf(panel, key), '已顯示 43／103');
  await link(panel, key, 'collapse-versions').fire('click');
  assert.equal(versionsOf(panel, key).length, 4, '收合回到預設');
  assert.equal(textOf(gapOf(panel, key)).trim(), '⋯ 中間還有 36 個版本 ⋯');
});

test('展開到剛好接上正式版時沒有虛線；全部顯示後只剩「收合」；正式版就在最新 3 個裡時不另外固定', async () => {
  const adjacent = await start({ list: { forbidden: false, packages: [bulk(20, 14)] } }); // 3 個後虛線 10 個；展開一次剛好顯示到第 13 個，正式版緊接在後
  await link(adjacent.panel, 'example.bulk', 'more-versions').fire('click');
  assert.equal(gapOf(adjacent.panel, 'example.bulk'), null, '中間 0 個版本不畫虛線');
  assert.equal(versionsOf(adjacent.panel, 'example.bulk').length, 14);
  assert.equal(countOf(adjacent.panel, 'example.bulk'), '已顯示 14／20');
  await link(adjacent.panel, 'example.bulk', 'more-versions').fire('click');
  assert.equal(versionsOf(adjacent.panel, 'example.bulk').length, 20);
  assert.equal(link(adjacent.panel, 'example.bulk', 'more-versions'), undefined);
  assert.equal(countOf(adjacent.panel, 'example.bulk'), '已顯示 20／20');
  const inside = await start({ list: { forbidden: false, packages: [bulk(12, 2)] } });
  assert.equal(gapOf(inside.panel, 'example.bulk'), null);
  assert.deepEqual(versionsOf(inside.panel, 'example.bulk'), ['1.12.0', '1.11.0', '1.10.0'], '正式版在最新 3 個裡，不重複顯示');
  assert.equal(countOf(inside.panel, 'example.bulk'), '共 12 個');
  const none = await start({ list: { forbidden: false, packages: [bulk(8, 99)] } }); // 完全沒有正式版
  assert.equal(gapOf(none.panel, 'example.bulk'), null);
  assert.equal(versionsOf(none.panel, 'example.bulk').length, 3);
});

test('目前的正式版是版號最新的 release 且 active 的版本，停用與否都算；駁回、送審中的 release 不算', async () => {
  const pack = bulk(30, 99);
  pack.versions[10] = version(1020, '1.20.0', { status: 'pending_review', statusLabel: '送審中' });
  pack.versions[14] = version(1016, '1.16.0', { isEnabled: false });
  pack.versions[20] = version(1010, '1.10.0');
  const { panel } = await start({ list: { forbidden: false, packages: [pack] } });
  assert.deepEqual(versionsOf(panel, 'example.bulk').slice(3), ['1.16.0']);
  assert.equal(textOf(gapOf(panel, 'example.bulk')).trim(), '⋯ 中間還有 11 個版本 ⋯');
  assert.equal(rowOf(panel, 1016).classList.contains('is-off'), true, '固定顯示的正式版若停用也有灰色色條');
});

test('展開狀態不記憶：重新讀取（登出再進入）回到預設，操作後重新讀取則維持', async () => {
  const { panel } = await start({ list: { forbidden: false, packages: [bulk(40, 30)] } });
  await link(panel, 'example.bulk', 'more-versions').fire('click');
  assert.equal(versionsOf(panel, 'example.bulk').length, 14);
  await toggleMore(rowOf(panel, 1040)).fire('click');
  await choose(panel, '停用此版本');
  assert.equal(versionsOf(panel, 'example.bulk').length, 14, '操作成功後重新讀取，展開狀態維持');
  panel.window.RcPanel.resetDeveloper();
  await panel.window.RcPanel.loadDeveloper();
  await settle();
  assert.equal(versionsOf(panel, 'example.bulk').length, 4, '重設後回到預設');
});

test('版本 ⋯ 選單：第一項是主要動作（藍色粗體）後接分隔線，其餘為停用／啟用、審核歷程，Preview 才有紅色「刪除此版本…」', async () => {
  const { panel } = await start();
  await toggleMore(rowOf(panel, 13)).fire('click');
  assert.equal(hidden(panel, 'popover'), false);
  assert.deepEqual(menuLabels(panel), ['取回申請…', '---', '停用此版本', '展開審核歷程', '---', '刪除此版本…']);
  const menu = panel.get('popover').children;
  assert.ok(menu[0].classList.contains('is-primary') && !menu[0].classList.contains('is-danger'), '主要動作是藍色粗體');
  assert.ok(menu.at(-1).classList.contains('is-danger'));
  assert.ok(!menu[2].classList.contains('is-primary') && !menu[2].classList.contains('is-danger'));
  assert.equal(toggleMore(rowOf(panel, 13)).getAttribute('aria-expanded'), 'true');
  await toggleMore(rowOf(panel, 13)).fire('click');
  assert.equal(hidden(panel, 'popover'), true, '再按同一顆收合');
  await toggleMore(rowOf(panel, 14)).fire('click');
  assert.deepEqual(menuLabels(panel), ['申請上架…', '---', '停用此版本', '展開審核歷程', '---', '刪除此版本…'], '已駁回也能申請上架');
  assert.ok(panel.get('popover').children[0].classList.contains('is-primary'));
  await toggleMore(rowOf(panel, 12)).fire('click');
  assert.deepEqual(menuLabels(panel), ['申請上架…', '---', '啟用此版本', '展開審核歷程', '---', '刪除此版本…'], '停用中的 Preview 可測試也能申請上架');
  await panel.document.fire('keydown', { key: 'Escape' });
  assert.equal(hidden(panel, 'popover'), true);
  await toggleMore(rowOf(panel, 11)).fire('click');
  assert.deepEqual(menuLabels(panel), ['停用此版本', '展開審核歷程'], '正式版沒有主要動作也沒有刪除，不留多餘分隔線');
  assert.ok(panel.get('popover').children.every(n => !n.classList.contains('is-primary')));
  await panel.document.fire('click', { target: { closest: () => null } });
  assert.equal(hidden(panel, 'popover'), true, '點選單外關閉');
});

test('資源包 ⋯ 選單只有「編輯資訊」', async () => {
  const { panel } = await start();
  await byClass(findByData(card(panel, 'example.kit'), 'role', 'package-name').parent.parent, 'dev-more')[0].fire('click');
  assert.deepEqual(menuLabels(panel), ['編輯資訊']);
});

test('停用／啟用：不開 sheet，直接呼叫、toast 並重新讀取清單', async () => {
  const { panel, dev } = await start();
  await toggleMore(rowOf(panel, 13)).fire('click');
  await choose(panel, '停用此版本');
  assert.deepEqual(dev('rc.dev.setEnabled').map(c => c.input), [{ versionId: 13, isEnabled: false }]);
  assert.equal(panel.window.RcPanel.sheetOpen(), false);
  assert.equal(toastOf(panel).text, '已停用 1.0.2');
  assert.equal(dev('rc.dev.listMyPackages').length, 2, '成功後重新讀取');
  await toggleMore(rowOf(panel, 12)).fire('click');
  await choose(panel, '啟用此版本');
  assert.deepEqual(dev('rc.dev.setEnabled').at(-1).input, { versionId: 12, isEnabled: true });
  assert.equal(toastOf(panel).text, '已啟用 1.0.1');
});

test('審核歷程：就地展開在版本列下方（新的在上；時間 | 動作 · 操作者，附註不是「—」才顯示），再選一次收合', async () => {
  const history = [{ id: 1, createdAt: at(11, 20, 15, 40), timeText: '2026/11/20 15:40', actionLabel: '上傳', actor: 'alice', comment: '首次上傳' },
    { id: 2, createdAt: at(11, 20, 16, 2), timeText: '2026/11/20 16:02', actionLabel: '停用', actor: 'alice', comment: '—' }];
  const { panel, dev } = await start({ extra: { 'rc.dev.history': () => ({ history }) } });
  await toggleMore(rowOf(panel, 12)).fire('click');
  await choose(panel, '展開審核歷程');
  assert.deepEqual(dev('rc.dev.history').map(c => c.input), [{ versionId: 12 }]);
  const box = findByData(rowOf(panel, 12), 'role', 'history');
  assert.ok(box, '歷程在該版本列內');
  const lines = findAllByData(box, 'role', 'history-row').map(r => r.children.map(c => textOf(c).replace(/\s+/g, ' ').trim()));
  assert.deepEqual(lines, [['11/20 16:02', '停用 · alice'], ['11/20 15:40', '上傳 · alice 首次上傳']]);
  assert.equal(findAllByData(box, 'role', 'history-comment').length, 1, '「—」不顯示');
  await toggleMore(rowOf(panel, 12)).fire('click');
  assert.equal(menuLabels(panel)[3], '收合審核歷程');
  await choose(panel, '收合審核歷程');
  assert.equal(findByData(rowOf(panel, 12), 'role', 'history'), null);
});

test('審核歷程讀取失敗時在該區顯示原因；展開中的歷程在操作後重新讀取', async () => {
  let fail = true;
  const { panel, dev } = await start({ extra: { 'rc.dev.history': () => { if (fail) throw Object.assign(new Error('讀不到歷程'), { code: 'market_error' }); return { history: [] }; } } });
  await toggleMore(rowOf(panel, 12)).fire('click');
  await choose(panel, '展開審核歷程');
  assert.match(textOf(findByData(rowOf(panel, 12), 'role', 'history')), /讀不到歷程/);
  fail = false;
  await toggleMore(rowOf(panel, 12)).fire('click');
  await choose(panel, '啟用此版本');
  await settle();
  assert.equal(dev('rc.dev.history').length, 2, '重新讀取清單後再讀歷程');
  assert.match(textOf(findByData(rowOf(panel, 12), 'role', 'history')), /沒有審核歷程/);
});

test('申請上架 sheet：附註選填、送出 submitReview，成功後 toast 並重新讀取', async () => {
  const { panel, dev } = await start({ extra: { 'rc.dev.submitReview': () => ({ version: { id: 14, channel: 'preview', status: 'pending_review' } }) } });
  await toggleMore(rowOf(panel, 14)).fire('click');
  await choose(panel, '申請上架…');
  assert.equal(hidden(panel, 'sheet-layer'), false);
  assert.equal(textOf(panel.get('sheet-title')).replace(/\s+/g, ' ').trim(), '申請上架 示範工具包 1.1.0');
  assert.match(sheetText(panel), /核准後會成為正式版/);
  assert.match(sheetText(panel), /送審附註（選填）/);
  assert.equal(panel.get('sheet-primary').disabled, false, '附註選填，直接可送出');
  assert.equal(textOf(panel.get('sheet-primary')).trim(), '申請上架');
  assert.ok(panel.get('sheet-primary').classList.contains('btn-primary'));
  await type(panel, fieldControl(panel, '送審附註'), ' 請審核 ');
  await panel.get('sheet-primary').fire('click');
  await settle();
  assert.deepEqual(dev('rc.dev.submitReview').map(c => c.input), [{ versionId: 14, comment: '請審核' }]);
  assert.equal(hidden(panel, 'sheet-layer'), true);
  assert.equal(toastOf(panel).text, '已申請上架，等待管理者審核');
  assert.equal(dev('rc.dev.listMyPackages').length, 2);
});

test('取回申請 sheet：說明與選填附註，送出 withdrawReview', async () => {
  const { panel, dev } = await start();
  await toggleMore(rowOf(panel, 13)).fire('click');
  await choose(panel, '取回申請…');
  assert.equal(textOf(panel.get('sheet-title')).replace(/\s+/g, ' ').trim(), '取回申請 示範工具包 1.0.2');
  assert.match(sheetText(panel), /取回後版本回到 Preview，可以修改後再次申請上架。/);
  assert.match(sheetText(panel), /附註（選填）/);
  assert.equal(textOf(panel.get('sheet-primary')).trim(), '取回申請');
  await panel.get('sheet-primary').fire('click');
  await settle();
  assert.deepEqual(dev('rc.dev.withdrawReview').map(c => c.input), [{ versionId: 13, comment: '' }]);
  assert.equal(toastOf(panel).text, '已取回申請');
});

test('送出失敗：錯誤顯示在 sheet 內並保留輸入，sheet 不關閉；Esc 與取消可關閉', async () => {
  const { panel } = await start({ extra: { 'rc.dev.submitReview': () => { throw Object.assign(new Error('版本狀態不允許申請上架'), { code: 'invalid_params' }); } } });
  await toggleMore(rowOf(panel, 14)).fire('click');
  await choose(panel, '申請上架…');
  await type(panel, fieldControl(panel, '送審附註'), '附註內容');
  await panel.get('sheet-primary').fire('click');
  await settle();
  assert.equal(hidden(panel, 'sheet-layer'), false);
  assert.equal(textOf(panel.get('sheet-error')).trim(), '版本狀態不允許申請上架');
  assert.equal(hidden(panel, 'sheet-error'), false);
  assert.equal(fieldControl(panel, '送審附註').value, '附註內容');
  assert.equal(panel.get('sheet-primary').disabled, false, '可以重試');
  await panel.document.fire('keydown', { key: 'Escape' });
  assert.equal(hidden(panel, 'sheet-layer'), true);
});

test('並行衝突（conflict）：顯示伺服器訊息、關閉 sheet 並重新讀取清單', async () => {
  const { panel, dev } = await start({ extra: { 'rc.dev.withdrawReview': () => { throw Object.assign(new Error('目前版本並非送審中'), { code: 'conflict' }); } } });
  await toggleMore(rowOf(panel, 13)).fire('click');
  await choose(panel, '取回申請…');
  await panel.get('sheet-primary').fire('click');
  await settle();
  assert.equal(hidden(panel, 'sheet-layer'), true);
  assert.deepEqual(toastOf(panel), { text: '目前版本並非送審中', kind: 'toast error' });
  assert.equal(dev('rc.dev.listMyPackages').length, 2);
  const direct = await start({ extra: { 'rc.dev.setEnabled': () => { throw Object.assign(new Error('版本已被刪除'), { code: 'conflict' }); } } });
  await toggleMore(rowOf(direct.panel, 13)).fire('click');
  await choose(direct.panel, '停用此版本');
  assert.equal(toastOf(direct.panel).text, '版本已被刪除');
  assert.equal(direct.dev('rc.dev.listMyPackages').length, 2, '直接操作遇到衝突也重新讀取');
});

test('工作階段失效：sheet 與直接操作都回到登入流程（重新讀取工作階段）', async () => {
  const expired = () => { throw Object.assign(new Error('登入已過期'), { code: 'session_expired' }); };
  const { panel, calls } = await start({ extra: { 'rc.dev.submitReview': expired, 'rc.dev.setEnabled': expired } });
  const sessions = () => calls.filter(c => c.method === 'rc.session.getState').length;
  const before = sessions();
  await toggleMore(rowOf(panel, 14)).fire('click');
  await choose(panel, '申請上架…');
  await panel.get('sheet-primary').fire('click');
  await settle();
  assert.equal(hidden(panel, 'sheet-layer'), true);
  assert.equal(sessions(), before + 1);
  await toggleMore(rowOf(panel, 13)).fire('click');
  await choose(panel, '停用此版本');
  assert.equal(sessions(), before + 2);
});

test('編輯資訊 sheet：帶入目前值、名稱必填、標籤以逗號分隔，儲存呼叫 updatePackage', async () => {
  const { panel, dev } = await start();
  await byClass(findByData(card(panel, 'example.kit'), 'role', 'package-name').parent.parent, 'dev-more')[0].fire('click');
  await choose(panel, '編輯資訊');
  assert.equal(textOf(panel.get('sheet-title')).replace(/\s+/g, ' ').trim(), '編輯資訊 example.kit');
  assert.ok(byClass(panel.get('sheet-title'), 'mono').length === 1, '識別碼以等寬字顯示');
  assert.deepEqual(['名稱', '描述', '分類', '標籤（以逗號分隔）'].map(l => fieldControl(panel, l).value), ['示範工具包', '示範說明', '文件工具', '備標, Word']);
  assert.equal(textOf(panel.get('sheet-primary')).trim(), '儲存');
  await type(panel, fieldControl(panel, '名稱'), '   ');
  assert.equal(panel.get('sheet-primary').disabled, true, '名稱空白不能儲存');
  await type(panel, fieldControl(panel, '名稱'), ' 新名稱 ');
  assert.equal(panel.get('sheet-primary').disabled, false);
  await type(panel, fieldControl(panel, '標籤'), '甲, 乙,丙');
  await type(panel, fieldControl(panel, '描述'), '新的說明');
  await panel.get('sheet-primary').fire('click');
  await settle();
  assert.deepEqual(dev('rc.dev.updatePackage').map(c => c.input), [{ packageKey: 'example.kit', name: '新名稱', description: '新的說明', category: '文件工具', tags: '甲, 乙,丙' }]);
  assert.equal(toastOf(panel).text, '已儲存資源包資訊');
  assert.equal(hidden(panel, 'sheet-layer'), true);
  assert.equal(dev('rc.dev.listMyPackages').length, 2);
});

test('刪除此版本 sheet：警告文字、輸入完整版號與 1–500 字原因才啟用紅色實心「刪除」', async () => {
  const { panel, dev } = await start();
  await toggleMore(rowOf(panel, 12)).fire('click');
  await choose(panel, '刪除此版本…');
  assert.equal(textOf(panel.get('sheet-title')).replace(/\s+/g, ' ').trim(), '刪除此版本 示範工具包 1.0.1（Preview）');
  assert.match(sheetText(panel), /刪除後無法復原，之後也不能再用 1\.0\.1 這個版號上傳。/);
  assert.match(sheetText(panel), /輸入版號 1\.0\.1 確認/);
  assert.match(sheetText(panel), /刪除原因（1–500 字）/);
  const primary = panel.get('sheet-primary');
  assert.equal(textOf(primary).trim(), '刪除');
  assert.ok(primary.classList.contains('btn-danger') && !primary.classList.contains('btn-primary'), '紅色實心');
  assert.equal(primary.disabled, true);
  await type(panel, fieldControl(panel, '輸入版號'), '1.0.1');
  assert.equal(primary.disabled, true, '還沒填原因');
  await type(panel, fieldControl(panel, '刪除原因'), '   ');
  assert.equal(primary.disabled, true, '空白原因不算');
  await type(panel, fieldControl(panel, '刪除原因'), '打包錯誤');
  assert.equal(primary.disabled, false);
  await type(panel, fieldControl(panel, '輸入版號'), '1.0');
  assert.equal(primary.disabled, true, '版號必須完整相同');
  await type(panel, fieldControl(panel, '輸入版號'), '1.0.1');
  await type(panel, fieldControl(panel, '刪除原因'), 'x'.repeat(501));
  assert.equal(primary.disabled, true, '原因超過 500 字');
  await type(panel, fieldControl(panel, '刪除原因'), '打包錯誤，改由新版本取代');
  await primary.fire('click');
  await settle();
  assert.deepEqual(dev('rc.dev.deleteVersion').map(c => c.input), [{ packageKey: 'example.kit', version: '1.0.1', comment: '打包錯誤，改由新版本取代', confirmationVersion: '1.0.1' }]);
  assert.equal(toastOf(panel).text, '已刪除 1.0.1');
  assert.equal(hidden(panel, 'sheet-layer'), true);
  assert.equal(dev('rc.dev.listMyPackages').length, 2);
});

test('刪除失敗：訊息顯示在 sheet 內，輸入保留', async () => {
  const { panel } = await start({ extra: { 'rc.dev.deleteVersion': () => { throw Object.assign(new Error('只有市集管理員才能刪除正式發行版本'), { code: 'forbidden' }); } } });
  await toggleMore(rowOf(panel, 12)).fire('click');
  await choose(panel, '刪除此版本…');
  await type(panel, fieldControl(panel, '輸入版號'), '1.0.1');
  await type(panel, fieldControl(panel, '刪除原因'), '原因');
  await panel.get('sheet-primary').fire('click');
  await settle();
  assert.equal(textOf(panel.get('sheet-error')).trim(), '只有市集管理員才能刪除正式發行版本');
  assert.equal(fieldControl(panel, '輸入版號').value, '1.0.1');
  assert.equal(fieldControl(panel, '刪除原因').value, '原因');
  assert.equal(hidden(panel, 'sheet-layer'), false);
});

test('403：顯示無權限說明、停用「打包並上傳…」，「從資料夾安裝…」維持可用', async () => {
  const { panel } = await start({ list: { forbidden: true, packages: [] } });
  const box = findByData(panel.get('developer-list'), 'role', 'developer-empty');
  assert.match(textOf(box), /🔒/);
  assert.match(textOf(box), /沒有資源包上傳權限/);
  assert.match(textOf(box), /你的帳號沒有資源包上傳權限，請洽市集管理者。仍可用「從資料夾安裝」在本機測試。/);
  assert.equal(panel.get('btn-dev-upload').disabled, true);
  assert.equal(panel.get('btn-dev-install').disabled, false);
  assert.equal(findByData(panel.get('developer-list'), 'role', 'developer-heading'), null);
});

test('沒有資源包：顯示空狀態，「打包並上傳…」維持可用', async () => {
  const { panel } = await start({ list: { forbidden: false, packages: [] } });
  assert.match(textOf(findByData(panel.get('developer-list'), 'role', 'developer-empty')), /尚無資源包。用「打包並上傳…」上傳第一個版本/);
  assert.equal(panel.get('btn-dev-upload').disabled, false);
});

test('讀取失敗：顯示原因與重新讀取，按下後重試成功；↻ 也重新讀取', async () => {
  let failing = true;
  const { panel, dev } = await start({ extra: { 'rc.dev.listMyPackages': async () => {
    if (failing) throw Object.assign(new Error('無法連線到市集'), { code: 'unreachable' });
    return { forbidden: false, packages: [second()] };
  } } });
  assert.equal(textOf(panel.get('developer-status')).trim(), '無法連線到市集');
  assert.equal(hidden(panel, 'developer-retry'), false);
  assert.equal(panel.get('developer-list').children.length, 0);
  failing = false;
  await panel.get('developer-retry').fire('click');
  await settle();
  assert.equal(textOf(panel.get('developer-status')).trim(), '');
  assert.equal(hidden(panel, 'developer-retry'), true);
  assert.equal(cards(panel).length, 1);
  await panel.get('btn-refresh').fire('click');
  await settle();
  assert.equal(dev('rc.dev.listMyPackages').length, 3);
});

test('讀取中先顯示「載入我的資源包中…」', async () => {
  let release;
  const { panel } = await start({ wait: false, extra: { 'rc.dev.listMyPackages': () => new Promise(resolve => { release = () => resolve({ forbidden: false, packages: [] }); }) } });
  assert.equal(textOf(panel.get('developer-status')).trim(), '載入我的資源包中…');
  release(); await settle();
  assert.equal(textOf(panel.get('developer-status')).trim(), '');
});

test('讀取時工作階段失效：重新讀取工作階段', async () => {
  const { panel, calls } = await start({ extra: { 'rc.dev.listMyPackages': () => { throw Object.assign(new Error('登入已過期'), { code: 'session_expired' }); } } });
  assert.equal(calls.filter(c => c.method === 'rc.session.getState').length, 2);
  assert.equal(hidden(panel, 'developer-retry'), true);
});

test('登出會清掉清單、sheet 與浮動選單，換帳號後不殘留', async () => {
  const { panel } = await start();
  await toggleMore(rowOf(panel, 14)).fire('click');
  await choose(panel, '申請上架…');
  assert.equal(hidden(panel, 'sheet-layer'), false);
  panel.window.RcPanel.resetDeveloper();
  assert.equal(hidden(panel, 'sheet-layer'), true);
  assert.equal(panel.get('developer-list').children.length, 0);
  assert.equal(panel.get('sheet-body').children.length, 0);
});

test('版面與樣式：popover 與 sheet 在 index.html、徽章配色、窄寬度版型都已定義', async () => {
  const [html, css] = await Promise.all(['index.html', 'panel.css'].map(f => readFile(new URL(`../panel/${f}`, import.meta.url), 'utf8')));
  assert.match(html, /<div id="sheet-layer" class="confirm-layer hidden"/);
  assert.match(html, /<div id="popover" class="popover-menu hidden" role="menu">/);
  assert.match(html, /<script src="js\/sheet\.js"><\/script>/);
  assert.ok(html.indexOf('id="developer-local"') < html.indexOf('id="developer-list"'), '本機開發中容器在伺服器清單之上');
  for (const kind of ['b-rel', 'b-pre', 'b-rev', 'b-rej', 'b-off']) assert.match(css, new RegExp(`\\.${kind} \\{`));
  assert.match(css, /\.dev-vsep \{[^}]*margin: 3px calc\(-1 \* var\(--card-pad\)\) 0/);
  assert.match(css, /\.dev-vrow \{[^}]*border-left: 3px solid transparent/, '版本列左側預留 3px 色條位置');
  assert.match(css, /\.dev-vrow\.is-off \{ border-left-color: var\(--muted\); \}/, '停用的版本列灰色色條');
  assert.match(css, /\.dev-card\.is-off \{ border-left-color: var\(--muted\); \}/, '全部停用的卡片灰色色條');
  assert.match(css, /\.dev-vtime \{[^}]*margin-left: auto;[^}]*white-space: nowrap/, '時間靠右、不斷行');
  assert.match(css, /\.dev-vgap \{[^}]*border-top: 1px dashed[^}]*border-bottom: 1px dashed/, '中間還有 N 個版本的虛線');
  assert.match(css, /\.menu-item\.is-primary \{[^}]*font-weight: 600/, '主要動作藍色粗體');
  assert.match(css, /@media \(max-width: 260px\) \{[\s\S]*\.dev-card \{ --card-pad: 8px/);
  assert.match(css, /\.popover-menu \{[^}]*max-width: calc\(100vw - 16px\)/, '窄側欄不超出面板');
  assert.match(css, /\.dev-vtop \{[^}]*flex-wrap: wrap/, '三個徽章加 ⋯ 在 220 px 可換行');
});

test('通用 sheet：執行中取消與 Esc 不關閉、按鈕顯示 busyLabel；onPrimary 回傳 false 保持開啟；validate 隨輸入更新', async () => {
  const { panel } = await start();
  const RC = panel.window.RcPanel;
  let finish;
  const input = RC.el('input', { type: 'text' });
  const handle = RC.openSheet({ title: '測試', subtitle: 'sub', body: [RC.sheetField('欄位', input, { hint: '提示' })], primaryLabel: '送出', busyLabel: '送出中…',
    validate: () => input.value === 'ok', onPrimary: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(panel.get('sheet-primary').disabled, true);
  await type(panel, input, 'ok');
  assert.equal(panel.get('sheet-primary').disabled, false);
  const pending = panel.get('sheet-primary').fire('click');
  await settle();
  assert.equal(textOf(panel.get('sheet-primary')).trim(), '送出中…');
  assert.equal(panel.get('sheet-primary').disabled, true);
  assert.equal(panel.get('sheet-cancel').disabled, true);
  RC.cancelSheet();
  assert.equal(RC.sheetOpen(), true, '執行中不能取消');
  finish(false);
  await pending;
  assert.equal(RC.sheetOpen(), true, 'onPrimary 回傳 false 保持開啟');
  assert.equal(textOf(panel.get('sheet-primary')).trim(), '送出');
  handle.setPrimary({ label: '下一步', kind: 'danger' });
  assert.ok(panel.get('sheet-primary').classList.contains('btn-danger'));
  handle.setError('錯誤');
  assert.equal(textOf(panel.get('sheet-error')).trim(), '錯誤');
  RC.cancelSheet();
  assert.equal(RC.sheetOpen(), false);
  assert.equal(panel.get('sheet-body').children.length, 0);
});
