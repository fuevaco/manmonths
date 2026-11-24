// 查詢列與清單：搜尋、類型與狀態篩選、排序；卡片與卡片／明細共用的一行式安裝狀態；就地重繪單一資源包。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, el, call, state } = RC;

  // ---------- 排序 ----------
  // 可選的排序欄位只寫在 index.html 的 #catalog-sort-field 選項；方向預設依欄位而定（比照 MarketSort）。
  const DEFAULT_SORT_FIELD = 'installCount';
  const sortFields = () => RC.optionValues($('catalog-sort-field'));
  const defaultDirection = (field) => (field === 'installCount' || field === 'uploadedAt' ? 'desc' : 'asc');
  let sortField = DEFAULT_SORT_FIELD;
  let sortDirection = defaultDirection(DEFAULT_SORT_FIELD);

  /** 設定排序；欄位無效時用預設欄位，方向沒有或無效時用該欄位的預設方向。 */
  RC.setSort = function setSort(field, direction) {
    sortField = sortFields().includes(field) ? field : DEFAULT_SORT_FIELD;
    sortDirection = direction === 'asc' || direction === 'desc' ? direction : defaultDirection(sortField);
  };

  /** 方向鈕文字，比照 MarketSort.DirectionText。 */
  function directionText(field, direction) {
    const desc = direction === 'desc';
    const words = field === 'installCount' ? ['多→少', '少→多'] : field === 'uploadedAt' ? ['新→舊', '舊→新'] : ['Z→A', 'A→Z'];
    return `${desc ? '↓' : '↑'} ${words[desc ? 0 : 1]}`;
  }

  RC.renderSortControls = function renderSortControls() {
    $('catalog-sort-field').value = sortField;
    const here = directionText(sortField, sortDirection), next = directionText(sortField, sortDirection === 'desc' ? 'asc' : 'desc');
    $('catalog-sort-direction').textContent = here;
    $('catalog-sort-direction').setAttribute('aria-label', `排序方向：${here}，點擊切換為 ${next}`);
    $('catalog-sort-direction').setAttribute('title', `目前：${here}，點擊切換為 ${next}`);
  };

  /** 切換欄位：方向重設為該欄位預設。 */
  RC.changeSortField = function changeSortField() {
    RC.setSort($('catalog-sort-field').value);
    RC.renderSortControls();
    RC.savePreferences({ sortField, sortDirection });
    return RC.loadCatalog();
  };

  RC.toggleSortDirection = function toggleSortDirection() {
    sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
    RC.renderSortControls();
    RC.savePreferences({ sortField, sortDirection });
    return RC.loadCatalog();
  };

  // ---------- 查詢 ----------
  let lastSearch = ''; // 上次查詢用的搜尋字串
  let catalogItems = new Map(); // 清單上的資源包，供就地重繪卡片

  /** 登入後：先讀偏好，再查詢清單（期間登出則不查詢）。 */
  RC.startCatalog = async function startCatalog() {
    const request = ++state.preferencesRequest;
    await RC.loadPreferences();
    if (request === state.preferencesRequest) return RC.loadCatalog();
  };

  /** keepList：返回清單時的背景重新整理，保留原清單與捲動位置，完成後才換成新資料。 */
  RC.loadCatalog = async function loadCatalog(options) {
    const keepList = options?.keepList === true;
    const request = ++state.catalogRequest;
    // useLastSearch：背景重新整理不套用搜尋框裡尚未按 Enter 送出的字
    const search = options?.useLastSearch === true ? lastSearch : $('catalog-search').value;
    lastSearch = search;
    state.catalogPending += 1;
    $('catalog-retry').classList.add('hidden');
    if (!keepList) {
      $('catalog-status').textContent = '載入資源包中…';
      $('catalog-list').replaceChildren();
    }
    try {
      const result = await call('rc.catalog.list', {
        search, type: $('catalog-type').value,
        ...($('catalog-installation').value ? { installation: $('catalog-installation').value } : {}),
        previewMode: state.showPreview, sortField, sortDirection
      });
      if (request !== state.catalogRequest) return;
      const scroll = $('view-main').scrollTop;
      catalogItems = new Map(result.data.map(p => [p.packageKey, p]));
      $('catalog-list').replaceChildren(...result.data.map(catalogCard));
      if (keepList) $('view-main').scrollTop = scroll;
      const count = result.data.length ? `共 ${result.data.length} 個` : '沒有符合條件的資源包';
      $('catalog-status').textContent = result.installedError ? `${count}。已安裝狀態無法讀取：${RC.messageOf(result.installedError)}` : count;
    } catch (e) {
      if (request !== state.catalogRequest) return;
      if (RC.sessionLost(e)) return RC.load();
      $('catalog-status').textContent = RC.messageOf(e);
      $('catalog-retry').classList.remove('hidden');
    } finally {
      state.catalogPending -= 1;
    }
  };

  // 搜尋只在按 Enter 時查詢（輸入法組字中的 Enter 是確認選字，不算）；清空搜尋框（含 ×）時自動重新查詢
  RC.onSearchKeydown = (ev) => {
    if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    return RC.loadCatalog();
  };
  RC.onSearchInput = () => {
    if (!$('catalog-search').value && lastSearch) return RC.loadCatalog();
  };

  // ---------- 安裝狀態 ----------
  RC.pendingCount = (p) => Number.isFinite(p?.pendingTargets?.count) ? p.pendingTargets.count : 0;

  /** 卡片與明細共用的安裝狀態判斷。 */
  RC.installState = function installState(p) {
    const status = p.installationStatus || 'notInstalled';
    // 開發中版本（從資料夾安裝）不算可更新；卡片顯示「開發中 x.y.z」與藍色左邊
    const dev = typeof p.devVersion === 'string' && p.devVersion !== '';
    const updatable = !dev && status === 'updateAvailable';
    const installed = !updatable && status !== 'notInstalled' && (p.deployments || []).length > 0;
    return { status, updatable, installed, dev, kind: dev ? 'dev' : updatable ? 'update' : status === 'unavailable' ? 'unavailable' : installed ? 'installed' : 'none' };
  };

  /** 簡易版本比較（x.y.z[-pre]）：面板只用來挑出最舊／最新的已安裝版本顯示；是否可更新由 worker 判斷。 */
  function compareVersions(a, b) {
    const [coreA, preA] = String(a).split(/-(.*)/s), [coreB, preB] = String(b).split(/-(.*)/s);
    const pa = coreA.split('.').map(n => parseInt(n, 10) || 0), pb = coreB.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
    if (preA === preB) return 0;
    if (preA === undefined) return 1;
    if (preB === undefined) return -1;
    return preA < preB ? -1 : 1;
  }
  const versionOf = (list, pick) => {
    const versions = list.map(d => d.version).filter(Boolean).sort(compareVersions);
    return pick === 'oldest' ? versions[0] : versions[versions.length - 1];
  };

  /** 卡片的狀態文字（只列版本，不列路徑）；x 為已安裝版本、y 為可更新到的版本。 */
  function installText(p) {
    const status = p.installationStatus || 'notInstalled';
    const deployments = p.deployments || [];
    if (status === 'updateAvailable') {
      const older = deployments.filter(d => d.status === 'updateAvailable' || d.updateVersion);
      const x = versionOf(older.length ? older : deployments, 'oldest');
      const y = older.find(d => d.updateVersion)?.updateVersion || p.latestVisibleVersion;
      return x && y ? `可更新 ${x} → ${y}` : '可更新';
    }
    if (status === 'current' || status === 'newer') {
      const x = versionOf(deployments, 'newest');
      const pending = RC.pendingCount(p); // 待補裝目標不算可更新
      return `${x ? `已安裝 ${x}` : '已安裝'}${pending > 0 ? ` · ${pending} 個新位置` : ''}`;
    }
    return status === 'unavailable' ? '已下架' : '未安裝';
  }

  /** 已下架、或開發中版本而市集沒有這個資源包時，worker 附的說明（statusHint）；其他狀態不顯示。 */
  const statusHint = (p) => ((p.installationStatus === 'unavailable' || RC.installState(p).dev) && typeof p.statusHint === 'string' ? p.statusHint.trim() : '');

  /** 開發中版本的狀態文字：藍色「開發中」徽章＋版本（＋待補裝位置數）。 */
  function devStatusText(p) {
    const pending = RC.pendingCount(p);
    return el('span', { className: 'card-status-text', 'data-role': 'status-text', 'data-kind': 'dev', ...(statusHint(p) ? { title: statusHint(p) } : {}) },
      el('span', { className: 'badge b-dev', 'data-role': 'dev-badge', textContent: '開發中' }), el('span', { textContent: ` ${p.devVersion}${pending > 0 ? ` · ${pending} 個新位置` : ''}` }));
  }

  /** 目錄、明細與 AI 推薦卡片共用的安裝狀態文字。 */
  RC.installStatusText = p => RC.installState(p).dev ? devStatusText(p) : el('span', { className: 'card-status-text', 'data-role': 'status-text', 'data-kind': RC.installState(p).kind, textContent: installText(p), ...(statusHint(p) ? { title: statusHint(p) } : {}) });

  /** 一行式安裝狀態：工具圖示＋狀態文字＋失敗與略過提示，右側為安裝／更新／補裝按鈕；卡片與明細頁共用。 */
  function statusRow(p, { showText = true } = {}) {
    const tools = (p.tools || []).length ? el('span', { className: 'card-tools' }, ...p.tools.map(t => RC.toolIcon({ ...t, label: RC.toolLabel(t) }))) : null;
    if (!tools && !showText) return null;
    return el('div', { className: 'card-status', 'data-role': 'status-row' },
      tools,
      showText ? RC.installStatusText(p) : null,
      RC.failureBadge(p),
      RC.skippedBadge(p),
      el('span', { className: 'card-actions', 'data-slot': 'card-actions' }, ...(showText ? [RC.actionButton(p)].flat() : [])));
  }

  /** 卡片與明細共用：一行式狀態列，展開時其下接失敗清單與略過清單。 */
  RC.stateBlock = (p, options) => [statusRow(p, options),
    options?.showText !== false && !RC.installState(p).dev && statusHint(p) ? el('div', { className: 'hint status-hint', 'data-role': 'status-hint', textContent: statusHint(p) }) : null,
    RC.failureList(p), RC.skippedList(p), RC.detachedNote(p)];

  // ---------- 卡片 ----------
  const TYPE_LABELS = { skill: 'Skills', agent: 'Agents', mcp: 'MCP', bundle: '組合包' };

  /** 上傳時間以本地時間顯示 yyyy-MM-dd。 */
  function localDate(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  }

  /** 資訊列：擁有者 · 安裝次數 · 上傳日期；卡片與明細共用。 */
  RC.metaRow = function metaRow(p) {
    const owner = typeof p.owner === 'string' ? p.owner.trim() : '';
    const date = p.lastUploadedAt ? localDate(p.lastUploadedAt) : '';
    const items = [
      owner ? el('span', { className: 'meta-item', 'data-meta': 'owner' }, RC.ICONS.owner(), el('span', { textContent: owner })) : null,
      Number.isFinite(p.installCount) ? el('span', { className: 'meta-item', 'data-meta': 'installs' }, RC.ICONS.installs(), el('span', { textContent: `${p.installCount} 次` })) : null,
      date ? el('span', { className: 'meta-item', 'data-meta': 'date', textContent: date }) : null
    ].filter(Boolean);
    // 開發中版本而市集沒有這個資源包：沒有擁有者與安裝次數，資訊列改放說明（草圖 §4）
    if (!items.length && RC.installState(p).dev && statusHint(p)) items.push(el('span', { className: 'meta-item', 'data-meta': 'hint', textContent: statusHint(p) }));
    if (!items.length) return null;
    const row = el('div', { className: 'card-meta', 'data-role': 'meta' });
    items.forEach((item, i) => row.append(...(i ? [el('span', { className: 'meta-sep', textContent: '·' }), item] : [item])));
    return row;
  };

  /** 卡片內這些元素（按鈕、連結、摘要、失敗清單…）有自己的動作，點擊它們不進入明細。 */
  const INTERACTIVE = 'button, a, summary, details, input, select, textarea, label, [data-action], [data-role="failure-list"], [data-role="skipped"], [data-role="skipped-list"], [data-role="detached-note"]';

  /** 點卡片進入明細：點在互動元素上、或有拖曳選取的文字時不進入。 */
  function shouldOpenDetails(ev, card) {
    const hit = ev.target?.closest?.(INTERACTIVE);
    if (hit && hit !== card) return false;
    return !String(window.getSelection?.() ?? '').length;
  }

  function catalogCard(p) {
    const { status, updatable, installed, dev } = RC.installState(p);
    const typeText = [TYPE_LABELS[p.type] || p.type, p.category].filter(Boolean).join(' · ');
    const description = typeof p.description === 'string' && p.description.trim() ? p.description.trim() : '';
    const card = el('li', { className: `panel-box catalog-card wrap${installed ? ' is-installed' : ''}${updatable ? ' has-update' : ''}${dev ? ' is-dev' : ''}`, 'data-package-key': p.packageKey, 'data-install-status': status,
      role: 'link', 'aria-label': `查看詳情：${p.name}` },
      el('div', { className: 'card-head' },
        el('div', { className: 'card-title', 'data-role': 'title' }, updatable ? el('span', { className: 'update-badge', 'data-role': 'update-badge', textContent: '可更新' }) : null, el('strong', { textContent: p.name })),
        el('div', { className: 'card-icons' }, RC.guideButton(p))),
      RC.metaRow(p),
      description ? el('p', { className: 'card-desc', 'data-role': 'description', textContent: description }) : null,
      el('div', { className: 'card-type muted', 'data-role': 'type', textContent: typeText }),
      ...RC.stateBlock(p));
    card.setAttribute('tabindex', '0');
    card.addEventListener('click', (ev) => (shouldOpenDetails(ev, card) ? RC.openDetails(p.packageKey, undefined, p) : undefined));
    // 只在焦點就在卡片本身時響應；焦點在內部按鈕時 Enter／空白鍵留給該按鈕
    card.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === card) { ev.preventDefault(); RC.openDetails(p.packageKey, undefined, p); }
    });
    return card;
  }

  // ---------- 就地重繪 ----------
  /** 目前畫面上的資源包資料：明細頁開著該資源包時用明細，否則用清單。 */
  RC.packageOf = function packageOf(key) {
    if (state.currentPackage?.packageKey === key && (state.currentDetail || state.detailSeed)) return RC.detailView();
    return catalogItems.get(key) || RC.localPackageOf?.(key) || null;
  };

  RC.clearCatalog = () => $('catalog-list').replaceChildren();

  /** 就地重繪單一資源包：清單卡片（不清空、不跳回頂端）與明細上方狀態。 */
  RC.rerenderPackage = function rerenderPackage(key) {
    const item = catalogItems.get(key);
    const list = $('catalog-list');
    const nodes = [...list.children];
    const old = nodes.find(c => c.getAttribute?.('data-package-key') === key);
    if (item && old) {
      const scroll = $('view-main').scrollTop;
      list.replaceChildren(...nodes.map(c => c === old ? catalogCard(item) : c));
      $('view-main').scrollTop = scroll;
    }
    if (state.currentPackage?.packageKey === key) { RC.renderDetailTop(); RC.updateSetupButton(); }
    RC.renderLocalPackages?.(); // 我的資源包的「本機開發中」卡片也依執行中狀態重繪
  };
})();
