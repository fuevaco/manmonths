// 可更新數量與同步：狀態下拉的「可更新 (N)」與清單上方的提示列；rc.updates.summary（不發網路請求）與 checkNow（立即向市集同步）；
// 切回面板（visibilitychange）時重新整理安裝狀態並同步。只重新計算數量，不自動更新任何資源包。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { $, call, state } = RC;

  const CHECK_TIMEOUT_MS = 120000;
  let updateCount = 0;
  let updateEpoch = 0; // 登出時遞增，丟棄較晚抵達的舊結果
  let checkStarts = 0;
  let checksRunning = 0;

  function setUpdateCount(count) {
    updateCount = Number.isInteger(count) && count > 0 ? count : 0;
    $('catalog-installation-updates').textContent = updateCount > 0 ? `可更新 (${updateCount})` : '可更新';
    RC.setText('update-banner', updateCount > 0 ? `${updateCount} 個資源包可更新` : '');
  }

  /** 登出：丟棄進行中的同步結果並清空數量。 */
  RC.resetUpdates = () => { updateEpoch += 1; setUpdateCount(0); };

  /** check=false 讀最近一次摘要（不發網路請求）；check=true 立即向市集同步。同步失敗保留上次的數量。 */
  RC.syncUpdates = async function syncUpdates(check) {
    if (!check && checksRunning > 0) return;
    const epoch = updateEpoch, started = checkStarts;
    if (check) { checkStarts += 1; checksRunning += 1; }
    try {
      const summary = await call(check ? 'rc.updates.checkNow' : 'rc.updates.summary', {}, check ? CHECK_TIMEOUT_MS : undefined);
      if (epoch !== updateEpoch || (!check && started !== checkStarts)) return;
      setUpdateCount(summary?.count);
    } catch (e) {
      if (epoch === updateEpoch && RC.sessionLost(e)) return RC.load();
    } finally {
      if (check) checksRunning -= 1;
    }
  };
  /** 開啟面板（登入後）：先顯示最近一次摘要，再立即同步一次。 */
  RC.syncUpdatesOnOpen = () => RC.syncUpdates(false).then(() => RC.syncUpdates(true));

  /** 點提示列：切到「可更新」篩選並查詢。 */
  RC.showUpdates = function showUpdates() {
    $('catalog-installation').value = 'updates';
    return RC.loadCatalog();
  };

  /** 切回面板：重新整理清單（或明細）的安裝狀態並同步可更新數量；隱藏時不做事，也不與進行中的作業重疊。 */
  RC.onVisibilityChange = function onVisibilityChange() {
    if (document.visibilityState !== 'visible' || document.hidden === true || state.busy) return;
    const inMain = RC.isShown('main');
    const inDetails = RC.isShown('details');
    if (!inMain && !inDetails) return;
    if (inMain && state.catalogPending === 0 && state.running.size === 0) RC.loadCatalog({ keepList: true, useLastSearch: true });
    if (inDetails && state.currentDetail && state.currentPackage && state.running.size === 0) RC.reloadDetails();
    if (checksRunning === 0) RC.syncUpdates(true);
  };
})();
