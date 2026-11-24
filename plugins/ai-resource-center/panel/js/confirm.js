// 一鍵操作的例外確認層：缺少參數、設定命令、受阻目標；只有一個主要按鈕與取消。
// 確認後帶 confirmedPlanId 執行；執行中這顆取消鈕改為取消進行中的安裝。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, el, call, state } = RC;

  // 設定命令執行或略過的理由（對照 PlanRenderer.DescribeReason）
  const REASON_LABELS = { FirstRun: '第一次執行', PreviousFailure: '上一次執行沒有成功，這次重試', ScriptChanged: '腳本內容與上次成功時不同', Reconfigure: '重新套用設定',
    UpdateRunOnUpdate: '版本改變且作者宣告更新時執行', SkippedAlreadySucceeded: '同版本且上次已成功', SkippedUpdateWithoutRunOnUpdate: '版本改變但作者未宣告更新時執行' };
  const BORROWED_NOTICE = '此命令是為 macOS 撰寫，將在 Linux 以 bash 執行。'; // Linux 借用 macOS 命令（planning.mjs 的 borrowedFromOs）
  const ELIGIBILITY_LABELS = { UnsupportedOperatingSystem: '不適用於本機作業系統', UnsupportedArchitecture: '不適用於本機處理器架構' };

  let confirmState = null; // { key, action, extra, response, inputs, replanned, busy, running }
  RC.confirmOpen = () => Boolean(confirmState);

  const commandLine = (c, joiner = ' ') => `${c.runner}${joiner}${c.script}${c.arguments?.length ? ` ${c.arguments.join(' ')}` : ''}`;
  const commandKey = (list) => JSON.stringify((list || []).map(c => [c.commandId, c.willExecute === true, c.runner, c.script]));
  const conflictKey = ({ contentId, ownerPackageKey, ownerContentId }) => JSON.stringify([contentId, ownerPackageKey, ownerContentId]);
  const blockedKey = (list) => JSON.stringify((list || []).map(b => [b.targetId, b.reason, b.otherReason, b.conflicts?.map(conflictKey).sort()]));
  /** 儲存參數必然改變計畫；若重新規劃後只剩剛才已確認過的同一批命令與受阻目標，不再重複詢問。 */
  const sameApproval = (before, after) => after?.needsConfirmation === true && !(after.reasons || []).includes('missingParameters')
    && (after.reasons || []).every(r => (before.reasons || []).includes(r))
    && commandKey(before.plan?.setupCommands) === commandKey(after.plan?.setupCommands)
    && blockedKey(before.plan?.blockedTargets) === blockedKey(after.plan?.blockedTargets)
    && (!after.plan?.blockedTargets?.length || before.plan?.deployableCount === after.plan.deployableCount);
  const runTimeout = (plan) => RC.RUN_TIMEOUT_MS + (plan?.setupCommands || []).filter(c => c.willExecute).reduce((sum, c) => sum + (c.timeoutMinutes || 0), 0) * 60000;

  // ---------- 內容 ----------
  function confirmSection(name, heading, ...children) {
    return el('section', { className: 'confirm-section', 'data-section': name }, el('div', { className: 'confirm-heading', textContent: heading }), ...children);
  }

  /** 設定命令清單（例外確認層與從資料夾安裝的 sheet 共用）；heading／joiner 供 sheet 沿用草圖的「安裝時會執行」與「runner · 腳本」寫法。 */
  function commandSection(commands, { heading, joiner = ' ' } = {}) {
    const run = commands.filter(c => c.willExecute), skipped = commands.filter(c => !c.willExecute);
    return confirmSection('setupCommands', run.length ? heading || `將先執行 ${run.length} 個設定命令` : '設定命令（這次不執行）',
      run.length ? el('div', { className: 'hint', textContent: '命令由資源包作者提供，會在你的電腦上依序執行；任何一項失敗就不安裝。' }) : null,
      ...run.flatMap(c => [el('div', { className: 'confirm-item', 'data-role': 'setup-command', 'data-command-id': c.commandId },
        el('strong', { textContent: c.name || c.commandId }),
        el('div', { className: 'location-path mono', textContent: commandLine(c, joiner) }),
        c.timeoutMinutes ? el('div', { className: 'hint', textContent: `最長執行 ${c.timeoutMinutes} 分鐘` }) : null),
        c.borrowedFromOs === 'macos' ? el('div', { className: 'notice', 'data-role': 'borrowed-command-notice', textContent: BORROWED_NOTICE }) : null]),
      skipped.length ? el('details', { className: 'backup-fold' }, el('summary', { textContent: `略過 ${skipped.length} 個命令` }),
        ...skipped.map(c => el('div', { className: 'confirm-item', 'data-role': 'skipped-command' },
          el('div', { textContent: `${c.name || c.commandId}：${ELIGIBILITY_LABELS[c.eligibility] || REASON_LABELS[c.reason] || '這次不需要執行'}` }),
          el('div', { className: 'location-path mono', textContent: commandLine(c) })))) : null);
  }

  /** 受阻目標清單（例外確認層與從資料夾安裝的 sheet 共用）。 */
  function blockedSection(plan, label, allBlocked) {
    const blocked = plan.blockedTargets || [];
    const groups = new Map(), other = [];
    for (const target of blocked) {
      for (const conflict of target.conflicts || []) {
        const key = conflictKey(conflict);
        if (!groups.has(key)) groups.set(key, { ...conflict, targets: new Map() });
        groups.get(key).targets.set(target.targetId, target);
      }
      if (!target.conflicts?.length) other.push(target);
      else if (target.otherReason) other.push({ ...target, reason: target.otherReason });
    }
    const count = new Set(blocked.map(t => t.targetId)).size;
    const tools = new Set(blocked.map(RC.toolLabel));
    const tool = groups.size && tools.size === 1 ? `${[...tools][0]} · ` : '';
    const rest = Number.isFinite(plan.deployableCount) ? plan.deployableCount : 0;
    return confirmSection('blockedTargets', `${tool}${count} 個位置無法${label}`,
      ...[...groups.values()].map(group => conflictGroup(group, tools.size > 1)),
      other.length ? el('ul', { className: 'location-list' }, ...other.map(t => RC.targetRow(t, 'blocked-target', '此位置受阻'))) : null,
      !allBlocked && rest > 0 ? el('div', { 'data-role': 'deployable', textContent: `其餘 ${rest} 個位置仍會${label}。` }) : null);
  }

  function conflictGroup({ contentId, ownerPackageKey, ownerContentId, targets }, showTools) {
    const code = value => el('code', { className: 'mono', textContent: value });
    const span = value => el('span', { textContent: value });
    const differentOwnerId = ownerContentId && contentId !== ownerContentId;
    return el('div', { className: 'confirm-conflict', 'data-role': 'content-conflict', 'data-content-id': contentId },
      el('strong', {}, span('內容 ID '), code(contentId), span(' 衝突')),
      el('div', {}, span('資源包 '), code(ownerPackageKey), span(differentOwnerId ? ' 的內容 ' : ' 已安裝相同 ID 的內容。'),
        differentOwnerId ? code(ownerContentId) : null, differentOwnerId ? span(' 已占用安裝路徑。') : null),
      el('ul', { className: 'location-list', 'aria-label': '受影響的位置' }, ...[...targets.values()].map(t =>
        el('li', { 'data-role': 'blocked-target', 'data-target-id': t.targetId },
          showTools ? el('span', { textContent: `${RC.toolLabel(t)} · ` }) : null,
          el('code', { className: 'location-path mono', textContent: t.rootPath || RC.toolLabel(t) })))));
  }

  RC.installConfirmLabel = plan => plan?.blockedTargets?.length && plan.deployableCount > 0
    ? `安裝到其餘 ${plan.deployableCount} 個位置` : '安裝';
  RC.commandSection = commandSection;
  RC.blockedSection = blockedSection;
  /** 儲存參數後重新規劃，若只剩剛才已確認過的同一批命令與受阻目標則不再詢問（確認層與 sheet 共用）。 */
  RC.sameApproval = sameApproval;
  RC.runTimeout = runTimeout;

  /** 解除安裝的確認內容：將移除的位置（工具圖示、友善名稱、根目錄）與備份、保留說明。 */
  function uninstallSection(deployments) {
    return confirmSection('uninstallTargets', `將從 ${deployments.length} 個位置移除`,
      el('ul', { className: 'location-list' }, ...deployments.map(d => {
        const label = RC.toolLabel(d);
        return el('li', { className: 'location-row', 'data-role': 'removal-target', 'data-target-id': d.id },
          RC.toolIcon({ hostId: RC.toolId(d), label, deployed: true }, { desktopLabel: false, caption: label }),
          el('div', { className: 'location-body' }, el('strong', { textContent: label }), el('div', { className: 'location-path mono', textContent: d.rootPath || '' })));
      })),
      el('div', { className: 'hint', 'data-role': 'uninstall-note', textContent: '你在安裝後修改過的檔案會先備份再移除。設定參數會保留，重新安裝可直接沿用。' }));
  }

  function renderUninstall() {
    const st = confirmState;
    const p = RC.packageOf(st.key);
    $('confirm-title').replaceChildren(el('strong', { className: 'wrap', textContent: `解除安裝 ${p?.name || st.key}？` }));
    $('confirm-body').replaceChildren(uninstallSection(st.response.deployments || []));
    RC.renderConfirmButtons();
  }

  /** 停止管理的確認內容：位置（工具圖示、友善名稱、根目錄）與「刪紀錄、不刪檔」說明；留在原處的路徑在完成後的結果列出。 */
  function renderDetach() {
    const st = confirmState;
    $('confirm-title').replaceChildren(el('strong', { className: 'wrap', textContent: '停止管理這個位置？' }));
    $('confirm-body').replaceChildren(confirmSection('detachTargets', '位置',
      el('ul', { className: 'location-list' }, ...(st.response.targets || []).map(t => {
        const label = RC.toolLabel(t);
        return el('li', { className: 'location-row', 'data-role': 'detach-target', 'data-target-id': t.targetId },
          RC.toolIcon({ hostId: t.hostId, label, deployed: true }, { desktopLabel: false, caption: label }),
          el('div', { className: 'location-body' }, el('strong', { textContent: label }), el('div', { className: 'location-path mono', textContent: t.rootPath || '' })));
      })),
      el('div', { className: 'hint', 'data-role': 'detach-note', textContent: '資源中心會刪除這個位置的安裝紀錄，但不會刪除任何檔案或設定。留在原處的內容需要你自行刪除：' }),
      el('div', { className: 'hint', 'data-role': 'detach-kept-later', textContent: '完成後會在結果中列出留在原處的路徑。' })));
    RC.renderConfirmButtons();
  }

  function renderConfirm() {
    const st = confirmState;
    if (!st) return;
    if (st.response.uninstall) return renderUninstall();
    if (st.response.detach) return renderDetach();
    const { response } = st;
    const plan = response.plan || {};
    const spec = RC.ACTIONS[st.action];
    const allBlocked = response.allBlocked === true;
    const p = RC.packageOf(st.key);
    $('confirm-title').replaceChildren(el('strong', { textContent: allBlocked ? `無法${spec.label}` : `確認${spec.label}` }),
      el('span', { className: 'confirm-name wrap', textContent: p?.name || st.key }));
    $('confirm-body').replaceChildren(...[
      st.replanned ? el('div', { className: 'notice', 'data-role': 'replanned', textContent: '本機狀態已改變，以下是重新規劃後的內容，請再確認一次。' }) : null,
      !allBlocked && plan.missingParameters?.length ? confirmSection('missingParameters', '需要設定參數',
        el('div', { className: 'hint', textContent: '設定儲存在這台電腦的共用設定檔；秘密只存入作業系統的安全儲存區。' }),
        ...plan.missingParameters.map(param => RC.paramField(param, st.inputs))) : null,
      !allBlocked && plan.setupCommands?.length ? commandSection(plan.setupCommands) : null,
      plan.blockedTargets?.length ? blockedSection(plan, spec.label, allBlocked) : null].filter(Boolean));
    RC.renderConfirmButtons();
  }

  RC.renderConfirmButtons = function renderConfirmButtons() {
    const st = confirmState;
    if (!st) return;
    const spec = RC.ACTIONS[st.action];
    const allBlocked = st.response.allBlocked === true;
    const danger = st.response.uninstall === true; // 解除安裝：紅色主要按鈕
    $('confirm-primary').classList.toggle('btn-primary', !danger);
    $('confirm-primary').classList.toggle('btn-danger', danger);
    $('confirm-primary').classList.toggle('hidden', allBlocked);
    $('confirm-primary').textContent = st.busy ? spec.running
      : st.action === 'install' ? RC.installConfirmLabel(st.response.plan) : spec.label;
    $('confirm-primary').disabled = st.busy;
    // 確認後正在執行時，這顆按鈕改為取消進行中的安裝（儲存參數階段仍不可取消）
    const cancellable = st.busy && st.running === true;
    $('confirm-cancel').textContent = cancellable ? '取消安裝' : allBlocked ? '關閉' : '取消';
    $('confirm-cancel').disabled = cancellable ? state.cancelRequested.has(st.key) : st.busy;
  };

  // ---------- 開合 ----------
  RC.openConfirm = function openConfirm(next) {
    confirmState = { ...next, inputs: new Map(), replanned: false, busy: false };
    RC.setText('confirm-error', '');
    renderConfirm();
    $('confirm-layer').classList.remove('hidden');
    RC.rerenderPackage(next.key);
    // 解除安裝、停止管理與全部受阻時，焦點先放在較安全的取消鈕
    (next.response.allBlocked || next.response.uninstall || next.response.detach ?$('confirm-cancel') : $('confirm-primary')).focus();
  };

  /** 關閉並捨棄待確認的計畫（登出或換帳號後也會呼叫）。 */
  RC.closeConfirm = function closeConfirm() {
    const key = confirmState?.key;
    if (confirmState) RC.clearSecrets(confirmState.inputs);
    confirmState = null;
    $('confirm-layer').classList.add('hidden');
    $('confirm-body').replaceChildren();
    RC.setText('confirm-error', '');
    if (key) RC.rerenderPackage(key);
  };

  /** 取消鈕與 Esc：未執行時關閉；確認後執行中則改為取消進行中的安裝。 */
  RC.cancelConfirm = () => {
    if (!confirmState) return;
    if (confirmState.busy) { if (confirmState.running === true) RC.requestCancel(confirmState.key); return; }
    RC.closeConfirm();
  };

  RC.confirmPrimary = async function confirmPrimary() {
    const st = confirmState;
    if (!st || st.busy || st.response.allBlocked) return;
    if (st.response.detach) { RC.closeConfirm(); return RC.runDetach(st.key, st.extra.targetIds); }
    if (st.response.uninstall) { RC.closeConfirm(); return RC.runUninstall(st.key); } // 沒有參數與計畫；執行狀態顯示在卡片與明細的按鈕上
    const plan = st.response.plan || {};
    RC.setText('confirm-error', '');
    let saved = false;
    if (plan.missingParameters?.length) {
      const { values, secrets, error } = RC.collectSetup(plan.missingParameters, st.inputs);
      if (error) return RC.setText('confirm-error', error);
      st.busy = true; RC.renderConfirmButtons();
      try {
        await RC.saveSetup(st.key, values, secrets);
        saved = true;
      } catch (e) {
        if (confirmState !== st) return;
        st.busy = false; RC.renderConfirmButtons();
        if (RC.sessionLost(e)) { RC.closeConfirm(); return RC.load(); }
        return RC.setText('confirm-error', RC.messageOf(e));
      } finally {
        RC.clearSecrets(st.inputs);
      }
    }
    st.busy = true; st.running = true; RC.renderConfirmButtons();
    RC.setRunning(st.key, st.action);
    const input = { packageKey: st.key, action: st.action, ...st.extra };
    try {
      let response = await call('rc.install.run', { ...input, confirmedPlanId: st.response.planId }, runTimeout(plan));
      if (saved && sameApproval(st.response, response)) response = await call('rc.install.run', { ...input, confirmedPlanId: response.planId }, runTimeout(response.plan));
      if (confirmState !== st) { RC.setRunning(st.key, null); return; }
      if (response?.needsConfirmation || response?.allBlocked) {
        // 確認時本機狀態已變動且重新規劃後仍有例外：更新確認層內容，再確認一次
        Object.assign(st, { response, replanned: true, busy: false, running: false, inputs: new Map() });
        RC.setRunning(st.key, null);
        renderConfirm();
        return;
      }
      RC.closeConfirm();
      await RC.finishRun(st.key, st.action, response);
    } catch (e) {
      if (confirmState === st) RC.closeConfirm();
      RC.setRunning(st.key, null);
      RC.actionFailed(e);
    }
  };
})();
