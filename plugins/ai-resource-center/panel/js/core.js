// 面板共用核心：命名空間、DOM 輔助、與 worker 溝通、錯誤訊息、跨模組狀態、短提示與畫面切換。
// 面板腳本都是 classic script，依 index.html 的 <script src> 順序載入（本檔最先、boot.js 最後）。
// 模組之間只透過 window.RcPanel（以下稱 RC）溝通：各檔把對外函式掛在 RC 上，呼叫其他模組一律寫成 RC.xxx()，
// 在執行時才取用，因此除了本檔必須最先載入，其餘模組彼此沒有載入順序相依。
(function () {
  'use strict';

  const RC = window.RcPanel = {};

  RC.$ = (id) => document.getElementById(id);

  /** 建立元素；文字一律用 textContent，市集與路徑內容不會被當成 HTML。 */
  RC.el = function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'title') node.setAttribute(k, v);
      else if (k === 'className') node.className = v; else node[k] = v;
    }
    node.append(...children.filter(Boolean));
    return node;
  };

  /** 深度優先找第一個符合的節點（含 root 本身）。 */
  RC.findNode = function findNode(node, match) {
    if (match(node)) return node;
    for (const child of node.children || []) { const found = findNode(child, match); if (found) return found; }
    return null;
  };

  /** 下拉選單的選項值；選項只寫在 index.html，面板邏輯由此讀取，不另外維護一份清單。 */
  RC.optionValues = (select) => [...(select?.children || [])]
    .filter(o => String(o.tagName).toLowerCase() === 'option').map(o => o.getAttribute('value') ?? o.textContent);

  // ---------- 跨模組共用狀態（只放多個模組都會讀寫的欄位；單一模組的狀態留在該模組內） ----------
  RC.state = {
    busy: false, // 登入、登出、重新整理進行中
    showPreview: false, // 偏好「顯示 Preview 版本」；清單與明細都依此帶 previewMode
    // 請求序號：遞增後，較晚抵達的舊結果會被丟棄
    catalogRequest: 0,
    preferencesRequest: 0,
    detailsRequest: 0,
    catalogPending: 0, // 進行中的清單查詢數，切回面板時避免重疊
    currentPackage: null, // 明細頁目前的資源包 { packageKey, previewMode, version }
    currentDetail: null, // worker 回傳的明細
    detailSeed: null, // 從清單帶進明細的資源包（作者、安裝次數、日期等 worker 明細沒有的欄位）
    running: new Map(), // packageKey → 執行中的一鍵動作；同一資源包同時只允許一個
    cancelRequested: new Set() // 已送出取消請求的資源包；操作結束前停用取消按鈕
  };

  // ---------- 與 worker 溝通（請求契約見 worker/contract.mjs） ----------
  RC.call = function call(method, input, timeoutMs) {
    if (!window.orca?.plugin) return Promise.reject(new Error('Orca Plugin Bridge 尚未就緒'));
    return window.orca.plugin.request(method, input, timeoutMs ? { timeoutMs } : undefined);
  };

  // 這些錯誤代碼代表工作階段已失效，面板回到登入畫面並顯示原因
  const SESSION_LOST = new Set(['session_expired', 'account_unavailable', 'signed_out']);
  RC.sessionLost = (e) => SESSION_LOST.has(e && e.code);

  // 共用資料格式過新時只顯示易懂提示，不帶技術細節（細節已寫入 worker log）。
  const SHARED_DATA_TOO_NEW = '共用資料由較新版本寫入，請更新 Orca 外掛';
  RC.messageOf = (e) => (e && e.code === 'sharedDataTooNew' ? SHARED_DATA_TOO_NEW : (e && e.message) || String(e || '發生未知錯誤'));

  // ---------- 文字與提示 ----------
  RC.setText = function setText(id, text) {
    const node = RC.$(id);
    node.textContent = text || '';
    node.classList.toggle('hidden', !text);
  };

  RC.banner = function banner(msg, kind = 'info') {
    const b = RC.$('banner');
    if (!msg) return b.classList.add('hidden');
    b.textContent = msg;
    b.className = `banner ${kind}`;
  };

  // 短提示：全部成功幾秒後消失；有失敗或錯誤時較久
  let toastTimer = null;
  RC.toast = function toast(message, kind = 'ok') {
    const node = RC.$('toast');
    clearTimeout(toastTimer);
    node.textContent = message;
    node.className = `toast ${kind}`;
    toastTimer = setTimeout(() => node.classList.add('hidden'), kind === 'error' ? 8000 : 4000);
  };
  RC.hideToast = () => { clearTimeout(toastTimer); RC.$('toast').classList.add('hidden'); };

  /** 使用者觸發的操作失敗：工作階段失效時回到登入畫面，否則以短提示顯示原因。 */
  RC.actionFailed = function actionFailed(e) {
    if (RC.sessionLost(e)) return RC.load();
    RC.toast(RC.messageOf(e), 'error');
  };

  // ---------- 畫面 ----------
  RC.DEVELOPER_TITLE = '我的資源包';
  const VIEWS = ['loading', 'login', 'main', 'details', 'developer'];
  RC.isShown = (view) => !RC.$(`view-${view}`).classList.contains('hidden');

  RC.showView = function showView(name) {
    for (const v of VIEWS) RC.$(`view-${v}`).classList.toggle('hidden', v !== name);
    const signedInView = name === 'main' || name === 'details' || name === 'developer';
    RC.$('btn-refresh').classList.toggle('hidden', !signedInView);
    RC.$('btn-settings').classList.toggle('hidden', !signedInView);
    // 明細頁與我的資源包：頂部列左側是 ← 與標題；其他畫面恢復「● 資源中心」
    const hasBack = name === 'details' || name === 'developer';
    RC.$('btn-back').classList.toggle('hidden', !hasBack);
    RC.$('status-dot').classList.toggle('hidden', hasBack);
    if (name === 'developer') {
      RC.setHeaderTitle(RC.DEVELOPER_TITLE);
      RC.$('btn-back').setAttribute('aria-label', '返回資源中心');
      RC.$('btn-back').setAttribute('title', '返回資源中心');
    } else if (name !== 'details') {
      RC.setHeaderTitle('');
      RC.$('btn-back').setAttribute('aria-label', '返回清單');
      RC.$('btn-back').setAttribute('title', '返回清單');
    }
    if (!signedInView) RC.closeMenu();
  };

  RC.setHeaderTitle = function setHeaderTitle(name) {
    RC.$('header-title').textContent = name || '資源中心';
    RC.$('header-title').setAttribute('title', name || '');
  };
})();
