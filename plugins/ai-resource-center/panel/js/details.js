// 明細頁：開啟與返回清單、資訊列與一行式安裝狀態、安裝位置、變更內容；操作後就地重新讀取。
// 使用說明與完整說明頁見 readme.js，設定參數見 setup.js。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, el, call, state } = RC;

  let listScroll = 0; // 進入明細前清單的捲動位置，返回時還原

  /** 明細用的資源包資料：清單帶入的欄位為底，worker 明細優先；已安裝狀態只看全域部署，讀不到時不沿用清單的舊狀態。 */
  RC.detailView = function detailView() {
    const view = { ...(state.detailSeed || {}), ...(state.currentDetail || {}) };
    if (state.currentDetail?.installedError) { delete view.installationStatus; delete view.deployments; }
    if (Array.isArray(view.deployments)) view.deployments = view.deployments.filter(d => d.scope !== 'project');
    return view;
  };

  RC.renderDetailTop = function renderDetailTop() {
    const view = RC.detailView();
    $('details-meta').replaceChildren(...[RC.metaRow(view)].filter(Boolean));
    $('details-description').textContent = typeof view.description === 'string' ? view.description.trim() : '';
    const block = !state.currentDetail && !state.detailSeed ? [] : RC.stateBlock(view, { showText: !view.installedError });
    $('details-status-row').replaceChildren(...block.filter(Boolean));
    RC.renderReadmeTools(view);
  };

  // ---------- 安裝位置 ----------
  /** 安裝位置的狀態：可更新 → y／已是最新／已下架（不顯示原始識別碼）。 */
  function locationStatus(d) {
    const status = d.status === 'updateAvailable' ? `可更新 → ${d.updateVersion}` : d.status === 'unavailable' ? '已下架' : '已是最新';
    return `${d.version}${d.channel === 'preview' ? ' (Preview)' : ''} · ${status}${d.source === 'local' ? ' · 本機來源' : ''}${d.contentDiffersFromMarket ? ' · 與市集內容不符（重裝可修復）' : ''}`;
  }

  function locationRow(d) {
    const hostId = RC.toolId(d);
    const label = RC.toolLabel(d);
    return el('li', { className: 'location-row', 'data-role': 'location' },
      RC.toolIcon({ hostId, label, deployed: true }, { desktopLabel: false }), // 友善名稱已寫明 Claude Desktop
      el('div', { className: 'location-body' },
        el('strong', { 'data-role': 'location-name', textContent: label }),
        el('div', { className: 'location-path mono', 'data-role': 'location-path', textContent: d.rootPath }),
        el('div', { className: 'location-status', 'data-role': 'location-status', textContent: locationStatus(d) }),
        d.backupPaths?.length ? RC.backupFold(d.backupPaths) : null));
  }

  /** 已安裝狀態：預設收合的「安裝位置（N）」，只列全域部署；沒有部署時不顯示。 */
  RC.renderInstalled = function renderInstalled() {
    if (!state.currentDetail) return;
    RC.renderDetailTop();
    const installedError = state.currentDetail.installedError;
    const locations = RC.detailView().deployments || [];
    $('details-installed').replaceChildren(...(installedError ? [el('div', { className: 'error', textContent: `已安裝狀態無法讀取：${installedError.message}` })]
      : locations.length ? [el('details', { className: 'fold', 'data-role': 'locations' }, el('summary', { textContent: `安裝位置（${locations.length}）` }),
        el('ul', { className: 'location-list' }, ...locations.map(locationRow)))] : []));
  };

  function renderChangelog(detail) {
    const selected = (detail.versions || []).find(v => v.version === detail.selectedVersion);
    const changelog = typeof selected?.changelog === 'string' ? selected.changelog.trim() : '';
    $('details-changelog').replaceChildren(...(changelog ? [el('details', { className: 'fold', 'data-role': 'changelog' },
      el('summary', { textContent: `版本 ${detail.selectedVersion} 的變更內容` }), el('p', { className: 'changelog-body', textContent: changelog }))] : []));
  }

  // ---------- 開啟、重新讀取、返回 ----------
  /** 開啟明細：一律取市集推薦版本；seed 是清單上的該資源包。 */
  RC.openDetails = async function openDetails(packageKey, version, seed) {
    const request = ++state.detailsRequest;
    if (RC.isShown('main')) listScroll = $('view-main').scrollTop;
    if (seed) state.detailSeed = seed;
    else if (state.detailSeed?.packageKey !== packageKey) state.detailSeed = null;
    state.currentDetail = null;
    RC.resetReader();
    $('details-installed').replaceChildren();
    $('details-changelog').replaceChildren();
    RC.clearSetup();
    state.currentPackage = { packageKey, previewMode: state.showPreview };
    RC.showView('details');
    RC.setHeaderTitle(state.detailSeed?.name || packageKey);
    RC.renderReadme('');
    RC.renderDetailTop();
    $('details-status').textContent = '讀取詳情中…';
    $('details-retry').classList.add('hidden');
    try {
      const detail = await call('rc.package.getDetails', { ...state.currentPackage, ...(version ? { version } : {}) });
      if (request !== state.detailsRequest) return;
      state.currentPackage.version = detail.selectedVersion;
      state.currentDetail = detail;
      RC.setHeaderTitle(detail.name || state.detailSeed?.name || packageKey);
      RC.renderInstalled();
      RC.renderSetup();
      renderChangelog(detail);
      RC.renderReadme(detail.readme);
      $('details-status').textContent = '';
    } catch (e) {
      if (request !== state.detailsRequest) return;
      if (RC.sessionLost(e)) return RC.load();
      $('details-status').textContent = RC.messageOf(e);
      $('details-retry').classList.remove('hidden');
    }
  };

  /** 明細讀取失敗後的「重新讀取詳情」。 */
  RC.retryDetails = () => RC.openDetails(state.currentPackage.packageKey);

  /** 操作後重新讀取明細（留在原頁，不清空說明與捲動）。 */
  RC.reloadDetails = async function reloadDetails() {
    const request = state.detailsRequest;
    try {
      const detail = await call('rc.package.getDetails', { packageKey: state.currentPackage.packageKey, previewMode: state.currentPackage.previewMode === true });
      if (request !== state.detailsRequest) return;
      state.currentDetail = detail;
      RC.renderInstalled();
      RC.renderSetup();
    } catch (e) {
      if (request !== state.detailsRequest) return;
      if (RC.sessionLost(e)) return RC.load();
      RC.toast(`無法重新讀取安裝狀態：${RC.messageOf(e)}`, 'error');
    }
  };

  /** 返回清單：保留篩選條件，先顯示原清單並還原捲動位置，再於背景重新整理狀態。 */
  RC.backToList = function backToList() {
    state.detailsRequest += 1;
    state.currentPackage = null;
    state.currentDetail = null;
    state.detailSeed = null;
    RC.resetReader();
    RC.showView('main');
    $('view-main').scrollTop = listScroll;
    return RC.loadCatalog({ keepList: true });
  };
})();
