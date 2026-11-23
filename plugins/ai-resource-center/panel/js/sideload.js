// 從資料夾安裝（開發中版本）：「我的資源包」的「本機開發中」區塊，與從資料夾安裝的 sheet（規格 §3、§5）。
// 沿用通用 sheet（sheet.js）與例外確認層的內容元件（confirm.js 的 RC.commandSection／RC.blockedSection、setup.js 的 RC.paramField／RC.collectSetup、
// install.js 的 RC.targetRow／RC.backupFold）；不自行實作任何部署邏輯，全部交給 worker 的 rc.dev.install.*、rc.install.* 與 rc.dev.listLocal。
//
// 對外：
//   RC.openInstallFromFolder()         「從資料夾安裝…」：路徑列（記住上次資料夾）→ 預檢 → 摘要確認 → 安裝 → 結果，全在同一個 sheet
//   RC.loadLocalPackages()／RC.resetLocalPackages()／RC.renderLocalPackages()   本機開發中區塊（#developer-local）
//   RC.localPackageOf(key)             解除安裝確認層需要的名稱與部署位置（catalog.js 的 RC.packageOf 找不到時的備援）
//   「上傳…」呼叫 RC.openUploadSheet?.({ folder })（由打包並上傳的 sheet 提供）
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, el, call, state } = RC;

  const PICK_TIMEOUT_MS = 118000; // 原生選擇視窗最長約兩分鐘（worker 在 115 秒時自行放棄）
  const PREPARE_TIMEOUT_MS = 120000; // 預檢＋打包到暫存目錄
  const SAVE_TIMEOUT_MS = 120000;
  const PICK_HINT = '已開啟選擇視窗；若沒看到，請查看工作列';
  const PICK_UNAVAILABLE = '這台電腦無法開啟選擇視窗，請直接貼上資料夾路徑';

  const span = (text, props = {}) => el('span', { ...props, textContent: text });
  const discard = (planId) => (planId ? call('rc.install.discard', { planId }).catch(() => {}) : Promise.resolve());

  // ---------- 本機開發中區塊 ----------
  let local = []; // rc.dev.listLocal 的 packages
  let localRequest = 0;
  const deployments = new Map(); // packageKey → 解除安裝前讀到的全域部署位置
  const reinstalling = new Set(); // 正在預檢重新安裝的 packageKey

  /** 解除安裝確認層需要名稱與部署位置；清單卡片沒有這個資源包時由這裡補上。 */
  RC.localPackageOf = (key) => {
    const found = local.find(p => p.packageKey === key);
    return found ? { packageKey: key, name: found.name, deployments: deployments.get(key) || [] } : null;
  };

  RC.resetLocalPackages = function resetLocalPackages() {
    localRequest += 1;
    local = [];
    deployments.clear(); reinstalling.clear();
    RC.renderLocalPackages();
  };

  /** 重新讀取全域收據中 source 為 local 的資源包；失敗時保留原清單並提示（工具列按鈕不受影響）。 */
  RC.loadLocalPackages = async function loadLocalPackages() {
    const mine = ++localRequest;
    try {
      const result = await call('rc.dev.listLocal', {});
      if (mine !== localRequest) return;
      local = Array.isArray(result?.packages) ? result.packages : [];
      RC.renderLocalPackages();
    } catch (e) {
      if (mine !== localRequest) return;
      if (RC.sessionLost(e)) return RC.load();
      RC.toast(RC.messageOf(e), 'error');
    }
  };

  /** 解除安裝：先取得部署位置（市集沒有這個資源包時詳情走本機收據），再走一般的解除安裝確認層。 */
  async function uninstall(pack) {
    try {
      const detail = await call('rc.package.getDetails', { packageKey: pack.packageKey, previewMode: state.showPreview });
      deployments.set(pack.packageKey, (detail?.deployments || []).filter(d => d.scope !== 'project'));
    } catch (e) {
      return RC.actionFailed(e);
    }
    RC.startUninstall(pack.packageKey);
  }

  /** 重新安裝：從記錄的來源資料夾重新預檢，結果放進從資料夾安裝的同一個 sheet。 */
  async function reinstall(pack) {
    const key = pack.packageKey;
    if (reinstalling.has(key) || state.running.has(key)) return;
    reinstalling.add(key); RC.renderLocalPackages();
    let prepared;
    try {
      prepared = await call('rc.dev.reinstallLocal', { packageKey: key }, PREPARE_TIMEOUT_MS);
    } catch (e) {
      RC.actionFailed(e);
      if (e?.code === 'source_missing') RC.loadLocalPackages();
      return;
    } finally {
      reinstalling.delete(key); RC.renderLocalPackages();
    }
    if (!RC.isShown('developer') || RC.confirmOpen()) return discard(prepared?.planId);
    openInstallSheet({ folder: pack.sourcePath, reinstallKey: key, prepared });
  }

  // 本機開發中卡片兩顆按鈕的滑過說明：重新安裝只動這台電腦，上傳會送到市集。
  const LOCAL_TIPS = Object.freeze({
    reinstall: '用來源資料夾目前的內容重新打包，再安裝到這台電腦的 AI 工具；只影響你自己，不會送到市集。改完檔案想再測一次時用。',
    upload: '把來源資料夾打包並上傳到市集，成為新的 Preview 版本，可接著申請上架；其他人會看得到。上傳前請先調高 lcpack.json 的版號。'
  });
  function localCard(pack) {
    const key = pack.packageKey, name = pack.name || key;
    const busy = state.running.has(key) || reinstalling.has(key);
    const missing = pack.sourceExists !== true;
    const more = el('button', { type: 'button', className: 'dev-more', 'aria-label': `${name} 的更多操作`, title: `${name} 的更多操作`, 'aria-haspopup': 'true', 'aria-expanded': 'false', textContent: '⋯', disabled: state.running.has(key) });
    more.addEventListener('click', () => RC.openPopover(more, [{ label: '解除安裝', kind: 'danger', onSelect: () => uninstall(pack) }]));
    const button = (action, label, tip, onClick) => {
      const b = el('button', { type: 'button', className: 'btn dev-btn', 'data-action': action, textContent: label, disabled: busy || missing, title: missing ? `來源資料夾已不存在，無法${label.replace('…', '')}` : tip });
      b.addEventListener('click', onClick);
      return b;
    };
    return el('div', { className: 'dev-card is-dev', 'data-role': 'local-package', 'data-package-key': key },
      el('div', { className: 'dev-ct' }, el('span', { className: 'dev-name' }, span(name, { className: 'ell', 'data-role': 'package-name' })), more),
      el('div', { className: 'dev-meta' }, span(key, { className: 'mono wrap', 'data-role': 'package-key' }), span(`開發中 ${pack.version}`, { className: 'badge b-dev', 'data-role': 'dev-badge' })),
      el('div', { className: 'muted mono ell', 'data-role': 'source-path', title: pack.sourcePath || '', textContent: pack.sourcePath || '（未記錄來源資料夾）' }),
      missing ? el('div', { className: 'dev-local-note', 'data-role': 'source-missing', textContent: '來源資料夾已不存在' }) : null,
      el('div', { className: 'dev-local-actions' },
        button('reinstall-local', '重新安裝', LOCAL_TIPS.reinstall, () => reinstall(pack)),
        button('upload-local', '上傳…', LOCAL_TIPS.upload, () => RC.openUploadSheet?.({ folder: pack.sourcePath }))));
  }

  /** 依目前資料重畫；沒有開發中版本時整個區塊隱藏。 */
  RC.renderLocalPackages = function renderLocalPackages() {
    const box = $('developer-local');
    box.classList.toggle('hidden', !local.length);
    box.replaceChildren(...(local.length ? [el('div', { className: 'dev-sec', 'data-role': 'local-heading', textContent: `本機開發中（${local.length}）` }), ...local.map(localCard)] : []));
  };

  // ---------- 從資料夾安裝的 sheet ----------
  /** 預檢阻擋項：紅框清單（問題＋檔案路徑）。 */
  function failureList(blocking) {
    return el('div', { className: 'failure-list', 'data-role': 'precheck-failures', role: 'alert' },
      span(`有 ${blocking.length} 個問題需要修正`, { className: 'precheck-title' }),
      ...blocking.map(b => el('div', { className: 'precheck-item', 'data-role': 'precheck-item' }, span(b.message || b.code || '未知問題'), b.path ? span(b.path, { className: 'precheck-path' }) : null)));
  }

  /** 預檢揭露項：黃色提醒，可折疊，不阻擋。 */
  function disclosureBox(disclosures) {
    if (!disclosures?.length) return null;
    return el('details', { className: 'notice', 'data-role': 'disclosures', open: true }, el('summary', { textContent: `${disclosures.length} 個提醒（不影響安裝）` }),
      ...disclosures.map(d => el('div', { className: 'precheck-item' }, span(d.message || d.code || ''), d.path ? span(d.path, { className: 'precheck-path' }) : null)));
  }

  /** 「✓ 預檢通過 · 將安裝到 ◎ Codex、✳ Claude Code」 */
  function okLine(tools) {
    const parts = [];
    (tools || []).forEach((t, i) => {
      // 頓號跟在前一個工具名稱後面，窄寬度換行時不會落在行首
      parts.push(el('span', { className: 'okline-tool', 'data-role': 'tool', 'data-tool': t.hostId }, RC.toolIcon({ hostId: t.hostId, label: RC.toolLabel(t), deployed: true }, { desktopLabel: false, caption: RC.toolLabel(t) }),
        span(`${RC.toolLabel(t)}${i < tools.length - 1 ? '、' : ''}`)));
      if (i < tools.length - 1) parts.push(span(' '));
    });
    return el('div', { className: 'okline', 'data-role': 'precheck-ok' }, span('✓ 預檢通過'), ...(parts.length ? [span(' · 將安裝到 '), ...parts] : []));
  }

  /** 安裝結果（同一般安裝的結果：成功、部分成功、受阻略過、失敗原因、備份位置）。 */
  function resultNodes(result) {
    const succeeded = result?.succeeded || [], failed = result?.failed || [], skipped = result?.skipped || [];
    const cancelled = failed.length > 0 && !succeeded.length && failed.every(t => t.reason === '已取消設定，尚未完成安裝');
    const title = cancelled ? '已取消安裝'
      : failed.length ? `${succeeded.length ? `${RC.ACTIONS.install.done(succeeded.length)}，` : ''}${failed.length} 個位置失敗`
      : succeeded.length ? RC.ACTIONS.install.done(succeeded.length) : '沒有需要處理的位置';
    const nodes = [failed.length ? el('div', { className: 'sheet-result-title', 'data-role': 'result-title', textContent: title }) : el('div', { className: 'okline', 'data-role': 'result-title', textContent: `✓ ${title}` })];
    if (succeeded.length) {
      nodes.push(el('ul', { className: 'location-list', 'data-role': 'installed-targets' }, ...succeeded.map(t => {
        const label = RC.toolLabel(t);
        return el('li', { className: 'location-row', 'data-role': 'installed-target', 'data-target-id': t.targetId },
          RC.toolIcon({ hostId: t.hostId, label, deployed: true }, { desktopLabel: false, caption: label }),
          el('div', { className: 'location-body' }, el('strong', { textContent: label }), el('div', { className: 'location-path mono', textContent: t.rootPath || '' })));
      })));
    }
    if (failed.length) nodes.push(el('div', { className: 'failure-list', 'data-role': 'failure-list' }, el('ul', { className: 'location-list' }, ...failed.map(t => RC.targetRow(t, 'failure-target', '此位置未完成部署', { backups: true })))));
    if (skipped.length) nodes.push(el('div', { className: 'skipped-list', 'data-role': 'skipped-list' }, el('ul', { className: 'location-list' }, ...skipped.map(t => RC.targetRow(t, 'skipped-target', '此位置已略過', { backups: true }))),
      el('div', { className: 'hint', textContent: '排除原因後，下次安裝、更新或補裝時會再嘗試。' })));
    const warnings = (result?.warnings || []).map(w => [w.summary, w.path].filter(Boolean).join(' ')).filter(Boolean);
    if (warnings.length) nodes.push(...warnings.map(w => el('div', { className: 'notice', 'data-role': 'result-warning', textContent: w })));
    const backups = (result?.backups || []).map(b => b.backupPath).filter(Boolean);
    if (backups.length) nodes.push(RC.backupFold(backups));
    return nodes;
  }

  /**
   * 開啟 sheet。reinstallKey：從本機開發中區塊「重新安裝」進來（預檢走 rc.dev.reinstallLocal，使用者改了路徑就改走一般預檢）；
   * prepared：已預檢好的回應（reinstallLocal 的結果），直接顯示。
   */
  function openInstallSheet({ folder = '', reinstallKey = null, prepared = null } = {}) {
    // phase：path 選資料夾｜failed 預檢有阻擋項｜confirm 摘要待確認｜blocked 全部受阻｜result 已套用
    const ctx = { phase: 'path', response: null, planId: null, key: null, inputs: new Map(), reinstallKey, picking: false, running: false, closed: false, replanned: false };
    const pathInput = el('input', { type: 'text', className: 'mono', value: folder, spellcheck: false, autocomplete: 'off', 'aria-label': '資源包資料夾', placeholder: '貼上資料夾的完整路徑' });
    const pickButton = el('button', { type: 'button', className: 'btn', 'data-action': 'pick-folder', textContent: '選擇…' });
    const pickHint = el('div', { className: 'hint hidden', 'data-role': 'pick-hint', role: 'status' });
    const pathField = RC.sheetField('資源包資料夾', el('div', { className: 'pathrow' }, pathInput, pickButton));
    pathField.append(pickHint);
    const detail = el('div', { className: 'sheet-detail', 'data-role': 'install-detail' });
    const options = {
      title: '從資料夾安裝', body: [pathField, detail], primaryLabel: '預檢', busyLabel: '檢查中…',
      validate: () => !ctx.picking && (ctx.phase !== 'path' && ctx.phase !== 'failed' ? true : pathInput.value.trim() !== ''),
      onPrimary: (h) => (ctx.phase === 'result' ? undefined : ctx.phase === 'confirm' ? apply(h) : precheck(h)),
      onClose: () => {
        ctx.closed = true;
        $('sheet-cancel').removeEventListener('click', onCancelClick);
        $('sheet-primary').classList.remove('hidden'); $('sheet-cancel').classList.remove('hidden');
        RC.clearSecrets(ctx.inputs);
        return discard(takePlan()); // 沒有套用的計畫一律丟棄（暫存的打包產物也一併刪除）
      }
    };
    const handle = RC.openSheet(options);
    const onCancelClick = () => { if (ctx.running) cancelInstall(); };
    $('sheet-cancel').addEventListener('click', onCancelClick);

    const takePlan = () => { const id = ctx.planId; ctx.planId = null; return id; };
    const setHint = (text) => { pickHint.textContent = text || ''; pickHint.classList.toggle('hidden', !text); };
    const show = (nodes, { label, primary = true, cancelLabel = '取消', cancelHidden = false } = {}) => {
      detail.replaceChildren(...nodes.filter(Boolean));
      handle.setPrimary({ ...(label ? { label } : {}), hidden: !primary }); // 隱藏狀態交給 sheet.js 的 renderPrimary，避免 refresh 時被還原
      handle.el.cancel.classList.toggle('hidden', cancelHidden);
      handle.el.cancel.textContent = cancelLabel;
      handle.refresh();
    };
    const subtitleOf = (r) => (r?.summary?.name || r?.packageKey) && (r.summary?.version || r.version) ? `${r.summary?.name || r.packageKey} · 開發中 ${r.summary?.version || r.version}` : '';

    /** 回到只有路徑列的狀態（路徑被改動、計畫已失效）。 */
    const backToPath = () => {
      discard(takePlan());
      RC.clearSecrets(ctx.inputs); ctx.inputs = new Map();
      Object.assign(ctx, { phase: 'path', response: null, replanned: false });
      options.busyLabel = '檢查中…';
      handle.setSubtitle('');
      show([], { label: '預檢' });
    };

    function showFailure(r) {
      ctx.phase = 'failed';
      handle.setSubtitle(''); // 預檢沒過，名稱與版號都還不算確定
      show([failureList(r.blocking || []), disclosureBox(r.disclosures)], { label: '重新檢查' });
    }

    function showConfirm(r) {
      const plan = r.plan || {}, allBlocked = r.allBlocked === true;
      ctx.response = r; ctx.planId = r.planId ?? null; ctx.key = r.packageKey; ctx.inputs = new Map();
      ctx.phase = allBlocked ? 'blocked' : 'confirm';
      handle.setSubtitle(subtitleOf(r));
      const params = !allBlocked ? plan.missingParameters || [] : [];
      show([
        ctx.replanned ? el('div', { className: 'notice', 'data-role': 'replanned', textContent: '本機狀態已改變，以下是重新規劃後的內容，請再確認一次。' }) : null,
        okLine(allBlocked ? [] : r.tools),
        disclosureBox(r.disclosures),
        r.replacesMarketVersion ? el('div', { className: 'notice', 'data-role': 'replaces-market', textContent: `將以開發中版本 ${r.version} 取代已安裝的市集版 ${r.replacesMarketVersion}；之後可在資源中心改用市集版。` }) : null,
        ...params.map(p => RC.paramField(p, ctx.inputs)),
        !allBlocked && plan.setupCommands?.length ? RC.commandSection(plan.setupCommands, { heading: '安裝時會執行', joiner: ' · ' }) : null,
        plan.blockedTargets?.length ? RC.blockedSection(plan, '安裝', allBlocked) : null
      ], allBlocked ? { primary: false, cancelLabel: '關閉' } : { label: '安裝' });
      options.busyLabel = '安裝中…';
    }

    /** 預檢（失敗時列出阻擋項，通過時顯示摘要）；丟出的錯誤由 sheet 顯示。 */
    async function precheck(h) {
      const typed = pathInput.value.trim().replace(/^"(.*)"$/, '$1').trim();
      if (typed !== pathInput.value) pathInput.value = typed;
      await discard(takePlan());
      ctx.replanned = false;
      options.busyLabel = '檢查中…';
      const r = ctx.reinstallKey ? await call('rc.dev.reinstallLocal', { packageKey: ctx.reinstallKey }, PREPARE_TIMEOUT_MS)
        : await call('rc.dev.install.prepare', { folder: typed }, PREPARE_TIMEOUT_MS);
      if (ctx.closed) { await discard(r?.planId); return false; }
      if (r?.precheckFailed) showFailure(r); else showConfirm(r);
      return false;
    }

    /** 按「安裝」：儲存參數 → 帶 confirmedPlanId 執行 → 顯示結果；重新規劃後仍有例外時換成新的確認內容。 */
    async function apply(h) {
      const r = ctx.response, plan = r.plan || {}, key = ctx.key;
      if (state.running.has(key)) throw new Error('這個資源包正在處理其他操作，請稍後再試');
      let saved = false;
      if (plan.missingParameters?.length) {
        const { values, secrets, error } = RC.collectSetup(plan.missingParameters, ctx.inputs);
        if (error) { h.setError(error); return false; }
        try {
          await call('rc.install.saveSetup', { packageKey: key, planId: ctx.planId, values, secrets }, SAVE_TIMEOUT_MS);
          saved = true;
        } catch (e) {
          if (e?.code === 'plan_stale') { ctx.planId = null; backToPath(); }
          throw e;
        } finally {
          RC.clearSecrets(ctx.inputs);
        }
      }
      ctx.running = true; RC.setRunning(key, 'install');
      handle.el.cancel.disabled = false; handle.el.cancel.textContent = '取消安裝'; // 執行中這顆按鈕改為取消進行中的安裝（設定命令可能執行很久）
      let response;
      try {
        const input = { packageKey: key, action: 'install' };
        response = await call('rc.install.run', { ...input, confirmedPlanId: ctx.planId }, RC.runTimeout(plan));
        if (saved && RC.sameApproval(r, response)) response = await call('rc.install.run', { ...input, confirmedPlanId: response.planId }, RC.runTimeout(response.plan));
      } catch (e) {
        ctx.running = false; RC.setRunning(key, null);
        if (!ctx.closed) { ctx.planId = null; backToPath(); }
        throw e;
      }
      ctx.running = false;
      if (ctx.closed) { RC.setRunning(key, null); return false; }
      if (response?.needsConfirmation || response?.allBlocked) {
        // 確認時本機狀態已變動且重新規劃後仍有例外：更新內容再確認一次
        RC.setRunning(key, null);
        ctx.replanned = true;
        showConfirm(response);
        return false;
      }
      ctx.planId = null; ctx.phase = 'result';
      handle.setSubtitle(subtitleOf(r));
      show(resultNodes(response), { label: '完成', cancelHidden: true });
      refreshAfterInstall(key); // 背景重新讀取；結果已在 sheet 上，不讓按鈕停在「安裝中…」
      return false;
    }

    async function cancelInstall() {
      if (!ctx.key) return;
      handle.el.cancel.disabled = true;
      await RC.requestCancel(ctx.key);
      if (ctx.running && !state.cancelRequested.has(ctx.key)) handle.el.cancel.disabled = false;
    }

    // 路徑改動：已預檢過的計畫作廢，回到只有路徑列的狀態（之後的重新預檢改走一般的資料夾預檢）
    // 和打包上傳的 sheet 一致：在路徑欄按 Enter 直接預檢
    pathInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault?.();
      if (!ctx.running && !ctx.picking && (ctx.phase === 'path' || ctx.phase === 'failed')) RC.sheetPrimary();
    });
    pathInput.addEventListener('input', () => {
      ctx.reinstallKey = null;
      if (ctx.phase !== 'path' && !ctx.running) backToPath();
    });

    pickButton.addEventListener('click', async () => {
      if (ctx.picking || ctx.running) return;
      ctx.picking = true; pickButton.disabled = true; setHint(PICK_HINT); handle.refresh();
      let picked;
      try {
        picked = await call('rc.dev.pickFolder', pathInput.value.trim() ? { initialPath: pathInput.value.trim() } : {}, PICK_TIMEOUT_MS);
      } catch (e) {
        if (RC.sessionLost(e)) return RC.load();
        if (!ctx.closed) setHint(RC.messageOf(e));
        return;
      } finally {
        ctx.picking = false; pickButton.disabled = false;
        if (!ctx.closed) handle.refresh();
      }
      if (ctx.closed) return;
      if (picked?.unavailable) return setHint(PICK_UNAVAILABLE);
      setHint('');
      if (!picked?.path) return;
      pathInput.value = picked.path;
      ctx.reinstallKey = null;
      if (ctx.phase !== 'path') backToPath();
      handle.refresh();
      RC.sheetPrimary(); // 選好資料夾就直接預檢
    });

    if (prepared) { if (prepared.precheckFailed) showFailure(prepared); else showConfirm(prepared); }
    else if (!folder) {
      // 預設帶入上次從資料夾安裝的資料夾（使用者已開始輸入就不覆蓋）
      call('rc.dev.install.lastFolder', {}).then(result => {
        if (ctx.closed || pathInput.value || typeof result?.folder !== 'string' || !result.folder) return;
        pathInput.value = result.folder; handle.refresh();
      }).catch(() => {});
    }
    return handle;
  }

  /** 套用後：重新讀取本機開發中區塊與資源中心的狀態與可更新數量，再放開該資源包的執行中狀態。 */
  async function refreshAfterInstall(key) {
    try {
      await Promise.all([RC.loadLocalPackages(), RC.loadCatalog({ keepList: true, useLastSearch: true })]);
    } finally {
      RC.setRunning(key, null);
    }
    RC.syncUpdates(true);
  }

  RC.openInstallFromFolder = function openInstallFromFolder() {
    if (RC.confirmOpen()) return;
    return openInstallSheet();
  };
})();
