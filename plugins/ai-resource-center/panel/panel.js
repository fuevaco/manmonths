(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const VIEWS = ['loading', 'login', 'main', 'details'];
  const SIGN_IN_TIMEOUT_MS = 60000;
  // 這些錯誤代碼代表工作階段已失效，面板回到登入畫面並顯示原因
  const SESSION_LOST = new Set(['session_expired', 'account_unavailable', 'signed_out']);

  let busy = false;
  let catalogRequest = 0;
  let detailsRequest = 0;
  let currentPackage = null;
  let currentDetail = null;
  let downloading = false;
  let currentPlan = null; // 使用者正在審核的部署摘要；套用只送出這一份
  let installing = false;
  let targetRequest = 0;
  let targetChecks = [];
  let targetInfo = new Map(); // 目標 id → worker 回傳的目標（專案範圍帶 projectRoot）
  let pendingUpdateIds = []; // 所選目標有不同的可更新版本時，尚待更新的其餘目標
  let failedIds = []; // 本次結果中失敗的目標，供「只重試失敗的目標」
  let finished = false; // 套用完成後只呈現結果（對照 LC-AI-Pack 安裝精靈步驟 3），按「完成」返回
  const selectedTargets = () => targetChecks.filter(c => c.checked).map(c => c.value);
  // 專案範圍沒有輸入路徑時，由 worker 自動列出已有該資源部署的專案
  const scopeInput = () => $('install-scope').value === 'project'
    ? { scope: 'project', ...($('install-project-root').value.trim() ? { projectRoot: $('install-project-root').value.trim() } : {}) } : {};

  function invalidateTargets() {
    targetRequest += 1;
    targetChecks = [];
    targetInfo = new Map();
    pendingUpdateIds = [];
    $('install-target').replaceChildren();
    $('install-plan').disabled = true;
    resetPlan();
    updateButton();
  }

  function selectionChanged(changed) {
    targetRequest += 1;
    resetPlan();
    pendingUpdateIds = []; // 使用者自己改選：不再接續上一批
    // 一份計畫只有一個專案：勾選另一個專案的目標時，取消其他專案的勾選
    const picked = changed && targetChecks.includes(changed) && changed.checked ? targetInfo.get(changed.value) : null;
    if (picked?.projectRoot) for (const c of targetChecks) if (c !== changed && c.checked && targetInfo.get(c.value)?.projectRoot !== picked.projectRoot) c.checked = false;
    $('install-plan').disabled = installing || !selectedTargets().length;
    renderInstalled();
  }

  /** 建立元素；文字一律用 textContent，市集與路徑內容不會被當成 HTML。 */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'className') node.className = v; else node[k] = v;
    }
    node.append(...children.filter(Boolean));
    return node;
  }

  // ---------- 安裝：部署目標 → 部署摘要 → 確認一次 → 結果 ----------
  const BACKUP_REASONS = { unmanaged: '目的地已有未受管的同名內容', localModification: '受管內容已被本機修改' };
  const STATUS_LABELS ={ succeeded: '已完成', partial: '部分完成', failed: '失敗', rejected: '未套用', rolledBack: '寫入失敗，已還原', rollbackIncomplete: '寫入失敗且未完整還原', stale: '狀態已改變', skipped: '未部署（受阻，維持原狀）',
    cancelled: '已取消', notDeployed: '未部署（設定命令未成功，目標未被改動）' };
  // 設定命令執行或略過的理由（對照 LC-AI-Pack PlanRenderer.DescribeReason）
  const REASON_LABELS = { FirstRun: '此範圍從未成功執行過', PreviousFailure: '上一次執行沒有成功，這次重試', ScriptChanged: '腳本內容與上次成功時不同', Reconfigure: '使用者要求重新設定',
    UpdateRunOnUpdate: '版本改變且作者宣告 runOnUpdate', SkippedAlreadySucceeded: '同版本且上次已成功，略過', SkippedUpdateWithoutRunOnUpdate: '版本改變但作者未宣告 runOnUpdate，略過' };
  const ELIGIBILITY_LABELS = { UnsupportedOperatingSystem: '不適用於本機作業系統', UnsupportedArchitecture: '不適用於本機處理器架構' };

  /** 套用完成：只留結果與「完成」；範圍、目標、「產生部署摘要」「更新所選目標」都收起（LC-AI-Pack 步驟 3 只顯示結論）。 */
  function setFinished(on) {
    finished = on;
    if (!on) failedIds = [];
    $('install-steps').classList.toggle('hidden', on);
    $('install-done').classList.toggle('hidden', !on);
    $('install-retry').classList.toggle('hidden', !on || !failedIds.length);
    $('details-update').classList.toggle('hidden', on || !updatableSelected().length);
  }

  /** 失敗的目標（對照 LC-AI-Pack HasFailedTargets）：寫入失敗、已還原、未完整還原、狀態已改變；受阻（skipped）與設定命令未執行不算。 */
  const FAILED_STATUSES = new Set(['failed', 'rolledBack', 'rollbackIncomplete', 'stale']);

  function resetPlan() {
    setFinished(false);
    currentPlan = null;
    $('install-summary').replaceChildren();
    $('install-result').replaceChildren();
    $('install-confirm').classList.add('hidden');
    $('install-status').textContent = '';
    renderSetup(null);
  }

  // ---------- 設定參數：在部署摘要中補上缺少的值；秘密只以遮罩欄位輸入，永不回顯 ----------
  const SOURCE_LABELS = { Global: '使用者全域設定', ProjectOverride: '專案覆寫', ManifestDefault: '資源包預設值', PendingInput: '本次輸入', Unset: '未設定' };

  function setupInput(p) {
    if (p.isSecret) return el('input', { type: 'password', name: p.parameterId, value: '', autocomplete: 'off', placeholder: p.secretProvided ? '留空則沿用已儲存的秘密' : '輸入秘密值' });
    if (p.type === 'boolean') return el('input', { type: 'checkbox', name: p.parameterId, checked: p.value === 'true' });
    if (p.type === 'choice') {
      const select = el('select', { name: p.parameterId }, ...p.options.map(o => el('option', { value: o.value, textContent: o.label })));
      select.value = p.value ?? '';
      return select;
    }
    return el('input', { type: 'text', name: p.parameterId, value: p.value ?? '' });
  }

  function renderSetup(plan) {
    const box = $('install-setup');
    const setup = plan?.setup;
    const fields = (setup?.parameters || []).filter(p => p.visible);
    box.classList.toggle('hidden', !fields.length);
    $('install-setup-save').classList.toggle('hidden', !fields.length);
    if (!fields.length) { box.replaceChildren(); return; }
    box.replaceChildren(el('strong', { textContent: `設定參數（${setup.scope === 'project' ? '本機專案覆寫' : '使用者全域'}）` }),
      el('div', { className: 'hint', textContent: '一般值與桌面工具共用同一份設定；秘密只存入作業系統的安全儲存區。' }),
      ...fields.map(p => el('div', { className: 'field setup-field' },
        el('label', { textContent: `${p.label}${p.required ? '（必填）' : ''}` }),
        setupInput(p),
        el('div', { className: p.needsInput ? 'hint problem-blocking' : 'hint', textContent: p.isSecret
          ? (p.secretProvided ? '已儲存於系統安全儲存區' : '尚未儲存')
          : (p.needsInput ? '尚未提供' : `來源：${SOURCE_LABELS[p.source] || p.source}`) }),
        p.description ? el('div', { className: 'hint', textContent: p.description }) : null)));
  }

  const findByName = (node, name) => node.name === name ? node : (node.children ? [...node.children].map(c => findByName(c, name)).find(Boolean) ?? null : null);

  async function saveSetup() {
    if (installing || !currentPlan?.setup) return;
    const request = detailsRequest;
    const generation = targetRequest;
    const reviewed = currentPlan;
    const values = {}, secrets = {};
    for (const p of reviewed.setup.parameters.filter(p => p.visible)) {
      const field = findByName($('install-setup'), p.parameterId);
      if (!field) continue;
      if (p.isSecret) { if (field.value) secrets[p.parameterId] = field.value; }
      else values[p.parameterId] = p.type === 'boolean' ? field.checked === true : field.value;
    }
    installing = true;
    $('install-setup-save').disabled = true;
    $('install-status').textContent = '儲存設定並重新產生部署摘要中…';
    try {
      const plan = await call('rc.deploy.saveSetup', { planDigest: reviewed.planDigest, values, secrets }, 120000);
      if (request !== detailsRequest || generation !== targetRequest) return;
      currentPlan = plan;
      renderSummary(plan);
      $('install-status').textContent = plan.canApply ? `設定已儲存。請確認部署摘要後按「${$('install-confirm').textContent}」。` : '設定已儲存，但仍有受阻原因，請依說明修正後重新產生摘要。';
    } catch (e) {
      if (request !== detailsRequest || generation !== targetRequest) return;
      if (SESSION_LOST.has(e && e.code)) return load();
      $('install-status').textContent = messageOf(e);
    } finally {
      installing = false;
      $('install-setup-save').disabled = false;
      for (const p of reviewed.setup.parameters.filter(p => p.isSecret)) {
        const field = findByName($('install-setup'), p.parameterId);
        if (field) field.value = '';
      }
    }
  }

  async function loadTargets() {
    invalidateTargets();
    const generation = targetRequest;
    const request = detailsRequest;
    $('install-target').replaceChildren();
    $('install-plan').disabled = true;
    $('install-targets-status').textContent = '偵測部署目標中…';
    try {
      const result = await call('rc.deploy.listTargets', { packageKey: currentPackage.packageKey, version: currentPackage.version,
        previewMode: currentPackage.previewMode === true, ...scopeInput() }, 120000);
      if (request !== detailsRequest || generation !== targetRequest) return;
      const targets = Array.isArray(result?.targets) ? result.targets : [];
      for (const [index, t] of targets.entries()) {
        const check = el('input', { type: 'checkbox', value: t.id, checked: index === 0 });
        targetInfo.set(t.id, t);
        check.addEventListener('change', () => selectionChanged(check));
        targetChecks.push(check);
        $('install-target').append(el('label', { className: 'target-choice' }, check,
          el('span', {}, el('strong', { textContent: t.label }), el('span', { className: 'path', textContent: t.rootPath }),
            ...(t.disclosures || []).map(text => el('span', { className: 'problem-warning', textContent: text })))));
      }
      $('install-targets-status').textContent = targets.length ? ''
        : $('install-scope').value === 'project' && !$('install-project-root').value.trim() ? '此資源包在專案範圍尚無部署。請輸入專案資料夾完整路徑後按「讀取專案目標」。'
        : '沒有可載入此資源的部署目標。請確認內容類型與範圍受支援，並先安裝及啟動對應的 AI 工具。';
      $('install-plan').disabled = !targets.length;
      renderInstalled(); // 已安裝狀態依所選範圍與專案呈現
      updateButton();
    } catch (e) {
      if (request !== detailsRequest || generation !== targetRequest) return;
      if (SESSION_LOST.has(e && e.code)) return load();
      $('install-targets-status').textContent = messageOf(e);
    }
  }

  function deploymentText(d) {
    const status = d.status === 'updateAvailable' ? `可更新 → ${d.updateVersion}` : d.status === 'unavailable' ? '已下架或不可見' : '無更新';
    return `${d.hostId} ${d.scope} · ${d.rootPath}：已安裝資源版本 ${d.version}${d.channel === 'preview' ? ' (Preview)' : ''} · ${status}${d.source === 'local' ? '（本機來源）' : ''}${d.contentDiffersFromMarket ? '；與市集內容不符（重裝可修復）' : ''}`;
  }

  const sameRoot = (a, b) => String(a).replaceAll('\\', '/').toLowerCase() === String(b).replaceAll('\\', '/').toLowerCase();
  /** 目前選取的專案（勾選的專案目標；尚未勾選時為已列出的專案目標）的根目錄。 */
  function currentProjectRoots() {
    const projectTargets = (list) => list.map(t => targetInfo.get(t)).filter(t => t?.scope === 'project');
    const checked = projectTargets(selectedTargets());
    return (checked.length ? checked : projectTargets([...targetInfo.keys()])).map(t => t.canonicalRoot ?? t.projectRoot ?? t.rootPath);
  }

  /** 已安裝狀態只列所選範圍：全域部署加上目前專案的部署；其他專案的部署收合保留（LC-AI-Pack 已安裝頁依部署分組，不遺失資訊）。 */
  function renderInstalled() {
    if (!currentDetail) return;
    const deployments = currentDetail.deployments || [];
    const installedError = currentDetail.installedError;
    const roots = currentProjectRoots();
    const relevant = d => d.scope !== 'project' || roots.some(root => sameRoot(root, d.rootPath));
    const here = deployments.filter(relevant), others = deployments.filter(d => !relevant(d));
    $('details-installed').replaceChildren(...(installedError ? [el('div', { className: 'error', textContent: `已安裝狀態無法讀取：${installedError.message}` })]
      : [...(here.length ? here.map(d => el('div', { textContent: deploymentText(d) })) : [el('div', { textContent: others.length ? '所選範圍尚未安裝' : '尚未安裝' })]),
        others.length ? el('details', {}, el('summary', { textContent: `其他專案的部署（${others.length}）` }), ...others.map(d => el('div', { textContent: deploymentText(d) }))) : null].filter(Boolean)));
    updateButton();
  }

  const selectedDeployments = () => (currentDetail?.deployments || []).filter(d => selectedTargets().includes(d.id));
  const updatableSelected = () => selectedDeployments().filter(d => d.updateVersion);

  function updateButton() {
    $('details-update').classList.toggle('hidden', finished || !updatableSelected().length);
    $('details-update').disabled = installing;
    $('install-confirm').textContent = selectedDeployments().length ? '確認更新' : '確認安裝';
  }

  async function updateSelected() {
    if (installing) return;
    const updatable = updatableSelected();
    if (!updatable.length) return;
    // 一份計畫只對應一個資源包版本：所選目標有不同的可更新版本時分批，每批各確認一次；完成後自動選取其餘目標接續
    const version = updatable[0].updateVersion;
    const ids = updatable.filter(d => d.updateVersion === version).map(d => d.id);
    const rest = updatable.filter(d => d.updateVersion !== version).map(d => d.id);
    if (currentPackage.version !== version) {
      await openDetails(currentPackage.packageKey, version);
      if (!targetChecks.some(c => ids.includes(c.value))) return;
    }
    for (const c of targetChecks) c.checked = ids.includes(c.value);
    $('install-plan').disabled = !selectedTargets().length;
    updateButton();
    await planInstall();
    // 摘要產生後才記下其餘批次（產生摘要會重置接續狀態）
    if (currentPlan) {
      pendingUpdateIds = rest;
      if (rest.length) $('install-status').textContent += ` 所選目標有不同的可更新版本，這次先更新到 ${version}；完成後會自動選取其餘 ${rest.length} 個目標。`;
    }
  }

  /** 一批更新完成後：把仍待更新的目標選起來並提示，使用者再按「更新所選目標」即接續下一批。 */
  function resumePendingUpdates() {
    const remaining = (currentDetail?.deployments || []).filter(d => pendingUpdateIds.includes(d.id) && d.updateVersion);
    pendingUpdateIds = [];
    if (!remaining.length) return '';
    const ids = remaining.map(d => d.id);
    for (const c of targetChecks) c.checked = ids.includes(c.value);
    $('install-plan').disabled = !selectedTargets().length;
    updateButton();
    const versions = [...new Set(remaining.map(d => d.updateVersion))];
    return ` 尚有 ${remaining.length} 個目標可更新到 ${versions.join('、')}，已為你選取，請按「完成」後再按「更新所選目標」繼續。`;
  }

  function problemList(problems) {
    if (!problems?.length) return null;
    return el('ul', {}, ...problems.map(p => el('li', { className: p.severity === 'Blocking' ? 'problem-blocking' : 'problem-warning',
      textContent: `${p.severity === 'Blocking' ? '受阻' : '注意'}：${p.summary}${p.path ? `（${p.path}）` : ''}` })));
  }

  // ---------- 設定命令：確認前只揭露，不執行；確認一次後才先執行命令再部署 ----------
  const commandDetail = c => `${c.runner} ${c.script}${c.arguments?.length ? ` ${c.arguments.join(' ')}` : ''}（逾時 ${c.timeoutMinutes} 分鐘）`;
  const executableCommands = plan => (plan?.setup?.commands || []).filter(c => c.willExecute);

  function renderCommands(box, plan) {
    const commands = plan.setup?.commands || [];
    if (!commands.length) return;
    const run = commands.filter(c => c.willExecute), others = commands.filter(c => !c.willExecute);
    box.append(el('strong', { textContent: run.length ? `設定命令（確認後先執行 ${run.length} 項，再部署）` : '設定命令（本次不執行）' }));
    if (run.length) box.append(el('div', { className: 'hint', textContent: '命令只在你確認後執行一次，依宣告順序；任何一項失敗就中止，部署目標不會被改動。腳本輸出只儲存在已遮罩的操作紀錄。' }));
    for (const c of run) box.append(el('div', { className: 'setup-command' }, el('div', { textContent: `${c.name}（${REASON_LABELS[c.reason] || c.reason}）` }), el('div', { className: 'path', textContent: commandDetail(c) })));
    if (others.length) box.append(el('details', {}, el('summary', { textContent: `略過的設定命令（${others.length} 項）` }),
      ...others.map(c => el('div', { className: 'setup-command' }, el('div', { textContent: `${c.name}：${ELIGIBILITY_LABELS[c.eligibility] || REASON_LABELS[c.reason] || c.reason}` }), el('div', { className: 'path', textContent: commandDetail(c) })))));
    if (plan.setup.setupRoot) box.append(el('div', { className: 'path', textContent: `安裝根目錄：${plan.setup.setupRoot}` }));
  }

  /** 套用結果中的設定命令：結局、exit code，以及（已遮罩的）輸出尾端。 */
  function commandResults(result) {
    const executed = (result.setup?.commands || []).filter(c => c.executed);
    if (!executed.length && !result.operation) return [];
    return [...executed.map(c => el('div', {},
      el('div', { className: c.succeeded ? '' : 'problem-blocking', textContent: `設定命令 ${c.name}：${c.succeeded ? '成功' : (c.outcome === 'Cancelled' ? '已取消' : c.outcome === 'TimedOut' ? '逾時' : `失敗${c.exitCode != null ? `（exit code ${c.exitCode}）` : ''}`)}` }),
      c.failureSummary ? el('div', { className: 'hint', textContent: c.failureSummary }) : null,
      c.output?.length ? el('details', {}, el('summary', { textContent: `命令輸出（${c.output.length} 行，已遮罩）` }), el('pre', { textContent: c.output.join('\n') })) : null)),
    result.operation ? el('div', { className: 'path', textContent: `操作 ${result.operation.id}；紀錄檔：${result.operation.logPath}` }) : null,
    result.operation?.canResume ? el('div', { className: 'hint', textContent: '修正條件後按「完成」，再按「產生部署摘要」重新安裝；上次未成功的命令會重新執行。' }) : null].filter(Boolean);
  }

  /** 單一目標的結果：一行狀態，可展開看寫入、備份、需人工處理的路徑與原因；失敗與未完整還原預設展開。 */
  function targetResult(t) {
    const lines = [
      t.writtenPaths?.length ? el('div', { className: 'path', textContent: `寫入：${t.writtenPaths.join('、')}` }) : null,
      t.removedPaths?.length ? el('div', { className: 'path', textContent: `移除：${t.removedPaths.join('、')}` }) : null,
      t.backupPaths?.length ? el('div', { className: 'path', textContent: `備份：${t.backupPaths.join('、')}` }) : null,
      t.partiallyRestoredPaths?.length ? el('div', { className: 'path problem-blocking', textContent: `部分還原：${t.partiallyRestoredPaths.join('、')}` }) : null,
      t.residualPaths?.length ? el('div', { className: 'path problem-blocking', textContent: `需人工處理：${t.residualPaths.join('、')}` }) : null,
      problemList(t.problems)].filter(Boolean);
    return el('details', { open: t.status !== 'succeeded' }, el('summary', { textContent: `${t.label}：${STATUS_LABELS[t.status] || t.status}` }),
      ...(lines.length ? lines : [el('div', { className: 'hint', textContent: '沒有檔案變更。' })]));
  }

  function renderSummary(plan) {
    const box = $('install-summary');
    const channel = plan.package.channel === 'preview' ? 'Preview' : '正式版';
    box.replaceChildren(el('strong', { textContent: '部署摘要' }),
      el('div', { textContent: `${plan.package.name} 版本 ${plan.package.version}（${channel}）` }));
    // ADR 0002：可安裝與受阻的目標同時列出；確認一次只部署可安裝的目標
    const deployable = plan.deployableCount ?? plan.targets.filter(t => t.canApply).length;
    const blocked = plan.blockedCount ?? plan.targets.filter(t => !t.canApply).length;
    if (plan.targets.length > 1 || blocked) {
      box.append(el('div', { textContent: `可安裝 ${deployable} 個目標；受阻 ${blocked} 個目標` }));
      if (deployable && blocked) box.append(el('div', { className: 'hint', textContent: '確認後只部署可安裝的目標，受阻的目標維持原狀；結果會逐一列出。' }));
    }
    for (const t of plan.targets) {
      box.append(el('div', { className: t.canApply ? '' : 'problem-blocking', textContent: `部署目標：${t.label}${t.canApply ? '' : '（受阻）'}` }), el('div', { className: 'path', textContent: t.rootPath }));
      if (t.installedVersions?.length) box.append(el('div', { textContent: `${t.installedVersions.join('、')} → ${t.nextVersion}` }));
      box.append(problemList(t.problems) || el('span'));
      box.append(el('details', {}, el('summary', { textContent: `變更明細（${t.changes.length} 項）` }),
        el('ul', {}, ...t.changes.map(c => el('li', {}, el('div', { textContent: `${c.changeLabel}：${c.kind} ${c.contentId}${c.willBackup ? `（先備份${BACKUP_REASONS[c.backupReason] ? `：${BACKUP_REASONS[c.backupReason]}` : ''}）` : ''}` }),
          el('div', { className: 'path', textContent: c.destinationPath }))))));
      if (t.loadPrecedence?.length) box.append(el('details', {}, el('summary', { textContent: `載入優先順序（${t.loadPrecedence.length} 項）` }),
        ...t.loadPrecedence.map(p => el('div', {}, el('div', { textContent: `${p.kind} ${p.contentId}：${p.text}` }),
          ...p.locations.map(l => el('div', { className: 'path', textContent: `${l.scopeLabel} ${l.version}${l.current ? '（本次部署）' : ''}：${l.path}` }))))));
      for (const c of t.configuration || []) box.append(el('details', {}, el('summary', { textContent: `MCP 設定：${c.contentId}` }),
        el('div', { className: 'path', textContent: c.ownedFields.join('、') }),
        el('pre', { textContent: `- ${c.redactedBefore}\n+ ${c.redactedAfter}` })));
    }
    for (const d of plan.unchangedDeployments || []) box.append(el('div', { className: 'path', textContent: `維持原版 ${d.version}：${d.rootPath}` }));
    renderCommands(box, plan);
    const planProblems = problemList(plan.problems);
    if (planProblems) box.append(planProblems);
    renderSetup(plan);
    $('install-confirm').classList.toggle('hidden', !plan.canApply);
  }

  async function planInstall() {
    if (installing || !currentPackage?.version || !selectedTargets().length) return;
    const request = detailsRequest;
    const generation = targetRequest;
    const targets = selectedTargets();
    resetPlan();
    installing = true;
    $('install-plan').disabled = true;
    $('install-status').textContent = '下載、驗證並產生部署摘要中…';
    try {
      // 所選位置已安裝不同版本時是「更新」：設定命令的判斷意圖（同版略過、更新只重跑 runOnUpdate）必須與規劃一致。
      const action = selectedDeployments().some(d => d.version !== currentPackage.version) ? 'update' : 'install';
      const plan = await call('rc.deploy.plan', { packageKey: currentPackage.packageKey, version: currentPackage.version, action,
        previewMode: currentPackage.previewMode === true, ...scopeInput(), targets }, 120000);
      if (request !== detailsRequest || generation !== targetRequest) return;
      currentPlan = plan;
      renderSummary(plan);
      $('install-status').textContent = plan.canApply ? `請確認部署摘要後按「${$('install-confirm').textContent}」。${plan.blockedCount ? `只會部署可安裝的 ${plan.deployableCount} 個目標，受阻的 ${plan.blockedCount} 個維持原狀。` : ''}`
        : (!plan.targets.some(t => t.canApply) ? '所有部署目標都受阻，請依原因修正後重新產生摘要。' : '部署計畫有受阻的原因，請依說明修正後重新產生摘要。');
    } catch (e) {
      if (request !== detailsRequest || generation !== targetRequest) return;
      if (SESSION_LOST.has(e && e.code)) return load();
      $('install-status').textContent = messageOf(e);
    } finally {
      installing = false;
      if (request === detailsRequest) $('install-plan').disabled = !selectedTargets().length;
    }
  }

  async function confirmInstall() {
    if (installing || !currentPlan?.canApply) return;
    const request = detailsRequest;
    const generation = targetRequest;
    const reviewed = currentPlan;
    installing = true;
    $('install-confirm').disabled = true;
    // 設定命令最長可執行到各自宣告的逾時（1–120 分鐘）；請求逾時要涵蓋命令時間，並提供取消。
    const commandMinutes = executableCommands(reviewed).reduce((sum, c) => sum + (c.timeoutMinutes || 0), 0);
    $('install-cancel').classList.toggle('hidden', !commandMinutes);
    $('install-status').textContent = commandMinutes ? `執行設定命令並部署中…（設定命令最長 ${commandMinutes} 分鐘，可取消）` : '套用部署計畫中…';
    try {
      const result = await call('rc.deploy.apply', { planDigest: reviewed.planDigest, targets: reviewed.targets.map(t => t.id) }, 120000 + commandMinutes * 60000);
      if (request !== detailsRequest || generation !== targetRequest) return;
      if (result.status === 'stale') {
        currentPlan = result.plan;
        renderSummary(result.plan);
        $('install-status').textContent = result.message;
        return;
      }
      currentPlan = null;
      $('install-confirm').classList.add('hidden');
      $('install-summary').replaceChildren(); // 已確認的部署摘要不再顯示，只留結果
      renderSetup(null);
      failedIds = result.targets.filter(t => FAILED_STATUSES.has(t.status)).map(t => t.id);
      setFinished(true);
      $('install-status').textContent = `安裝${STATUS_LABELS[result.status] || result.status}`;
      $('install-result').replaceChildren(...result.targets.map(targetResult), problemList(result.problems) || el('span'), ...commandResults(result));
      try {
        const detail = await call('rc.package.getDetails', { ...currentPackage });
        if (request === detailsRequest) {
          currentDetail = detail; renderInstalled();
          if (pendingUpdateIds.length) $('install-status').textContent += resumePendingUpdates();
        }
      } catch (e) {
        if (request !== detailsRequest) return;
        if (SESSION_LOST.has(e && e.code)) return load();
        currentDetail = null;
        $('details-installed').textContent = `部署結果已保留；無法重新讀取已安裝版本：${messageOf(e)}`;
        $('details-update').classList.add('hidden');
      }
    } catch (e) {
      if (request !== detailsRequest || generation !== targetRequest) return;
      if (SESSION_LOST.has(e && e.code)) return load();
      resetPlan();
      $('install-status').textContent = messageOf(e);
    } finally {
      installing = false;
      $('install-confirm').disabled = false;
      $('install-cancel').classList.add('hidden');
      updateButton();
      if (request === detailsRequest) $('install-plan').disabled = !selectedTargets().length;
    }
  }

  /** 只重試失敗的目標（對照 LC-AI-Pack RetryFailedTargetsAsync）：只勾選失敗的目標並重新產生部署摘要；仍需確認一次才套用，已成功的目標不再送出。 */
  async function retryFailed() {
    if (installing) return;
    const ids = failedIds.filter(id => targetChecks.some(c => c.value === id));
    if (!ids.length) { $('install-status').textContent = '目前的部署目標清單已改變，找不到失敗的目標；請按「完成」後重新選擇。'; return; }
    for (const c of targetChecks) c.checked = ids.includes(c.value);
    updateButton();
    await planInstall();
    if (currentPlan) $('install-status').textContent = `已針對失敗的目標重新產生部署摘要，請重新確認後再安裝。${$('install-status').textContent}`;
  }

  /** 取消正在執行的設定命令：整棵子行程樹被終止，部署目標不被改動；結果由進行中的套用請求回報。 */
  async function cancelInstall() {
    $('install-cancel').disabled = true;
    try { await call('rc.deploy.cancel', {}); } catch (e) { $('install-status').textContent = messageOf(e); } finally { $('install-cancel').disabled = false; }
  }

  async function openDetails(packageKey, version) {
    const request = ++detailsRequest;
    currentDetail = null;
    $('details-installed').replaceChildren();
    $('details-update').classList.add('hidden');
    currentPackage = { packageKey, previewMode: $('catalog-preview').checked === true };
    showView('details');
    $('details-download').disabled = true;
    $('details-version').disabled = true;
    $('details-readme').textContent = '';
    $('details-title').textContent = packageKey;
    $('details-description').textContent = '';
    $('details-hosts').textContent = '';
    $('details-changelog').textContent = '';
    $('details-status').textContent = '讀取詳情中…';
    $('details-retry').classList.add('hidden');
    resetPlan();
    try {
      const detail = await call('rc.package.getDetails', { ...currentPackage, ...(version ? { version } : {}) });
      if (request !== detailsRequest) return;
      currentPackage.version = detail.selectedVersion;
      currentDetail = detail;
      renderInstalled();
      $('details-title').textContent = detail.name;
      $('details-description').textContent = detail.description || '';
      $('details-version').replaceChildren();
      for (const v of detail.versions) {
        const option = document.createElement('option');
        option.value = v.version;
        option.textContent = `${v.version}${v.channel === 'preview' ? ' (Preview)' : ''}`;
        $('details-version').append(option);
      }
      $('details-version').value = detail.selectedVersion;
      const selected = detail.versions.find(v => v.version === detail.selectedVersion);
      $('details-hosts').textContent = `相容 AI 工具：${selected.hosts.join('、') || '未提供'}`;
      $('details-changelog').textContent = selected.changelog || '';
      $('details-readme').textContent = detail.readme;
      $('details-status').textContent = '';
      $('details-download').disabled = false;
      $('details-version').disabled = false;
      await loadTargets();
    } catch (e) {
      if (request !== detailsRequest) return;
      if (SESSION_LOST.has(e && e.code)) return load();
      $('details-status').textContent = messageOf(e);
      $('details-retry').classList.remove('hidden');
    }
  }

  async function download() {
    if (downloading || !currentPackage?.version) return;
    downloading = true;
    const request = detailsRequest;
    const input = { ...currentPackage };
    const destinationFile = $('details-destination').value.trim();
    if (destinationFile) input.destinationFile = destinationFile;
    $('details-download').disabled = true;
    $('details-version').disabled = true;
    $('details-status').textContent = '下載與驗證 ZIP 中…';
    try {
      const result = await call('rc.download.save', input, 120000);
      if (request === detailsRequest) $('details-status').textContent = `已儲存：${result.filePath}`;
    } catch (e) {
      if (request !== detailsRequest) return;
      if (SESSION_LOST.has(e && e.code)) return load();
      $('details-status').textContent = messageOf(e);
    } finally {
      downloading = false;
      if (request === detailsRequest) {
        $('details-download').disabled = false;
        $('details-version').disabled = false;
      }
    }
  }

  async function loadCatalog() {
    const request = ++catalogRequest;
    $('catalog-retry').classList.add('hidden');
    $('catalog-status').textContent = '載入資源包中…';
    $('catalog-list').replaceChildren();
    try {
      const result = await call('rc.catalog.list', {
        search: $('catalog-search').value, type: $('catalog-type').value,
        ...($('catalog-installation').value ? { installation: $('catalog-installation').value } : {}),
        previewMode: $('catalog-preview').checked === true
      });
      if (request !== catalogRequest) return;
      const labels = { skill: 'Skills', agent: 'Agents', mcp: 'MCP', bundle: '組合包' };
      for (const p of result.data) {
        const row = document.createElement('li');
        row.className = 'panel-box wrap';
        const title = document.createElement('strong');
        title.textContent = p.name;
        const meta = document.createElement('span');
        meta.className = 'muted';
        meta.textContent = `${labels[p.type] || p.type} · ${p.latestVisibleVersion || '尚無可見版本'}`;
        row.append(title, meta);
        for (const d of p.deployments || []) row.append(el('div', { className: 'path', textContent: deploymentText(d) }));
        const open = document.createElement('button');
        open.className = 'btn';
        open.textContent = '查看詳情';
        open.addEventListener('click', () => openDetails(p.packageKey));
        row.append(open);
        $('catalog-list').append(row);
      }
      const count = result.data.length ? `共 ${result.data.length} 個資源包` : '沒有符合條件的資源包';
      $('catalog-status').textContent = result.installedError ? `${count}。已安裝狀態無法讀取：${result.installedError.message}` : count;
    } catch (e) {
      if (request !== catalogRequest) return;
      if (SESSION_LOST.has(e && e.code)) return load();
      $('catalog-status').textContent = messageOf(e);
      $('catalog-retry').classList.remove('hidden');
    }
  }

  async function loadClientVersions() {
    const request = detailsRequest;
    $('client-versions').textContent = '';
    try {
      const result = await call('rc.client.getVersions', {});
      if (request !== detailsRequest || !result) return;
      $('client-versions').textContent = `Orca 外掛用戶端版本：${result.orca.version}；LC-AI-Pack 用戶端（共用收據最後部署：${result.lcAiPack.receiptVersion || '未偵測'}；市集最新發行版：${result.lcAiPack.version || '未提供'}）`;
    } catch (e) {
      if (request !== detailsRequest) return;
      if (SESSION_LOST.has(e && e.code)) return load();
      $('client-versions').textContent = '用戶端版本暫時無法讀取';
    }
  }

  // ---------- 與 worker 溝通（請求契約見 worker/contract.mjs） ----------
  function call(method, input, timeoutMs) {
    if (!window.orca?.plugin) return Promise.reject(new Error('Orca Plugin Bridge 尚未就緒'));
    return window.orca.plugin.request(method, input, timeoutMs ? { timeoutMs } : undefined);
  }

  const messageOf = (e) => (e && e.message) || String(e || '發生未知錯誤');

  // ---------- 畫面 ----------
  function showView(name) {
    for (const v of VIEWS) $(`view-${v}`).classList.toggle('hidden', v !== name);
    $('btn-refresh').classList.toggle('hidden', name !== 'main');
  }
  function setText(id, text) {
    const node = $(id);
    node.textContent = text || '';
    node.classList.toggle('hidden', !text);
  }
  function banner(msg, kind = 'info') {
    const b = $('banner');
    if (!msg) return b.classList.add('hidden');
    b.textContent = msg;
    b.className = `banner ${kind}`;
  }
  const setStatus = (s) => ($('status-dot').className = `status-dot ${s}`);
  function applyTheme(scheme) {
    document.body.classList.toggle('light', scheme === 'light');
    document.documentElement.classList.toggle('light', scheme === 'light');
  }
  function setBusy(on) {
    busy = on;
    for (const id of ['btn-login', 'btn-logout', 'btn-refresh', 'in-url', 'in-user', 'in-pass']) $(id).disabled = on;
    $('btn-login').textContent = on ? '登入中…' : '登入';
  }

  // ---------- 狀態呈現 ----------
  function render(state) {
    detailsRequest += 1;
    currentPackage = null;
    banner(null);
    if (!state.signedIn) {
      catalogRequest += 1;
      $('catalog-list').replaceChildren();
      setStatus('');
      if (!$('in-url').value) $('in-url').value = state.marketUrl || '';
      setText('login-notice', state.notice || '');
      setText('login-error', '');
      showView('login');
      ($('in-url').value ? $('in-user') : $('in-url')).focus();
      return;
    }
    $('main-url').textContent = state.marketUrl;
    $('main-account').textContent = state.account;
    setStatus('connected');
    $('in-pass').value = '';
    showView('main');
    loadClientVersions();
    loadCatalog();
  }

  async function load() {
    try {
      render(await call('rc.session.getState', undefined, SIGN_IN_TIMEOUT_MS));
    } catch (e) {
      setStatus('error');
      showView('login');
      banner(messageOf(e), 'error');
    }
  }

  // ---------- 動作 ----------
  async function signIn(ev) {
    ev.preventDefault();
    if (busy) return;
    const input = { marketUrl: $('in-url').value, username: $('in-user').value, password: $('in-pass').value };
    if (!input.marketUrl.trim() || !input.username.trim() || !input.password) {
      setText('login-error', '請填寫市集網址、帳號與密碼');
      return;
    }
    setText('login-error', '');
    setBusy(true);
    try {
      const state = await call('rc.session.signIn', input, SIGN_IN_TIMEOUT_MS);
      $('in-url').value = state.marketUrl;
      render(state);
    } catch (e) {
      setText('login-notice', '');
      setText('login-error', messageOf(e));
      $(e && e.code === 'invalid_url' ? 'in-url' : 'in-pass').focus();
    } finally {
      $('in-pass').value = '';
      setBusy(false);
    }
  }

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try {
      const state = await call('rc.session.signOut');
      render(state);
    } catch (e) {
      banner(messageOf(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (busy) return;
    setBusy(true);
    try {
      render(await call('rc.session.getState', undefined, SIGN_IN_TIMEOUT_MS));
    } catch (e) {
      if (SESSION_LOST.has(e && e.code)) return load();
      banner(messageOf(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------- 啟動 ----------
  function boot() {
    if (document.body.classList.contains('light') || document.documentElement.classList.contains('light')) applyTheme('light');
    window.orca?.on?.('theme', (t) => t?.colorScheme && applyTheme(t.colorScheme));
    $('login-form').addEventListener('submit', signIn);
    $('btn-logout').addEventListener('click', signOut);
    $('btn-refresh').addEventListener('click', refresh);
    $('details-back').addEventListener('click', () => { detailsRequest += 1; currentPackage = null; showView('main'); loadCatalog(); });
    $('details-version').addEventListener('change', () => openDetails(currentPackage.packageKey, $('details-version').value));
    $('details-retry').addEventListener('click', () => openDetails(currentPackage.packageKey, currentPackage.version));
    $('details-download').addEventListener('click', download);
    $('install-scope').addEventListener('change', () => {
      invalidateTargets();
      const project = $('install-scope').value === 'project';
      $('install-project').classList.toggle('hidden', !project);
      $('install-targets-status').textContent = '';
      // 專案範圍先自動列出已有此資源部署的專案；也可輸入專案路徑讀取其他專案
      return loadTargets();
    });
    $('install-project-root').addEventListener('input', invalidateTargets);
    $('install-detect').addEventListener('click', loadTargets);
    $('install-target').addEventListener('change', selectionChanged);
    $('details-update').addEventListener('click', updateSelected);
    $('install-plan').addEventListener('click', planInstall);
    $('install-confirm').addEventListener('click', confirmInstall);
    $('install-retry').addEventListener('click', retryFailed);
    $('install-done').addEventListener('click', () => { resetPlan(); $('install-plan').disabled = installing || !selectedTargets().length; updateButton(); });
    $('install-cancel').addEventListener('click', cancelInstall);
    $('install-setup-save').addEventListener('click', saveSetup);
    $('catalog-form').addEventListener('submit', (ev) => { ev.preventDefault(); return loadCatalog(); });
    $('catalog-type').addEventListener('change', loadCatalog);
    $('catalog-installation').addEventListener('change', loadCatalog);
    $('catalog-retry').addEventListener('click', loadCatalog);
    $('catalog-preview').addEventListener('change', loadCatalog);
    $('catalog-clear').addEventListener('click', () => {
      $('catalog-search').value = '';
      $('catalog-type').value = '';
      $('catalog-installation').value = '';
      return loadCatalog();
    });
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
