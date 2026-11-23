// 一鍵安裝、更新、補裝（ADR-0003）：按下即套用，只在例外時顯示確認層（confirm.js）。
// 本檔負責主要按鈕、執行中與取消、結果短提示、失敗提示與失敗清單（含重試），以及操作後重新讀取狀態。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { el, call, state } = RC;

  // 動作名稱對應 rc.install.run 的 action；dataAction 是卡片與明細狀態列按鈕的 data-action。
  RC.ACTIONS = {
    install: { dataAction: 'install', label: '安裝', running: '安裝中…', done: n => `已安裝到 ${n} 個位置` },
    update: { dataAction: 'update', label: '更新', running: '更新中…', done: n => `已更新 ${n} 個位置` },
    fillPending: { dataAction: 'fill-pending', label: '補裝', running: '補裝中…', done: n => `已補裝到 ${n} 個位置` },
    retry: { label: '重試', running: '重試中…', done: n => `已重新安裝到 ${n} 個位置` },
    reapply: { label: '重新套用', running: '套用中…', done: n => `已重新套用到 ${n} 個位置` },
    uninstall: { dataAction: 'uninstall', label: '解除安裝', running: '解除安裝中…', done: n => `已從 ${n} 個位置解除安裝` },
    detach: { label: '停止管理', running: '處理中…', done: n => `已停止管理 ${n} 個位置，檔案保留在原處` }
  };
  const { ACTIONS } = RC;
  // 一鍵操作含下載與多個根目錄的部署；有設定命令時再加上各命令宣告的逾時（見 confirm.js）。
  RC.RUN_TIMEOUT_MS = 300000;
  const CANCELLED_REASON = '已取消設定，尚未完成安裝'; // worker 對被取消目標回報的原因
  const openFailures = new Set(); // 失敗清單已展開的資源包（卡片與明細共用）
  const openSkipped = new Set(); // 略過清單已展開的資源包（卡片與明細共用）
  const detachedNotes = new Map(); // 停止管理後留在原處的路徑（packageKey → detached[]），使用者按「知道了」才收起

  const failureCount = (p) => p?.lastFailure?.targets?.length || 0;
  const skippedCount = (p) => p?.lastSkipped?.targets?.length || 0;

  /** 狀態列右側的主要動作：未安裝→安裝、可更新→更新（一併補齊待補裝目標）、只有待補裝目標→補裝；其餘不顯示。 */
  function mainAction(p) {
    if (p.installedError) return null;
    if (RC.installState(p).dev) return RC.pendingCount(p) > 0 ? 'fillPending' : null; // 開發中版本只補裝；改用市集版另有按鈕（devActions）
    const { status } = RC.installState(p);
    if (status === 'notInstalled') return 'install';
    if (status === 'updateAvailable') return 'update';
    if ((status === 'current' || status === 'newer') && RC.pendingCount(p) > 0) return 'fillPending';
    return null;
  }

  /** 全域部署（Orca 只管理全域部署）；解除安裝的位置數與確認層的位置清單都以它為準。 */
  RC.globalDeployments = (p) => (p?.deployments || []).filter(d => d.scope !== 'project');

  /** 已安裝（有任何全域部署：最新、較新、可更新、已下架，或有待補裝目標）才能解除安裝。 */
  function canUninstall(p) {
    if (p.installedError || RC.installState(p).status === 'notInstalled') return false;
    return RC.globalDeployments(p).length > 0 || RC.pendingCount(p) > 0;
  }

  /** 紅色次要按鈕：開確認層，不直接執行；執行中停用並顯示「解除安裝中…」。 */
  function uninstallButton(p, busy) {
    const button = el('button', { type: 'button', className: 'btn btn-action btn-danger-outline', 'data-action': 'uninstall',
      textContent: busy ? ACTIONS.uninstall.running : ACTIONS.uninstall.label, disabled: busy || RC.confirmOpen() });
    button.addEventListener('click', () => RC.startUninstall(p.packageKey));
    return button;
  }

  /**
   * 開發中版本（從資料夾安裝）的按鈕：待補裝時「補裝」（主要；來源資料夾不存在時停用並以 title 說明）、
   * 市集有此資源包時「改用市集版」（一般安裝推薦版本，覆蓋後收據回到市集語意）、再接「解除安裝」。
   */
  function devActions(p) {
    const fill = RC.pendingCount(p) > 0 ? el('button', { type: 'button', className: 'btn btn-action btn-primary', 'data-action': ACTIONS.fillPending.dataAction, textContent: ACTIONS.fillPending.label,
      disabled: RC.confirmOpen() || Boolean(p.fillUnavailableReason), ...(p.fillUnavailableReason ? { title: p.fillUnavailableReason } : {}) }) : null;
    fill?.addEventListener('click', () => RC.startAction(p.packageKey, 'fillPending'));
    const sw = p.canSwitchToMarket === true ? el('button', { type: 'button', className: 'btn btn-action', 'data-action': 'switch-market', textContent: '改用市集版', disabled: RC.confirmOpen() }) : null;
    sw?.addEventListener('click', () => RC.startAction(p.packageKey, 'install'));
    return [fill, sw, canUninstall(p) ? uninstallButton(p, false) : null];
  }

  RC.actionButton = function actionButton(p) {
    const action = mainAction(p);
    const busy = state.running.get(p.packageKey);
    if (!busy && !p.installedError && RC.installState(p).dev) return devActions(p);
    if (busy === 'uninstall') return uninstallButton(p, true); // 解除安裝不執行命令，不提供取消
    if (busy === 'detach') return el('button', { type: 'button', className: 'btn btn-action', 'data-action': 'running', textContent: ACTIONS.detach.running, disabled: true }); // 只刪安裝紀錄，同樣不提供取消
    if (!action && !busy) return canUninstall(p) ? uninstallButton(p, false) : null;
    const spec = ACTIONS[action] || {};
    const button = el('button', { type: 'button', className: `btn btn-action${busy ? '' : ' btn-primary'}`, 'data-action': spec.dataAction || 'running',
      textContent: busy ? ACTIONS[busy].running : spec.label, disabled: Boolean(busy) || RC.confirmOpen() });
    // 卡片上的按鈕只做安裝，不進入明細
    button.addEventListener('click', () => RC.startAction(p.packageKey, action));
    if (!busy) return [button, canUninstall(p) ? uninstallButton(p, false) : null];
    // 事先無法得知這次操作會不會執行設定命令，因此任何一鍵操作進行中都提供取消
    const cancel = el('button', { type: 'button', className: 'btn btn-action', 'data-action': 'cancel-install', textContent: '取消',
      title: '取消設定並停止這次安裝', disabled: state.cancelRequested.has(p.packageKey) });
    cancel.addEventListener('click', () => RC.requestCancel(p.packageKey));
    return [button, cancel];
  };

  /** 取消進行中的一鍵操作：送出後停用按鈕；請求失敗或目前沒有可取消的設定命令時恢復，讓使用者可再試。結果仍由原操作回報。 */
  RC.requestCancel = async function requestCancel(key) {
    if (!state.running.has(key) || state.cancelRequested.has(key)) return;
    state.cancelRequested.add(key); RC.rerenderPackage(key); RC.renderConfirmButtons();
    let accepted = false;
    try {
      accepted = (await call('rc.install.cancel', { packageKey: key }))?.cancelled === true;
    } catch (e) {
      if (!RC.sessionLost(e)) RC.toast(RC.messageOf(e), 'error');
    }
    if (!accepted && state.running.has(key)) { state.cancelRequested.delete(key); RC.rerenderPackage(key); RC.renderConfirmButtons(); }
  };

  // ---------- 失敗提示與失敗清單 ----------
  RC.failureBadge = function failureBadge(p) {
    const count = failureCount(p);
    if (!count) return null;
    const open = openFailures.has(p.packageKey);
    const badge = el('button', { type: 'button', className: 'failure-badge', 'data-role': 'failure', 'aria-expanded': String(open), title: open ? '收合失敗清單' : '查看失敗原因', textContent: `${count} 個位置失敗` });
    badge.addEventListener('click', () => { if (open) openFailures.delete(p.packageKey); else openFailures.add(p.packageKey); RC.rerenderPackage(p.packageKey); });
    return badge;
  };

  // ---------- 略過提示與略過清單（使用者在確認畫面已同意略過的受阻目標；中性、沒有重試） ----------
  RC.skippedBadge = function skippedBadge(p) {
    const count = skippedCount(p);
    if (!count) return null;
    const open = openSkipped.has(p.packageKey);
    const badge = el('button', { type: 'button', className: 'skipped-badge', 'data-role': 'skipped', 'aria-expanded': String(open), title: open ? '收合略過清單' : '查看略過的位置', textContent: `略過 ${count} 個位置` });
    badge.addEventListener('click', () => { if (open) openSkipped.delete(p.packageKey); else openSkipped.add(p.packageKey); RC.rerenderPackage(p.packageKey); });
    return badge;
  };

  RC.skippedList = function skippedList(p) {
    if (!skippedCount(p) || !openSkipped.has(p.packageKey)) return null;
    return el('div', { className: 'skipped-list', 'data-role': 'skipped-list' },
      el('ul', { className: 'location-list' }, ...p.lastSkipped.targets.map(t => RC.targetRow(t, 'skipped-target', '此位置已略過', { backups: true }))),
      el('div', { className: 'hint', 'data-role': 'skipped-note', textContent: '排除原因後，下次安裝、更新或補裝時會再嘗試。' }));
  };

  RC.backupFold = (paths) => el('details', { className: 'backup-fold', 'data-role': 'backups' }, el('summary', { textContent: `備份位置（${paths.length}）` }),
    ...paths.map(b => el('div', { className: 'location-path mono', textContent: b })));

  /** 失敗原因的「詳細紀錄」：worker 回傳的原始部署問題（已遮罩秘密），預設收合；原因文字會請使用者展開這裡查看。 */
  const detailFold = (detail) => el('details', { className: 'backup-fold', 'data-role': 'failure-detail' }, el('summary', { textContent: '詳細紀錄' }),
    ...detail.map(d => el('div', { className: 'location-path mono wrap', textContent: [d.summary, d.explanation].filter(Boolean).join('：') || d.code || '' })));

  /** 部署目標的一列（失敗清單與確認層的受阻目標共用）：工具圖示、友善名稱、根目錄、原因；backups 時另列備份位置與詳細紀錄。 */
  RC.targetRow = function targetRow(t, role, fallbackReason, { backups = false, actions = null } = {}) {
    const label = RC.toolLabel(t);
    return el('li', { className: 'location-row', 'data-role': role, 'data-target-id': t.targetId },
      RC.toolIcon({ hostId: t.hostId, label, deployed: true }, { desktopLabel: false, caption: label }),
      el('div', { className: 'location-body' }, el('strong', { textContent: label }), el('div', { className: 'location-path mono', textContent: t.rootPath || '' }),
        el('div', { className: 'failure-reason', textContent: t.reason || fallbackReason }),
        backups && Array.isArray(t.detail) && t.detail.length ? detailFold(t.detail) : null,
        backups && t.backupPaths?.length ? RC.backupFold(t.backupPaths) : null,
        actions));
  };

  /** 只有上一次解除安裝失敗的位置，才能改成「停止管理」（刪安裝紀錄、檔案保留）。 */
  const canDetach = (p) => p?.lastFailure?.action === 'uninstall';

  /** 失敗列上的次要按鈕：作用於該列位置；開確認層，不直接執行。 */
  function detachButton(p, t, busy) {
    const button = el('button', { type: 'button', className: 'btn btn-action btn-detach', 'data-action': 'detach', 'data-target-id': t.targetId,
      textContent: busy === 'detach' ? ACTIONS.detach.running : '停止管理此位置（保留檔案）', disabled: Boolean(busy) || RC.confirmOpen() });
    button.addEventListener('click', () => RC.startDetach(p.packageKey, t.targetId));
    return button;
  }

  /** 失敗的精簡清單：每個失敗的部署目標一列（解除安裝失敗時附「停止管理此位置（保留檔案）」），附「重試失敗項目」。 */
  RC.failureList = function failureList(p) {
    if (!failureCount(p) || !openFailures.has(p.packageKey)) return null;
    const busy = state.running.get(p.packageKey);
    const retry = el('button', { type: 'button', className: 'btn btn-block', 'data-action': 'retry', textContent: busy === 'retry' ? ACTIONS.retry.running : '重試失敗項目', disabled: Boolean(busy) || RC.confirmOpen() });
    retry.addEventListener('click', () => RC.startAction(p.packageKey, 'retry', { targetIds: p.lastFailure.targets.map(t => t.targetId) }));
    return el('div', { className: 'failure-list', 'data-role': 'failure-list' },
      el('ul', { className: 'location-list' }, ...p.lastFailure.targets.map(t => RC.targetRow(t, 'failure-target', '此位置未完成部署',
        { backups: true, actions: canDetach(p) ? el('div', { className: 'failure-actions' }, detachButton(p, t, busy)) : null }))), retry);
  };

  /** 停止管理完成後：留在原處、需要使用者自行處理的路徑（每個位置一列）；沒有路徑時不顯示。 */
  RC.detachedNote = function detachedNote(p) {
    const list = (detachedNotes.get(p.packageKey) || []).filter(d => d.keptPaths?.length);
    if (!list.length) return null;
    const dismiss = el('button', { type: 'button', className: 'btn btn-action', 'data-action': 'dismiss-detached', textContent: '知道了' });
    dismiss.addEventListener('click', () => { detachedNotes.delete(p.packageKey); RC.rerenderPackage(p.packageKey); });
    return el('div', { className: 'detached-note', 'data-role': 'detached-note' },
      el('div', { className: 'detached-title', textContent: '已停止管理，下列內容留在原處，需要你自行刪除：' }),
      el('ul', { className: 'location-list' }, ...list.map(d => {
        const label = RC.toolLabel(d);
        return el('li', { className: 'location-row', 'data-role': 'detached-target', 'data-target-id': d.targetId },
          RC.toolIcon({ hostId: d.hostId, label, deployed: true }, { desktopLabel: false, caption: label }),
          el('div', { className: 'location-body' }, el('strong', { textContent: label }), el('div', { className: 'location-path mono', textContent: d.rootPath || '' }),
            ...d.keptPaths.map(k => el('div', { className: 'location-path mono', 'data-role': 'kept-path', textContent: k }))));
      })), dismiss);
  };

  // ---------- 執行 ----------
  RC.setRunning = function setRunning(key, action) {
    if (action) state.running.set(key, action); else { state.running.delete(key); state.cancelRequested.delete(key); }
    RC.rerenderPackage(key);
  };

  /** 解除安裝一律先確認；確認層見 confirm.js。 */
  RC.startUninstall = function startUninstall(key) {
    const p = RC.packageOf(key);
    if (!p || state.running.has(key) || RC.confirmOpen()) return;
    RC.openConfirm({ key, action: 'uninstall', extra: {}, response: { uninstall: true, deployments: RC.globalDeployments(p) } });
  };

  /** 停止管理一律先確認（只允許上一次解除安裝失敗的位置）；確認層見 confirm.js。 */
  RC.startDetach = function startDetach(key, targetId) {
    const p = RC.packageOf(key);
    const target = canDetach(p) ? p.lastFailure.targets.find(t => t.targetId === targetId) : null;
    if (!target || state.running.has(key) || RC.confirmOpen()) return;
    RC.openConfirm({ key, action: 'detach', extra: { targetIds: [target.targetId] }, response: { detach: true, targets: [target] } });
  };

  /** 確認後執行：只刪安裝紀錄；提示數量並記下留在原處的路徑，再重新讀取狀態。 */
  RC.runDetach = async function runDetach(key, targetIds) {
    if (state.running.has(key)) return;
    RC.setRunning(key, 'detach');
    let result;
    try {
      result = await call('rc.install.run', { packageKey: key, action: 'detach', targetIds }, RC.RUN_TIMEOUT_MS);
    } catch (e) {
      RC.setRunning(key, null);
      RC.actionFailed(e);
      if (!RC.sessionLost(e)) await RC.refreshPackage(key);
      return;
    }
    const detached = Array.isArray(result?.detached) ? result.detached : [];
    const failed = result?.failed?.length || 0;
    if (detached.length) detachedNotes.set(key, [...(detachedNotes.get(key) || []).filter(d => !detached.some(n => n.targetId === d.targetId)), ...detached]);
    if (failed) { openFailures.add(key); RC.toast(`${detached.length ? `${ACTIONS.detach.done(detached.length)}，` : ''}${failed} 個位置失敗`, 'error'); }
    else RC.toast(detached.length ? ACTIONS.detach.done(detached.length) : '沒有需要處理的位置');
    try { await refreshPackage(key); } finally { RC.setRunning(key, null); }
  };

  /** 登出或換帳號後清掉留下的提示。 */
  RC.clearDetachedNotes = () => { detachedNotes.clear(); };

  /** 確認後執行：不再有第二次確認（worker 不會回 needsConfirmation）；失敗（含找不到安裝紀錄）顯示原因並重新整理狀態。 */
  RC.runUninstall = async function runUninstall(key) {
    if (state.running.has(key)) return;
    RC.setRunning(key, 'uninstall');
    let response;
    try {
      response = await call('rc.install.run', { packageKey: key, action: 'uninstall' }, RC.RUN_TIMEOUT_MS);
    } catch (e) {
      RC.setRunning(key, null);
      RC.actionFailed(e);
      if (!RC.sessionLost(e)) await RC.refreshPackage(key);
      return;
    }
    return RC.finishRun(key, 'uninstall', response);
  };

  RC.startAction = async function startAction(key, action, extra = {}) {
    if (!action || !ACTIONS[action] || state.running.has(key) || RC.confirmOpen()) return;
    RC.setRunning(key, action);
    let response;
    try {
      response = await call('rc.install.run', { packageKey: key, action, ...extra }, RC.RUN_TIMEOUT_MS);
    } catch (e) {
      RC.setRunning(key, null);
      return RC.actionFailed(e);
    }
    if (response?.needsConfirmation || response?.allBlocked) {
      RC.setRunning(key, null);
      return RC.openConfirm({ key, action, extra, response });
    }
    return RC.finishRun(key, action, response);
  };

  /** 結果：全部成功顯示短提示；略過（使用者已在確認畫面同意）用中性提示；有失敗時提示數量（失敗優先）並展開失敗清單。再重新讀取該資源包的狀態。 */
  RC.finishRun = async function finishRun(key, action, result) {
    const succeeded = result?.succeeded?.length || 0, failed = result?.failed?.length || 0, skipped = result?.skipped?.length || 0;
    // 重試上一次失敗的解除安裝：成功提示沿用解除安裝的說法
    const spec = action === 'retry' && RC.packageOf(key)?.lastFailure?.action === 'uninstall' ? ACTIONS.uninstall : ACTIONS[action];
    const backedUp = action === 'uninstall' || spec === ACTIONS.uninstall ? result?.backups?.length || 0 : 0;
    const warnings = (result?.warnings ?? []).map(warning => [warning.summary, warning.path].filter(Boolean).join(' '));
    const note = (backedUp ? `，已備份 ${backedUp} 個修改過的檔案` : '') + (warnings.length ? `\n${warnings.join('\n')}` : '');
    const skipNote = skipped ? `略過 ${skipped} 個位置` : '';
    if (failed && !succeeded && result.failed.every(t => t.reason === CANCELLED_REASON)) {
      // 使用者主動取消：中性提示；目標仍列在失敗清單，可「重試失敗項目」
      openFailures.add(key);
      RC.toast('已取消安裝', 'info');
    } else if (failed) {
      openFailures.add(key);
      RC.toast(`${succeeded ? `${spec.done(succeeded)}，` : ''}${failed} 個位置失敗${skipNote ? `，${skipNote}` : ''}${note}`, 'error');
    } else {
      openFailures.delete(key);
      if (skipped) RC.toast(`${succeeded ? `${spec.done(succeeded)}，` : ''}${skipNote}${note}`, 'info');
      else RC.toast(succeeded ? `${spec.done(succeeded)}${note}` : action === 'reapply' ? '設定已儲存' : '沒有需要處理的位置');
    }
    try { await refreshPackage(key); } finally { RC.setRunning(key, null); }
    RC.syncUpdates(true); // 安裝、更新後可更新數量會改變；只重新計算，不自動更新任何資源包
  };

  RC.refreshPackage = refreshPackage;
  async function refreshPackage(key) {
    const tasks = [];
    if (state.currentPackage?.packageKey === key && RC.isShown('details')) tasks.push(RC.reloadDetails());
    if (RC.isShown('main')) tasks.push(RC.loadCatalog({ keepList: true }));
    if (RC.isShown('developer')) tasks.push(RC.loadLocalPackages?.());
    await Promise.all(tasks);
  }
})();
