(() => {
  'use strict';

  // --- State ---
  let scope = 'mine';
  let typeFilter = 'All';
  let hideClosed = true;
  let searchText = '';
  let createType = 'Task';
  let items = [];
  let selectedItem = null;
  let searchTimer = null;

  // --- Elements ---
  const statusDot = document.getElementById('status-dot');
  const banner = document.getElementById('banner');
  const filtersBar = document.getElementById('filters-bar');

  const viewList = document.getElementById('view-list');
  const viewSettings = document.getElementById('view-settings');
  const viewCreate = document.getElementById('view-create');
  const viewDetail = document.getElementById('view-detail');

  const btnNew = document.getElementById('btn-new');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnSettings = document.getElementById('btn-settings');

  // Filters
  const searchInput = document.getElementById('search-input');
  const chkHideClosed = document.getElementById('chk-hide-closed');

  // Settings
  const cfgUrl = document.getElementById('cfg-url');
  const cfgPat = document.getElementById('cfg-pat');
  const cfgPatStatus = document.getElementById('cfg-pat-status');
  const btnClearPat = document.getElementById('btn-clear-pat');
  const cfgApiVersion = document.getElementById('cfg-api-version');
  const cfgInsecureTls = document.getElementById('cfg-insecure-tls');
  const cfgProject = document.getElementById('cfg-project');
  const projectList = document.getElementById('project-list');
  const cfgAgent = document.getElementById('cfg-agent');
  const btnTestConn = document.getElementById('btn-test-conn');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');

  // Create
  const createTitle = document.getElementById('create-title');
  const createDesc = document.getElementById('create-desc');
  const createDescLabel = document.getElementById('create-desc-label');
  const createPriority = document.getElementById('create-priority');
  const createAssignMe = document.getElementById('create-assign-me');
  const createIteration = document.getElementById('create-iteration');
  const btnSubmitCreate = document.getElementById('btn-submit-create');
  const btnCancelCreate = document.getElementById('btn-cancel-create');
  const btnCloseCreate = document.getElementById('btn-close-create');

  // Detail
  const detailHeaderId = document.getElementById('detail-header-id');
  const detailBadges = document.getElementById('detail-badges');
  const detailTitle = document.getElementById('detail-title');
  const detailInfo = document.getElementById('detail-info');
  const detailDesc = document.getElementById('detail-desc');
  const detailStateSelect = document.getElementById('detail-state-select');
  const detailComment = document.getElementById('detail-comment');
  const btnUpdateState = document.getElementById('btn-update-state');
  const btnSendComment = document.getElementById('btn-send-comment');
  const btnLaunchAgent = document.getElementById('btn-launch-agent');
  const btnDetailOpen = document.getElementById('btn-detail-open');
  const btnCloseDetail = document.getElementById('btn-close-detail');

  // --- Helpers ---
  function callWorker(method, input) {
    if (!window.orca || !window.orca.plugin) {
      return Promise.reject(new Error('Orca Plugin Bridge 尚未就緒'));
    }
    return window.orca.plugin.request(method, input);
  }

  function showBanner(msg, kind = 'info') {
    banner.textContent = msg;
    banner.className = `banner ${kind}`;
    banner.classList.remove('hidden');
  }

  function hideBanner() {
    banner.classList.add('hidden');
  }

  function setStatus(state) {
    statusDot.className = `status-dot ${state}`;
  }

  function stripHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function showView(name) {
    viewList.classList.toggle('hidden', name !== 'list');
    filtersBar.classList.toggle('hidden', name !== 'list');
    viewSettings.classList.toggle('hidden', name !== 'settings');
    viewCreate.classList.toggle('hidden', name !== 'create');
    viewDetail.classList.toggle('hidden', name !== 'detail');
  }

  function applyTheme(colorScheme) {
    const isLight = colorScheme === 'light';
    document.body.classList.toggle('light', isLight);
    document.body.classList.toggle('dark', !isLight);
  }

  // --- Data & Rendering ---
  async function loadConfigIntoForm() {
    const cfg = await callWorker('tfs.getConfig');
    cfgUrl.value = cfg.tfsUrl || '';
    cfgProject.value = cfg.project || '';
    cfgApiVersion.value = cfg.apiVersion || '5.0';
    cfgInsecureTls.checked = Boolean(cfg.allowInsecureTls);
    cfgAgent.value = cfg.defaultAgent || 'claude';
    cfgPat.value = '';
    if (cfg.hasPat) {
      cfgPatStatus.textContent = '已安全儲存 PAT（位於系統金鑰圈）';
      btnClearPat.classList.remove('hidden');
    } else {
      cfgPatStatus.textContent = '尚未儲存 PAT';
      btnClearPat.classList.add('hidden');
    }
    return cfg;
  }

  async function refreshWorkItems() {
    hideBanner();
    viewList.innerHTML = '<div class="empty-state">載入 TFS 工項中...</div>';
    try {
      const res = await callWorker('tfs.listWorkItems', {
        scope,
        type: typeFilter,
        hideClosed,
        search: searchText
      });
      items = res.items || [];
      setStatus('connected');
      renderList();
    } catch (err) {
      setStatus('error');
      viewList.innerHTML = '';
      showBanner(err.message || String(err), 'error');
    }
  }

  function renderList() {
    viewList.innerHTML = '';
    if (items.length === 0) {
      viewList.innerHTML = '<div class="empty-state">找不到符合條件的 Task / Bug 工項。</div>';
      return;
    }

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'wi-card';

      const meta = document.createElement('div');
      meta.className = 'wi-meta';

      const idSpan = document.createElement('span');
      idSpan.className = 'wi-id';
      idSpan.textContent = `#${item.id}`;

      const typeBadge = document.createElement('span');
      typeBadge.className = `badge ${item.type === 'Bug' ? 'badge-bug' : 'badge-task'}`;
      typeBadge.textContent = item.type;

      const stateBadge = document.createElement('span');
      stateBadge.className = 'badge badge-state';
      stateBadge.textContent = item.state;

      meta.append(idSpan, typeBadge, stateBadge);

      const titleDiv = document.createElement('div');
      titleDiv.className = 'wi-title';
      titleDiv.textContent = item.title;

      const subDiv = document.createElement('div');
      subDiv.className = 'wi-sub';

      const ownerSpan = document.createElement('span');
      ownerSpan.textContent = item.assignedTo ? `👤 ${item.assignedTo}` : '未指派';

      const iterSpan = document.createElement('span');
      const shortIter = item.iterationPath ? item.iterationPath.split('\\').pop() : '';
      iterSpan.textContent = shortIter;

      subDiv.append(ownerSpan, iterSpan);

      card.append(meta, titleDiv, subDiv);
      card.addEventListener('click', () => openDetail(item));
      viewList.appendChild(card);
    }
  }

  function openDetail(item) {
    selectedItem = item;
    hideBanner();
    detailHeaderId.textContent = `#${item.id}`;

    detailBadges.innerHTML = '';
    const typeBadge = document.createElement('span');
    typeBadge.className = `badge ${item.type === 'Bug' ? 'badge-bug' : 'badge-task'}`;
    typeBadge.textContent = item.type;
    const stateBadge = document.createElement('span');
    stateBadge.className = 'badge badge-state';
    stateBadge.textContent = item.state;
    detailBadges.append(typeBadge, stateBadge);

    detailTitle.textContent = item.title;
    const infoParts = [
      item.assignedTo ? `指派給：${item.assignedTo}` : '未指派',
      item.priority ? `優先權：P${item.priority}` : '',
      item.iterationPath ? `Iteration：${item.iterationPath}` : ''
    ].filter(Boolean);
    detailInfo.textContent = infoParts.join(' · ');

    const bodyText = stripHtml(item.type === 'Bug' ? (item.reproSteps || item.description) : (item.description || item.reproSteps));
    detailDesc.textContent = bodyText || '（無詳細說明）';

    // Ensure current state is in dropdown
    const hasOption = Array.from(detailStateSelect.options).some((o) => o.value === item.state);
    if (!hasOption && item.state) {
      const opt = document.createElement('option');
      opt.value = item.state;
      opt.textContent = item.state;
      detailStateSelect.prepend(opt);
    }
    detailStateSelect.value = item.state || 'New';
    detailComment.value = '';
    showView('detail');
  }

  // --- Event Setup ---
  function setupEvents() {
    btnRefresh.addEventListener('click', () => {
      showView('list');
      refreshWorkItems();
    });

    btnSettings.addEventListener('click', async () => {
      hideBanner();
      await loadConfigIntoForm();
      showView('settings');
    });

    btnCloseSettings.addEventListener('click', () => {
      hideBanner();
      showView('list');
    });

    btnTestConn.addEventListener('click', async () => {
      hideBanner();
      btnTestConn.disabled = true;
      btnTestConn.textContent = '連線測試中...';
      try {
        const res = await callWorker('tfs.testConnection', {
          tfsUrl: cfgUrl.value,
          apiVersion: cfgApiVersion.value,
          allowInsecureTls: cfgInsecureTls.checked,
          ...(cfgPat.value.trim() ? { pat: cfgPat.value.trim() } : {})
        });
        projectList.innerHTML = '';
        for (const proj of res.projects || []) {
          const opt = document.createElement('option');
          opt.value = proj;
          projectList.appendChild(opt);
        }
        if (!cfgProject.value && res.projects?.length === 1) {
          cfgProject.value = res.projects[0];
        }
        setStatus('connected');
        showBanner(`連線成功！共找到 ${res.projects.length} 個專案，請選擇後儲存設定。`, 'success');
      } catch (err) {
        setStatus('error');
        showBanner(err.message || String(err), 'error');
      } finally {
        btnTestConn.disabled = false;
        btnTestConn.textContent = '🔌 測試連線並載入專案';
      }
    });

    btnClearPat.addEventListener('click', async () => {
      await callWorker('tfs.clearPat');
      cfgPatStatus.textContent = '已清除 PAT';
      btnClearPat.classList.add('hidden');
    });

    btnSaveSettings.addEventListener('click', async () => {
      hideBanner();
      btnSaveSettings.disabled = true;
      try {
        await callWorker('tfs.saveConfig', {
          tfsUrl: cfgUrl.value,
          project: cfgProject.value,
          apiVersion: cfgApiVersion.value,
          allowInsecureTls: cfgInsecureTls.checked,
          defaultAgent: cfgAgent.value,
          ...(cfgPat.value.trim() ? { pat: cfgPat.value.trim() } : {})
        });
        showView('list');
        await refreshWorkItems();
      } catch (err) {
        showBanner(err.message || String(err), 'error');
      } finally {
        btnSaveSettings.disabled = false;
      }
    });

    // Filters
    document.getElementById('scope-pills').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-scope]');
      if (!btn) return;
      scope = btn.dataset.scope;
      document.querySelectorAll('#scope-pills button').forEach((b) => b.classList.toggle('active', b === btn));
      refreshWorkItems();
    });

    document.getElementById('type-pills').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-type]');
      if (!btn) return;
      typeFilter = btn.dataset.type;
      document.querySelectorAll('#type-pills button').forEach((b) => b.classList.toggle('active', b === btn));
      refreshWorkItems();
    });

    chkHideClosed.addEventListener('change', () => {
      hideClosed = chkHideClosed.checked;
      refreshWorkItems();
    });

    searchInput.addEventListener('input', () => {
      searchText = searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refreshWorkItems, 350);
    });

    // Create View
    btnNew.addEventListener('click', () => {
      hideBanner();
      createTitle.value = '';
      createDesc.value = '';
      showView('create');
      createTitle.focus();
    });

    const closeCreate = () => {
      hideBanner();
      showView('list');
    };
    btnCloseCreate.addEventListener('click', closeCreate);
    btnCancelCreate.addEventListener('click', closeCreate);

    document.getElementById('create-type-pills').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-type]');
      if (!btn) return;
      createType = btn.dataset.type;
      document.querySelectorAll('#create-type-pills button').forEach((b) => b.classList.toggle('active', b === btn));
      createDescLabel.textContent = createType === 'Bug' ? '重現步驟 / 說明 (Repro Steps)' : '說明 (Description)';
    });

    btnSubmitCreate.addEventListener('click', async () => {
      hideBanner();
      const title = createTitle.value.trim();
      if (!title) {
        showBanner('請輸入工項標題！', 'error');
        return;
      }
      btnSubmitCreate.disabled = true;
      btnSubmitCreate.textContent = '建立中...';
      try {
        const res = await callWorker('tfs.createWorkItem', {
          type: createType,
          title,
          description: createDesc.value,
          priority: createPriority.value,
          assignToMe: createAssignMe.checked,
          iterationPath: createIteration.value
        });
        showView('list');
        showBanner(`成功建立 ${res.item.type} #${res.item.id}：${res.item.title}`, 'success');
        await refreshWorkItems();
      } catch (err) {
        showBanner(err.message || String(err), 'error');
      } finally {
        btnSubmitCreate.disabled = false;
        btnSubmitCreate.textContent = '建立工項';
      }
    });

    // Detail View
    btnCloseDetail.addEventListener('click', () => {
      hideBanner();
      showView('list');
    });

    btnDetailOpen.addEventListener('click', () => {
      if (!selectedItem?.webUrl) return;
      if (window.orca?.shell?.openExternal) {
        window.orca.shell.openExternal(selectedItem.webUrl);
      } else {
        window.open(selectedItem.webUrl, '_blank', 'noopener,noreferrer');
      }
    });

    btnUpdateState.addEventListener('click', async () => {
      if (!selectedItem) return;
      hideBanner();
      btnUpdateState.disabled = true;
      try {
        const res = await callWorker('tfs.updateWorkItem', {
          id: selectedItem.id,
          state: detailStateSelect.value
        });
        openDetail(res.item);
        showBanner(`已將 #${res.item.id} 狀態更新為 ${res.item.state}`, 'success');
      } catch (err) {
        showBanner(err.message || String(err), 'error');
      } finally {
        btnUpdateState.disabled = false;
      }
    });

    btnSendComment.addEventListener('click', async () => {
      if (!selectedItem) return;
      const comment = detailComment.value.trim();
      if (!comment) return;
      hideBanner();
      btnSendComment.disabled = true;
      try {
        const res = await callWorker('tfs.updateWorkItem', {
          id: selectedItem.id,
          comment
        });
        detailComment.value = '';
        openDetail(res.item);
        showBanner(`已送出留言至 #${res.item.id}`, 'success');
      } catch (err) {
        showBanner(err.message || String(err), 'error');
      } finally {
        btnSendComment.disabled = false;
      }
    });

    btnLaunchAgent.addEventListener('click', async () => {
      if (!selectedItem) return;
      hideBanner();
      btnLaunchAgent.disabled = true;
      try {
        const res = await callWorker('tfs.launchAgent', selectedItem);
        showBanner(`已在工作區「${res.workspaceName}」啟動 ${res.agent} 處理 #${selectedItem.id}`, 'success');
      } catch (err) {
        showBanner(err.message || String(err), 'error');
      } finally {
        btnLaunchAgent.disabled = false;
      }
    });
  }

  // --- Bootstrap ---
  async function init() {
    applyTheme(document.documentElement.classList.contains('light') ? 'light' : 'dark');
    if (window.orca?.on) {
      window.orca.on('theme', (t) => {
        if (t?.colorScheme) applyTheme(t.colorScheme);
      });
    }

    setupEvents();

    try {
      const cfg = await loadConfigIntoForm();
      if (!cfg.tfsUrl || !cfg.hasPat || !cfg.project) {
        showView('settings');
        showBanner('請先設定地端 TFS Collection 網址、PAT 與專案名稱。', 'info');
      } else {
        showView('list');
        await refreshWorkItems();
      }
    } catch (err) {
      showView('settings');
      showBanner(err.message || String(err), 'error');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
