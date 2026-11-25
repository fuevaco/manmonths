// AI 助手設定與狀態；HTTP 只交給 worker，面板不持有已儲存的 PAT。
(function () {
  'use strict';
  const RC = window.RcPanel;
  const { $, el, call } = RC;
  let settings = null, returnView = 'main', editingId = null, editingEndpoint = null, editRevision = 0;
  let editorRevision = 0, editType = 'openai', platform = '', detected = null;
  let codexModels = { models: [], defaultModel: '' }, modelsLoading = 0; // codexModels 同時是面板工作階段內的快取
  let statusTimer = null, viewRevision = 0, statusRevision = 0;
  // 平台名稱由 worker 隨設定（settings.platforms）與狀態（platformLabel）回傳。這裡只列 index.html 的平台選項。
  const platformKeys = ['claude-code', 'codex'];
  const platformName = key => settings?.platforms?.[key]?.label ?? '';
  const claudeAliases = ['fable', 'opus', 'sonnet', 'haiku'];
  // 「自行輸入…」的選項值：模型名稱不含角括號，不會和真實模型撞名。
  const customModelOption = '<custom>';
  // 「預設」一律附上模型名稱。還不知道時，Claude Code 說明由方案決定，Codex 維持「預設」。
  RC.defaultModelLabel = (key, defaultModel) => defaultModel ? '預設（' + defaultModel + '）'
    : key === 'claude-code' ? '預設（依你的 Claude 方案決定）' : '預設';
  const stateLabel = value => value === 'ok' ? '正常' : value === 'error' ? '異常' : '未設定或已停用';
  const accountLabel = status => status?.account ? status.account + '（跟隨 Orca）' : '';
  function endpointSource(endpoint) {
    if (endpoint.type !== 'local-tool') return 'OpenAI 相容 · ' + endpoint.baseUrl;
    const status = endpoint.status;
    let source = accountLabel(status);
    if (status?.state === 'error') {
      if (status.reasonCode === 'not-signed-in') source = '未登入';
      else if (status.reasonCode === 'missing-cli') source = '找不到 CLI';
      else source = status.reason;
    }
    return ['本機 AI 工具', platformName(endpoint.platform), source].filter(Boolean).join(' · ');
  }
  function paintStatus(status) {
    if (!status?.state) return;
    const time = status.checkedAt == null ? '' : new Date(status.checkedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
    const label = status.platformLabel ?? '';
    const stateText = '● ' + stateLabel(status.state);
    let model = status.model;
    let detail = status.state === 'error' ? status.reason : status.name && status.name + ' · ' + time + ' 檢查';
    let warning = '';
    if (label) {
      model = status.state === 'ok' ? model || RC.defaultModelLabel(status.platform, status.defaultModel) : '—';
      if (status.state !== 'error') {
        const account = accountLabel(status);
        detail = label + (account ? ' · ' + account : '') + (time ? (account ? '· ' : ' · ') + time + ' 檢查' : '');
        if (status.versionWarning) warning = '⚠ ' + label + ' ' + status.version + ' ' + status.versionWarning;
      }
    }
    const title = ['AI 助手：' + stateText + (model ? ' · ' + model : ''), detail, warning].filter(Boolean).join('\n');
    $('ai-tooltip').classList.toggle('hidden', !label);
    if (label) {
      RC.setText('ai-tooltip-state', stateText);
      $('ai-tooltip-state').className = status.state === 'ok' ? 'ai-ok' : status.state === 'error' ? 'ai-tooltip-error' : '';
      RC.setText('ai-tooltip-model', model);
      RC.setText('ai-tooltip-detail', detail);
      RC.setText('ai-tooltip-warning', warning);
    }
    $('btn-ai').setAttribute('aria-describedby', label ? 'ai-tooltip' : '');
    $('btn-ai').setAttribute('title', label ? '' : title);
    $('ai-status-dot').className = `ai-dot ${status.state}`;
    RC.setAiChatModel(status.model, status.platform, status.defaultModel);
    if (settings && RC.isShown('ai-settings') && settings.enabled && settings.activeEndpointId) {
      const active = settings.endpoints.find(endpoint => endpoint.id === settings.activeEndpointId);
      if (active) { active.status = status; renderEndpoints(); }
    }
    if (RC.isShown('ai-chat')) {
      $('status-dot').setAttribute('title', title);
      $('status-dot').className = `status-dot ${status.state === 'ok' ? 'connected' : status.state === 'error' ? 'error' : ''}`;
    }
  }
  async function syncStatus() {
    const revision = viewRevision;
    const request = ++statusRevision;
    try {
      const result = await call('rc.ai.status.get');
      if (revision === viewRevision && request === statusRevision) paintStatus(result);
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
      return el('div', { className: `ai-endpoint${selected ? ' selected' : ''}` },
        el('div', { className: 'ai-endpoint-row' }, radio,
          el('span', { className: 'ai-endpoint-name', textContent: endpoint.name }),
          el('span', { className: `ai-endpoint-status ${status}${endpoint.type === 'local-tool' ? ' local' : ''}`, title: endpoint.status?.reason || '', textContent: stateLabel(status) }, el('span', { className: `ai-inline-dot ${status}` })),
          el('span', { className: 'muted ai-endpoint-model', textContent: endpoint.model || (endpoint.type === 'local-tool' ? RC.defaultModelLabel(endpoint.platform, endpoint.defaultModel) : '—') }), editButton, remove),
        el('div', { className: 'ai-endpoint-source muted', textContent: endpointSource(endpoint) }));
    }));
  }
  function confirmDelete(endpoint, selected) {
    const name = platformName(endpoint.platform);
    const details = endpoint.type === 'local-tool'
      ? ['類型：本機 AI 工具（' + name + '）', '只刪除這個端點設定，不影響 ' + name + ' 本身或你在 Orca 的登入。']
      : ['Base URL：' + endpoint.baseUrl, '一併刪除這個端點儲存的 PAT，刪除後無法復原。'];
    const body = details.map(text => RC.sheetText(text));
    if (selected) {
      const note = RC.sheetText('這是目前使用中的端點，刪除後 AI 助手會變成「未設定」，需要另外選擇端點。');
      if (endpoint.type === 'local-tool') note.classList.add('muted');
      body.push(note);
    }
    RC.openSheet({
      title: `刪除 AI 端點「${endpoint.name}」？`,
      body,
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
    editorRevision++;
    $('ai-editor').classList.add('hidden');
    $('ai-pat').value = '';
  }
  function renderEditorType() {
    const local = editType === 'local-tool';
    $('ai-type-openai').classList.toggle('btn-primary', !local);
    $('ai-type-local').classList.toggle('btn-primary', local);
    $('ai-type-openai').setAttribute('aria-pressed', String(!local));
    $('ai-type-local').setAttribute('aria-pressed', String(local));
    const installed = Object.values(detected ?? {}).some(result => result.installed);
    $('ai-type-local').disabled = !installed;
    RC.setText('ai-local-unavailable', detected && !installed ? '未偵測到 Claude Code 或 Codex CLI。安裝並在 Orca 登入後，重新開啟設定頁。' : '');
    for (const id of ['ai-url-field', 'ai-pat-field', 'ai-openai-model']) $(id).classList.toggle('hidden', local);
    $('ai-platform-field').classList.toggle('hidden', !local);
    $('ai-local-model-field').classList.toggle('hidden', !local);
    const label = platformName(platform);
    RC.setText('ai-local-notice', local && label
      ? '帳號跟隨 Orca，每次提問都使用 Orca 當下選定的 ' + label + ' 帳號與額度，要換帳號請在 Orca 切換。資源包說明與 README 會送到 ' + settings.platforms[platform].vendor + '。請依 ' + label + ' 的使用條款自行登入。'
      : '');
    for (const key of platformKeys) {
      const result = detected?.[key];
      const input = $('ai-platform-' + key);
      input.disabled = !result?.installed;
      input.checked = platform === key;
      $('ai-platform-' + key + '-option').classList.toggle('disabled', input.disabled);
      $('ai-platform-' + key + '-option').classList.toggle('selected', input.checked);
      RC.setText('ai-platform-' + key + '-hint', result
        ? result.installed ? ('已偵測到 ' + result.version).trim() : '未偵測到 ' + platformName(key) + ' CLI，請先安裝並在 Orca 登入'
        : '');
      RC.setText('ai-platform-' + key + '-warning', result?.versionWarning ? '⚠ ' + result.versionWarning : '');
    }
  }
  function renderCustomModel() {
    const custom = $('ai-local-model').value === customModelOption;
    $('ai-custom-model-field').classList.toggle('hidden', !custom);
    RC.setText('ai-custom-model-hint', custom ? '輸入完整的模型名稱。儲存時不會檢查名稱，第一次提問時才知道能不能用。' : '');
  }
  /** keepCustom：使用者正選著「自行輸入…」時，名稱還沒打也維持在自行輸入。 */
  function localModelOptions(model = '', keepCustom = false) {
    const claude = platform === 'claude-code';
    const { models, defaultModel } = codexModels;
    // Codex 清單還沒回來或讀取失敗時，已存的名稱先當一般選項，不能當成自行輸入。
    const unlisted = !claude && !models.length && model ? [model] : [];
    // 預設模型已併進「預設（名稱）」那一項；使用者明確存了這個名稱時，才另外列成一般選項。
    const aliases = [...(claude ? claudeAliases : models.filter(name => name !== defaultModel || name === model)), ...unlisted];
    const saved = editingEndpoint?.type === 'local-tool' && editingEndpoint.platform === platform ? editingEndpoint.defaultModel : '';
    const defaultLabel = RC.defaultModelLabel(platform, (claude ? '' : defaultModel) || saved);
    $('ai-local-model').replaceChildren(
      el('option', { value: '', textContent: defaultLabel }),
      ...aliases.map(value => el('option', { value, textContent: value })),
      el('option', { value: customModelOption, textContent: '自行輸入…' })
    );
    const custom = model ? !aliases.includes(model) : keepCustom;
    $('ai-local-model').value = custom ? customModelOption : model;
    $('ai-custom-model').value = custom ? model : '';
    renderCustomModel();
  }
  function showCodexModels(result) {
    codexModels = { models: result.models, defaultModel: result.defaultModel };
    if (platform !== 'codex') return;
    const select = $('ai-local-model');
    const custom = select.value === customModelOption;
    localModelOptions(custom ? $('ai-custom-model').value : select.value, custom);
  }
  /** 唯讀取 Codex 模型清單，不必按測試連線。丟棄過期的回應，失敗時維持現狀。 */
  async function loadCodexModels() {
    const editor = editorRevision;
    if (modelsLoading === editor || !detected?.codex?.installed) return;
    modelsLoading = editor;
    try {
      const result = await call('rc.ai.localTools.models', { platform: 'codex' }, 10000);
      if (editor === editorRevision && result.models.length) showCodexModels(result);
    } catch (e) {
      if (editor === editorRevision && RC.sessionLost(e)) RC.load();
    } finally { if (modelsLoading === editor) modelsLoading = 0; }
  }
  function endpointFields() {
    const id = editingId ? { id: editingId } : {};
    if (editType === 'openai') {
      return { ...id, type: editType, baseUrl: $('ai-url').value, pat: $('ai-pat').value, model: $('ai-model').value };
    }
    const selected = $('ai-local-model').value;
    return { ...id, type: editType, platform, model: selected === customModelOption ? $('ai-custom-model').value : selected };
  }
  function switchPlatform(key) {
    if (platform === key || !detected?.[key]?.installed) return;
    editRevision++;
    platform = key;
    localModelOptions();
    if (key === 'codex') void loadCodexModels();
    RC.setText('ai-test-result', '');
    RC.setText('ai-save-error', '');
    renderEditorType();
  }
  function switchType(type) {
    if (type === editType || (type === 'local-tool' && $('ai-type-local').disabled)) return;
    editRevision++;
    editType = type;
    if (type === 'local-tool' && !platform) {
      platform = platformKeys.find(key => detected[key]?.installed);
      localModelOptions();
    }
    RC.setText('ai-test-result', '');
    RC.setText('ai-save-error', '');
    renderEditorType();
    if (type === 'local-tool' && platform === 'codex') void loadCodexModels();
  }
  async function edit(endpoint = null) {
    editRevision++;
    const revision = ++editorRevision;
    editingId = endpoint?.id;
    editingEndpoint = endpoint;
    editType = endpoint?.type === 'local-tool' ? 'local-tool' : 'openai';
    platform = endpoint?.platform || '';
    detected = null;
    $('ai-name').value = endpoint?.name || '';
    $('ai-url').value = endpoint?.baseUrl || '';
    $('ai-pat').value = '';
    $('ai-pat').type = 'password';
    $('ai-pat-eye').setAttribute('aria-label', '顯示 PAT');
    $('ai-test').disabled = false;
    $('ai-pat').placeholder = endpoint?.hasPat ? '已設定' : '未填';
    const openAiModel = editType === 'openai' ? endpoint?.model : '';
    modelOptions(openAiModel ? [openAiModel] : [], openAiModel);
    localModelOptions(editType === 'local-tool' ? endpoint.model : '');
    RC.setText('ai-test-result', ''); RC.setText('ai-save-error', '');
    $('ai-editor').classList.remove('hidden');
    if (endpoint?.baseUrl) urlHint();
    else { RC.setText('ai-url-hint', ''); RC.setText('ai-url-error', ''); }
    renderEditorType();
    try {
      const result = await call('rc.ai.localTools.detect', {}, 10000);
      if (revision !== editorRevision) return;
      detected = result;
    } catch (e) {
      if (revision !== editorRevision) return;
      if (RC.sessionLost(e)) { RC.load(); return; }
      detected = null;
    }
    renderEditorType();
    if (platform === 'codex') void loadCodexModels();
  }
  async function testConnection() {
    const local = editType === 'local-tool';
    if (!local && !urlHint()) return;
    const revision = editRevision;
    const editor = editorRevision;
    $('ai-test').disabled = true;
    RC.setText('ai-test-result', '');
    try {
      const result = await call('rc.ai.endpoints.test', endpointFields(), local ? 10000 : undefined);
      if (revision !== editRevision) return;
      let message;
      if (local) {
        const reason = result.reasonCode === 'not-signed-in' ? '尚未登入，請在 Orca 登入後再試' : result.reason;
        message = result.state === 'ok'
          ? ('✓ 已登入 · ' + result.platformLabel + ' ' + result.version).trimEnd()
          : '✕ ' + reason;
        if (result.platform === 'codex' && platform === 'codex' && result.models.length) {
          showCodexModels(result);
        }
      } else {
        modelOptions(result.models, result.models.includes(result.model) ? result.model : '');
        message = result.state === 'ok' ? '✓ 取得 ' + result.models.length + ' 個模型' : result.reason;
      }
      $('ai-test-result').className = result.state === 'ok' ? 'ai-ok' : 'error';
      RC.setText('ai-test-result', message);
      if (editingId) {
        const updated = await call('rc.ai.settings.get');
        if (revision === editRevision) { settings = updated; renderEndpoints(); await syncStatus(); }
      }
    } catch (e) { if (revision === editRevision) { $('ai-test-result').className = 'error'; RC.setText('ai-test-result', RC.messageOf(e)); } }
    finally { if (editor === editorRevision) $('ai-test').disabled = false; }
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
      if (returnView === 'ai-chat') {
        const revision = viewRevision;
        void call('rc.ai.status.check').then(status => {
          if (revision === viewRevision) paintStatus(status);
        }).catch(RC.actionFailed);
      }
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
      if (editType === 'openai' && !urlHint()) return;
      if (!$('ai-name').value.trim()) { RC.setText('ai-save-error', '請填寫名稱'); return; }
      const editor = editorRevision;
      $('ai-save').disabled = true;
      try {
        if (await update({ endpoint: { ...endpointFields(), name: $('ai-name').value } }) && editor === editorRevision) closeEditor();
      } finally { $('ai-save').disabled = false; }
    });
    $('ai-add').addEventListener('click', () => edit());
    $('ai-type-openai').addEventListener('click', () => switchType('openai'));
    $('ai-type-local').addEventListener('click', () => switchType('local-tool'));
    for (const key of platformKeys) $('ai-platform-' + key).addEventListener('change', () => switchPlatform(key));
    $('ai-local-model').addEventListener('change', renderCustomModel);
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
