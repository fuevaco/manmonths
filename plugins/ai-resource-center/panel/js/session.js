// 登入狀態：讀取工作階段並切換登入／已登入畫面，登入、登出與 ↻ 重新整理。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, call, state } = RC;

  const SIGN_IN_TIMEOUT_MS = 60000;
  // 沒有可用的鑰匙圈（Ubuntu）時無法安全儲存登入：顯示說明並停用登入。舊的 host 不回報時視為可用。
  const KEYRING_NOTICE = '這台電腦沒有可用的鑰匙圈，無法安全儲存登入。請安裝並解鎖 GNOME 鑰匙圈後重新開啟。';
  let keyringUnavailable = false;

  function setBusy(on) {
    state.busy = on;
    for (const id of ['btn-login', 'btn-logout', 'btn-refresh', 'in-url', 'in-user', 'in-pass']) $(id).disabled = on;
    $('btn-login').textContent = on ? '登入中…' : '登入';
    if (!on && keyringUnavailable) $('btn-login').disabled = true;
  }

  /** 依工作階段呈現：未登入時清掉所有已登入的狀態並顯示登入畫面；已登入時顯示清單並開始讀取。 */
  function render(session) {
    keyringUnavailable = session.secretsProtection === 'unavailable';
    state.detailsRequest += 1;
    state.currentPackage = null;
    RC.banner(null);
    RC.closeConfirm(); // 登出或換帳號後，待確認的計畫已失效
    if (!session.signedIn) {
      state.catalogRequest += 1;
      state.preferencesRequest += 1;
      RC.resetUpdates();
      RC.clearDetachedNotes?.();
      RC.resetReader();
      RC.resetDeveloper();
      RC.clearCatalog();
      RC.setStatus('');
      if (!$('in-url').value) $('in-url').value = session.marketUrl || '';
      RC.setText('login-notice', keyringUnavailable ? KEYRING_NOTICE : session.notice || '');
      RC.setText('login-error', '');
      $('btn-login').disabled = keyringUnavailable;
      RC.showView('login');
      ($('in-url').value ? $('in-user') : $('in-url')).focus();
      return;
    }
    RC.renderMenuIdentity(session);
    RC.setStatus('connected');
    $('in-pass').value = '';
    RC.showView('main');
    RC.loadPluginVersion();
    RC.startCatalog();
    RC.syncUpdatesOnOpen();
  }

  /** 讀取工作階段；工作階段失效的錯誤也走這裡回到登入畫面。 */
  RC.load = async function load() {
    try {
      render(await call('rc.session.getState', undefined, SIGN_IN_TIMEOUT_MS));
    } catch (e) {
      RC.setStatus('error');
      RC.showView('login');
      RC.banner(RC.messageOf(e), 'error');
    }
  };

  RC.signIn = async function signIn(ev) {
    ev.preventDefault();
    if (state.busy || keyringUnavailable) return;
    const input = { marketUrl: $('in-url').value, username: $('in-user').value, password: $('in-pass').value };
    if (!input.marketUrl.trim() || !input.username.trim() || !input.password) {
      RC.setText('login-error', '請填寫市集網址、帳號與密碼');
      return;
    }
    RC.setText('login-error', '');
    setBusy(true);
    try {
      const session = await call('rc.session.signIn', input, SIGN_IN_TIMEOUT_MS);
      $('in-url').value = session.marketUrl;
      render(session);
    } catch (e) {
      RC.setText('login-notice', '');
      RC.setText('login-error', RC.messageOf(e));
      $(e && e.code === 'invalid_url' ? 'in-url' : 'in-pass').focus();
    } finally {
      $('in-pass').value = '';
      setBusy(false);
    }
  };

  RC.signOut = async function signOut() {
    RC.closeMenu();
    if (state.busy) return;
    setBusy(true);
    try {
      render(await call('rc.session.signOut'));
    } catch (e) {
      RC.banner(RC.messageOf(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** ↻：清單頁重新讀取登入狀態與目錄；明細頁重新讀取同一份詳情，留在原頁。兩者都立即同步可更新數量。 */
  RC.refresh = async function refresh() {
    if (state.busy) return;
    if (RC.isShown('developer')) return RC.loadDeveloper?.();
    if (RC.isShown('details') && state.currentPackage) {
      RC.syncUpdates(true);
      return RC.openDetails(state.currentPackage.packageKey); // 一律重新取推薦版本與已安裝狀態
    }
    setBusy(true);
    try {
      render(await call('rc.session.getState', undefined, SIGN_IN_TIMEOUT_MS));
    } catch (e) {
      if (RC.sessionLost(e)) return RC.load();
      RC.banner(RC.messageOf(e), 'error');
    } finally {
      setBusy(false);
    }
  };
})();
