import http from 'node:http';
import https from 'node:https';

const SECRET_PAT_KEY = 'tfs_pat';

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
      'User-Agent': 'Orca-TFS-WorkItems/1.0.0'
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

function formatAssignedTo(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  return raw.displayName || raw.uniqueName || '';
}

function buildWorkItemWebUrl(config, id) {
  if (!config.tfsUrl || !config.project) return '';
  return `${config.tfsUrl}/${encodeURIComponent(config.project)}/_workitems/edit/${id}`;
}

function normalizeWorkItem(config, item) {
  const f = item.fields || {};
  return {
    id: item.id,
    rev: item.rev,
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
    webUrl: item._links?.html?.href || buildWorkItemWebUrl(config, item.id)
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

    const data = await tfsRequest(cfg, `_apis/projects?api-version=${encodeURIComponent(cfg.apiVersion)}`);
    const projects = (data?.value || []).map((p) => p.name).sort((a, b) => a.localeCompare(b));
    return {
      ok: true,
      projects
    };
  });

  orca.panels.handle('tfs.listWorkItems', async (input = {}) => {
    const cfg = await loadConfig(orca);
    if (!cfg.project) {
      throw makeError('請先在設定中填寫或選擇 TFS 專案名稱 (Project)。', 'invalid_params');
    }

    const scope = input.scope || 'mine'; // 'mine' | 'all'
    const typeFilter = input.type || 'All'; // 'All' | 'Task' | 'Bug'
    const hideClosed = input.hideClosed !== false;
    const search = String(input.search || '').trim();

    // Direct #ID lookup
    const idMatch = search.match(/^#?(\d+)$/);
    if (idMatch) {
      const targetId = Number(idMatch[1]);
      const fields = [
        'System.Id',
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
      const item = await tfsRequest(
        cfg,
        `${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${targetId}?fields=${encodeURIComponent(fields)}&api-version=${encodeURIComponent(cfg.apiVersion)}`
      );
      return { items: item ? [normalizeWorkItem(cfg, item)] : [] };
    }

    const conditions = [`[System.TeamProject] = '${cfg.project.replace(/'/g, "''")}'`];

    if (scope === 'mine') {
      conditions.push('[System.AssignedTo] = @Me');
    }

    if (typeFilter === 'Task' || typeFilter === 'Bug') {
      conditions.push(`[System.WorkItemType] = '${typeFilter}'`);
    } else {
      conditions.push(`[System.WorkItemType] IN ('Task', 'Bug')`);
    }

    if (hideClosed) {
      conditions.push(`[System.State] NOT IN ('Closed', 'Done', 'Removed')`);
    }

    if (search) {
      conditions.push(`[System.Title] CONTAINS '${search.replace(/'/g, "''")}'`);
    }

    const query = `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;

    const wiqlRes = await tfsRequest(
      cfg,
      `${encodeURIComponent(cfg.project)}/_apis/wit/wiql?$top=50&api-version=${encodeURIComponent(cfg.apiVersion)}`,
      {
        method: 'POST',
        body: { query }
      }
    );

    const ids = (wiqlRes?.workItems || []).map((w) => w.id).slice(0, 50);
    if (ids.length === 0) {
      return { items: [] };
    }

    const fields = [
      'System.Id',
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

    const batchRes = await tfsRequest(
      cfg,
      `${encodeURIComponent(cfg.project)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${encodeURIComponent(fields)}&api-version=${encodeURIComponent(cfg.apiVersion)}`
    );

    const byId = new Map((batchRes?.value || []).map((item) => [item.id, normalizeWorkItem(cfg, item)]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    return { items: ordered };
  });

  orca.panels.handle('tfs.createWorkItem', async (input = {}) => {
    const cfg = await loadConfig(orca);
    if (!cfg.project) {
      throw makeError('請先設定 TFS 專案名稱。', 'invalid_params');
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
      `${encodeURIComponent(cfg.project)}/_apis/wit/workitems/$${type}?api-version=${encodeURIComponent(cfg.apiVersion)}`,
      {
        method: 'POST',
        body: patch,
        contentType: 'application/json-patch+json'
      }
    );

    const normalized = normalizeWorkItem(cfg, created);
    orca.host.call('notifications.show', {
      title: `已建立 TFS ${normalized.type} #${normalized.id}`,
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
      `${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${id}?api-version=${encodeURIComponent(cfg.apiVersion)}`,
      {
        method: 'PATCH',
        body: patch,
        contentType: 'application/json-patch+json'
      }
    );

    return { item: normalizeWorkItem(cfg, updated) };
  });

  orca.panels.handle('tfs.launchAgent', async (input = {}) => {
    const cfg = await loadConfig(orca);
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

    const cleanDesc = stripHtml(input.reproSteps || input.description || '');
    const promptLines = [
      `請協助處理以下 TFS ${input.type || 'Task'} 工項：`,
      `- 工項編號：#${input.id}`,
      `- 標題：${input.title || ''}`,
      input.state ? `- 目前狀態：${input.state}` : '',
      cleanDesc ? `\n詳細說明：\n${cleanDesc}` : ''
    ].filter(Boolean);

    const agentName = String(input.agent || cfg.defaultAgent || 'claude').trim();
    const res = await orca.host.call('agent.launch', {
      workspaceId: targetWorkspace.id,
      agent: agentName,
      prompt: promptLines.join('\n')
    });

    return { ok: true, terminalId: res.terminalId, workspaceName: targetWorkspace.name, agent: agentName };
  });
}
