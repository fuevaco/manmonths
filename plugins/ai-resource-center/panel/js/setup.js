// 設定參數：欄位呈現與讀取（明細區塊與確認層共用）；明細「設定參數」區塊預設收合，儲存後以新值重新套用到已部署的目標。
// 一般值直接編輯；秘密只以 password 欄位輸入，永不回顯。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, el, call, state } = RC;

  const SOURCE_LABELS = { Global: '使用者全域設定', ProjectOverride: '專案覆寫', ManifestDefault: '資源包預設值', PendingInput: '本次輸入', Unset: '未設定' };
  const SAVE_TIMEOUT_MS = 120000;

  // ---------- 欄位 ----------
  function setupInput(p) {
    const attrs = { name: p.parameterId, 'data-param': p.parameterId, 'aria-label': p.label || p.parameterId };
    if (p.isSecret) return el('input', { ...attrs, type: 'password', value: '', autocomplete: 'off', placeholder: p.isSet ? '已設定；輸入新值以取代' : '輸入秘密值' });
    if (p.type === 'boolean') return el('input', { ...attrs, type: 'checkbox', checked: p.value === true || p.value === 'true' });
    if (p.type === 'choice') {
      const select = el('select', attrs, ...(p.value ? [] : [el('option', { value: '', textContent: '請選擇' })]),
        ...(p.options || []).map(o => el('option', { value: o.value, textContent: o.label })));
      select.value = p.value ?? '';
      return select;
    }
    return el('input', { ...attrs, type: 'text', value: p.value ?? '', spellcheck: false, autocomplete: 'off' });
  }

  /** 一個參數欄位；inputs 收集輸入元件供 collectSetup 讀取。 */
  RC.paramField = function paramField(p, inputs) {
    const input = setupInput(p);
    inputs.set(p.parameterId, input);
    const label = `${p.label || p.parameterId}${p.required ? '（必填）' : ''}`;
    const source = p.isSecret ? (p.isSet ? '已設定' : '未設定') : p.source && p.source !== 'Unset' ? `來源：${SOURCE_LABELS[p.source] || p.source}` : '';
    return el('div', { className: `field setup-field${p.type === 'boolean' ? ' setup-check' : ''}`, 'data-param-row': p.parameterId },
      p.type === 'boolean' ? el('label', { className: 'checkbox' }, input, el('span', { textContent: label })) : el('label', { textContent: label }),
      p.type === 'boolean' ? null : input,
      source ? el('div', { className: `hint${p.isSecret && p.isSet ? ' setup-set' : ''}`, 'data-role': 'param-state', textContent: source }) : null,
      p.description ? el('div', { className: 'hint', textContent: p.description }) : null);
  };

  /** 讀取表單：必填驗證；秘密留空表示不變（尚未設定的必填秘密除外）。 */
  RC.collectSetup = function collectSetup(params, inputs) {
    const values = {}, secrets = {};
    let error = '';
    for (const p of params) {
      const field = inputs.get(p.parameterId);
      if (!field) continue;
      const label = p.label || p.parameterId;
      if (p.isSecret) {
        if (field.value) secrets[p.parameterId] = field.value;
        else if (p.required && !p.isSet && !error) error = `請輸入「${label}」`;
        continue;
      }
      if (p.type === 'boolean') { values[p.parameterId] = field.checked === true; continue; }
      const value = String(field.value ?? '').trim();
      if (!value && p.required && !error) error = p.type === 'choice' ? `請選擇「${label}」` : `請填寫「${label}」`;
      values[p.parameterId] = value || null;
    }
    return { values, secrets, error };
  };
  RC.clearSecrets = (inputs) => { for (const field of inputs.values()) if (field.type === 'password') field.value = ''; };

  /** 儲存參數（與 LC-AI-Pack 共用；秘密只存入作業系統的安全儲存區）。 */
  RC.saveSetup = (packageKey, values, secrets) => call('rc.install.saveSetup', { packageKey, values, secrets }, SAVE_TIMEOUT_MS);

  // ---------- 明細區塊 ----------
  let setupInputs = new Map(); // 明細「設定參數」的輸入欄位
  let setupFold = null;
  let setupSaving = false;

  const visibleParameters = (detail) => (detail.parameters || []).filter(p => p.visible !== false);

  RC.renderSetup = function renderSetup() {
    const box = $('details-setup');
    const detail = state.currentDetail;
    const wasOpen = setupFold?.open === true;
    setupFold = null;
    setupInputs = new Map();
    if (!detail) return box.replaceChildren();
    if (detail.parametersError) {
      setupFold = el('details', { className: 'fold', 'data-role': 'setup', open: wasOpen }, el('summary', { textContent: '設定參數' }),
        el('div', { className: 'error', textContent: `設定參數無法讀取：${detail.parametersError.message || '請稍後再試'}` }));
      return box.replaceChildren(setupFold);
    }
    const params = visibleParameters(detail);
    if (!params.length) return box.replaceChildren();
    const save = el('button', { type: 'button', className: 'btn btn-primary btn-block', 'data-action': 'save-setup', textContent: '儲存並重新套用' });
    save.addEventListener('click', saveSetupAndReapply);
    setupFold = el('details', { className: 'fold', 'data-role': 'setup', open: wasOpen }, el('summary', { textContent: '設定參數' }),
      el('div', { className: 'setup-form' }, ...params.map(p => RC.paramField(p, setupInputs)),
        el('div', { className: 'hint', textContent: '與 LC-AI-Pack 共用同一份設定；秘密只存入作業系統的安全儲存區，留空表示不變。' }),
        el('div', { className: 'error hidden', 'data-role': 'setup-error', role: 'alert' }), save));
    box.replaceChildren(setupFold);
    RC.updateSetupButton();
  };

  /** 換到另一個資源包的明細時先清空區塊（保留輸入欄位表，待新明細重繪）。 */
  RC.clearSetup = () => { setupFold = null; $('details-setup').replaceChildren(); };

  const setupPart = (role) => setupFold
    ? RC.findNode(setupFold, node => node.getAttribute?.('data-role') === role || node.getAttribute?.('data-action') === role) : null;

  RC.updateSetupButton = function updateSetupButton() {
    const save = setupPart('save-setup');
    if (!save || !state.currentDetail) return;
    const busy = state.running.get(state.currentDetail.packageKey);
    save.disabled = setupSaving || Boolean(busy) || RC.confirmOpen();
    save.textContent = setupSaving ? '儲存中…' : busy === 'reapply' ? '重新套用中…' : '儲存並重新套用';
  };

  function setupError(message) {
    const node = setupPart('setup-error');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('hidden', !message);
  }

  async function saveSetupAndReapply() {
    const detail = state.currentDetail;
    if (!detail || setupSaving || RC.confirmOpen() || state.running.has(detail.packageKey)) return;
    const { values, secrets, error } = RC.collectSetup(visibleParameters(detail), setupInputs);
    setupError(error);
    if (error) return;
    const request = state.detailsRequest, key = detail.packageKey;
    setupSaving = true; RC.updateSetupButton();
    try {
      const result = await RC.saveSetup(key, values, secrets);
      if (request === state.detailsRequest && Array.isArray(result?.parameters)) state.currentDetail.parameters = result.parameters;
    } catch (e) {
      if (RC.sessionLost(e)) return RC.load();
      if (request === state.detailsRequest) setupError(RC.messageOf(e));
      return;
    } finally {
      setupSaving = false;
      RC.clearSecrets(setupInputs);
      RC.updateSetupButton();
    }
    return RC.startAction(key, 'reapply');
  }
})();
