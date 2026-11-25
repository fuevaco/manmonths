import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startWorker, leakedSecrets } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { startPanel, textOf, createManualIntervals, findAllByData } from './panel-harness.mjs';

const delta = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
async function fixture(t, respond, deps = {}, select = (req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '{"keys":["demo"]}' } }] }))) {
  const market = await startFakeMarket({ packages: [{ packageKey: 'demo', type: 'skill', name: '示範資源包', description: '整理會議', latestReleaseVersion: '1.0.0' }] });
  market.override('GET /api/market/packages/demo/versions/1.0.0/readme', () => ({ status: 200, body: { readme: '會議整理說明' } }));
  const requests = [], selections = [];
  let modelChecks = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { modelChecks++; return res.end(JSON.stringify({ data: [{ id: 'sample-model' }] })); }
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    if (!payload.stream) { selections.push(payload); return select(req, res, payload); }
    requests.push({ ...payload, authorization: req.headers.authorization, url: req.url });
    respond(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const worker = startWorker({ deps });
  t.after(async () => { worker.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await market.close(); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const saved = await worker.call('rc.ai.settings.save', { endpoint: { name: '示範服務', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'sample-model', pat: 'synthetic-chat-secret' } });
  await worker.call('rc.ai.settings.save', { activeEndpointId: saved.endpoints[0].id });
  return { worker, market, requests, selections, checks: () => modelChecks };
}
async function until(read, predicate) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(JSON.stringify(await read()));
}
const poll = (worker, streamId) => worker.call('rc.ai.chat.poll', { streamId });

test('對話的單次請求逾時計時器不維持程序存活', async t => {
  const { worker } = await fixture(t, () => {}, { aiChatTimeoutMs: 41 });
  const timers = [], original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    const timer = original(fn, ms, ...args);
    if (ms === 41) timers.push(timer);
    return timer;
  });
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
  await until(async () => timers.length > 0, Boolean);
  assert.equal(timers[0].hasRef(), false);
  const result = await until(() => poll(worker, streamId), r => !r.running);
  assert.match(result.messages.at(-1).error, /逾時/);
});

test('對話送出系統提示與資源清單，跨 chunk SSE 逐步回覆並隱藏資源包標記', async t => {
  let finish;
  const { worker, requests } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = delta('推薦 **示範資源包** [[pkg:demo]]');
    res.write(frame.slice(0, 9)); res.write(frame.slice(9));
    finish = () => res.end(delta('。[[pkg:missing]][[pkg:demo]]') + 'data: [DONE]\n\n');
  });
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '整理會議' });
  assert.equal((await poll(worker, streamId)).phase, '找尋相關資源包中…');
  const partial = await until(() => poll(worker, streamId), r => r.messages.at(-1)?.text.includes('示範'));
  assert.equal(partial.phase, '回覆中…');
  assert.equal(partial.messages.at(-1).text, '推薦 **示範資源包** ');
  finish();
  const done = await until(() => poll(worker, streamId), r => !r.running);
  assert.equal(done.messages.at(-1).text, '推薦 **示範資源包** 。');
  assert.deepEqual(done.messages.at(-1).packageKeys, ['demo']);
  assert.equal(done.catalog.packageCount, 1);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer synthetic-chat-secret');
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].model, 'sample-model');
  for (const expected of ['任務型', '清單', '沒有', '無關', '繁體中文', '[[pkg:<packageKey>]]', '**名稱** [[pkg:key]]', '不可取代名稱', '示範資源包', '整理會議']) assert.ok(requests[0].messages[0].content.includes(expected), expected);
  assert.deepEqual(leakedSecrets(worker.state.transcript, ['synthetic-chat-secret']), []);
});

test('資源包標記取代名稱時補回主詞，附近已有名稱則移除標記', async t => {
  const cases = [
    ['你可以用 [[pkg:demo]]，它提供整理。', '你可以用 **示範資源包**，它提供整理。'],
    ['**示範資源包** [[pkg:demo]]，它提供整理。', '**示範資源包** ，它提供整理。'],
    ['示範資源包' + '。'.repeat(41) + '[[pkg:demo]]', '示範資源包' + '。'.repeat(41) + '**示範資源包**'],
    ['[[pkg:demo]][[pkg:demo]][[pkg:missing]]', '**示範資源包**']
  ];
  for (const [raw, expected] of cases) {
    const { worker } = await fixture(t, (req, res) => res.end(delta(raw) + 'data: [DONE]\n\n'));
    const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
    const result = await until(() => poll(worker, streamId), r => !r.running);
    assert.equal(result.messages.at(-1).text, expected);
    assert.deepEqual(result.messages.at(-1).packageKeys, ['demo']);
  }
});


test('停止中止連線並保留文字，清除後不帶舊紀錄且舊串流不能覆蓋新對話', async t => {
  let closed = false;
  const { worker, requests } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(delta('保留這段[[pk'));
    res.on('close', () => { closed = true; });
  });
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '第一問' });
  await until(() => poll(worker, streamId), r => r.messages.at(-1)?.text.includes('保留'));
  const stopped = await worker.call('rc.ai.chat.stop', { streamId });
  assert.equal(stopped.running, false);
  assert.equal(stopped.messages.at(-1).text, '保留這段[[pk');
  await until(async () => closed, Boolean);
  const cleared = await worker.call('rc.ai.chat.clear');
  assert.deepEqual(cleared.messages, []);
  await worker.call('rc.ai.chat.send', { message: '第二問' });
  await until(async () => requests, r => r.length === 2);
  assert.deepEqual(requests[1].messages.slice(1), [{ role: 'user', content: '第二問' }]);
  await assert.rejects(poll(worker, streamId), { code: 'invalid_params' });
});

test('不完整資源包標記只在串流中隱藏，完成、停止與錯誤均保留原文及增量', async t => {
  for (const suffix of ['[[pkg:demo', '[', '[[pk']) {
    for (const ending of ['done', 'stop', 'error']) {
      let finish;
      const { worker } = await fixture(t, (req, res) => {
        res.write(delta('原文' + suffix));
        finish = () => res.end(ending === 'done' ? 'data: [DONE]\n\n' : '');
      });
      const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
      const partial = await until(() => poll(worker, streamId), r => r.messages.at(-1)?.text === '原文');
      assert.equal(partial.running, true);
      if (ending === 'stop') await worker.call('rc.ai.chat.stop', { streamId });
      else finish();
      const result = await until(() => poll(worker, streamId), r => !r.running);
      assert.equal(result.messages.at(-1).text, '原文' + suffix);
      assert.equal(Boolean(result.messages.at(-1).error), ending === 'error');
      const update = await worker.call('rc.ai.chat.poll', { streamId, offsets: partial.messages.map(m => m.text.length) });
      assert.equal(update.updates.at(-1).delta, suffix);
    }
  }
});

test('完成八輪對話後下一問只帶最近六輪，清除進行中的對話與登出都清除 worker 紀錄', async t => {
  const { worker, requests } = await fixture(t, (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'));
  for (let i = 1; i <= 9; i++) {
    const { streamId } = await worker.call('rc.ai.chat.send', { message: `問題${i}` });
    await until(() => poll(worker, streamId), r => !r.running);
  }
  assert.deepEqual(requests.at(-1).messages.slice(1).map(m => m.content), ['問題3', '回答', '問題4', '回答', '問題5', '回答', '問題6', '回答', '問題7', '回答', '問題8', '回答', '問題9']);
  await worker.call('rc.ai.chat.send', { message: '清除這問' });
  assert.deepEqual((await worker.call('rc.ai.chat.clear')).messages, []);
  await worker.call('rc.session.signOut');
  assert.deepEqual((await worker.call('rc.ai.chat.poll')).messages, []);
});

test('非 2xx、斷線、逾時與模型錯誤在對話顯示安全原因並重檢端點', async t => {
  for (const mode of ['http', 'network', 'timeout', 'model', 'incomplete']) {
    const { worker, checks } = await fixture(t, (req, res) => {
      if (mode === 'timeout') return;
      if (mode === 'network') return res.destroy();
      if (mode === 'http') { res.writeHead(401); return res.end('synthetic-chat-secret'); }
      if (mode === 'model') return res.end('data: {"error":{"message":"synthetic-chat-secret"}}\n\n');
      res.end(delta('未完成'));
    }, { aiChatTimeoutMs: 30 });
    const before = checks();
    const { streamId } = await worker.call('rc.ai.chat.send', { message: '請推薦' });
    const result = await until(() => poll(worker, streamId), r => !r.running);
    assert.match(result.messages.at(-1).error, mode === 'http' ? /HTTP 401/ : mode === 'timeout' ? /逾時/ : /無法取得/);
    await until(async () => checks(), count => count > before);
    assert.deepEqual(leakedSecrets([...worker.state.transcript, ...worker.state.logs], ['synthetic-chat-secret']), []);
  }
});

test('空白、停用或未設定端點時不可送出，重開 worker 不保留對話', async t => {
  const { worker } = await fixture(t, (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'));
  await assert.rejects(worker.call('rc.ai.chat.send', { message: '  ' }), { code: 'invalid_params' });
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
  await until(() => poll(worker, streamId), r => !r.running);
  const reopened = startWorker({ state: worker.state }); t.after(() => reopened.dispose());
  assert.deepEqual((await reopened.call('rc.ai.chat.poll')).messages, []);
  await worker.call('rc.ai.settings.save', { enabled: false });
  await assert.rejects(worker.call('rc.ai.chat.send', { message: '推薦' }), /設定/);
  await worker.call('rc.ai.settings.save', { enabled: true, activeEndpointId: null });
  await assert.rejects(worker.call('rc.ai.chat.send', { message: '推薦' }), /設定/);
});


test('跨 chunk 的資源包標記不閃現文字，卡片依推薦順序去重並忽略未知識別碼', async t => {
  let append;
  const { worker, market } = await fixture(t, (req, res) => {
    res.write(delta('推薦[[p'));
    append = text => res.write(delta(text));
  });
  market.override('GET /api/market/packages', () => ({ status: 200, body: { data: [
    { packageKey: 'demo', name: '示範資源包', type: 'skill', latestReleaseVersion: '1.0.0' },
    { packageKey: 'second', name: '第二個資源包', type: 'skill', latestReleaseVersion: '1.0.0' }
  ], meta: { total: 2 } } }));
  const timers = createManualIntervals();
  const panel = await startPanel(worker.call, { timers });
  await until(async () => panel.get('view-main').classList.contains('hidden'), hidden => !hidden);
  await panel.get('btn-ai').fire('click');
  await panel.get('ai-chat-chips').children[0].fire('click');
  const interval = timers.calls.find(c => c.delay === 250);
  const read = async () => { await timers.fire(interval.id); return textOf(panel.get('ai-chat-messages')); };
  await until(read, text => text.includes('推薦'));
  assert.ok(!textOf(panel.get('ai-chat-messages')).includes('[['));
  assert.equal(findAllByData(panel.get('ai-chat-messages'), 'package-key').length, 0);
  append('kg:second]]與[[pkg:de');
  await until(read, () => findAllByData(panel.get('ai-chat-messages'), 'package-key').length === 1);
  assert.ok(!textOf(panel.get('ai-chat-messages')).includes('[['));
  append('mo]][[pkg:missing]][[pkg:second]]');
  await until(read, () => findAllByData(panel.get('ai-chat-messages'), 'package-key').length === 2);
  assert.deepEqual(findAllByData(panel.get('ai-chat-messages'), 'package-key').map(c => c.dataset.packageKey), ['second', 'demo']);
  await panel.get('ai-chat-send').fire('click');
});

test('對話畫面提供定案開場與問題 chip，輪詢回答、停止及清除', async t => {
  const { worker } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(delta('**推薦** <script>壞內容</script> [[pkg:demo]]'));
  });
  const timers = createManualIntervals();
  const panel = await startPanel(worker.call, { timers });
  await until(async () => panel.get('view-main').classList.contains('hidden'), hidden => !hidden);
  await panel.get('btn-ai').fire('click');
  assert.match(textOf(panel.get('ai-chat-intro')), /我是.*資源中心的任務型助手.*其他問題不在我的服務範圍/);
  assert.deepEqual(panel.get('ai-chat-chips').children.map(n => n.textContent), ['怎麼把逐字稿整理成會議紀錄？', '我想自動開 TFS 工項', '有沒有畫流程圖的資源包？']);
  await panel.get('ai-chat-chips').children[1].fire('click');
  assert.equal(panel.get('ai-chat-send').textContent, '■');
  const interval = timers.calls.find(c => c.delay === 250);
  assert.ok(interval);
  await until(async () => { await timers.fire(interval.id); return textOf(panel.get('ai-chat-messages')); }, text => text.includes('推薦'));
  assert.match(textOf(panel.get('ai-chat-messages')), /我想自動開 TFS 工項/);
  assert.ok(!textOf(panel.get('ai-chat-messages')).includes('[[pkg:'));
  assert.equal(panel.get('ai-chat-messages').children.some(n => n.tagName === 'script'), false);
  assert.match(textOf(panel.get('ai-chat-messages')), /ⓘ 從 1 個資源包中挑出 1 個參考/);
  assert.match(textOf(panel.get('ai-chat-intro')), /AI 只參考最近 6 輪對話；換話題時可按 🗑 清除。/);
  await panel.get('ai-chat-send').fire('click');
  assert.equal((await worker.call('rc.ai.chat.poll')).running, false);
  await panel.get('btn-ai-clear').fire('click');
  assert.equal(panel.get('ai-chat-messages').children.length, 0);
  assert.deepEqual((await worker.call('rc.ai.chat.poll')).messages, []);
});

test('清除須等待 worker 成功，失敗保留回答與草稿、提示錯誤並可繼續輪詢及重試', async t => {
  let append, rejectClear, hold = false;
  const { worker } = await fixture(t, (req, res) => {
    res.write(delta('保留回答')); append = () => res.write(delta('後續文字'));
  });
  const timers = createManualIntervals();
  const panel = await startPanel((method, input) => {
    if (method === 'rc.ai.chat.clear' && hold) return new Promise((resolve, reject) => { rejectClear = reject; });
    return worker.call(method, input);
  }, { timers });
  await until(async () => panel.get('view-main').classList.contains('hidden'), hidden => !hidden);
  await panel.get('btn-ai').fire('click');
  await panel.get('ai-chat-chips').children[0].fire('click');
  const read = async () => {
    for (const timer of timers.calls.filter(c => c.method === 'setInterval' && c.delay === 250)) await timers.fire(timer.id);
    return textOf(panel.get('ai-chat-messages'));
  };
  await until(read, text => text.includes('保留回答'));
  const before = textOf(panel.get('ai-chat-messages'));
  panel.get('ai-chat-question').value = '尚未送出的草稿';
  hold = true;
  const clearing = panel.get('btn-ai-clear').fire('click');
  await until(async () => Boolean(rejectClear), Boolean);
  assert.equal(textOf(panel.get('ai-chat-messages')), before);
  assert.equal(panel.get('ai-chat-question').value, '尚未送出的草稿');
  rejectClear(new Error('清除失敗')); await clearing;
  assert.equal(textOf(panel.get('ai-chat-messages')), before);
  assert.match(panel.get('toast').textContent, /清除失敗/);
  append();
  await until(read, text => text.includes('後續文字'));
  hold = false;
  await panel.get('btn-ai-clear').fire('click');
  assert.equal(panel.get('ai-chat-messages').children.length, 0);
  assert.equal(panel.get('ai-chat-question').value, '');
  assert.deepEqual((await worker.call('rc.ai.chat.poll')).messages, []);
  await panel.get('ai-chat-chips').children[0].fire('click');
  await until(read, text => text.includes('保留回答'));
});

test('對話連結沿用 README 的未開啟提示、取消處理與鍵盤瀏覽器 fallback', async t => {
  const { worker } = await fixture(t, (req, res) => res.end(delta('[說明](https://docs.example/guide)') + 'data: [DONE]\n\n'));
  const timers = createManualIntervals();
  let outcome = { opened: false, reason: 'consent-unavailable' };
  const panel = await startPanel(worker.call, { timers, openExternal: async () => outcome });
  await until(async () => panel.get('view-main').classList.contains('hidden'), hidden => !hidden);
  await panel.get('btn-ai').fire('click');
  await panel.get('ai-chat-chips').children[0].fire('click');
  await until(async () => {
    for (const timer of timers.calls.filter(c => c.method === 'setInterval' && c.delay === 250)) await timers.fire(timer.id);
    return findAllByData(panel.get('ai-chat-messages'), 'action', 'external-link').length;
  }, Boolean);
  const box = panel.get('ai-chat-messages');
  const link = findAllByData(box, 'action', 'external-link')[0];
  await box.fire('click', { target: link });
  assert.deepEqual(panel.externalUrls, ['https://docs.example/guide']);
  assert.match(panel.get('toast').textContent, /Orca 視窗不在前景/);
  panel.get('toast').classList.add('hidden');
  outcome = { opened: false, reason: 'cancelled' };
  await box.fire('click', { target: link });
  assert.equal(panel.get('toast').classList.contains('hidden'), true);
  const opened = [];
  panel.window.orca.shell = undefined;
  panel.window.open = (...args) => opened.push(args);
  await box.fire('keydown', { key: 'Enter', target: link });
  assert.deepEqual(opened, [['https://docs.example/guide', '_blank', 'noopener,noreferrer']]);
});

test('輸入框 Enter 送出、Shift+Enter 與空白不送出；停用後返回對話禁止送出並提示設定', async t => {
  const { worker, requests } = await fixture(t, (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'));
  const panel = await startPanel(worker.call);
  await until(async () => panel.get('view-main').classList.contains('hidden'), hidden => !hidden);
  await panel.get('btn-ai').fire('click');
  panel.get('ai-chat-question').value = '  ';
  await panel.get('ai-chat-question').fire('keydown', { key: 'Enter' });
  panel.get('ai-chat-question').value = '問題';
  await panel.get('ai-chat-question').fire('keydown', { key: 'Enter', shiftKey: true });
  assert.equal(requests.length, 0);
  await panel.get('ai-chat-question').fire('keydown', { key: 'Enter', shiftKey: false });
  await until(async () => requests.length, n => n === 1);
  await panel.get('btn-ai-settings').fire('click');
  panel.get('ai-enabled').checked = false;
  await panel.get('ai-enabled').fire('change');
  await panel.get('btn-back').fire('click');
  await until(async () => panel.get('ai-chat-question').disabled, Boolean);
  assert.match(panel.get('ai-chat-unavailable').textContent, /AI 助手設定/);
  assert.equal(panel.get('ai-chat-unavailable').classList.contains('hidden'), false);
});

test('已有端點但停用或未選用時，AI 按鈕仍開啟對話並顯示設定提示', async t => {
  const { worker } = await fixture(t, (req, res) => res.end());
  for (const settings of [{ enabled: false }, { enabled: true, activeEndpointId: null }]) {
    await worker.call('rc.ai.settings.save', settings);
    const panel = await startPanel(worker.call);
    await until(async () => panel.get('view-main').classList.contains('hidden'), hidden => !hidden);
    await panel.get('btn-ai').fire('click');
    await until(async () => panel.get('ai-chat-question').disabled, Boolean);
    assert.equal(panel.get('view-ai-chat').classList.contains('hidden'), false);
    assert.equal(panel.get('view-ai-settings').classList.contains('hidden'), true);
    assert.equal(panel.get('ai-chat-unavailable').classList.contains('hidden'), false);
    assert.match(panel.get('ai-chat-unavailable').textContent, /AI 助手設定/);
    await panel.get('btn-ai-settings').fire('click');
    assert.equal(panel.get('view-ai-settings').classList.contains('hidden'), false);
    await panel.get('ai-enabled').fire('change');
  }
});

test('整理清單時停止仍以完整輪次保留最近六輪，清除後晚到清單不啟動模型請求', async t => {
  const { worker, market, requests } = await fixture(t, (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'));
  let release, entered = false;
  market.override('GET /api/market/packages', async () => {
    entered = true;
    return new Promise(resolve => { release = () => resolve({ status: 200, body: { data: [], meta: { total: 0 } } }); });
  });
  await worker.call('rc.ai.chat.send', { message: '等清單' });
  await until(async () => entered, Boolean);
  await worker.call('rc.ai.chat.stop');
  release();
  market.override('GET /api/market/packages', () => ({ status: 200, body: { data: [], meta: { total: 0 } } }));
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '接著問' });
  await until(() => poll(worker, streamId), r => !r.running);
  assert.deepEqual(requests[0].messages.slice(1), [{ role: 'user', content: '接著問' }]);
  entered = false;
  market.override('GET /api/market/packages', async () => {
    entered = true;
    return new Promise(resolve => { release = () => resolve({ status: 200, body: { data: [], meta: { total: 0 } } }); });
  });
  await worker.call('rc.ai.chat.send', { message: '清除這問' });
  await until(async () => entered, Boolean);
  await worker.call('rc.ai.chat.clear'); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await worker.call('rc.ai.chat.poll')).messages, []);
  assert.equal(requests.length, 1);
});

test('模型歷史只保留有效問答，排除錯誤、空白及停止時尚無回答的整輪', async t => {
  let mode = 'ok', finish;
  const { worker, requests } = await fixture(t, (req, res) => {
    if (mode === 'error') return res.end(delta('錯誤的部分文字') + 'data: {"error":{}}\n\n');
    if (mode === 'empty') return res.end(delta('  ') + 'data: [DONE]\n\n');
    if (mode === 'stop') { res.write(delta('')); finish = () => res.end(); return; }
    res.end(delta('有效回答') + 'data: [DONE]\n\n');
  });
  for (mode of ['ok', 'error', 'empty', 'stop', 'ok']) {
    const { streamId } = await worker.call('rc.ai.chat.send', { message: mode });
    if (mode === 'stop') {
      await until(async () => Boolean(finish), Boolean);
      await worker.call('rc.ai.chat.stop', { streamId }); finish();
    }
    await until(() => poll(worker, streamId), r => !r.running);
  }
  assert.deepEqual(requests.at(-1).messages.slice(1), [
    { role: 'user', content: 'ok' }, { role: 'assistant', content: '有效回答' }, { role: 'user', content: 'ok' }
  ]);
});

test('串流輪詢可依文字位移取得增量，不重傳已讀取的回答', async t => {
  let append;
  const { worker } = await fixture(t, (req, res) => {
    res.write(delta('第一段'));
    append = () => res.end(delta('第二段') + 'data: [DONE]\n\n');
  });
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '問題' });
  const first = await until(() => poll(worker, streamId), r => r.messages.at(-1)?.text === '第一段');
  append();
  await until(() => poll(worker, streamId), r => !r.running);
  const next = await worker.call('rc.ai.chat.poll', { streamId, offsets: first.messages.map(m => m.text.length) });
  assert.equal(next.messages, undefined);
  assert.equal(next.updates.at(-1).delta, '第二段');
  assert.equal(next.updates.at(-1).index, 1);
  assert.equal(next.updates.some(m => m.role === 'user'), false);
});

test('SSE 跨回應段切開 UTF-8 與事件換行時仍完整顯示，DONE 不必等待伺服器關線', async t => {
  let resume, finish, closed = false;
  const { worker } = await fixture(t, (req, res) => {
    const bytes = Buffer.from(delta('你好'));
    const split = bytes.indexOf(Buffer.from('你')) + 1;
    res.write(bytes.subarray(0, split));
    resume = () => res.write(bytes.subarray(split, bytes.length - 1));
    finish = () => res.write(bytes.subarray(bytes.length - 1).toString() + 'data: [DONE]\r\n\r\n');
    res.on('close', () => { closed = true; });
  });
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '問題' });
  await until(async () => Boolean(resume), Boolean);
  assert.equal((await poll(worker, streamId)).messages.at(-1).text, '');
  resume();
  await new Promise(resolve => setImmediate(resolve));
  finish();
  const result = await until(() => poll(worker, streamId), r => !r.running);
  assert.equal(result.messages.at(-1).text, '你好');
  await until(async () => closed, Boolean);
});

test('先以摘要挑選候選，再只讀候選 README 串流回答並保存參考資訊', async t => {
  const { worker, market, requests } = await fixture(t, (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'));
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '整理會議' });
  const result = await until(() => poll(worker, streamId), r => !r.running);
  assert.deepEqual(result.messages.at(-1).reference, { packageCount: 1, keys: ['demo'], names: ['示範資源包'], fallback: false,
    selectModel: 'sample-model', answerModel: 'sample-model', streamed: true });
  assert.match(requests[0].messages[0].content, /會議整理說明/);
  assert.equal(market.requests.filter(r => r.path.endsWith('/readme')).length, 1);
});

test('候選清單只含指定摘要欄位，最多挑五個並與上一輪合併八個，本輪優先且清除後重置', async t => {
  let keys = ['missing', 'p0', 'p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
  const { worker, market, requests, selections } = await fixture(t,
    (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'), {},
    (req, res) => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keys }) } }] })));
  const rows = Array.from({ length: 10 }, (_, i) => ({ packageKey: `p${i}`, type: 'skill', name: `資源${i}`, description: `說明${i}`, category: '文件', tags: ['整理'], latestReleaseVersion: '1.0.0' }));
  market.override('GET /api/market/packages', () => ({ status: 200, body: { data: rows, meta: { total: 10 } } }));
  for (const p of rows) market.override(`GET /api/market/packages/${p.packageKey}/versions/1.0.0/readme`, () => ({ status: 200, body: { readme: `完整${p.packageKey}` } }));
  const ask = async message => {
    const { streamId } = await worker.call('rc.ai.chat.send', { message });
    return until(() => poll(worker, streamId), r => !r.running);
  };
  const first = await ask('第一問');
  assert.equal(first.messages.at(-1).error, undefined);
  assert.deepEqual(first.messages.at(-1).reference.keys, ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.equal(selections[0].stream, false);
  assert.equal(selections[0].temperature, 0);
  assert.deepEqual(selections[0].response_format, { type: 'json_object' });
  const summaries = JSON.parse(selections[0].messages[0].content.split('\n').at(-1));
  assert.deepEqual(Object.keys(summaries[0]), ['packageKey', 'name', 'description', 'category', 'tags']);
  assert.equal(market.requests.filter(r => r.path.endsWith('/readme')).length, 5);
  keys = ['p7', 'p6', 'p5', 'p4', 'p3'];
  const second = await ask('追問');
  assert.deepEqual(second.messages.at(-1).reference.keys, ['p7', 'p6', 'p5', 'p4', 'p3', 'p0', 'p1', 'p2']);
  assert.deepEqual(second.messages[1].reference, first.messages[1].reference);
  assert.equal(selections[0].max_tokens, 200);
  assert.match(selections[0].messages[0].content, /scope 為 out 或都不符合時 keys 為空陣列/);
  const task = '\n\n任務：不要回答提問。依規則判斷 scope，並依最新提問（必要時參考先前提問）從清單挑出相關資源包，只輸出 JSON 物件 {"scope":"in"|"out","keys":[...]}。';
  assert.equal(selections[0].messages[1].content, '最新提問：第一問' + task);
  assert.equal(selections[1].messages.length, 2, '第一階段只送一則使用者訊息');
  assert.equal(selections[1].messages[1].content,
    '使用者先前的提問：\n- 第一問\n先前推薦過的資源包：p0、p1、p2、p3、p4\n\n最新提問：追問' + task, '不附助手回答，任務指示在最後');
  assert.deepEqual(requests[1].messages.slice(1).map(m => m.content), ['第一問', '回答', '追問']);
  assert.equal(market.requests.filter(r => r.path.endsWith('/readme')).length, 8);
  assert.ok(!requests[1].messages[0].content.includes('完整p8'));
  await worker.call('rc.ai.chat.clear'); keys = ['p9'];
  assert.deepEqual((await ask('新話題')).messages.at(-1).reference.keys, ['p9']);
});

test('第一階段的資源清單附上內容清單（Skill 識別碼與說明），並在提示中說明要一併比對', async t => {
  const { worker, market, selections } = await fixture(t, (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'));
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: { packageKey: 'demo', versions: [{ version: '1.0.0', channel: 'release', isEnabled: true,
    contents: [{ id: 'meeting-processor', kind: 'skill', description: '整理逐字稿' }] }] } }));
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '逐字稿' });
  await until(() => poll(worker, streamId), r => !r.running);
  const summaries = JSON.parse(selections[0].messages[0].content.split('\n').at(-1));
  assert.deepEqual(summaries[0].contents, ['meeting-processor：整理逐字稿']);
  assert.match(selections[0].messages[0].content, /contents 是資源包內含的 Skill 等內容/);
});

test('第一階段判定與資源中心無關時，直接回覆固定說明、不呼叫第二階段也不推薦', async t => {
  const { worker, requests, selections } = await fixture(t,
    (req, res) => res.end(delta('不該出現') + 'data: [DONE]\n\n'), {},
    (req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '{"scope":"out","keys":[]}' } }] })));
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '幫我寫九九乘法表' });
  const result = await until(() => poll(worker, streamId), r => !r.running);
  const answer = result.messages.at(-1);
  assert.equal(selections.length, 1);
  assert.equal(requests.length, 0, '不呼叫第二階段');
  assert.match(answer.text, /這個問題不在我的服務範圍/);
  assert.match(answer.text, /不會直接幫你寫程式、翻譯或回答一般問題/);
  assert.deepEqual(answer.packageKeys, []);
  assert.equal(answer.error, undefined);
  assert.match(selections[0].messages[0].content, /"out"：要你直接產出內容或完成工作本身/);
  assert.match(selections[0].messages[1].content, /\{"scope":"in"\|"out","keys":\[\.\.\.\]\}/);
});

test('無關的提問不影響下一輪沿用先前推薦的候選', async t => {
  let content = '{"scope":"in","keys":["demo"]}';
  const { worker, requests } = await fixture(t,
    (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'), {},
    (req, res) => res.end(JSON.stringify({ choices: [{ message: { content } }] })));
  const ask = async message => { const { streamId } = await worker.call('rc.ai.chat.send', { message }); return until(() => poll(worker, streamId), r => !r.running); };
  await ask('整理會議');
  content = '{"scope":"out","keys":[]}';
  await ask('今天天氣如何');
  content = '{"scope":"in","keys":[]}';
  const third = await ask('那要怎麼設定');
  assert.deepEqual(third.messages.at(-1).reference.keys, ['demo']);
  assert.equal(requests.length, 2);
});

test('判定相關但沒有合適資源包時，第二階段要求直說沒有；並一律不代為完成工作', async t => {
  const { worker, requests } = await fixture(t,
    (req, res) => res.end(delta('目前沒有') + 'data: [DONE]\n\n'), {},
    (req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '{"scope":"in","keys":[]}' } }] })));
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '有沒有做投影片的工具' });
  await until(() => poll(worker, streamId), r => !r.running);
  assert.match(requests[0].messages[0].content, /第一階段判定本次提問在清單中沒有合適的資源包/);
  assert.match(requests[0].messages[0].content, /可以依候選的 README 說明資源包的用途、安裝、設定與使用方式；但不要直接完成使用者的工作本身/);
});

test('JSON 模式回 400 只重試一次，文字中的第一個 JSON 物件可選取候選', async t => {
  const { worker, selections } = await fixture(t,
    (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'), {},
    (req, res, body) => {
      if (body.response_format) { res.writeHead(400); return res.end('{}'); }
      res.end(JSON.stringify({ choices: [{ message: { content: '結果：```json\n{"note":"字串內 } 與 \\" 引號", "keys":["demo"]}\n``` {"keys":[]}' } }] }));
    });
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
  const result = await until(() => poll(worker, streamId), r => !r.running);
  assert.deepEqual(result.messages.at(-1).reference.keys, ['demo']);
  assert.equal(selections.length, 2);
  assert.equal(selections[1].response_format, undefined);
});

test('JSON 模式下回覆夾帶說明文字時，仍擷取其中第一個 JSON 物件', async t => {
  const { worker, selections } = await fixture(t,
    (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'), {},
    (req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '建議如下：{"keys":["demo"]}' } }] })));
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
  const result = await until(() => poll(worker, streamId), r => !r.running);
  assert.deepEqual(result.messages.at(-1).reference.keys, ['demo']);
  assert.equal(selections.length, 1);
});

test('候選無法解析時即使上一輪有候選，也只用說明回答且不抓 README', async t => {
  let content = '{"keys":["demo"]}';
  const { worker, market, requests } = await fixture(t,
    (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'), {},
    (req, res) => res.end(JSON.stringify({ choices: [{ message: { content } }] })));
  for (content of ['{"keys":["demo"]}', '不是 JSON', '{"keys":"demo"}']) {
    const before = market.requests.filter(r => r.path.endsWith('/readme')).length;
    const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
    const result = await until(() => poll(worker, streamId), r => !r.running);
    if (content === '{"keys":["demo"]}') continue;
    assert.deepEqual(result.messages.at(-1).reference, { packageCount: 1, keys: [], names: [], fallback: true,
      selectModel: 'sample-model', answerModel: 'sample-model', streamed: true });
    assert.equal(result.messages.at(-1).error, undefined);
    assert.equal(market.requests.filter(r => r.path.endsWith('/readme')).length, before);
    assert.ok(!requests.at(-1).messages[0].content.includes('會議整理說明'));
  }
});

test('分隔線與送給模型的有效歷史一致，參考資訊各自保留且增量輪詢不遺失', async t => {
  let content = '{"keys":["demo"]}', answer = '回答';
  const { worker, requests } = await fixture(t,
    (req, res) => res.end(delta(answer) + 'data: [DONE]\n\n'), {},
    (req, res) => res.end(JSON.stringify({ choices: [{ message: { content } }] })));
  const timers = createManualIntervals();
  const panel = await startPanel(worker.call, { timers });
  await until(async () => panel.get('view-main').classList.contains('hidden'), hidden => !hidden);
  await panel.get('btn-ai').fire('click');
  const read = async () => {
    for (const timer of timers.calls.filter(c => c.delay === 250)) await timers.fire(timer.id);
    return worker.call('rc.ai.chat.poll');
  };
  for (let i = 0; i < 9; i++) {
    content = i === 7 ? 'invalid' : '{"keys":["demo"]}';
    answer = i === 1 ? '  ' : i === 3 ? '' : '回答';
    panel.get('ai-chat-question').value = `問題${i}`;
    await panel.get('ai-chat-form').fire('submit');
    await until(read, r => !r.running && panel.get('ai-chat-send').textContent !== '■');
  }
  const result = await read();
  // 有效輪次是 0、2、4、5、6、7、8；最近六輪從問題2起。
  assert.equal(result.historyStart, 4);
  const nodes = panel.get('ai-chat-messages').children;
  const dividers = nodes.filter(n => n.classList.contains('ai-chat-history-divider'));
  assert.equal(dividers.length, 1);
  assert.equal(textOf(dividers[0]), '─── 以上較早的對話，AI 已不會參考 ───');
  assert.equal(textOf(nodes[nodes.indexOf(dividers[0]) + 1]), '問題2');
  const references = nodes.flatMap(n => n.children).filter(n => n.classList.contains('ai-chat-context'));
  assert.equal(references.length, 9);
  assert.equal(references[0].textContent, 'ⓘ 從 1 個資源包中挑出 1 個參考 · 模型 sample-model');
  assert.equal(references[0].getAttribute('title'), '本輪參考：示範資源包');
  assert.equal(references[7].textContent, 'ⓘ 從 1 個資源包的說明中回答 · 模型 sample-model');
  assert.equal(references[7].getAttribute('title'), null);
  panel.get('ai-chat-question').value = '下一問';
  await panel.get('ai-chat-form').fire('submit');
  await until(read, r => !r.running && panel.get('ai-chat-send').textContent !== '■');
  assert.equal(requests.at(-1).messages[1].content, '問題2');
});

test('第一階段停止與清除會中止 HTTP，不啟動回答或污染新對話', async t => {
  let entered = false, closed = false;
  const { worker, requests } = await fixture(t, () => assert.fail('不得進入第二階段'), {},
    (req, res) => { entered = true; res.writeHead(200); res.flushHeaders(); res.on('close', () => { closed = true; }); });
  for (const action of ['stop', 'clear']) {
    entered = false; closed = false;
    const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
    await until(async () => entered, Boolean);
    assert.equal((await poll(worker, streamId)).phase, '找尋相關資源包中…');
    const result = await worker.call(`rc.ai.chat.${action}`);
    assert.equal(result.running, false);
    await until(async () => closed, Boolean);
    assert.equal(requests.length, 0);
    assert.equal((await worker.call('rc.ai.chat.poll')).messages.length, action === 'clear' ? 0 : 2);
  }
});

test('第一階段斷線、逾時與 HTTP 錯誤沿用安全錯誤並重檢端點', async t => {
  for (const mode of ['network', 'timeout', 'http']) {
    const { worker, requests, checks } = await fixture(t, () => assert.fail('不得進入第二階段'), { aiChatTimeoutMs: 40 },
      (req, res) => {
        if (mode === 'network') return res.destroy();
        if (mode === 'http') { res.writeHead(401); res.end('synthetic-chat-secret'); }
      });
    const before = checks();
    const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
    const result = await until(() => poll(worker, streamId), r => !r.running);
    assert.match(result.messages.at(-1).error, mode === 'timeout' ? /逾時/ : mode === 'http' ? /HTTP 401/ : /無法取得/);
    assert.equal(requests.length, 0);
    await until(async () => checks(), n => n > before);
    assert.deepEqual(leakedSecrets(worker.state.transcript, ['synthetic-chat-secret']), []);
  }
});

test('讀候選時顯示數量，停止或清除後晚到 README 不會進入回答；零候選略過閱讀', async t => {
  let keys = ['demo'], entered = false, release;
  const { worker, market, requests } = await fixture(t,
    (req, res) => res.end(delta('回答') + 'data: [DONE]\n\n'), {},
    (req, res) => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keys }) } }] })));
  market.override('GET /api/market/packages/demo/versions/1.0.0/readme', () => {
    entered = true;
    return new Promise(resolve => { release = () => resolve({ status: 503, body: {} }); });
  });
  for (const action of ['stop', 'clear']) {
    entered = false;
    const { streamId } = await worker.call('rc.ai.chat.send', { message: '推薦' });
    await until(async () => entered, Boolean);
    assert.equal((await poll(worker, streamId)).phase, '閱讀 1 個資源包說明…');
    await worker.call(`rc.ai.chat.${action}`); release();
    await until(async () => market.requests.filter(r => r.path.endsWith('/readme')).length, n => n > 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(requests.length, 0);
  }
  keys = [];
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '無候選' });
  const result = await until(() => poll(worker, streamId), r => !r.running);
  assert.deepEqual(result.messages.at(-1).reference.keys, []);
  assert.equal(result.messages.at(-1).reference.fallback, false);
  assert.equal(result.messages.at(-1).error, undefined);
});

test('編輯使用中的 OpenAI 相容端點的名稱、Base URL、模型或 PAT 時保留對話', async t => {
  const { worker } = await fixture(t, (req, res) => res.end(delta('推薦') + 'data: [DONE]\n\n'));
  const { streamId } = await worker.call('rc.ai.chat.send', { message: '整理會議' });
  await until(() => poll(worker, streamId), r => !r.running);
  const [endpoint] = (await worker.call('rc.ai.settings.get')).endpoints;
  await worker.call('rc.ai.settings.save', { endpoint: { id: endpoint.id, name: '改名', baseUrl: endpoint.baseUrl.replace('127.0.0.1', 'localhost'), model: 'other-model', pat: 'synthetic-new-secret' } });
  assert.equal((await worker.call('rc.ai.chat.poll')).messages.length, 2);
});
