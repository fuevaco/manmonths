// 通用 sheet 與浮動選單：兩者都與資源包安裝無關，我的資源包的各種操作與後續的打包上傳、從資料夾安裝共用。
// 例外確認層（confirm.js）專屬於一鍵安裝的計畫與取消流程，這裡另有一層 #sheet-layer，樣式沿用 .confirm-layer／.confirm-sheet。
//
// RC.openSheet({ title, subtitle?, subtitleMono?, body, primaryLabel, busyLabel?, primaryKind?, cancelLabel?, validate?, onPrimary, onCancel?, onClose?, focus? }) → handle
//   title          標題（粗體）；subtitle 在標題下方的灰色小字（subtitleMono 以等寬字顯示，例如識別碼）
//   body           內容節點陣列（用 RC.sheetField 建立標籤＋欄位）；body 內任何 input 事件都會重新呼叫 validate
//   primaryLabel   唯一的主要按鈕文字；primaryKind: 'primary'（預設，藍）或 'danger'（紅色實心）
//   busyLabel      執行中的按鈕文字（預設「處理中…」）；執行中取消與 Esc 不會關閉
//   validate()     回傳 false 時停用主要按鈕（選填，預設一律可按）
//   onPrimary(handle) 按下主要按鈕：async；正常結束就關閉 sheet，回傳 false 則保持開啟（供多步驟流程換內容）；
//                  丟出錯誤時顯示 RC.messageOf(e) 在錯誤區並保留輸入；工作階段失效則關閉並回登入畫面
//   onCancel(handle) 按下取消鈕或 Esc：回傳 false（可為 async）則不關閉，供「取消上傳」這類取消進行中工作的步驟
//   onClose(info)  sheet 關閉時呼叫（任何途徑，含被另一個 sheet 取代）；info.reset 為 true 代表登出或換帳號清除畫面
//   focus          開啟後取得焦點的節點（預設 body 內第一個 input／textarea，否則取消鈕）
//   handle         { close(), setError(message), setSubtitle(text), refresh(), setBody(nodes), setPrimary({ label, kind, hidden }), setCancel({ label }),
//                    setTitle({ title, subtitle?, subtitleMono? }), el: { body, primary, cancel } }
// RC.closeSheet({ reset? })／RC.sheetOpen()／RC.cancelSheet()（取消鈕與 Esc；執行中不理會）
// RC.sheetField(label, control, { hint? }) → <div class="field">；RC.sheetText(text) → 一般說明文字節點
//
// RC.openPopover(anchor, items) 浮動選單，樣式同齒輪選單；再按一次同一個錨點、點選單外或按 Esc 關閉
//   items: [{ label, onSelect, kind?: 'danger' | 'primary' }, { separator: true }]；danger 紅字、primary 藍色粗體（該列的主要動作）；選取後先關閉再呼叫 onSelect
// RC.closePopover()／RC.popoverOpen()／RC.closePopoverOnOutsideClick(ev)
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, el } = RC;

  // ---------- sheet ----------
  let sheet = null; // { options, busy, handle }
  RC.sheetOpen = () => Boolean(sheet);

  RC.sheetField = function sheetField(label, control, { hint } = {}) {
    return el('div', { className: 'field' }, el('label', { textContent: label }), control, hint ? el('div', { className: 'hint', textContent: hint }) : null);
  };
  RC.sheetText = (text) => el('div', { className: 'sheet-text', textContent: text });

  function renderPrimary() {
    const st = sheet;
    if (!st) return;
    const kind = st.primaryKind;
    $('sheet-primary').classList.toggle('btn-primary', kind !== 'danger');
    $('sheet-primary').classList.toggle('btn-danger', kind === 'danger');
    $('sheet-primary').classList.toggle('hidden', st.primaryHidden === true);
    $('sheet-primary').textContent = st.busy ? (st.options.busyLabel || '處理中…') : st.primaryLabel;
    $('sheet-primary').disabled = st.busy || (st.options.validate ? st.options.validate() === false : false);
    $('sheet-cancel').disabled = st.busy;
  }

  RC.closeSheet = function closeSheet(info) {
    if (!sheet) return;
    const { options } = sheet;
    sheet = null;
    $('sheet-layer').classList.add('hidden');
    $('sheet-body').replaceChildren();
    $('sheet-title').replaceChildren();
    RC.setText('sheet-error', '');
    $('sheet-primary').classList.remove('hidden');
    try { options.onClose?.({ reset: info?.reset === true }); } catch { /* 清理失敗不影響關閉 */ }
  };

  RC.cancelSheet = function cancelSheet() {
    const st = sheet;
    if (!st || st.busy) return;
    const decided = st.options.onCancel?.(st.handle);
    if (decided && typeof decided.then === 'function') return decided.then((keep) => { if (keep !== false && sheet === st) RC.closeSheet(); });
    if (decided !== false) RC.closeSheet();
  };

  /** 標題下方的灰色小字；空字串時移除。 */
  function setSubtitle(text, mono) {
    const title = $('sheet-title');
    title.replaceChildren(...[...title.children].slice(0, 1), ...(text ? [el('span', { className: `confirm-name wrap${mono ? ' mono' : ''}`, textContent: text })] : []));
  }

  RC.openSheet = function openSheet(options) {
    RC.closePopover();
    RC.closeSheet();
    const st = sheet = { options, busy: false, primaryLabel: options.primaryLabel, primaryKind: options.primaryKind || 'primary' };
    const setBody = (nodes) => { if (sheet === st) { $('sheet-body').replaceChildren(...nodes); renderPrimary(); } };
    const titleNodes = ({ title, subtitle, subtitleMono }) => [el('strong', { className: 'wrap', textContent: title }),
      subtitle ? el('span', { className: `confirm-name wrap${subtitleMono ? ' mono' : ''}`, textContent: subtitle }) : null].filter(Boolean); // null 傳給 replaceChildren 會變成文字「null」
    const handle = st.handle = {
      close: () => { if (sheet === st) RC.closeSheet(); },
      setError: (message) => { if (sheet === st) RC.setText('sheet-error', message); },
      setSubtitle: (text) => { if (sheet === st) setSubtitle(text, st.options.subtitleMono); },
      refresh: () => { if (sheet === st) renderPrimary(); },
      setBody,
      setPrimary: ({ label, kind, hidden }) => { if (sheet !== st) return; if (label) st.primaryLabel = label; if (kind) st.primaryKind = kind; if (hidden !== undefined) st.primaryHidden = hidden === true; renderPrimary(); },
      setCancel: ({ label }) => { if (sheet === st && label) $('sheet-cancel').textContent = label; },
      setTitle: (next) => { if (sheet === st) $('sheet-title').replaceChildren(...titleNodes(next)); },
      el: { body: $('sheet-body'), primary: $('sheet-primary'), cancel: $('sheet-cancel') }
    };
    $('sheet-title').replaceChildren(...titleNodes(options));
    $('sheet-cancel').textContent = options.cancelLabel || '取消';
    RC.setText('sheet-error', '');
    $('sheet-body').replaceChildren(...(options.body || []));
    renderPrimary();
    $('sheet-layer').classList.remove('hidden');
    const target = options.focus || RC.findNode($('sheet-body'), n => ['input', 'textarea'].includes(String(n.tagName).toLowerCase())) || $('sheet-cancel');
    target.focus();
    return handle;
  };

  /** 主要按鈕：執行 onPrimary；失敗時留在 sheet 顯示原因並保留輸入。 */
  RC.sheetPrimary = async function sheetPrimary() {
    const st = sheet;
    if (!st || st.busy || $('sheet-primary').disabled) return;
    RC.setText('sheet-error', '');
    st.busy = true; renderPrimary();
    try {
      const keepOpen = (await st.options.onPrimary(st.handle)) === false;
      if (sheet !== st) return;
      st.busy = false;
      if (keepOpen) renderPrimary(); else RC.closeSheet();
    } catch (e) {
      if (sheet !== st) return;
      st.busy = false;
      if (RC.sessionLost(e)) { RC.closeSheet(); return RC.load(); }
      RC.setText('sheet-error', RC.messageOf(e));
      renderPrimary();
    }
  };

  /** body 內的輸入變動時，依 validate 更新主要按鈕。 */
  RC.sheetInput = () => { if (sheet) renderPrimary(); };

  // ---------- 浮動選單 ----------
  let popoverAnchor = null;
  RC.popoverOpen = () => Boolean(popoverAnchor);

  RC.closePopover = function closePopover() {
    if (!popoverAnchor) return;
    popoverAnchor.setAttribute('aria-expanded', 'false');
    popoverAnchor.classList?.remove('is-open');
    popoverAnchor = null;
    $('popover').classList.add('hidden');
    $('popover').replaceChildren();
  };

  /** 點選單與錨點以外的地方時關閉。 */
  RC.closePopoverOnOutsideClick = (ev) => {
    if (!popoverAnchor) return;
    if (ev.target?.closest?.('#popover') || popoverAnchor.contains?.(ev.target)) return;
    RC.closePopover();
  };

  RC.openPopover = function openPopover(anchor, items) {
    const same = popoverAnchor === anchor;
    RC.closePopover();
    if (same) return;
    popoverAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    anchor.classList?.add('is-open');
    const menu = $('popover');
    menu.replaceChildren(...items.map(item => {
      if (item.separator) return el('hr', { className: 'menu-sep' });
      const button = el('button', { type: 'button', role: 'menuitem', className: `menu-item${item.kind === 'danger' ? ' is-danger' : item.kind === 'primary' ? ' is-primary' : ''}`, textContent: item.label });
      button.addEventListener('click', () => { RC.closePopover(); return item.onSelect?.(); });
      return button;
    }));
    menu.classList.remove('hidden');
    placePopover(menu, anchor);
    RC.findNode(menu, n => n.tagName === 'button')?.focus();
  };

  /** 貼在錨點下方、靠錨點右緣；下方放不下就改放上方。 */
  function placePopover(menu, anchor) {
    const rect = anchor.getBoundingClientRect?.();
    if (!rect || !menu.style) return;
    const root = document.documentElement;
    const viewportWidth = root.clientWidth || 0, viewportHeight = root.clientHeight || 0;
    menu.style.right = `${Math.max(8, viewportWidth - rect.right)}px`;
    let top = rect.bottom + 2;
    if (viewportHeight && top + menu.offsetHeight > viewportHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 2);
    menu.style.top = `${top}px`;
  }
})();
