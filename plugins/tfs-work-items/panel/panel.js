(() => {
  'use strict';

  // --- State ---
  let projectFilter = '__ALL__';
  let scope = 'mine';
  let typeFilter = 'All';
  let stateFilter = '__ALL_OPEN__';
  let searchText = '';
  let createType = 'Task';
  let projects = []; // [{ name, description, label }]
  let allItems = [];
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
  const projectSelectFilter = document.getElementById('project-filter');
  const searchInput = document.getElementById('search-input');
  const stateSelectFilter = document.getElementById('state-filter');

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
  const createProject = document.getElementById('create-project');
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

  function populateProjectsUI(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    projects = list;

    // 1. Filter dropdown
    const prevFilter = projectSelectFilter.value || projectFilter;
    projectSelectFilter.innerHTML = '<option value="__ALL__">📁 所有專案（依專案分類顯示）</option>';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.label || p.name;
      opt.title = p.description ? `${p.description} (${p.name})` : p.name;
      projectSelectFilter.appendChild(opt);
    }
    if (prevFilter && Array.from(projectSelectFilter.options).some((o) => o.value === prevFilter)) {
      projectSelectFilter.value = prevFilter;
    } else {
      projectSelectFilter.value = '__ALL__';
      projectFilter = '__ALL__';
    }

    // 2. Create form dropdown
    const prevCreate = createProject.value;
    createProject.innerHTML = '';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.label && p.label !== p.name ? `${p.label} (${p.name})` : p.name;
      opt.title = p.description ? `${p.description} (${p.name})` : p.name;
      createProject.appendChild(opt);
    }
    if (prevCreate && Array.from(createProject.options).some((o) => o.value === prevCreate)) {
      createProject.value = prevCreate;
    } else if (projectFilter !== '__ALL__' && Array.from(createProject.options).some((o) => o.value === projectFilter)) {
      createProject.value = projectFilter;
    }

    // 3. Settings datalist
    projectList.innerHTML = '';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.name;
      if (p.description) opt.label = p.description;
      projectList.appendChild(opt);
    }
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
    if (cfg.project) {
      projectFilter = cfg.project;
    }
    return cfg;
  }

  function populateStateFilter(list) {
    const prev = stateSelectFilter.value || stateFilter;
    const states = Array.from(new Set(list.map((i) => i.state).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b, 'zh-Hant')
    );
    stateSelectFilter.innerHTML = '<option value="__ALL_OPEN__">所有狀態</option>';
    for (const st of states) {
      const opt = document.createElement('option');
      opt.value = st;
      opt.textContent = st;
      stateSelectFilter.appendChild(opt);
    }
    if (prev && Array.from(stateSelectFilter.options).some((o) => o.value === prev)) {
      stateSelectFilter.value = prev;
      stateFilter = prev;
    } else {
      stateSelectFilter.value = '__ALL_OPEN__';
      stateFilter = '__ALL_OPEN__';
    }
  }

  function applyStateFilter() {
    if (stateFilter === '__ALL_OPEN__') {
      items = allItems;
    } else {
      items = allItems.filter((i) => i.state === stateFilter);
    }
    renderList();
  }

  async function refreshWorkItems({ preserveBanner = false, ensureItem = null } = {}) {
    if (!preserveBanner) hideBanner();
    viewList.innerHTML = '<div class="empty-state">載入 Azure DevOps 工項中...</div>';
    try {
      const res = await callWorker('tfs.listWorkItems', {
        project: projectFilter,
        scope,
        type: typeFilter,
        search: searchText
      });
      if (res.projects) {
        populateProjectsUI(res.projects);
      }
      let list = (res.items || []).filter(
        (i) => !['Closed', 'Done', 'Removed'].includes(i.state)
      );
      if (ensureItem && !['Closed', 'Done', 'Removed'].includes(ensureItem.state)) {
        if (!list.some((i) => i.id === ensureItem.id)) {
          list = [ensureItem, ...list];
        }
      }
      allItems = list;
      populateStateFilter(allItems);
      setStatus('connected');
      applyStateFilter();
    } catch (err) {
      setStatus('error');
      viewList.innerHTML = '';
      showBanner(err.message || String(err), 'error');
    }
  }

  function createWorkItemCard(item, showProjectBadge, isGrouped = false) {
    const card = document.createElement('div');
    const typeClass = item.type === 'Bug' ? 'is-bug' : 'is-task';
    card.className = `wi-card ${typeClass}${isGrouped ? ' is-grouped' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'wi-meta';

    const idSpan = document.createElement('span');
    idSpan.className = 'wi-id';
    idSpan.textContent = `#${item.id}`;

    const typeBadge = document.createElement('span');
    typeBadge.className = `badge ${item.type === 'Bug' ? 'badge-bug' : 'badge-task'}`;
    typeBadge.textContent = item.type;

    meta.append(idSpan, typeBadge);

    if (showProjectBadge && item.projectLabel) {
      const projBadge = document.createElement('span');
      projBadge.className = 'badge badge-project';
      projBadge.textContent = item.projectLabel;
      projBadge.title = item.projectName || item.projectLabel;
      meta.appendChild(projBadge);
    }

    const stateBadge = document.createElement('span');
    stateBadge.className = 'badge badge-state';
    stateBadge.textContent = item.state;
    meta.appendChild(stateBadge);

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
    return card;
  }

  function renderList() {
    viewList.innerHTML = '';
    if (items.length === 0) {
      viewList.innerHTML = '<div class="empty-state">找不到符合條件的 Task / Bug 工項。</div>';
      return;
    }

    // Group by project description when showing all projects
    if (projectFilter === '__ALL__') {
      const groups = new Map();
      for (const item of items) {
        const key = item.projectName || 'unknown';
        if (!groups.has(key)) {
          groups.set(key, {
            label: item.projectLabel || key,
            name: item.projectName || '',
            items: []
          });
        }
        groups.get(key).items.push(item);
      }

      const sortedGroups = Array.from(groups.values()).sort((a, b) =>
        a.label.localeCompare(b.label, 'zh-Hant')
      );

      for (const group of sortedGroups) {
        const header = document.createElement('div');
        header.className = 'project-group-header';
        header.title = group.name;

        const titleSpan = document.createElement('span');
        titleSpan.textContent = `📁 ${group.label}`;

        const countSpan = document.createElement('span');
        countSpan.className = 'project-group-count';
        countSpan.textContent = String(group.items.length);

        header.append(titleSpan, countSpan);
        viewList.appendChild(header);

        for (const item of group.items) {
          viewList.appendChild(createWorkItemCard(item, false, true));
        }
      }
    } else {
      for (const item of items) {
        viewList.appendChild(createWorkItemCard(item, false));
      }
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
    detailBadges.appendChild(typeBadge);

    if (item.projectLabel) {
      const projBadge = document.createElement('span');
      projBadge.className = 'badge badge-project';
      projBadge.textContent = item.projectLabel;
      projBadge.title = item.projectName || item.projectLabel;
      detailBadges.appendChild(projBadge);
    }

    const stateBadge = document.createElement('span');
    stateBadge.className = 'badge badge-state';
    stateBadge.textContent = item.state;
    detailBadges.appendChild(stateBadge);

    detailTitle.textContent = item.title;
    const infoParts = [
      item.assignedTo ? `指派給：${item.assignedTo}` : '未指派',
      item.priority ? `優先權：P${item.priority}` : '',
      item.iterationPath ? `Iteration：${item.iterationPath}` : ''
    ].filter(Boolean);
    detailInfo.textContent = infoParts.join(' · ');

    const bodyText = stripHtml(item.type === 'Bug' ? (item.reproSteps || item.description) : (item.description || item.reproSteps));
    detailDesc.textContent = bodyText || '（無詳細說明）';

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
        populateProjectsUI(res.projects || []);
        setStatus('connected');
        showBanner(`連線成功！共載入 ${(res.projects || []).length} 個專案（若預設專案留空將顯示所有專案）。`, 'success');
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
        projectFilter = cfgProject.value.trim() || '__ALL__';
        showView('list');
        await refreshWorkItems();
      } catch (err) {
        showBanner(err.message || String(err), 'error');
      } finally {
        btnSaveSettings.disabled = false;
      }
    });

    // Filters
    projectSelectFilter.addEventListener('change', () => {
      projectFilter = projectSelectFilter.value;
      refreshWorkItems();
    });

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

    stateSelectFilter.addEventListener('change', () => {
      stateFilter = stateSelectFilter.value;
      applyStateFilter();
    });

    searchInput.addEventListener('input', () => {
      searchText = searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refreshWorkItems, 350);
    });

    // Create View
    btnNew.addEventListener('click', async () => {
      hideBanner();
      if (projects.length === 0) {
        try {
          const res = await callWorker('tfs.listProjects', {});
          populateProjectsUI(res.projects || []);
        } catch (err) {
          showBanner(err.message || String(err), 'error');
          return;
        }
      }
      if (projectFilter !== '__ALL__' && Array.from(createProject.options).some((o) => o.value === projectFilter)) {
        createProject.value = projectFilter;
      }
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
      const targetProj = createProject.value;
      if (!targetProj) {
        showBanner('請選擇所屬專案！', 'error');
        return;
      }
      const title = createTitle.value.trim();
      if (!title) {
        showBanner('請輸入工項標題！', 'error');
        return;
      }
      btnSubmitCreate.disabled = true;
      btnSubmitCreate.textContent = '建立中...';
      try {
        const res = await callWorker('tfs.createWorkItem', {
          project: targetProj,
          type: createType,
          title,
          description: createDesc.value,
          priority: createPriority.value,
          assignToMe: createAssignMe.checked,
          iterationPath: createIteration.value
        });
        const created = res.item;
        // Adjust active filters if needed so the newly created item is visible in the list
        if (projectFilter !== '__ALL__' && created.projectName && projectFilter !== created.projectName) {
          projectFilter = created.projectName;
          projectSelectFilter.value = created.projectName;
        }
        if (typeFilter !== 'All' && typeFilter !== created.type) {
          typeFilter = 'All';
          document.querySelectorAll('#type-pills button').forEach((b) =>
            b.classList.toggle('active', b.dataset.type === 'All')
          );
        }
        if (scope === 'mine' && !createAssignMe.checked) {
          scope = 'all';
          document.querySelectorAll('#scope-pills button').forEach((b) =>
            b.classList.toggle('active', b.dataset.scope === 'all')
          );
        }
        if (stateFilter !== '__ALL_OPEN__' && stateFilter !== created.state) {
          stateFilter = '__ALL_OPEN__';
          stateSelectFilter.value = '__ALL_OPEN__';
        }

        // Optimistically prepend immediately, then sync with server while keeping banner
        allItems = [created, ...allItems.filter((i) => i.id !== created.id)];
        populateStateFilter(allItems);
        showView('list');
        applyStateFilter();
        showBanner(`成功建立 ${created.type} #${created.id} (${created.projectLabel})：${created.title}`, 'success');
        await refreshWorkItems({ preserveBanner: true, ensureItem: created });
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
      applyStateFilter();
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
        if (['Closed', 'Done', 'Removed'].includes(res.item.state)) {
          allItems = allItems.filter((i) => i.id !== res.item.id);
        } else {
          allItems = allItems.map((i) => (i.id === res.item.id ? res.item : i));
        }
        populateStateFilter(allItems);
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
        showBanner(`已在工作區「${res.workspaceName}」啟動 ${res.agent} 處理 #${res.id}`, 'success');
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
      if (!cfg.tfsUrl || !cfg.hasPat) {
        showView('settings');
        showBanner('請先設定地端 TFS Collection 網址與 PAT（專案名稱可留空以檢視所有專案）。', 'info');
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
