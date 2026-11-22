import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, createHostState } from './harness.mjs';

test('偏好以外掛儲存區持久保存，欄位切換採預設方向，無效輸入整批拒絕', async t => {
  const state = createHostState();
  const worker = startWorker({ state });
  t.after(() => worker.dispose());
  assert.deepEqual(await worker.call('rc.preferences.get'), {
    sortField: 'installCount', sortDirection: 'desc', showPreview: false, checkIntervalMinutes: 15
  });
  const expected = { sortField: 'owner', sortDirection: 'asc', showPreview: true, checkIntervalMinutes: 0 };
  assert.deepEqual(await worker.call('rc.preferences.set', { sortField: 'owner', showPreview: true, checkIntervalMinutes: 0 }), expected);
  for (const input of [[], { sortField: 'bad' }, { sortDirection: 'up' }, { showPreview: 1 }, { checkIntervalMinutes: 30 }, { unknown: true }, { showPreview: false, checkIntervalMinutes: '15' }]) {
    await assert.rejects(worker.call('rc.preferences.set', input), { code: 'invalid_params' });
    assert.deepEqual(await worker.call('rc.preferences.get'), expected);
  }
  for (const checkIntervalMinutes of [15, 60, 240, 1440, 0]) await worker.call('rc.preferences.set', { checkIntervalMinutes });
  const reopened = startWorker({ state });
  t.after(() => reopened.dispose());
  assert.deepEqual(await reopened.call('rc.preferences.get'), expected);
});
