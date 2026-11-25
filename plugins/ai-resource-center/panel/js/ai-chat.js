// AI 助手對話：僅透過 worker 讀取，沿用安全的 Markdown 呈現。
(function () {
  'use strict';
  const RC = window.RcPanel;
  const { $, el, call } = RC;
  let revision = 0, viewRevision = 0, timer = null, polling = false, sending = false, available = true, opened = false, incremental = false;
  const setupMessage = '請到 AI 助手設定啟用端點並選擇模型';
  let unavailableMessage = setupMessage;
  let state = { messages: [], running: false }, ready = Promise.resolve();
  let endpoint = null, configuredModel = '';
  let packages = new Map();
  let detailScroll = null;
  // 輸入框隨內容長高（Shift+Enter 換行），最高 INPUT_MAX_HEIGHT，超過改為捲動。
  const INPUT_MAX_HEIGHT = 140;
  function fitInput() {
    const input = $('ai-chat-question');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX_HEIGHT)}px`;
    input.style.overflowY = input.scrollHeight > INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }
  const questions = ['怎麼把逐字稿整理成會議紀錄？', '我想自動開 TFS 工項', '有沒有畫流程圖的資源包？'];
  function packageCard(p) {
    const view = el('button', { type: 'button', className: 'btn', 'data-action': 'view-package', textContent: '查看 ›' });
    view.addEventListener('click', () => {
      detailScroll = $('ai-chat-scroll').scrollTop;
      return RC.openDetails(p.packageKey, undefined, p);
    });
    return el('div', { className: 'ai-package-card', 'data-package-key': p.packageKey },
      el('div', { className: 'ai-package-row' }, el('b', { textContent: `📦 ${p.name}` }), el('span', { className: 'muted', textContent: p.latestVisibleVersion ? `v${p.latestVisibleVersion}` : '' })), RC.metaRow(p),
      el('div', { className: 'ai-package-description muted', textContent: p.description || '' }),
      el('div', { className: 'ai-package-row' }, RC.installStatusText(p), view));
  }
  function renderTitle() {
    const actualModel = endpoint?.type === 'local-tool' && state.messages.findLast(message => message.reference?.answerModel)?.reference.answerModel;
    const model = actualModel || configuredModel;
    RC.setText('ai-header-model', model ? '· ' + model : '');
  }
  // 本機 AI 工具選「預設」時也不留白，顯示「預設（名稱）」。
  RC.setAiChatModel = function (model, platform, defaultModel) {
    configuredModel = model || (platform ? RC.defaultModelLabel(platform, defaultModel) : '');
    renderTitle();
  };
  function render() {
    renderTitle();
    const scroll = $('ai-chat-scroll').scrollTop;
    $('ai-chat-messages').replaceChildren(...state.messages.flatMap((message, index) => {
      const node = el('div', { className: message.role === 'user' ? 'ai-chat-me' : 'ai-chat-answer markdown' });
      if (message.role === 'user') node.textContent = message.text;
      else {
        node.append(window.RcMarkdown.render(message.text, document));
        for (const key of message.packageKeys || []) { const p = packages.get(key); if (p) node.append(packageCard(p)); }
        if (message.reference) {
          const ref = message.reference;
          const context = ref.fallback ? `ⓘ 從 ${ref.packageCount} 個資源包的說明中回答` : `ⓘ 從 ${ref.packageCount} 個資源包中挑出 ${ref.keys.length} 個參考`;
          const { selectModel, answerModel } = ref;
          const models = (!selectModel || !answerModel || selectModel === answerModel)
            ? [(answerModel || selectModel) && '模型 ' + (answerModel || selectModel)]
            : [selectModel && '挑選 ' + selectModel, answerModel && '回答 ' + answerModel];
          node.append(el('div', { className: 'ai-chat-context muted',
            textContent: [context, ...models.filter(Boolean), ref.appServerFallback && '這次以相容模式回答，沒有逐字顯示'].filter(Boolean).join(' · '),
            ...(!ref.fallback && ref.names.length ? { title: `本輪參考：${ref.names.join('、')}` } : {}) }));
        }
        if (message.error) node.append(el('div', { className: 'error', textContent: message.error }));
      }
      return index === state.historyStart ? [el('div', { className: 'ai-chat-history-divider muted', textContent: '─── 以上較早的對話，AI 已不會參考 ───' }), node] : [node];
    }));
    RC.setText('ai-chat-phase', state.phase);
    $('ai-chat-send').textContent = state.running ? '■' : '';
    if (!state.running) $('ai-chat-send').replaceChildren(RC.ICONS.send());
    $('ai-chat-send').setAttribute('aria-label', state.running ? '停止' : '送出');
    $('ai-chat-send').setAttribute('title', state.running ? '停止' : '送出');
    $('ai-chat-send').disabled = sending || (!available && !state.running);
    $('ai-chat-question').disabled = !available;
    RC.setText('ai-chat-unavailable', available ? '' : unavailableMessage);
    for (const chip of $('ai-chat-chips').children) chip.disabled = sending || state.running || !available;
    $('ai-chat-scroll').scrollTop = RC.isShown('ai-chat') && detailScroll === null ? $('ai-chat-scroll').scrollHeight : scroll;
  }
  function stopTimer() { if (timer !== null) clearInterval(timer); timer = null; }
  async function poll() {
    if (polling) return;
    polling = true;
    const expected = revision;
    try {
      const params = incremental && state.streamId ? { streamId: state.streamId, offsets: state.messages.map(m => m.text.length) } : {};
      const result = await call('rc.ai.chat.poll', params).catch(error => {
        // 切換使用中的端點會清除 worker 對話，改讀新對話的完整快照。
        if (params.streamId && error.code === 'invalid_params' && expected === revision) return call('rc.ai.chat.poll', {});
        throw error;
      });
      if (expected !== revision) return;
      if (result.updates) {
        const messages = state.messages.slice();
        for (const update of result.updates) messages[update.index] = { role: update.role, text: (messages[update.index]?.text ?? '') + update.delta, packageKeys: update.packageKeys, error: update.error, reference: update.reference };
        state = { ...result, messages };
      } else state = result;
      incremental = true; render();
      if (!state.running) stopTimer();
    } catch (error) { if (expected === revision) { stopTimer(); RC.actionFailed(error); } }
    finally { polling = false; }
  }
  async function submit(question) {
    if (sending || state.running || !available || !question.trim()) return;
    detailScroll = null;
    const expected = ++revision;
    sending = true; incremental = false; render();
    try {
      await ready;
      if (expected !== revision) return;
      await call('rc.ai.chat.send', { message: question });
      if (expected !== revision) return;
      $('ai-chat-question').value = ''; fitInput();
      state.running = true;
      await poll();
      if (expected === revision && state.running && timer === null) timer = setInterval(poll, 250);
    } catch (error) {
      if (expected !== revision) return;
      if (RC.sessionLost(error)) return RC.load();
      state.messages.push({ role: 'assistant', text: '', packageKeys: [], error: RC.messageOf(error) });
    } finally { if (expected === revision) { sending = false; render(); } }
  }
  async function clear() {
    const expected = ++revision;
    stopTimer(); sending = true; incremental = false; render();
    const clearing = call('rc.ai.chat.clear');
    ready = clearing.catch(() => {});
    try {
      await clearing;
      if (expected !== revision) return;
      detailScroll = null;
      state = { messages: [], running: false }; $('ai-chat-question').value = ''; fitInput();
    } catch (error) { if (expected === revision) RC.actionFailed(error); }
    finally {
      if (expected === revision) {
        sending = false; render();
        if (state.running && timer === null) timer = setInterval(poll, 250);
      }
    }
  }
  RC.chatViewChanged = name => {
    const view = ++viewRevision;
    if (['login', 'loading'].includes(name)) { endpoint = null; configuredModel = ''; packages = new Map(); if (opened) { opened = false; void clear(); } return; }
    if (name === 'ai-chat') {
      incremental = false;
      if (detailScroll !== null) $('ai-chat-scroll').scrollTop = detailScroll;
      if (!opened) { opened = true; ready = call('rc.ai.chat.clear'); }
      void call('rc.ai.settings.get').then(settings => {
        if (view !== viewRevision) return;
        endpoint = settings.endpoints.find(e => e.id === settings.activeEndpointId);
        const local = endpoint?.type === 'local-tool';
        available = settings.enabled && (local || Boolean(endpoint?.model));
        RC.setAiChatModel(settings.enabled ? endpoint?.model : '', settings.enabled ? endpoint?.platform : '', endpoint?.defaultModel);
        render();
      }).catch(RC.actionFailed);
      void ready.then(poll).then(() => { if (state.running && timer === null) timer = setInterval(poll, 250); }).catch(RC.actionFailed);
      void call('rc.catalog.list', { previewMode: RC.state.showPreview }).then(result => {
        if (view !== viewRevision) return;
        packages = new Map(result.data.map(p => [p.packageKey, p])); render();
      }).catch(RC.actionFailed);
    }
  };
  RC.bindAiChat = function () {
    $('ai-chat-intro').append(document.createTextNode('我是'), el('b', { textContent: '資源中心的任務型助手' }),
      document.createTextNode('：描述你想完成的工作，我會從架上的資源包推薦適合的選擇。其他問題不在我的服務範圍。AI 只參考最近 6 輪對話；換話題時可按 🗑 清除。'));
    $('ai-chat-chips').replaceChildren(...questions.map(question => {
      const chip = el('button', { type: 'button', className: 'ai-chat-chip', textContent: question });
      chip.addEventListener('click', () => submit(question)); return chip;
    }));
    async function sendOrStop(event) {
      event.preventDefault();
      if (!state.running) return submit($('ai-chat-question').value);
      const expected = ++revision;
      stopTimer();
      try {
        const result = await call('rc.ai.chat.stop');
        if (expected === revision) { state = result; incremental = false; render(); }
      } catch (error) { if (expected === revision) RC.actionFailed(error); }
    }
    $('ai-chat-form').addEventListener('submit', sendOrStop);
    // preventDefault 避免同一次點擊再觸發表單送出。
    $('ai-chat-send').addEventListener('click', sendOrStop);
    $('ai-chat-question').addEventListener('input', fitInput);
    $('ai-chat-question').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); return submit($('ai-chat-question').value); }
    });
    $('btn-ai-clear').addEventListener('click', clear);
    $('ai-chat-scroll').addEventListener('scroll', () => {
      if (!RC.isShown('ai-chat') || detailScroll === null) return;
      const scroll = $('ai-chat-scroll');
      detailScroll = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1 ? null : scroll.scrollTop;
    });
    $('ai-chat-messages').addEventListener('click', event => {
      const link = event.target.closest?.('[data-action="external-link"]');
      if (link) return RC.activateReadmeLink(event);
    });
    $('ai-chat-messages').addEventListener('keydown', RC.onReadmeKeydown);
    window.addEventListener?.('pagehide', () => { stopTimer(); void call('rc.ai.chat.clear').catch(() => {}); });
    render();
  };
})();
