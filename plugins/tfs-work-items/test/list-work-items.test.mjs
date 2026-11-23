import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import activate from '../worker/index.mjs';
import { startMockTfs, makeItems } from './mock-tfs.mjs';

const closers = [];
after(async () => { for (const c of closers) await c(); });

// 最小的假 Orca，只提供 listWorkItems 會用到的設定與祕密
async function boot(items) {
  const tfs = await startMockTfs({ items });
  closers.push(tfs.close);
  const handlers = new Map();
  const settings = { tfsUrl: tfs.url, project: '', apiVersion: '5.0', allowInsecureTls: false, authMode: 'pat', defaultAgent: 'claude' };
  activate({
    log() {},
    settings: { get: async (k) => (k ? settings[k] : { ...settings }), set: async (k, v) => { settings[k] = v; } },
    secrets: { get: async () => 'pat-token', set: async () => {}, delete: async () => {} },
    host: { call: async () => ({}) },
    panels: { handle: (n, f) => handlers.set(n, f), post() {} }
  });
  return { tfs, list: (input) => handlers.get('tfs.listWorkItems')(input || {}, {}) };
}

const openItems = (items) => items.filter((i) => i.state !== '已關閉');

test('工項超過 100 筆時，要回傳全部，而且 total 等於實際符合的總數', async () => {
  const { tfs, list } = await boot(makeItems()); // 350 筆，其中約 1/4 是「已關閉」
  const expected = openItems(tfs.items).length;
  assert.ok(expected > 100, '測試資料必須超過 100 筆才有意義');
  const res = await list({ scope: 'all' });
  assert.equal(res.total, expected, 'total 必須是符合條件的總筆數');
  assert.equal(res.items.length, expected, '未超過載入上限時，要完整回傳');
  assert.equal(new Set(res.items.map((i) => i.id)).size, res.items.length, '不可有重複');
});

test('各專案的筆數加總要等於全部（群組標題的數字才會正確）', async () => {
  const { tfs, list } = await boot(makeItems());
  const res = await list({ scope: 'all' });
  const counts = {};
  for (const i of res.items) counts[i.projectName] = (counts[i.projectName] || 0) + 1;
  for (const p of ['ProjA', 'ProjB', 'ProjC']) {
    assert.equal(counts[p], openItems(tfs.items).filter((i) => i.project === p).length, p);
  }
});

test('多選狀態：已提議 + 作用中 只回傳這兩種，且數量完整', async () => {
  const { tfs, list } = await boot(makeItems());
  const want = new Set(['已提議', '作用中']);
  const expected = tfs.items.filter((i) => want.has(i.state)).length;
  assert.ok(expected > 100);
  const res = await list({ scope: 'all', states: ['已提議', '作用中'] });
  assert.equal(res.total, expected);
  assert.equal(res.items.length, expected);
  assert.ok(res.items.every((i) => want.has(i.state)));
  assert.ok(res.items.some((i) => i.state === '已提議') && res.items.some((i) => i.state === '作用中'));
});

test('單一狀態（舊的 state 參數）仍然可用', async () => {
  const { tfs, list } = await boot(makeItems());
  const res = await list({ scope: 'all', state: '作用中' });
  assert.equal(res.total, tfs.items.filter((i) => i.state === '作用中').length);
  assert.ok(res.items.every((i) => i.state === '作用中'));
});

test('選到已關閉類狀態時，仍然不會顯示已關閉的工項', async () => {
  const { list } = await boot(makeItems());
  const res = await list({ scope: 'all', states: ['已關閉'] });
  assert.equal(res.total, 0);
  assert.equal(res.items.length, 0);
});

test('單引號等特殊字元的狀態名稱不會破壞查詢', async () => {
  const items = makeItems({ perProject: { ProjA: 20 } });
  items[0].state = "Won't fix";
  const { list } = await boot(items);
  const res = await list({ scope: 'all', states: ["Won't fix"] });
  assert.equal(res.items.length, 1);
});

test('超過載入上限時：total 仍是真實總數，並標示被截斷，且載入的是最近更新的', async () => {
  const items = makeItems({ perProject: { ProjA: 1700 } });
  const { tfs, list } = await boot(items);
  const expected = openItems(tfs.items);
  const res = await list({ scope: 'all' });
  assert.equal(res.total, expected.length);
  assert.ok(res.items.length < res.total, '應該被截斷');
  assert.equal(res.truncated, true);
  assert.equal(res.loaded, res.items.length);
  // 載入的必須是「最近更新」的前 N 筆
  const newest = expected.slice().sort((a, b) => (a.changed < b.changed ? 1 : -1)).slice(0, res.items.length).map((i) => i.id);
  assert.deepEqual(res.items.map((i) => i.id), newest);
  // 取明細時，每次請求不可超過 200 筆
  const batches = tfs.log.filter((r) => r.path.endsWith('/_apis/wit/workitems'));
  assert.ok(batches.length >= 2);
  for (const b of batches) assert.ok(new URL(`http://x${b.search ? '/' + b.search : ''}`).searchParams.get('ids').split(',').length <= 200);
});

test('沒有符合的工項：total 為 0，不會呼叫明細端點', async () => {
  const { tfs, list } = await boot(makeItems());
  const res = await list({ scope: 'all', search: '不存在的關鍵字' });
  assert.equal(res.total, 0);
  assert.deepEqual(res.items, []);
  assert.equal(tfs.log.filter((r) => r.path.endsWith('/_apis/wit/workitems')).length, 0);
});

test('依專案篩選時，total 與筆數都是該專案的', async () => {
  const { tfs, list } = await boot(makeItems());
  const res = await list({ scope: 'all', project: 'ProjB' });
  const expected = openItems(tfs.items).filter((i) => i.project === 'ProjB').length;
  assert.equal(res.total, expected);
  assert.equal(res.items.length, expected);
});

test('#ID 直接查詢：只回傳那一筆，total 為 1；找不到時為 0 筆', async () => {
  const items = makeItems();
  const { list } = await boot(items);
  const hit = await list({ search: `#${items[5].id}` });
  assert.equal(hit.total, 1);
  assert.deepEqual(hit.items.map((i) => i.id), [items[5].id]);
  assert.equal(hit.truncated, false);
  await assert.rejects(list({ search: '#99999999' }), /TF401232|404/);
});
