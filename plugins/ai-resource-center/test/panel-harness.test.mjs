import test from 'node:test';
import assert from 'node:assert/strict';
import { Element, findByData, findAllByData, startPanel } from './panel-harness.mjs';
import { startWorker } from './harness.mjs';

test('data 屬性可雙向同步，並在多層子樹依名稱與完整值定位', () => {
  const root = new Element(), wrapper = new Element(), first = new Element(), second = new Element();
  first.dataset.targetId = 'claude|global|C:\\profiles\\"work"';
  second.setAttribute('data-target-id', 'codex|global');
  first.setAttribute('aria-label', '目標');
  wrapper.append(second); root.append(first, wrapper);
  assert.equal(first.getAttribute('data-target-id'), first.dataset.targetId);
  assert.equal(second.dataset.targetId, 'codex|global');
  second.dataset.targetId = 'codex|project';
  assert.equal(second.getAttribute('data-target-id'), 'codex|project');
  assert.equal(first.getAttribute('aria-label'), '目標');
  assert.equal(first.getAttribute('missing'), null);
  assert.deepEqual(findAllByData(root, 'target-id'), [first, second]);
  assert.equal(findByData(root, 'target-id', first.dataset.targetId), first);
  assert.equal(findByData(root, 'target-id', 'codex|project'), second);
  assert.equal(findByData(root, 'target-id', 'missing'), null);
  assert.deepEqual(findAllByData(root, 'target-id', 'missing'), []);
});

test('面板主機替身記錄外部連結、手動計時與可見度事件，可注入開啟失敗', async () => {
  const panel = await startPanel(async () => ({ signedIn: false }));
  await panel.window.orca.shell.openExternal('https://guide.example.com');
  assert.deepEqual(panel.externalUrls, ['https://guide.example.com']);
  let ticks = 0;
  const id = panel.window.setInterval(() => { ticks += 1; }, 15000);
  assert.deepEqual(panel.timers.calls, [{ method: 'setInterval', id, delay: 15000 }]);
  assert.equal(ticks, 0);
  await panel.timers.fire(id); await panel.timers.fire(id);
  assert.equal(ticks, 2);
  panel.window.clearInterval(id);
  await panel.timers.fire(id);
  assert.equal(ticks, 2);
  assert.deepEqual(panel.timers.calls.at(-1), { method: 'clearInterval', id });
  const visibility = [];
  const listener = () => visibility.push([panel.document.visibilityState, panel.document.hidden]);
  panel.document.addEventListener('visibilitychange', listener);
  await panel.setVisibility('hidden'); await panel.setVisibility('visible');
  panel.document.removeEventListener('visibilitychange', listener);
  await panel.setVisibility('hidden');
  assert.deepEqual(visibility, [['hidden', true], ['visible', false]]);
  const failing = await startPanel(async () => ({ signedIn: false }), { openExternal: async () => { throw new Error('無法開啟'); } });
  await assert.rejects(failing.window.orca.shell.openExternal('https://guide.example.com'), /無法開啟/);
  assert.deepEqual(failing.externalUrls, ['https://guide.example.com']);
  assert.deepEqual(await panel.window.orca.shell.openExternal('https://guide.example.com'), { opened: true });
  const declined = await startPanel(async () => ({ signedIn: false }), { openExternal: async () => ({ opened: false, reason: 'cancelled' }) });
  assert.deepEqual(await declined.window.orca.shell.openExternal('https://guide.example.com'), { opened: false, reason: 'cancelled' });
  const start = panel.clock.now;
  panel.clock.advance(600000);
  assert.equal(panel.clock.now - start, 600000);
});

test('worker 通知使用 Orca host 契約，記錄呼叫且拒絕未預期能力', async t => {
  const worker = startWorker(); t.after(() => worker.dispose());
  const payload = { title: '可更新', body: '有 3 個資源包可更新' };
  await worker.orca.host.call('notifications.show', payload);
  assert.deepEqual(worker.state.hostCalls, [{ method: 'notifications.show', input: payload }]);
  await assert.rejects(worker.orca.host.call('unexpected.method'), /unexpected host call/);
  const failing = startWorker({ hostCall: async () => { throw new Error('通知失敗'); } });
  t.after(() => failing.dispose());
  await assert.rejects(failing.orca.host.call('notifications.show', payload), /通知失敗/);
  assert.deepEqual(failing.state.hostCalls, [{ method: 'notifications.show', input: payload }]);
});
