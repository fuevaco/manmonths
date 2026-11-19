import http from 'node:http';
import https from 'node:https';

const SECRET_PAT_KEY = 'tfs_pat';

const CLOSED_STATES = new Set([
  'Closed',
  'Done',
  'Removed',
  '已關閉',
  '已完成',
  '完成',
  '已移除'
]);

const CLOSED_STATES_WIQL = Array.from(CLOSED_STATES)
  .map((s) => `'${s}'`)
  .join(', ');

let cachedStatesKey = '';
let cachedOpenStates = [];

async function fetchOpenStatesCatalog(cfg, projectSample) {
  const proj = projectSample || cfg.project;
  const cacheKey = `${cfg.tfsUrl}|${proj}|${cfg.apiVersion}`;
  if (cachedStatesKey === cacheKey && cachedOpenStates.length > 0) {
    return cachedOpenStates;
  }

  const found = [];
  if (proj) {
    for (const wiType of ['Task', 'Bug']) {
      try {
        const res = await tfsRequest(
          cfg,
          `${encodeURIComponent(proj)}/_apis/wit/workitemtypes/${wiType}/states?api-version=5.0-preview.1`
        );
        for (const st of res?.value || []) {
          const name = String(st.name || '').trim();
          if (name && !CLOSED_STATES.has(name) && !found.includes(name)) {
            found.push(name);
          }
        }
      } catch {
        // Older TFS may not expose /states preview endpoint; ignore and fall back
      }
    }
  }

  if (found.length > 0) {
    cachedStatesKey = cacheKey;
    cachedOpenStates = found;
  }
  return cachedOpenStates;
}

// 依「專案 + 工項類型」取得該類型 workflow 的完整狀態清單（含已關閉類，由呼叫端決定是否過濾）
const cachedTypeStates = new Map(); // key -> string[]

async function fetchWorkItemTypeStates(cfg, project, wiType) {
  const proj = String(project || cfg.project || '').trim();
  const type = String(wiType || '').trim();
  if (!proj || !type) return [];

  const cacheKey = `${cfg.tfsUrl}|${proj}|${type}|${cfg.apiVersion}`;
  const cached = cachedTypeStates.get(cacheKey);
  if (cached && cached.length > 0) return cached;

  const base = `${encodeURIComponent(proj)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}`;
  const names = [];
  const add = (raw) => {
    const name = String(raw || '').trim();
    if (name && !names.includes(name)) names.push(name);
  };

  // 1) 專用 states 端點（TFS 2018+ / Azure DevOps）
  try {
    const res = await tfsRequest(cfg, `${base}/states?api-version=5.0-preview.1`);
    for (const st of res?.value || []) add(st.name);
  } catch {
    // 忽略，改用型別定義 fallback
  }

  // 2) Fallback：讀取工項類型定義，使用 states 或 transitions 的 key
  if (names.length === 0) {
    const def = await tfsRequest(cfg, `${base}?api-version=${encodeURIComponent(cfg.apiVersion)}`);
    if (Array.isArray(def?.states)) {
      for (const st of def.states) add(typeof st === 'string' ? st : st?.name);
    }
    if (names.length === 0 && def?.transitions && typeof def.transitions === 'object') {
      for (const [from, targets] of Object.entries(def.transitions)) {
        add(from);
        for (const t of Array.isArray(targets) ? targets : []) add(t?.to);
      }
    }
  }

  if (names.length > 0) cachedTypeStates.set(cacheKey, names);
  return names;
}

// 往上追溯父項，直到「需求」層（或沒有父項 / 達到上限）為止
const REQUIREMENT_TYPES = new Set(['Requirement', '需求']);
const MAX_ANCESTOR_DEPTH = 8;
const PARENT_FIELDS = [
  'System.Id',
  'System.TeamProject',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.Parent'
].join(',');

async function fetchWorkItemAncestors(cfg, id) {
  const ancestors = [];
  const seen = new Set([Number(id)]);

  const fetchOne = async (wid) => {
    const res = await tfsRequest(
      cfg,
      `_apis/wit/workitems/${encodeURIComponent(wid)}?fields=${encodeURIComponent(PARENT_FIELDS)}&api-version=${encodeURIComponent(cfg.apiVersion)}`
    );
    return res || null;
  };

  let current = await fetchOne(id);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const parentId = Number(current?.fields?.['System.Parent']);
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);

    const parent = await fetchOne(parentId);
    if (!parent) break;
    const f = parent.fields || {};
    const projectName = String(f['System.TeamProject'] || '').trim();
    const type = String(f['System.WorkItemType'] || '');
    ancestors.push({
      id: parent.id,
      type,
      title: f['System.Title'] || '',
      state: f['System.State'] || '',
      webUrl: parent._links?.html?.href || buildWorkItemWebUrl(cfg, projectName, parent.id),
      isRequirement: REQUIREMENT_TYPES.has(type)
    });
    if (REQUIREMENT_TYPES.has(type)) break;
    current = parent;
  }
  return ancestors; // 由最近的父項到最上層
}

let cachedProjectKey = '';
let cachedProjects = []; // [{ name, description, label }]
let cachedProjectMap = new Map(); // name -> { name, description, label }

function normalizeBaseUrl(rawUrl) {
  return String(rawUrl || '').trim().replace(/\/+$/, '');
}

function makeError(message, code = 'action_failed') {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function loadConfig(orca) {
  const all = await orca.settings.get();
  const pat = await orca.secrets.get(SECRET_PAT_KEY);
  return {
    tfsUrl: normalizeBaseUrl(all.tfsUrl || ''),
    project: String(all.project || '').trim(),
    apiVersion: String(all.apiVersion || '5.0').trim(),
    allowInsecureTls: Boolean(all.allowInsecureTls),
    defaultAgent: String(all.defaultAgent || 'claude').trim() || 'claude',
    pat: pat || ''
  };
}

function tfsRequest(config, relativePath, { method = 'GET', body = null, contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    if (!config.tfsUrl) {
      reject(makeError('尚未設定 TFS Collection 網址，請先在面板設定中填寫。', 'invalid_params'));
      return;
    }
    if (!config.pat) {
      reject(makeError('尚未設定 PAT (Personal Access Token)，請先在面板設定中填入。', 'invalid_params'));
      return;
    }

    let targetUrl;
    try {
      const base = config.tfsUrl + '/';
      const rel = relativePath.replace(/^\/+/, '');
      targetUrl = new URL(rel, base);
    } catch (e) {
      reject(makeError(`TFS 網址格式不正確：${e.message}`, 'invalid_params'));
      return;
    }

    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const authToken = Buffer.from(`:${config.pat}`, 'utf8').toString('base64');

    const payload = body !== null ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Basic ${authToken}`,
      Accept: 'application/json',
      'User-Agent': 'Orca-TFS-WorkItems/1.1.0'
    };

    if (payload !== null) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }

    const reqOptions = {
      method,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      headers,
      timeout: 20000
    };

    if (isHttps && config.allowInsecureTls) {
      reqOptions.rejectUnauthorized = false;
    }

    const req = transport.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }

        const serverMsg =
          parsed?.message ||
          parsed?.value?.Message ||
          (raw && raw.length < 300 ? raw : '');

        if (res.statusCode === 401 || res.statusCode === 203) {
          reject(makeError(`TFS 驗證失敗 (HTTP ${res.statusCode})：請確認 PAT 是否正確、未過期，且具備 Work Items (Read & Write) 權限。`, 'not_permitted'));
          return;
        }
        if (res.statusCode === 403) {
          reject(makeError(`TFS 權限不足 (HTTP 403)：${serverMsg || '請確認 PAT 權限範圍。'}`, 'not_permitted'));
          return;
        }
        if (res.statusCode === 404) {
          reject(makeError(`找不到 TFS 資源 (HTTP 404)：請檢查 Collection 網址與專案名稱是否正確。${serverMsg ? `(${serverMsg})` : ''}`, 'invalid_params'));
          return;
        }
        reject(makeError(`TFS API 錯誤 (HTTP ${res.statusCode})：${serverMsg || res.statusMessage || '未知錯誤'}`));
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(makeError('連線 TFS 伺服器逾時，請檢查網路或內網 VPN 連線。', 'timeout'));
    });

    req.on('error', (err) => {
      if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'UNABLE_TO_VERIFY_LEAF_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN' || /certificate/i.test(err.message)) {
        reject(makeError(`SSL 憑證驗證失敗 (${err.code || err.message})：若為公司內網自簽憑證，請在設定勾選「允許內網自簽 HTTPS 憑證」。`));
        return;
      }
      reject(makeError(`無法連線至 TFS：${err.message}`));
    });

    if (payload !== null) {
      req.write(payload, 'utf8');
    }
    req.end();
  });
}

function truncateText(text, maxChars = 20) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const chars = Array.from(clean);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : clean;
}

async function fetchProjectsCatalog(cfg, forceRefresh = false) {
  const cacheKey = `${cfg.tfsUrl}|${cfg.apiVersion}|${cfg.allowInsecureTls}`;
  if (!forceRefresh && cachedProjectKey === cacheKey && cachedProjects.length > 0) {
    return { projects: cachedProjects, projectMap: cachedProjectMap };
  }

  const data = await tfsRequest(cfg, `_apis/projects?$top=500&api-version=${encodeURIComponent(cfg.apiVersion)}`);
  const list = (data?.value || []).map((p) => {
    const name = String(p.name || '').trim();
    const desc = String(p.description || '').replace(/\s+/g, ' ').trim();
    // Prefer description (truncated to 20 chars) as primary display label instead of cryptic code like pj2014
    const label = truncateText(desc, 20) || name;
    return {
      id: p.id,
      name,
      description: desc,
      label
    };
  });

  list.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'));
  cachedProjectKey = cacheKey;
  cachedProjects = list;
  cachedProjectMap = new Map(list.map((p) => [p.name, p]));
  return { projects: cachedProjects, projectMap: cachedProjectMap };
}

function formatAssignedTo(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  return raw.displayName || raw.uniqueName || '';
}

function buildWorkItemWebUrl(config, projectName, id) {
  if (!config.tfsUrl) return '';
  if (projectName) {
    return `${config.tfsUrl}/${encodeURIComponent(projectName)}/_workitems/edit/${id}`;
  }
  return `${config.tfsUrl}/_workitems/edit/${id}`;
}

function normalizeWorkItem(config, item, projectMap) {
  const f = item.fields || {};
  const projectName = String(f['System.TeamProject'] || '').trim();
  const projInfo = projectMap.get(projectName);
  const projectLabel = projInfo?.label || projectName || '未分類專案';

  return {
    id: item.id,
    rev: item.rev,
    projectName,
    projectLabel,
    type: f['System.WorkItemType'] || 'Task',
    title: f['System.Title'] || '',
    state: f['System.State'] || '',
    assignedTo: formatAssignedTo(f['System.AssignedTo']),
    priority: f['Microsoft.VSTS.Common.Priority'] ?? null,
    areaPath: f['System.AreaPath'] || '',
    iterationPath: f['System.IterationPath'] || '',
    description: f['System.Description'] || '',
    reproSteps: f['Microsoft.VSTS.TCM.ReproSteps'] || '',
    createdDate: f['System.CreatedDate'] || '',
    changedDate: f['System.ChangedDate'] || '',
    webUrl: item._links?.html?.href || buildWorkItemWebUrl(config, projectName, item.id)
  };
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

const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.TeamProject',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.AssignedTo',
  'System.IterationPath',
  'System.AreaPath',
  'System.CreatedDate',
  'System.ChangedDate',
  'Microsoft.VSTS.Common.Priority',
  'System.Description',
  'Microsoft.VSTS.TCM.ReproSteps'
].join(',');

export default function activate(orca) {
  orca.log('TFS Work Items worker activated.');

  orca.panels.handle('tfs.getConfig', async () => {
    const cfg = await loadConfig(orca);
    return {
      tfsUrl: cfg.tfsUrl,
      project: cfg.project,
      apiVersion: cfg.apiVersion,
      allowInsecureTls: cfg.allowInsecureTls,
      defaultAgent: cfg.defaultAgent,
      hasPat: Boolean(cfg.pat)
    };
  });

  orca.panels.handle('tfs.saveConfig', async (input = {}) => {
    if (typeof input.tfsUrl === 'string') {
      await orca.settings.set('tfsUrl', normalizeBaseUrl(input.tfsUrl));
    }
    if (typeof input.project === 'string') {
      await orca.settings.set('project', input.project.trim());
    }
    if (typeof input.apiVersion === 'string' && input.apiVersion) {
      await orca.settings.set('apiVersion', input.apiVersion.trim());
    }
    if (typeof input.allowInsecureTls === 'boolean') {
      await orca.settings.set('allowInsecureTls', input.allowInsecureTls);
    }
    if (typeof input.defaultAgent === 'string' && input.defaultAgent.trim()) {
      await orca.settings.set('defaultAgent', input.defaultAgent.trim());
    }
    if (typeof input.pat === 'string' && input.pat.trim()) {
      await orca.secrets.set(SECRET_PAT_KEY, input.pat.trim());
    }
    cachedProjectKey = '';
    const cfg = await loadConfig(orca);
    return {
      ok: true,
      hasPat: Boolean(cfg.pat)
    };
  });

  orca.panels.handle('tfs.clearPat', async () => {
    await orca.secrets.delete(SECRET_PAT_KEY);
    return { ok: true };
  });

  orca.panels.handle('tfs.testConnection', async (input) => {
    const baseCfg = await loadConfig(orca);
    const cfg = {
      ...baseCfg,
      ...(input?.tfsUrl !== undefined ? { tfsUrl: normalizeBaseUrl(input.tfsUrl) } : {}),
      ...(input?.apiVersion ? { apiVersion: String(input.apiVersion).trim() } : {}),
      ...(typeof input?.allowInsecureTls === 'boolean' ? { allowInsecureTls: input.allowInsecureTls } : {}),
      ...(input?.pat ? { pat: String(input.pat).trim() } : {})
    };

    const { projects } = await fetchProjectsCatalog(cfg, true);
    return {
      ok: true,
      projects
    };
  });

  orca.panels.handle('tfs.listProjects', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const { projects } = await fetchProjectsCatalog(cfg, Boolean(input.force));
    return { projects };
  });

  orca.panels.handle('tfs.getWorkItemTypeStates', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const states = await fetchWorkItemTypeStates(cfg, input.project, input.type);
    return { states };
  });

  orca.panels.handle('tfs.getWorkItemAncestors', async (input = {}) => {
    const id = Number(input.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw makeError('缺少有效的工項 ID。', 'invalid_params');
    }
    const cfg = await loadConfig(orca);
    const ancestors = await fetchWorkItemAncestors(cfg, id);
    return { ancestors };
  });

  orca.panels.handle('tfs.listWorkItems', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const { projects, projectMap } = await fetchProjectsCatalog(cfg, false).catch(() => ({
      projects: cachedProjects,
      projectMap: cachedProjectMap
    }));

    const projectFilter = String(input.project !== undefined ? input.project : cfg.project || '').trim();
    const scope = input.scope || 'mine'; // 'mine' | 'all'
    const typeFilter = input.type || 'All'; // 'All' | 'Task' | 'Bug'
    const stateFilter = String(input.state || '').trim();
    const search = String(input.search || '').trim();

    // Direct #ID lookup (collection-level, works across all projects)
    const idMatch = search.match(/^#?(\d+)$/);
    if (idMatch) {
      const targetId = Number(idMatch[1]);
      const item = await tfsRequest(
        cfg,
        `_apis/wit/workitems/${targetId}?fields=${encodeURIComponent(WORK_ITEM_FIELDS)}&api-version=${encodeURIComponent(cfg.apiVersion)}`
      );
      return {
        items: item ? [normalizeWorkItem(cfg, item, projectMap)] : [],
        projects
      };
    }

    const conditions = [];

    if (projectFilter && projectFilter !== '__ALL__') {
      conditions.push(`[System.TeamProject] = '${projectFilter.replace(/'/g, "''")}'`);
    }

    if (scope === 'mine') {
      conditions.push('[System.AssignedTo] = @Me');
    }

    if (typeFilter === 'Task' || typeFilter === 'Bug') {
      conditions.push(`[System.WorkItemType] = '${typeFilter}'`);
    } else {
      conditions.push(`[System.WorkItemType] IN ('Task', 'Bug')`);
    }

    // Always exclude closed/done/removed items (both English and Chinese TFS states)
    conditions.push(`[System.State] NOT IN (${CLOSED_STATES_WIQL})`);

    if (stateFilter && stateFilter !== '__ALL_OPEN__') {
      conditions.push(`[System.State] = '${stateFilter.replace(/'/g, "''")}'`);
    }

    if (search) {
      conditions.push(`[System.Title] CONTAINS '${search.replace(/'/g, "''")}'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT [System.Id] FROM WorkItems ${whereClause} ORDER BY [System.ChangedDate] DESC`;

    // Collection-level WIQL endpoint works across ALL projects when projectFilter is empty
    const wiqlPath =
      projectFilter && projectFilter !== '__ALL__'
        ? `${encodeURIComponent(projectFilter)}/_apis/wit/wiql?$top=100&api-version=${encodeURIComponent(cfg.apiVersion)}`
        : `_apis/wit/wiql?$top=100&api-version=${encodeURIComponent(cfg.apiVersion)}`;

    const wiqlRes = await tfsRequest(cfg, wiqlPath, {
      method: 'POST',
      body: { query }
    });

    const sampleProj = (projectFilter && projectFilter !== '__ALL__') ? projectFilter : projects[0]?.name;
    const openStates = await fetchOpenStatesCatalog(cfg, sampleProj);

    const ids = (wiqlRes?.workItems || []).map((w) => w.id).slice(0, 100);
    if (ids.length === 0) {
      return { items: [], projects, openStates };
    }

    const batchRes = await tfsRequest(
      cfg,
      `_apis/wit/workitems?ids=${ids.join(',')}&fields=${encodeURIComponent(WORK_ITEM_FIELDS)}&api-version=${encodeURIComponent(cfg.apiVersion)}`
    );

    const byId = new Map((batchRes?.value || []).map((item) => [item.id, normalizeWorkItem(cfg, item, projectMap)]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    return { items: ordered, projects, openStates };
  });

  orca.panels.handle('tfs.createWorkItem', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const targetProject = String(input.project || cfg.project || '').trim();
    if (!targetProject || targetProject === '__ALL__') {
      throw makeError('請選擇要建立工項的目標專案。', 'invalid_params');
    }

    const type = input.type === 'Bug' ? 'Bug' : 'Task';
    const title = String(input.title || '').trim();
    if (!title) {
      throw makeError('請輸入工項標題。', 'invalid_params');
    }

    const patch = [
      { op: 'add', path: '/fields/System.Title', value: title }
    ];

    const descText = String(input.description || '').trim();
    if (descText) {
      const htmlDesc = descText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>');
      if (type === 'Bug') {
        patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: htmlDesc });
      }
      patch.push({ op: 'add', path: '/fields/System.Description', value: htmlDesc });
    }

    if (input.priority !== undefined && input.priority !== null && input.priority !== '') {
      const prio = Number(input.priority);
      if (Number.isInteger(prio) && prio >= 1 && prio <= 4) {
        patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: prio });
      }
    }

    if (input.areaPath && String(input.areaPath).trim()) {
      patch.push({ op: 'add', path: '/fields/System.AreaPath', value: String(input.areaPath).trim() });
    }

    if (input.iterationPath && String(input.iterationPath).trim()) {
      patch.push({ op: 'add', path: '/fields/System.IterationPath', value: String(input.iterationPath).trim() });
    }

    if (input.assignToMe) {
      try {
        const conn = await tfsRequest(cfg, `_apis/connectionData?api-version=${encodeURIComponent(cfg.apiVersion)}`);
        const userName = conn?.authenticatedUser?.providerDisplayName || conn?.authenticatedUser?.customDisplayName;
        if (userName) {
          patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: userName });
        }
      } catch (e) {
        orca.log(`Unable to resolve current TFS user for assignToMe: ${e.message}`);
      }
    }

    const created = await tfsRequest(
      cfg,
      `${encodeURIComponent(targetProject)}/_apis/wit/workitems/$${type}?api-version=${encodeURIComponent(cfg.apiVersion)}`,
      {
        method: 'POST',
        body: patch,
        contentType: 'application/json-patch+json'
      }
    );

    const { projectMap } = await fetchProjectsCatalog(cfg, false).catch(() => ({ projectMap: cachedProjectMap }));
    const normalized = normalizeWorkItem(cfg, created, projectMap);
    orca.host.call('notifications.show', {
      title: `已建立 TFS ${normalized.type} #${normalized.id} (${normalized.projectLabel})`,
      body: normalized.title
    }).catch(() => {});

    return { item: normalized };
  });

  orca.panels.handle('tfs.updateWorkItem', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const id = Number(input.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw makeError('無效的工項 ID。', 'invalid_params');
    }

    const patch = [];
    if (typeof input.state === 'string' && input.state.trim()) {
      patch.push({ op: 'add', path: '/fields/System.State', value: input.state.trim() });
    }
    if (typeof input.comment === 'string' && input.comment.trim()) {
      const htmlComment = input.comment
        .trim()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>');
      patch.push({ op: 'add', path: '/fields/System.History', value: htmlComment });
    }

    if (patch.length === 0) {
      throw makeError('沒有需要更新的欄位。', 'invalid_params');
    }

    const updated = await tfsRequest(
      cfg,
      `_apis/wit/workitems/${id}?api-version=${encodeURIComponent(cfg.apiVersion)}`,
      {
        method: 'PATCH',
        body: patch,
        contentType: 'application/json-patch+json'
      }
    );

    const { projectMap } = await fetchProjectsCatalog(cfg, false).catch(() => ({ projectMap: cachedProjectMap }));
    return { item: normalizeWorkItem(cfg, updated, projectMap) };
  });

  orca.panels.handle('tfs.listCurrentAgents', async () => {
    const [ctx, res] = await Promise.all([
      orca.host.call('workspace.readContext').catch(() => null),
      orca.host.call('agents.list').catch(() => ({ agents: [] }))
    ]);
    const agents = (res?.agents || []).filter((a) => Boolean(a.terminalId));
    return {
      workspaceName: ctx?.displayName || '',
      agents
    };
  });

  // 把工項內容「放進」Agent 的輸入框但不送出，由使用者確認後自行按 Enter。
  // 有指定現有終端機就送給它；否則開新的 CLI。
  orca.panels.handle('tfs.launchAgent', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const cleanDesc = stripHtml(input.reproSteps || input.description || '');
    const projPart = input.projectLabel
      ? `${input.projectLabel}${input.projectName && input.projectLabel !== input.projectName ? ` (${input.projectName})` : ''}`
      : '';

    // 上層路徑（需求 > 工作 ...），取得失敗就略過
    const ancestors = await fetchWorkItemAncestors(cfg, input.id).catch(() => []);
    const ancestorText = ancestors
      .slice()
      .reverse()
      .map((p) => `${p.type} #${p.id} ${p.title}`)
      .join(' > ');

    // 單行文字：避免換行被終端機當成 Enter 而提前送出
    const singleLineDesc = cleanDesc.replace(/\s*\n+\s*/g, ' | ').slice(0, 1500);
    const draftPrompt = [
      `Azure DevOps ${input.type || 'Task'} #${input.id}`,
      projPart ? `專案：${projPart}` : '',
      ancestorText ? `上層：${ancestorText}` : '',
      `標題：${input.title || ''}`,
      input.state ? `狀態：${input.state}` : '',
      singleLineDesc ? `說明：${singleLineDesc}` : '',
      '請先閱讀並理解以上工項，等我確認後再開始動手。'
    ].filter(Boolean).join('；').slice(0, 4000);

    const typeIntoTerminal = async (terminalId) => {
      const sendRes = await orca.host.call('terminal.sendText', {
        terminalId: String(terminalId),
        text: draftPrompt,
        enter: false
      });
      if (!sendRes?.accepted) {
        throw makeError('無法將工項內容放入輸入框，請確認該終端機仍在開啟狀態。');
      }
    };

    // 送給現有 Agent
    if (input.terminalId) {
      await typeIntoTerminal(input.terminalId);
      const ctx = await orca.host.call('workspace.readContext').catch(() => null);
      return {
        ok: true,
        mode: 'existing',
        terminalId: input.terminalId,
        workspaceName: ctx?.displayName || '目前視窗',
        agent: '目前視窗的 Agent'
      };
    }

    // 沒有現有 Agent：開新的 CLI
    const ctx = await orca.host.call('workspace.readContext');
    const listRes = await orca.host.call('workspace.list');
    const workspaces = listRes?.workspaces || [];

    let targetWorkspace = null;
    if (ctx) {
      targetWorkspace = workspaces.find((w) => w.name === ctx.displayName || w.branch === ctx.branch) || workspaces[0];
    } else {
      targetWorkspace = workspaces[0];
    }

    if (!targetWorkspace) {
      throw makeError('找不到可用的 Orca 工作區，請先開啟一個專案或 Worktree。', 'unavailable');
    }

    const agentName = String(input.agent || cfg.defaultAgent || 'claude').trim();

    // 不帶 prompt 啟動（帶 prompt 時 Orca 會自動送出），待 CLI 就緒後只輸入文字、不按 Enter
    const res = await orca.host.call('agent.launch', {
      workspaceId: targetWorkspace.id,
      agent: agentName
    });

    await waitForAgentReady(orca, targetWorkspace.id, res.terminalId);
    await typeIntoTerminal(res.terminalId).catch(() => {
      throw makeError('已開啟新的 CLI，但無法將工項內容放入輸入框，請到該終端機手動貼上。');
    });

    return { ok: true, mode: 'new', terminalId: res.terminalId, workspaceName: targetWorkspace.name, agent: agentName };
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 等 Agent CLI 進入可輸入狀態（waiting / done）；偵測不到時最多等 timeoutMs 後仍繼續
async function waitForAgentReady(orca, workspaceId, terminalId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let res = await orca.host.call('agents.list', { workspaceId }).catch(() => null);
    if (!res) res = await orca.host.call('agents.list', {}).catch(() => null);
    const agent = (res?.agents || []).find((a) => a.terminalId === terminalId);
    if (agent && (agent.state === 'waiting' || agent.state === 'done')) {
      await sleep(800); // 讓輸入框完成渲染
      return true;
    }
    await sleep(500);
  }
  return false;
}
