// 我的資源包視圖：從齒輪選單進入，頂端按鈕列固定；← 返回資源中心並還原其捲動位置。
// 清單來自 rc.dev.listMyPackages：每個資源包一張卡片，版本由新到舊、每列只佔一行（版號、通道、狀態、時間、⋯），
// 所有操作（含主要動作「申請上架…」「取回申請…」）收進「⋯」選單；審核歷程在版本列下方就地展開。
// 預設顯示最新 3 個版本，目前的正式版不在其中時固定顯示在最後；「再顯示 10 個版本」每次多顯示 10 個。
// 各操作的 sheet 用 sheet.js 的通用 sheet，成功後 toast 並重新讀取。
// 「打包並上傳…」見 upload.js；「本機開發中」區塊（#developer-local）與從資料夾安裝見 sideload.js。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, el, call } = RC;

  const COLLAPSED_VERSIONS = 3; // 預設顯示最新的版本數
  const VERSION_STEP = 10; // 每按一次「再顯示 10 個版本」多顯示的版本數

  let mainScroll = 0; // 進入前資源中心清單的捲動位置，返回時還原
  let request = 0; // 讀取序號：較晚抵達的舊結果丟棄
  let data = { forbidden: false, packages: [] };
  let loaded = false;
  const expansions = new Map(); // packageKey → 「再顯示 10 個版本」按過的次數；不記憶，重新載入面板就回到預設
  const historyOpen = new Map(); // versionId → { rows: array|null, error: string }：已展開審核歷程的版本
  const pending = new Set(); // 正在執行停用／啟用的 versionId，避免連點

  // ---------- 進出 ----------
  /** 進入「我的資源包」：關閉選單、記住資源中心的捲動位置（篩選條件留在原欄位，不動）。 */
  RC.openDeveloper = function openDeveloper() {
    RC.closeMenu();
    if (RC.isShown('developer')) return;
    if (RC.isShown('main')) mainScroll = $('view-main').scrollTop;
    else if (RC.isShown('details')) { mainScroll = RC.listScrollPosition(); RC.leaveDetails(); }
    else return; // 未登入時沒有此入口
    RC.showView('developer');
    $('view-developer').scrollTop = 0;
    return RC.loadDeveloper?.();
  };

  /** ←：回到資源中心，保留篩選與捲動位置，並在背景重新整理清單狀態。 */
  RC.leaveDeveloper = function leaveDeveloper() {
    RC.closePopover();
    RC.showView('main');
    $('view-main').scrollTop = mainScroll;
    return RC.loadCatalog({ keepList: true });
  };

  /** 登出或換帳號時清掉本視圖的內容。 */
  RC.resetDeveloper = function resetDeveloper() {
    mainScroll = 0;
    request += 1;
    data = { forbidden: false, packages: [] };
    loaded = false;
    expansions.clear(); historyOpen.clear(); pending.clear();
    RC.resetLocalPackages?.();
    RC.closePopover();
    RC.closeSheet({ reset: true });
    $('developer-list').replaceChildren();
    $('btn-dev-upload').disabled = false;
    RC.setText('developer-status', '');
    $('developer-retry').classList.add('hidden');
  };

  /** 打包並上傳的預檢通過後，判斷識別碼是不是新的：清單已載入時回傳是否已有此識別碼，尚未載入回傳 null（不顯示說明）。 */
  RC.developerHasPackage = (packageKey) => loaded ? data.packages.some(p => p.packageKey.toLowerCase() === String(packageKey).toLowerCase()) : null;

  // ---------- 格式 ----------
  const pad = (n) => String(n).padStart(2, '0');
  /** 本地時間 MM/DD HH:mm；無法解析時回傳空字串。 */
  function stamp(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  /** 版本列的時間：今年顯示 MM/DD HH:mm，跨年顯示 YYYY/MM/DD；無法解析時回傳空字串。 */
  function versionStamp(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() === new Date().getFullYear() ? stamp(iso) : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  }
  const badge = (kind, text) => el('span', { className: `badge ${kind}`, textContent: text });

  /** 狀態徽章：已上架／可測試綠藍、送審中黃、已駁回紅；沒見過的狀態用灰色顯示伺服器給的文字。 */
  function statusBadge(v) {
    if (v.status === 'active') return v.channel === 'preview' ? badge('b-pre', '可測試') : badge('b-rel', '已上架');
    if (v.status === 'pending_review') return badge('b-rev', '送審中');
    if (v.status === 'rejected') return badge('b-rej', '已駁回');
    return badge('b-off', v.statusLabel || '狀態未知');
  }

  function moreButton(label) {
    return el('button', { type: 'button', className: 'dev-more', 'aria-label': label, title: label, 'aria-haspopup': 'true', 'aria-expanded': 'false', textContent: '⋯' });
  }

  // ---------- 繪製 ----------
  function historyBox(v) {
    const h = historyOpen.get(v.id);
    const box = el('div', { className: 'dev-hist', 'data-role': 'history' });
    if (!h.rows && !h.error) box.append(el('div', { className: 'muted', textContent: '載入審核歷程…' }));
    else if (h.error) box.append(el('div', { className: 'dev-vrej', textContent: h.error }));
    else if (!h.rows.length) box.append(el('div', { className: 'muted', textContent: '沒有審核歷程' }));
    else for (const row of h.rows) {
      box.append(el('div', { 'data-role': 'history-row' },
        el('span', { className: 'muted', textContent: stamp(row.createdAt) || String(row.timeText || '').replace(/^\d{4}\//, '') }),
        el('span', { className: 'wrap' }, el('span', { textContent: `${row.actionLabel}${row.actor ? ` · ${row.actor}` : ''}` }),
          row.comment && row.comment !== '—' ? el('div', { className: 'muted', 'data-role': 'history-comment', textContent: row.comment }) : null)));
    }
    return box;
  }

  /** 目前的正式版：版號最新的 release 且 active 的版本（停用與否都算；LC-AI-Pack 沒有另外的定義）。 */
  const currentRelease = (pack) => pack.versions.find(v => v.channel === 'release' && v.status === 'active') || null;

  /** 版本「⋯」選單：第一段是這個版本的主要動作（藍色粗體，沒有就不出現），其次是停用／啟用與審核歷程，Preview 才有紅色刪除。 */
  function versionMenu(pack, v) {
    const open = historyOpen.has(v.id);
    const primary = v.primaryAction === 'submit' ? [{ label: '申請上架…', kind: 'primary', onSelect: () => reviewSheet(pack, v, 'submit') }]
      : v.primaryAction === 'withdraw' ? [{ label: '取回申請…', kind: 'primary', onSelect: () => reviewSheet(pack, v, 'withdraw') }] : [];
    return [
      ...(primary.length ? [...primary, { separator: true }] : []),
      { label: v.isEnabled ? '停用此版本' : '啟用此版本', onSelect: () => setEnabled(v, !v.isEnabled) },
      { label: open ? '收合審核歷程' : '展開審核歷程', onSelect: () => toggleHistory(v) },
      ...(v.canDelete ? [{ separator: true }, { label: '刪除此版本…', kind: 'danger', onSelect: () => deleteSheet(pack, v) }] : [])
    ];
  }

  /** 版本列：一行（版號、通道、狀態、時間靠右、⋯）；寬度不夠時時間自動換到第二行。已駁回在下一行加紅字原因。 */
  function versionRow(pack, v) {
    const more = moreButton(`${v.version} 的更多操作`);
    more.addEventListener('click', () => RC.openPopover(more, versionMenu(pack, v)));
    const partlyOff = !v.isEnabled && !pack.allDisabled; // 全部停用時只有卡片左側有色條，版本列不再各自標示
    const reviewed = Boolean(v.reviewedAt);
    const uploader = v.uploadedBy || v.submittedBy;
    const actor = reviewed ? (v.reviewedBy ? `審核者 ${v.reviewedBy}` : '') : (uploader ? `上傳者 ${uploader}` : '');
    const when = versionStamp(reviewed ? v.reviewedAt : v.uploadedAt);
    const time = el('span', { className: 'dev-vtime', 'data-role': 'version-time', ...(actor ? { title: actor } : {}) },
      el('span', { textContent: `${reviewed ? '審核' : '上傳'}${when ? ` ${when}` : ''}` }),
      partlyOff ? el('span', { className: 'dev-off', 'data-role': 'version-off', textContent: ' · 已停用' }) : null);
    return el('div', { className: `dev-vrow${partlyOff ? ' is-off' : ''}`, 'data-role': 'version-row', 'data-version-id': v.id, 'data-version': v.version, 'data-status': v.status },
      el('div', { className: 'dev-vtop' },
        el('span', { className: 'dev-ver', textContent: v.version }),
        v.channel === 'preview' ? badge('b-pre', 'Preview') : badge('b-rel', '正式版'),
        statusBadge(v),
        time,
        more),
      v.status === 'rejected' && v.rejectReason ? el('div', { className: 'dev-vrej', 'data-role': 'reject-reason', textContent: `駁回原因：${v.rejectReason}` }) : null,
      historyOpen.has(v.id) ? historyBox(v) : null);
  }

  /** 這張卡片目前要畫的版本：最新的 limit 個，加上（不在其中時）固定在最後的目前正式版與中間隔了幾個。 */
  function visibleVersions(pack) {
    const total = pack.versions.length;
    const limit = Math.min(total, COLLAPSED_VERSIONS + VERSION_STEP * (expansions.get(pack.packageKey) || 0));
    const release = currentRelease(pack);
    const releaseIndex = release ? pack.versions.indexOf(release) : -1;
    const pinned = releaseIndex >= limit ? release : null;
    return { total, limit, shown: pack.versions.slice(0, limit), pinned, hidden: pinned ? releaseIndex - limit : 0, count: limit + (pinned ? 1 : 0) };
  }

  /** 版本清單下方：左邊「再顯示 N 個版本」（N 最多 10，剩不到 10 個時顯示實際數量；全部顯示後沒有）與「收合」（展開過才有），右邊「共 N 個」或「已顯示 x／N」。 */
  function versionFooter(pack, view) {
    const key = pack.packageKey;
    const expanded = expansions.has(key);
    const link = (action, label, onClick) => {
      const button = el('button', { type: 'button', className: 'dev-vlink', 'data-action': action, textContent: label });
      button.addEventListener('click', () => { onClick(); render(); });
      return button;
    };
    return el('div', { className: 'dev-vfoot', 'data-role': 'version-footer' },
      el('span', { className: 'dev-vlinks' },
        view.count < view.total ? link('more-versions', `再顯示 ${Math.min(VERSION_STEP, view.total - view.count)} 個版本`, () => expansions.set(key, (expansions.get(key) || 0) + 1)) : null,
        expanded ? link('collapse-versions', '收合', () => expansions.delete(key)) : null),
      el('span', { className: 'dev-vcount', 'data-role': 'version-count', textContent: expanded ? `已顯示 ${view.count}／${view.total}` : `共 ${view.total} 個` }));
  }

  function packageCard(pack) {
    const more = moreButton(`${pack.name || pack.packageKey} 的更多操作`);
    more.addEventListener('click', () => RC.openPopover(more, [{ label: '編輯資訊', onSelect: () => editSheet(pack) }]));
    const view = visibleVersions(pack);
    const meta = [pack.currentUserRole === 'maintainer' ? '維護者' : '擁有者', `↓ ${pack.installCount} 次`, pack.category].filter(Boolean);
    const card = el('div', { className: `dev-card${pack.allDisabled ? ' is-off' : ''}`, 'data-role': 'dev-package', 'data-package-key': pack.packageKey },
      el('div', { className: 'dev-ct' },
        el('span', { className: 'dev-name' }, el('span', { className: 'ell', 'data-role': 'package-name', textContent: pack.name || pack.packageKey })),
        more),
      el('div', { className: 'muted mono ell', 'data-role': 'package-key', title: pack.packageKey, textContent: pack.packageKey }),
      el('div', { className: 'dev-meta', 'data-role': 'package-meta' }, ...meta.map((text, i) => el('span', { textContent: i ? `· ${text}` : text })),
        pack.allDisabled ? el('span', { className: 'dev-off', 'data-role': 'all-off', textContent: '· 全部版本已停用' }) : null));
    for (const v of view.shown) card.append(el('div', { className: 'dev-vsep' }), versionRow(pack, v));
    if (view.pinned) {
      card.append(view.hidden > 0 ? el('div', { className: 'dev-vgap', 'data-role': 'version-gap', textContent: `⋯ 中間還有 ${view.hidden} 個版本 ⋯` }) : el('div', { className: 'dev-vsep' }));
      card.append(versionRow(pack, view.pinned));
    }
    if (view.total > COLLAPSED_VERSIONS && (view.count < view.total || expansions.has(pack.packageKey))) card.append(versionFooter(pack, view)); // 全部都看得到、也沒展開過時沒有頁尾
    return card;
  }

  function emptyBox(...children) {
    return el('div', { className: 'panel-box developer-empty', 'data-role': 'developer-empty' }, ...children);
  }

  /** 依目前資料重畫清單，並維持捲動位置；先收起已失去錨點的浮動選單。 */
  function render() {
    RC.closePopover();
    const scroll = $('view-developer').scrollTop;
    $('btn-dev-upload').disabled = data.forbidden;
    if (data.forbidden) {
      $('developer-list').replaceChildren(emptyBox(el('div', { className: 'developer-empty-icon', textContent: '🔒' }),
        el('div', { className: 'developer-empty-title', textContent: '沒有資源包上傳權限' }),
        el('div', { className: 'muted', textContent: '你的帳號沒有資源包上傳權限，請洽市集管理者。仍可用「從資料夾安裝」在本機測試。' })));
    } else if (!data.packages.length) {
      $('developer-list').replaceChildren(emptyBox(el('div', { className: 'muted', textContent: '尚無資源包。用「打包並上傳…」上傳第一個版本' })));
    } else {
      $('developer-list').replaceChildren(el('div', { className: 'dev-sec', 'data-role': 'developer-heading', textContent: `我的資源包（${data.packages.length}）` }), ...data.packages.map(packageCard));
    }
    $('view-developer').scrollTop = scroll;
  }

  // ---------- 讀取 ----------
  /** 重新讀取清單（↻、進入視圖與每次操作成功後）。keepList：保留原清單與捲動位置，完成後才換成新資料。 */
  RC.loadDeveloper = async function loadDeveloper(options) {
    const keepList = options?.keepList === true && loaded;
    const mine = ++request;
    RC.loadLocalPackages?.(); // 本機開發中區塊與伺服器清單各自讀取；沒有上傳權限（403）時照常顯示
    $('developer-retry').classList.add('hidden');
    if (!keepList) {
      RC.setText('developer-status', '載入我的資源包中…');
      $('developer-list').replaceChildren();
    }
    try {
      const result = await call('rc.dev.listMyPackages', {});
      if (mine !== request) return;
      data = { forbidden: result?.forbidden === true, packages: result?.packages || [] };
      loaded = true;
      const ids = new Set(data.packages.flatMap(p => p.versions.map(v => v.id)));
      for (const id of [...historyOpen.keys()]) { if (ids.has(id)) historyOpen.set(id, { rows: null, error: '' }); else historyOpen.delete(id); }
      RC.setText('developer-status', '');
      render();
      for (const id of historyOpen.keys()) fetchHistory(id);
    } catch (e) {
      if (mine !== request) return;
      if (RC.sessionLost(e)) return RC.load();
      if (keepList) return RC.toast(RC.messageOf(e), 'error');
      RC.setText('developer-status', RC.messageOf(e));
      $('developer-retry').classList.remove('hidden');
    }
  };

  const reload = () => RC.loadDeveloper({ keepList: true });

  // ---------- 審核歷程 ----------
  async function fetchHistory(versionId) {
    try {
      const result = await call('rc.dev.history', { versionId });
      if (historyOpen.has(versionId)) historyOpen.set(versionId, { rows: [...(result?.history || [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), error: '' }); // 新的在上
    } catch (e) {
      if (RC.sessionLost(e)) return RC.load();
      if (historyOpen.has(versionId)) historyOpen.set(versionId, { rows: null, error: RC.messageOf(e) });
    }
    if (RC.isShown('developer')) render();
  }

  function toggleHistory(v) {
    if (historyOpen.has(v.id)) { historyOpen.delete(v.id); return render(); }
    historyOpen.set(v.id, { rows: null, error: '' });
    render();
    return fetchHistory(v.id);
  }

  // ---------- 操作 ----------
  /** 並行衝突（409）：顯示伺服器訊息並重新讀取；回傳 true 代表已處理。 */
  function conflictHandled(e) {
    if (e?.code !== 'conflict') return false;
    RC.toast(RC.messageOf(e), 'error');
    reload();
    return true;
  }

  async function setEnabled(v, isEnabled) {
    if (pending.has(v.id)) return;
    pending.add(v.id);
    try {
      await call('rc.dev.setEnabled', { versionId: v.id, isEnabled });
      RC.toast(`已${isEnabled ? '啟用' : '停用'} ${v.version}`);
      reload();
    } catch (e) {
      if (!conflictHandled(e)) RC.actionFailed(e);
    } finally {
      pending.delete(v.id);
    }
  }

  const textarea = (placeholder, value = '') => el('textarea', { placeholder, value, rows: 3 });
  const textInput = (value = '', placeholder = '') => el('input', { type: 'text', value, placeholder, autocomplete: 'off', spellcheck: false });

  /** 申請上架／取回申請：同一種 sheet，附註選填。 */
  function reviewSheet(pack, v, kind) {
    const submit = kind === 'submit';
    const note = textarea(submit ? '給審核者的說明' : '取回的原因');
    RC.openSheet({
      title: submit ? '申請上架' : '取回申請', subtitle: `${pack.name || pack.packageKey} ${v.version}`,
      body: [RC.sheetText(submit ? '要直接申請上架嗎？核准後會成為正式版，所有人都會在資源中心看到。' : '取回後版本回到 Preview，可以修改後再次申請上架。'),
        RC.sheetField(submit ? '送審附註（選填）' : '附註（選填）', note)],
      primaryLabel: submit ? '申請上架' : '取回申請',
      onPrimary: async () => {
        try {
          const result = await call(submit ? 'rc.dev.submitReview' : 'rc.dev.withdrawReview', { versionId: v.id, comment: note.value.trim() });
          const released = result?.version?.channel === 'release' && result.version.status === 'active';
          RC.toast(submit ? (released ? '已申請上架，版本已上架' : '已申請上架，等待管理者審核') : '已取回申請');
          reload();
        } catch (e) {
          if (!conflictHandled(e)) throw e;
        }
      }
    });
  }

  /** 編輯資訊：名稱必填；標籤以逗號分隔。 */
  function editSheet(pack) {
    const name = textInput(pack.name), description = textarea('', pack.description), category = textInput(pack.category), tags = textInput((pack.tags || []).join(', '));
    RC.openSheet({
      title: '編輯資訊', subtitle: pack.packageKey, subtitleMono: true,
      body: [RC.sheetField('名稱', name), RC.sheetField('描述', description), RC.sheetField('分類', category), RC.sheetField('標籤（以逗號分隔）', tags)],
      primaryLabel: '儲存',
      validate: () => name.value.trim() !== '',
      onPrimary: async () => {
        try {
          await call('rc.dev.updatePackage', { packageKey: pack.packageKey, name: name.value.trim(), description: description.value, category: category.value, tags: tags.value });
          RC.toast('已儲存資源包資訊');
          reload();
        } catch (e) {
          if (!conflictHandled(e)) throw e;
        }
      }
    });
  }

  /** 刪除此版本（只限 Preview）：輸入完整版號與 1–500 字原因，紅色實心主要按鈕。 */
  function deleteSheet(pack, v) {
    const confirmation = textInput('', v.version), reason = textarea('例如：打包錯誤，改由新版本取代');
    reason.maxLength = 500;
    const valid = () => confirmation.value === v.version && reason.value.trim().length >= 1 && reason.value.trim().length <= 500;
    RC.openSheet({
      title: '刪除此版本', subtitle: `${pack.name || pack.packageKey} ${v.version}（${v.channel === 'preview' ? 'Preview' : '正式版'}）`,
      body: [el('div', { className: 'error', textContent: `刪除後無法復原，之後也不能再用 ${v.version} 這個版號上傳。` }),
        RC.sheetField(`輸入版號 ${v.version} 確認`, confirmation), RC.sheetField('刪除原因（1–500 字）', reason)],
      primaryLabel: '刪除', busyLabel: '刪除中…', primaryKind: 'danger',
      validate: valid,
      onPrimary: async () => {
        if (!valid()) return false;
        try {
          await call('rc.dev.deleteVersion', { packageKey: pack.packageKey, version: v.version, comment: reason.value.trim(), confirmationVersion: confirmation.value });
          historyOpen.delete(v.id);
          RC.toast(`已刪除 ${v.version}`);
          reload();
        } catch (e) {
          if (!conflictHandled(e)) throw e;
        }
      }
    });
  }
})();
