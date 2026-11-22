// 明細頁的使用說明：Markdown 渲染（markdown.js 的 window.RcMarkdown）、連結事件委派、全版閱讀模式；
// 以及完整說明頁 🌐（rc.guide.prepare 準備好本機網址後以系統瀏覽器開啟，卡片與明細共用）。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, el, call } = RC;

  const GUIDE_TIMEOUT_MS = 180000;
  const GUIDE_READY_TTL_MS = 10 * 60 * 1000; // 本機說明頁伺服器閒置 10 分鐘後關閉
  const CONSENT_UNAVAILABLE = 'Orca 視窗不在前景，無法確認開啟，請再試一次';
  const preparingGuides = new Set(); // 正在準備完整說明頁的資源包（卡片與明細共用）
  const readyGuides = new Map(); // packageKey -> { url, at }：已準備好、等使用者再按一次開啟（使用者手勢過期時）
  let readerMode = false; // 使用說明全版閱讀模式
  let detailScroll = 0; // 進入閱讀模式前明細頁的捲動位置，離開時還原

  /** 使用說明標題列右側：完整說明頁 🌐（有才顯示）；⤢ 在有內容時顯示。 */
  RC.renderReadmeTools = function renderReadmeTools(view) {
    const guide = RC.state.currentDetail || RC.state.detailSeed ? RC.guideButton(view) : null;
    $('details-guide-slot').replaceChildren(...(guide ? [guide] : []));
  };

  RC.renderReadme = function renderReadme(text) {
    const box = $('details-readme');
    const content = typeof text === 'string' && text.trim() ? text : '';
    if (!content) box.replaceChildren();
    else if (window.RcMarkdown) box.replaceChildren(window.RcMarkdown.render(content, document));
    else box.textContent = content; // markdown.js 載入失敗時退回純文字
    $('btn-reader').classList.toggle('hidden', !content);
    if (!content) setReader(false);
  };

  /**
   * 以系統瀏覽器開啟網址。回傳 shell.openExternal 的 { opened, reason? }（沒有回傳值視為已開啟）；
   * 沒有 window.orca.shell（例如瀏覽器預覽）時退回 window.open。開啟失敗時丟出例外。
   */
  async function openExternalUrl(url) {
    const shell = window.orca?.shell;
    if (typeof shell?.openExternal === 'function') return (await shell.openExternal(url)) || { opened: true };
    if (typeof window.open === 'function') window.open(url, '_blank', 'noopener,noreferrer');
    return { opened: true };
  }

  /**
   * 處理 openExternal 的回傳：true 表示已開啟；使用者取消不顯示錯誤；
   * 視窗不在前景（無法確認）提示再試一次。
   */
  function openedOk(result, failLabel) {
    if (result?.opened !== false) return true;
    if (result.reason === 'consent-unavailable') RC.toast(CONSENT_UNAVAILABLE, 'error');
    else if (result.reason !== 'cancelled') RC.toast(failLabel, 'error');
    return false;
  }

  // ---------- 連結 ----------
  /** 事件目標往上找到 Markdown 連結（連結內可能還有粗體等子元素）。 */
  function readmeLinkOf(ev) {
    const box = $('details-readme');
    for (let node = ev?.target; node && node !== box; node = node.parentNode) {
      const action = node.getAttribute?.('data-action');
      if (action === 'external-link' || action === 'anchor-link') return node;
    }
    return null;
  }
  const findAnchor = (root, slug) => RC.findNode(root, node => node.getAttribute?.('data-anchor') === slug);

  RC.activateReadmeLink = async function activateReadmeLink(ev) {
    const link = readmeLinkOf(ev);
    if (!link) return;
    ev.preventDefault?.();
    const href = link.getAttribute('data-href') || '';
    if (link.getAttribute('data-action') === 'anchor-link') {
      let slug = href.replace(/^#/, '');
      try { slug = decodeURIComponent(slug); } catch { /* 保留原字串 */ }
      const target = findAnchor($('details-readme'), href.replace(/^#/, '')) || findAnchor($('details-readme'), slug);
      target?.scrollIntoView?.({ block: 'start' });
      return;
    }
    try { openedOk(await openExternalUrl(href), '無法開啟連結'); } catch (e) { RC.toast(`無法開啟連結：${RC.messageOf(e)}`, 'error'); }
  };
  RC.onReadmeKeydown = (ev) => { if (ev.key === 'Enter') return RC.activateReadmeLink(ev); };

  // ---------- 閱讀模式 ----------
  function setReader(on) {
    if (on === readerMode) return;
    readerMode = on;
    const view = $('view-details');
    if (on) detailScroll = view.scrollTop || 0;
    view.classList.toggle('reader', on);
    syncReaderControls();
    view.scrollTop = on ? 0 : detailScroll;
  }
  RC.setReader = setReader;
  RC.readerOpen = () => readerMode;
  RC.toggleReader = () => setReader(!readerMode);

  /** 離開明細頁或重新讀取時：不還原捲動位置，只清除閱讀模式。 */
  RC.resetReader = function resetReader() {
    readerMode = false;
    $('view-details').classList.remove('reader');
    syncReaderControls();
  };

  function syncReaderControls() {
    const label = readerMode ? '結束放大閱讀' : '放大閱讀';
    $('btn-reader').setAttribute('aria-label', label);
    $('btn-reader').setAttribute('title', label);
    const back = readerMode ? '返回明細' : '返回清單';
    $('btn-back').setAttribute('aria-label', back);
    $('btn-back').setAttribute('title', back);
  }

  /** ←：閱讀模式先回到明細頁（還原捲動位置），否則回到清單。 */
  RC.goBack = function goBack() {
    if (readerMode) return setReader(false);
    return RC.backToList();
  };

  // ---------- 完整說明頁 🌐 ----------
  /** 已準備好且未過期的網址；過期的順手清掉。 */
  function readyUrl(key) {
    const ready = readyGuides.get(key);
    if (ready && Date.now() - ready.at < GUIDE_READY_TTL_MS) return ready.url;
    readyGuides.delete(key);
    return null;
  }

  RC.guideButton = function guideButton(p) {
    if (p?.hasFullGuide !== true) return null;
    const busy = preparingGuides.has(p.packageKey);
    const ready = !busy && readyUrl(p.packageKey) !== null;
    const label = busy ? '準備中…' : ready ? '開啟完整說明頁（已準備好）' : '開啟完整說明頁';
    const button = el('button', { type: 'button', className: `btn btn-icon btn-card-icon${busy ? ' is-busy' : ''}${ready ? ' is-ready' : ''}`, title: label, 'aria-label': label, 'aria-busy': String(busy),
      'data-action': 'full-guide', disabled: busy }, busy ? RC.ICONS.spinner() : RC.ICONS.globe());
    button.addEventListener('click', () => openFullGuide(p.packageKey));
    return button;
  };

  async function openFullGuide(key) {
    if (preparingGuides.has(key)) return;
    // 上一次準備好但沒能開啟（使用者手勢過期等）：直接用已拿到的網址，這次點擊就是新的手勢
    const ready = readyUrl(key);
    if (ready) return launchGuide(key, ready);
    preparingGuides.add(key);
    RC.rerenderPackage(key);
    let url = null;
    try {
      const result = await call('rc.guide.prepare', { packageKey: key }, GUIDE_TIMEOUT_MS);
      url = typeof result?.url === 'string' && /^https?:\/\//i.test(result.url) ? result.url : null;
      if (!url) RC.toast('這個版本的外掛無法開啟完整說明頁，請更新 Orca 外掛', 'error');
    } catch (e) {
      RC.actionFailed(e);
    } finally {
      preparingGuides.delete(key);
    }
    // prepare 可能花了不少時間而使手勢過期：開啟失敗時改成「已準備好，再按一次開啟」
    if (url) await launchGuide(key, url, true);
    RC.rerenderPackage(key);
  }

  async function launchGuide(key, url, fresh = false) {
    try {
      const result = await openExternalUrl(url);
      if (result?.opened === false) {
        // 使用者自己取消：不再保留；視窗不在前景：保留，稍後再按即可
        if (result.reason === 'cancelled') readyGuides.delete(key);
        else readyGuides.set(key, { url, at: fresh ? Date.now() : readyGuides.get(key)?.at ?? Date.now() });
      } else readyGuides.delete(key);
      openedOk(result, '無法開啟完整說明頁');
    } catch (e) {
      readyGuides.set(key, { url, at: fresh ? Date.now() : readyGuides.get(key)?.at ?? Date.now() });
      RC.toast(`無法開啟完整說明頁：${RC.messageOf(e)}。說明頁已準備好，請再按一次 🌐 開啟`, 'error');
    }
    RC.rerenderPackage(key);
  }
})();
