import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel, settle, textOf, findByData, findAllByData } from './panel-harness.mjs';

const base = { packageKey: 'meeting', name: '會議紀錄整理', type: 'skill', description: '整理逐字稿、錄音與白板圖片', latestVisibleVersion: '1.3.0', installationStatus: 'notInstalled', deployments: [] };
async function start(items = [base]) {
  let sent = false;
  const calls = [];
  const panel = await startPanel(async (method, input) => {
    calls.push({ method, input });
    if (method === 'rc.session.getState') return { signedIn: true, account: 'alice' };
    if (method === 'rc.preferences.get') return { showPreview: true };
    if (method === 'rc.ai.settings.get') return { enabled: true, activeEndpointId: 'sample', endpoints: [{ id: 'sample', model: 'sample-model' }] };
    if (method === 'rc.catalog.list') return { data: input.search ? [] : items };
    if (method === 'rc.ai.chat.clear') { sent = false; return {}; }
    if (method === 'rc.ai.chat.send') { sent = true; return { streamId: 'sample' }; }
    if (method === 'rc.ai.chat.poll') return { running: false, messages: sent ? [
      { role: 'user', text: '整理會議' },
      { role: 'assistant', text: '推薦這些資源包', packageKeys: items.map(p => p.packageKey) }
    ] : [] };
    if (method === 'rc.package.getDetails') return { ...items.find(p => p.packageKey === input.packageKey), selectedVersion: '1.3.0', readme: '# 使用說明', versions: [] };
    return {};
  });
  panel.get('catalog-search').value = '沒有符合的搜尋';
  await panel.get('catalog-search').fire('keydown', { key: 'Enter' });
  await panel.get('btn-ai').fire('click');
  await settle();
  await panel.get('ai-chat-chips').children[0].fire('click');
  return { panel, calls, cards: () => findAllByData(panel.get('ai-chat-messages'), 'package-key') };
}

test('回答下方的卡片沿用目錄資料，不受搜尋篩選影響，僅提供查看按鈕', async () => {
  const { panel, cards } = await start();
  assert.equal(cards().length, 1);
  const card = cards()[0];
  assert.equal(panel.get('ai-chat-messages').children[1].contains(card), true);
  assert.match(textOf(card), /📦 會議紀錄整理.*v1\.3\.0.*整理逐字稿、錄音與白板圖片.*未安裝.*查看 ›/);
  assert.equal(findAllByData(card, 'action').length, 1);
  assert.equal(findByData(card, 'action', 'view-package').tagName, 'button');
});

test('查看開啟現有詳細頁，放大閱讀後返回對話仍保留內容、輸入與捲動位置', async () => {
  const { panel, cards, calls } = await start();
  const before = textOf(panel.get('ai-chat-messages'));
  panel.get('ai-chat-scroll').scrollHeight = 900;
  panel.get('ai-chat-scroll').scrollTop = 123;
  panel.get('ai-chat-question').value = '接著想問';
  await findByData(cards()[0], 'action', 'view-package').fire('click');
  assert.equal(panel.get('view-details').classList.contains('hidden'), false);
  assert.equal(calls.filter(c => c.method === 'rc.package.getDetails').at(-1).input.packageKey, 'meeting');
  assert.match(textOf(panel.get('details-readme')), /使用說明/);
  assert.equal(panel.get('btn-back').getAttribute('aria-label'), '返回對話');
  await panel.get('btn-reader').fire('click');
  assert.equal(panel.get('btn-back').getAttribute('aria-label'), '返回明細');
  await panel.get('btn-back').fire('click');
  assert.equal(panel.get('view-details').classList.contains('hidden'), false);
  await panel.get('btn-back').fire('click');
  await settle();
  assert.equal(panel.get('view-ai-chat').classList.contains('hidden'), false);
  assert.equal(textOf(panel.get('ai-chat-messages')), before);
  assert.equal(panel.get('ai-chat-scroll').scrollTop, 123);
  assert.equal(panel.get('ai-chat-question').value, '接著想問');
  assert.equal(calls.filter(c => c.method === 'rc.ai.chat.clear').length, 1);
});

test('推薦卡片的已安裝、可更新與開發中版本文字和目錄一致，清除後仍能再次推薦', async () => {
  const items = [
    { ...base, installationStatus: 'current', deployments: [{ version: '1.3.0' }] },
    { ...base, packageKey: 'update', installationStatus: 'updateAvailable', deployments: [{ version: '1.0.0', status: 'updateAvailable', updateVersion: '1.3.0' }] },
    { ...base, packageKey: 'dev', devVersion: '1.4.0', installationStatus: 'current', deployments: [{ version: '1.4.0' }] }
  ];
  const { panel, cards } = await start(items);
  const statuses = () => cards().map(c => textOf(findByData(c, 'role', 'status-text')).replace(/\s+/g, ' ').trim());
  assert.deepEqual(statuses(), ['已安裝 1.3.0', '可更新 1.0.0 → 1.3.0', '開發中 1.4.0']);
  await panel.get('btn-ai-clear').fire('click');
  assert.equal(cards().length, 0);
  await panel.get('ai-chat-chips').children[0].fire('click');
  assert.deepEqual(statuses(), ['已安裝 1.3.0', '可更新 1.0.0 → 1.3.0', '開發中 1.4.0']);
});

test('推薦卡片在名稱下方顯示和目錄卡片相同的資訊列：擁有者 · 安裝次數 · 上傳日期', async () => {
  const { cards } = await start([{ ...base, owner: 'alice', installCount: 24, lastUploadedAt: '2026-11-20T03:00:00Z' }]);
  const card = cards()[0];
  const meta = findByData(card, 'role', 'meta');
  assert.ok(meta, '有資訊列');
  assert.equal(textOf(findByData(meta, 'meta', 'owner')).trim(), 'alice');
  assert.equal(textOf(findByData(meta, 'meta', 'installs')).trim(), '24 次');
  assert.match(textOf(findByData(meta, 'meta', 'date')), /2026-11-20/);
  const order = card.children.map(n => n.getAttribute?.('data-role') ?? n.className);
  assert.equal(order.indexOf('meta'), 1, '資訊列在名稱列之後、說明之前');
});

test('沒有擁有者、安裝次數與日期時不顯示空白資訊列', async () => {
  const { cards } = await start();
  assert.equal(findByData(cards()[0], 'role', 'meta'), null);
});
