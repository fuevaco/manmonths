// 進入點：最後載入；綁定 index.html 上固定元素的事件，然後讀取工作階段。
// 動態建立的卡片、明細與確認層內容由各模組自行綁定。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $ } = RC;

  function boot() {
    if (document.body.classList.contains('light') || document.documentElement.classList.contains('light')) RC.applyTheme('light');
    window.orca?.on?.('theme', (t) => t?.colorScheme && RC.applyTheme(t.colorScheme));

    // 頂部列與齒輪選單
    $('login-form').addEventListener('submit', RC.signIn);
    $('btn-logout').addEventListener('click', RC.signOut);
    $('btn-my-packages').addEventListener('click', RC.openDeveloper);
    $('btn-refresh').addEventListener('click', RC.refresh);
    RC.closeMenu();
    $('btn-settings').addEventListener('click', RC.toggleMenu);
    document.addEventListener('click', RC.closeMenuOnOutsideClick);
    document.addEventListener('click', RC.closePopoverOnOutsideClick);
    // Esc 依序關閉：浮動選單與齒輪選單 → 通用 sheet → 確認層 → 閱讀模式
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (RC.popoverOpen()) RC.closePopover();
      else if (RC.menuOpen()) RC.closeMenu();
      else if (RC.sheetOpen()) RC.cancelSheet();
      else if (RC.confirmOpen()) RC.cancelConfirm();
      else if (RC.readerOpen()) RC.setReader(false);
    });

    // 明細頁與使用說明
    $('btn-back').addEventListener('click', RC.goBack);
    $('btn-reader').addEventListener('click', RC.toggleReader);
    $('details-readme').addEventListener('click', RC.activateReadmeLink);
    $('details-readme').addEventListener('keydown', RC.onReadmeKeydown);

    // 可更新數量與偏好
    document.addEventListener('visibilitychange', RC.onVisibilityChange);
    $('update-banner').addEventListener('click', RC.showUpdates);
    $('check-interval').addEventListener('change', RC.changeCheckInterval);
    $('details-retry').addEventListener('click', RC.retryDetails);

    // 一鍵安裝的確認層與短提示
    $('confirm-primary').addEventListener('click', RC.confirmPrimary);
    $('confirm-cancel').addEventListener('click', RC.cancelConfirm);
    $('toast').addEventListener('click', RC.hideToast);

    // 通用 sheet 與我的資源包
    $('sheet-primary').addEventListener('click', RC.sheetPrimary);
    $('sheet-cancel').addEventListener('click', RC.cancelSheet);
    $('sheet-body').addEventListener('input', RC.sheetInput);
    $('developer-retry').addEventListener('click', () => RC.loadDeveloper());
    $('btn-dev-upload').addEventListener('click', () => RC.openUploadSheet());
    $('btn-dev-install').addEventListener('click', () => RC.openInstallFromFolder());

    // 查詢列
    $('catalog-form').addEventListener('submit', (ev) => ev.preventDefault());
    $('catalog-search').addEventListener('keydown', RC.onSearchKeydown);
    $('catalog-search').addEventListener('input', RC.onSearchInput);
    $('catalog-type').addEventListener('change', RC.loadCatalog);
    $('catalog-installation').addEventListener('change', RC.loadCatalog);
    $('catalog-sort-field').addEventListener('change', RC.changeSortField);
    $('catalog-sort-direction').addEventListener('click', RC.toggleSortDirection);
    $('catalog-retry').addEventListener('click', RC.loadCatalog);
    $('catalog-preview').addEventListener('change', RC.changePreview);

    RC.load();
    RC.call('rc.client.migration').then(result => {
      if (result?.message) RC.toast(result.message, result.blocked ? 'error' : 'ok');
    }).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
