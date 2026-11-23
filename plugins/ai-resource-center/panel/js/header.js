// 頂部列與齒輪選單：連線狀態點、主題、選單開合、Orca 外掛版本，以及選單內的偏好（Preview、檢查更新頻率）。
// 偏好存在外掛（rc.preferences.get/set）；排序欄位與方向由查詢列（catalog.js）負責驗證與呈現。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, call, state } = RC;

  // ---------- 頂部列 ----------
  RC.setStatus = function setStatus(s) {
    const hiddenNow = $('status-dot').classList.contains('hidden');
    $('status-dot').className = `status-dot ${s}`;
    $('status-dot').classList.toggle('hidden', hiddenNow);
  };

  RC.applyTheme = function applyTheme(scheme) {
    document.body.classList.toggle('light', scheme === 'light');
    document.documentElement.classList.toggle('light', scheme === 'light');
  };

  // ---------- 齒輪選單 ----------
  RC.setMenu = function setMenu(open) {
    $('settings-menu').classList.toggle('hidden', !open);
    $('btn-settings').setAttribute('aria-expanded', String(open));
  };
  RC.closeMenu = () => RC.setMenu(false);
  RC.menuOpen = () => !$('settings-menu').classList.contains('hidden');
  RC.toggleMenu = () => RC.setMenu(!RC.menuOpen());
  /** 點選選單與齒輪以外的地方時關閉選單。 */
  RC.closeMenuOnOutsideClick = (ev) => {
    if (RC.menuOpen() && !ev.target?.closest?.('#settings-menu, #btn-settings')) RC.closeMenu();
  };

  /** 身分列：圓形縮寫頭像（帳號第一個字元，大寫）、帳號、只含主機名稱的市集網址（滑過顯示完整網址）。 */
  RC.renderMenuIdentity = function renderMenuIdentity(session) {
    const account = String(session?.account || '').trim();
    const url = String(session?.marketUrl || '').trim();
    let host = url;
    try { host = new URL(url).hostname || url; } catch (e) { /* 不是有效網址時照原文顯示 */ }
    $('menu-avatar').textContent = (Array.from(account)[0] || '?').toUpperCase();
    $('menu-account').textContent = account;
    $('menu-account').setAttribute('title', account);
    $('menu-url').textContent = host;
    $('menu-url').setAttribute('title', url);
  };

  // 齒輪選單最底部以小字顯示 Orca 外掛自己的版本；讀不到時不顯示該行。
  RC.loadPluginVersion = async function loadPluginVersion() {
    const request = state.detailsRequest;
    RC.setText('menu-version', '');
    try {
      const result = await call('rc.client.getVersions', {});
      if (request !== state.detailsRequest || !result?.orca?.version) return;
      RC.setText('menu-version', `外掛 v${String(result.orca.version).replace(/^v/i, '')}`);
    } catch (e) {
      if (request !== state.detailsRequest) return;
      if (RC.sessionLost(e)) return RC.load();
    }
  };

  // ---------- 偏好 ----------
  // 檢查更新頻率（分鐘；0 = 關閉）。可選的值只寫在 index.html 的 #check-interval 選項。
  const DEFAULT_CHECK_INTERVAL = 15;
  const checkIntervals = () => RC.optionValues($('check-interval')).map(Number);
  let checkInterval = DEFAULT_CHECK_INTERVAL;

  /** 選單內偏好控制項的呈現。 */
  function renderMenuSettings() {
    $('catalog-preview').checked = state.showPreview;
    $('check-interval').value = String(checkInterval);
  }

  /** 偏好只是便利：儲存失敗不影響查詢，也不打擾使用者。 */
  RC.savePreferences = function savePreferences(update) {
    return call('rc.preferences.set', update).catch(() => {});
  };

  /** 讀取偏好；讀不到或無效時用預設值，仍可瀏覽清單。 */
  RC.loadPreferences = async function loadPreferences() {
    RC.setSort(); state.showPreview = false; checkInterval = DEFAULT_CHECK_INTERVAL;
    try {
      const saved = await call('rc.preferences.get', {});
      RC.setSort(saved?.sortField, saved?.sortDirection);
      state.showPreview = saved?.showPreview === true;
      if (checkIntervals().includes(saved?.checkIntervalMinutes)) checkInterval = saved.checkIntervalMinutes;
    } catch (e) {
      RC.setSort();
    }
    RC.renderSortControls();
    renderMenuSettings();
  };

  /** 檢查更新頻率只存偏好，排程由 worker 依偏好重新安排；儲存失敗時還原選項。 */
  RC.changeCheckInterval = async function changeCheckInterval() {
    const next = Number($('check-interval').value);
    if (!checkIntervals().includes(next)) return renderMenuSettings();
    const previous = checkInterval;
    checkInterval = next;
    try {
      await call('rc.preferences.set', { checkIntervalMinutes: next });
    } catch (e) {
      if (RC.sessionLost(e)) return RC.load();
      if (checkInterval === next) checkInterval = previous;
      renderMenuSettings();
      RC.toast(`無法儲存檢查更新設定：${RC.messageOf(e)}`, 'error');
    }
  };

  RC.changePreview = function changePreview() {
    state.showPreview = $('catalog-preview').checked === true;
    RC.savePreferences({ showPreview: state.showPreview });
    return RC.loadCatalog();
  };
})();
