// AI 助手設定與狀態；HTTP 只交給 worker，面板不持有已儲存的 PAT。
(function () {
  'use strict';
  const RC = window.RcPanel;
  const { $, el, call } = RC;
  let settings = null, returnView = 'main', editingId = null, editRevision = 0;
  let statusTimer = null, viewRevision = 0;
  const stateLabel = value => value === 'ok' ? '正常' : value === 'error' ? '異常' : '未設定或已停用';
  function paintStatus(status) {
    if (!status?.state) return;
    const time = status.checkedAt == null ? '' : new Date(status.checkedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
    const first = `AI 助手：● ${stateLabel(status.state)}${status.model ? ` · ${status.model}` : ''}`;
    $('btn-ai').setAttribute('title', first + (status.state === 'error' ? `\n${status.reason}` : status.name ? `\n${status.name} · ${time} 檢查` : ''));
    $('ai-status-dot').className = `ai-dot ${status.state}`;
    $('ai-header-model').textContent = status.model ? `· ${status.model}` : '';
    if (settings && RC.isShown('ai-settings') && settings.enabled && settings.activeEndpointId) {
      const active = settings.endpoints.find(endpoint => endpoint.id === settings.activeEndpointId);
      if (active) { active.status = status; renderEndpoints(); }
    }
    if (RC.isShown('ai-chat')) {
      $('status-dot').setAttribute('title', $('btn-ai').getAttribute('title'));
      $('status-dot').className = `status-dot ${status.state === 'ok' ? 'connected' : status.state === 'error' ? 'error' : ''}`;
    }
  }
  async function syncStatus() {
    const revision = viewRevision;
    try {
      const result = await call('rc.ai.status.get');
      if (revision === viewRevision) paintStatus(result);
    } catch (e) { if (RC.sessionLost(e)) RC.load(); }
  }
  function renderEndpoints() {
    $('ai-enabled').checked = settings.enabled;
    $('ai-endpoints').replaceChildren(...settings.endpoints.map(endpoint => {
      const selected = endpoint.id === settings.activeEndpointId;
      const radio = el('input', { type: 'radio', name: 'ai-active', checked: selected, 'aria-label': `啟用 ${endpoint.name}`, 'data-ai-select': endpoint.id });
      radio.addEventListener('change', () => update({ activeEndpointId: endpoint.id }));
      const editButton = el('button', { type: 'button', className: 'btn ai-row-button', textContent: '編輯', 'aria-label': `編輯 ${endpoint.name}`, 'data-ai-edit': endpoint.id });
      editButton.addEventListener('click', () => edit(endpoint));
      const remove = el('button', { type: 'button', className: 'btn btn-danger-outline ai-row-button', textContent: '刪除', 'aria-label': `刪除 ${endpoint.name}`, 'data-ai-delete': endpoint.id });
      remove.addEventListener('click', () => confirmDelete(endpoint, selected));
      const status = endpoint.status?.state || 'unset';
      return el('div', { className: `ai-endpoint${selected ? ' selected' : ''}` }, radio,
        el('span', { className: 'ai-endpoint-name', textContent: endpoint.name }),
        el('span', { className: `ai-endpoint-status ${status}`, title: endpoint.status?.reason || '', textContent: stateLabel(status) }, el('span', { className: `ai-inline-dot ${status}` })),
        el('span', { className: 'muted ai-endpoint-model', textContent: endpoint.model || '—' }), editButton, remove);
    }));
  }
  /** 刪除前一律確認：端點與 PAT 刪除後無法復原。 */
  function confirmDelete(endpoint, selected) {
    RC.openSheet({
      title: `刪除 AI 端點「${endpoint.name}」？`,
      body: [RC.sheetText(`Base URL：${endpoint.baseUrl}`), RC.sheetText('一併刪除這個端點儲存的 PAT，刪除後無法復原。'),
        selected ? RC.sheetText('這是目前使用中的端點，刪除後 AI 助手會變成「未設定」，需要另外選擇端點。') : null].filter(Boolean),
      primaryLabel: '刪除', busyLabel: '刪除中…', primaryKind: 'danger',
      onPrimary: async () => {
        const revision = viewRevision;
        const result = await call('rc.ai.settings.save', { deleteId: endpoint.id }, 20000);
        if (editingId === endpoint.id) closeEditor();
        if (revision !== viewRevision) return;
        settings = result;
        renderEndpoints(); await syncStatus();
      }
    });
  }
  async function update(input) {
    const revision = viewRevision;
    try {
      const result = await call('rc.ai.settings.save', input, 20000);
      if (revision !== viewRevision) return false;
      settings = result;
      renderEndpoints(); await syncStatus();
      return true;
    } catch (e) { RC.actionFailed(e); return false; }
  }
  function urlHint() {
    RC.setText('ai-url-error', '');
    RC.setText('ai-url-hint', '');
    try {
      const u = new URL($('ai-url').value);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
      const path = u.pathname.replace(/\/+$/, '') || '/v1';
      RC.setText('ai-url-hint', `實際呼叫：${u.origin}${path}/models`);
      return true;
    } catch (e) { RC.setText('ai-url-error', '請輸入有效的 http/https Base URL'); return false; }
  }
  function modelOptions(models, selected) {
    $('ai-model').replaceChildren(...models.map(model => el('option', { value: model, textContent: model })));
    $('ai-model').value = selected || '';
  }
  function closeEditor() {
    editRevision++;
    $('ai-editor').classList.add('hidden');
    $('ai-pat').value = '';
  }
  function edit(endpoint = null) {
    editRevision++;
    editingId = endpoint?.id;
    $('ai-name').value = endpoint?.name || '';
    $('ai-url').value = endpoint?.baseUrl || '';
    $('ai-pat').value = '';
    $('ai-pat').type = 'password';
    $('ai-pat').placeholder = endpoint?.hasPat ? '已設定' : '未填';
    modelOptions(endpoint?.model ? [endpoint.model] : [], endpoint?.model);
    RC.setText('ai-test-result', ''); RC.setText('ai-save-error', '');
    $('ai-editor').classList.remove('hidden');
    if (endpoint) urlHint();
    else { RC.setText('ai-url-hint', ''); RC.setText('ai-url-error', ''); }
  }
  async function testConnection() {
    if (!urlHint()) return;
    const revision = editRevision;
    $('ai-test').disabled = true;
    RC.setText('ai-test-result', '');
    try {
      const result = await call('rc.ai.endpoints.test', { id: editingId, baseUrl: $('ai-url').value, pat: $('ai-pat').value, model: $('ai-model').value });
      if (revision !== editRevision) return;
      modelOptions(result.models, result.models.includes(result.model) ? result.model : '');
      $('ai-test-result').className = result.state === 'ok' ? 'ai-ok' : 'error';
      RC.setText('ai-test-result', result.state === 'ok' ? `✓ 取得 ${result.models.length} 個模型` : result.reason);
      if (editingId) {
        settings = await call('rc.ai.settings.get');
        if (revision === editRevision) { renderEndpoints(); await syncStatus(); }
      }
    } catch (e) { if (revision === editRevision) { $('ai-test-result').className = 'error'; RC.setText('ai-test-result', RC.messageOf(e)); } }
    finally { $('ai-test').disabled = false; }
  }
  RC.aiViewChanged = function (name) {
    viewRevision++;
    RC.chatViewChanged?.(name);
    const catalog = ['main', 'details', 'developer'].includes(name);
    const chat = name === 'ai-chat', ai = chat || name === 'ai-settings';
    if (catalog || ai) {
      if (statusTimer === null) { void syncStatus(); statusTimer = setInterval(syncStatus, 5000); }
    } else {
      if (statusTimer !== null) clearInterval(statusTimer);
      statusTimer = null;
      closeEditor(); settings = null;
    }
    $('btn-ai').classList.toggle('hidden', !catalog);
    $('btn-ai-clear').classList.toggle('hidden', !chat);
    $('btn-ai-settings').classList.toggle('hidden', !chat);
    $('ai-header-model').classList.toggle('hidden', !chat);
    if (ai) {
      $('btn-back').classList.remove('hidden');
      $('btn-back').setAttribute('title', '返回資源中心');
      $('btn-back').setAttribute('aria-label', '返回資源中心');
      $('status-dot').classList.toggle('hidden', !chat);
      RC.setHeaderTitle(chat ? 'AI 助手' : 'AI 助手設定');
    } else if (name === 'main') { RC.setStatus('connected'); $('status-dot').setAttribute('title', '市集連線狀態'); }
  };
  async function openSettings() {
    const revision = viewRevision;
    const result = await call('rc.ai.settings.get');
    if (revision !== viewRevision) return;
    settings = result;
    RC.showView('ai-settings');
    $('ai-enabled').checked = settings.enabled;
    closeEditor();
    renderEndpoints();
  }
  RC.aiBack = () => {
    if (RC.isShown('ai-settings')) {
      closeEditor(); RC.showView(returnView);
      if (returnView === 'ai-chat') void call('rc.ai.status.check').then(paintStatus).catch(RC.actionFailed);
      return true;
    }
    if (RC.isShown('ai-chat')) { RC.showView('main'); return true; }
    return false;
  };
  RC.bindAi = function () {
    $('btn-ai').addEventListener('click', async () => {
      const revision = viewRevision;
      try {
        const result = await call('rc.ai.settings.get');
        if (revision !== viewRevision) return;
        settings = result;
        returnView = 'main';
        if (!settings.endpoints.length) return openSettings();
        const status = await call('rc.ai.status.check');
        if (revision !== viewRevision) return;
        RC.showView('ai-chat');
        paintStatus(status);
      } catch (e) { RC.actionFailed(e); }
    });
    $('btn-ai-settings').addEventListener('click', async () => { try { returnView = 'ai-chat'; await openSettings(); } catch (e) { RC.actionFailed(e); } });
    $('ai-enabled').addEventListener('change', () => update({ enabled: $('ai-enabled').checked }));
    $('ai-editor').addEventListener('submit', async event => {
      event.preventDefault();
      if (!urlHint()) return;
      if (!$('ai-name').value.trim()) { RC.setText('ai-save-error', '請填寫名稱'); return; }
      $('ai-save').disabled = true;
      try {
        if (await update({ endpoint: { ...(editingId ? { id: editingId } : {}), name: $('ai-name').value, baseUrl: $('ai-url').value, pat: $('ai-pat').value, model: $('ai-model').value } })) closeEditor();
      } finally { $('ai-save').disabled = false; }
    });
    $('ai-add').addEventListener('click', () => edit());
    $('ai-cancel').addEventListener('click', closeEditor);
    $('ai-url').addEventListener('input', () => { editRevision++; RC.setText('ai-test-result', ''); urlHint(); });
    $('ai-pat').addEventListener('input', () => { editRevision++; RC.setText('ai-test-result', ''); });
    $('ai-pat-eye').addEventListener('click', () => {
      $('ai-pat').type = $('ai-pat').type === 'password' ? 'text' : 'password';
      $('ai-pat-eye').setAttribute('aria-label', $('ai-pat').type === 'password' ? '顯示 PAT' : '隱藏 PAT');
    });
    $('ai-test').addEventListener('click', testConnection);
  };
})();
