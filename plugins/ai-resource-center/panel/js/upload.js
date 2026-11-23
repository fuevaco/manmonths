// 打包並上傳：從「我的資源包」的「打包並上傳…」進入，同一個 sheet 走完「資料夾 → 預檢 → 上傳 → 送審」，每一步只有一個主要按鈕與取消。
// 資料夾：路徑文字框（可直接貼上）＋「選擇…」（作業系統對話框，rc.dev.pickFolder，最久約 115 秒）；路徑改變（選擇、Enter、離開欄位）時先
// rc.dev.checkFolder 再 rc.dev.inspect（只做 worker 的預檢，不上傳）。預檢沒過列出阻擋項，主要按鈕改為「重新檢查」；通過顯示摘要。
// 上傳：rc.dev.upload.start 開背景工作，每 700 毫秒輪詢 rc.dev.upload.status；上傳中只有「取消上傳」，失敗可「重試」，取消回到預檢通過。
// 上傳成功後詢問是否送審（rc.dev.submitReviewByVersion）；關閉 sheet 時一律 dispose 背景工作，有上傳成功則重新讀取我的資源包。
// 對外：RC.openUploadSheet({ folder? })，folder 有值時直接帶入並預檢（之後的「本機開發中」卡片也用它）。
(function () {
  'use strict';

  const RC = window.RcPanel;
  const { el, call } = RC;

  const PICK_TIMEOUT_MS = 118000; // 比 worker 的選擇器逾時（115 秒）略長
  const POLL_MS = 700;
  const STEPS = ['資料夾', '預檢', '上傳', '送審'];
  const TYPE_LABELS = { skill: 'Skill', agent: 'Agent', mcp: 'MCP', bundle: '組合包' };
  const COUNT_LABELS = [['skill', 'Skills'], ['agent', 'Agents'], ['command', 'Commands'], ['prompt', 'Prompts'], ['mcp', 'MCP']];
  const READY = new Set(['failed', 'passed', 'uploadFailed', 'asked']); // 主要按鈕可按的階段

  const sizeText = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  /** 貼上的路徑常帶前後空白，或是檔案總管「複製為路徑」的成對雙引號。 */
  const normalizePath = (text) => String(text ?? '').trim().replace(/^"(.*)"$/, '$1').trim();

  function summaryText(summary) {
    const label = TYPE_LABELS[summary.type] || summary.type || '';
    const counts = summary.type === 'bundle' ? COUNT_LABELS.filter(([kind]) => summary.contentCounts?.[kind] > 0).map(([kind, name]) => `${summary.contentCounts[kind]} ${name}`) : [];
    return counts.length ? `${label} · ${counts.join('、')}` : label;
  }

  RC.openUploadSheet = function openUploadSheet({ folder } = {}) {
    // phase：empty 尚無預檢結果、checking、badPath（找不到資料夾或預檢無法執行）、failed（有阻擋項）、passed、
    //        uploading、uploadFailed、asked（已上傳，詢問送審）
    let phase = 'empty';
    let group = 'folder'; // 目前 body 的組成：folder（含路徑列）或 flow（上傳與送審）
    let inspection = null, checkedPath = '', message = '';
    let token = 0, inflight = null; // 預檢序號與進行中的路徑（Enter 與 change 同時觸發時只做一次）
    let committed = null; // 最近一次開始預檢的路徑：離開欄位時值沒變就不重做（程式回填路徑後，瀏覽器仍會在失焦時送出 change）
    let jobId = null, polling = null, pollBusy = false, cancelling = false;
    let uploaded = null; // 上傳成功的 status
    let picking = false, closed = false, lastSaved = '';
    let handle = null;

    // ---------- 固定的元件 ----------
    const stepNodes = STEPS.map(text => el('span', { textContent: text }));
    const steps = el('div', { className: 'upload-steps', 'data-role': 'upload-steps' }, ...stepNodes);
    const pathInput = el('input', { type: 'text', value: '', placeholder: '貼上資料夾路徑，或按「選擇…」', autocomplete: 'off', spellcheck: false, 'aria-label': '資源包資料夾', 'data-role': 'upload-path' });
    const pickButton = el('button', { type: 'button', className: 'btn', 'data-action': 'pick-folder', textContent: '選擇…' });
    const hint = el('div', { className: 'hint hidden', 'data-role': 'path-hint' });
    const folderField = RC.sheetField('資源包資料夾', el('div', { className: 'upload-path' }, pathInput, pickButton));
    folderField.append(hint);
    const result = el('div', { className: 'upload-result', 'data-role': 'upload-result' });
    const note = el('textarea', { placeholder: '給審核者的說明', rows: 3 });

    const setHint = (text) => { hint.textContent = text || ''; hint.classList.toggle('hidden', !text); };

    // ---------- 各階段的內容 ----------
    const text = (value) => el('div', { textContent: value });

    function failureList(blocking) {
      return el('div', { className: 'failure-list upload-failures', 'data-role': 'precheck-failures' },
        el('div', { className: 'upload-failure-head', textContent: `有 ${blocking.length} 個問題需要修正` }),
        ...blocking.map(item => el('div', { className: 'upload-failure-item', 'data-role': 'precheck-failure' },
          el('span', { textContent: item.message }), item.path ? el('span', { className: 'upload-failure-path mono', textContent: item.path }) : null)));
    }

    function disclosureList(list, open) {
      return el('details', { className: 'notice', open, 'data-role': 'precheck-disclosures' },
        el('summary', { textContent: `${list.length} 個提醒（不影響上傳）` }),
        ...list.map(item => el('div', { className: 'upload-disclosure', 'data-role': 'precheck-disclosure' },
          el('span', { textContent: item.message }), item.path ? el('span', { className: 'upload-failure-path mono', textContent: ` ${item.path}` }) : null)));
    }

    function passedSummary() {
      const s = inspection.summary;
      const known = RC.developerHasPackage?.(s.key);
      const rows = [['名稱', s.name, false], ['識別碼', s.key, true], ['版本', s.version, false], ['類型', summaryText(s), false], ['檔案', `${s.fileCount} 個 · ${sizeText(s.totalBytes)}`, false]];
      return [el('div', { className: 'upload-ok', 'data-role': 'precheck-ok', textContent: '✓ 預檢通過' }),
        el('dl', { className: 'upload-summary', 'data-role': 'upload-summary' },
          ...rows.flatMap(([label, value, mono]) => [el('dt', { textContent: label }), el('dd', { className: mono ? 'mono' : '', textContent: String(value ?? '') })])),
        known === false ? el('div', { className: 'info-note', 'data-role': 'new-package-note', textContent: '這是新的資源包，上傳後你會成為擁有者。' }) : null,
        inspection.disclosures?.length ? disclosureList(inspection.disclosures, false) : null];
    }

    function uploadingBox() {
      return [text('正在上傳…'), el('div', { className: 'upload-progress', 'data-role': 'upload-progress' }, el('i')),
        el('div', { className: 'muted upload-note', textContent: '大型資源包可能需要幾分鐘。' })];
    }

    function askBox() {
      return [RC.sheetText('要直接申請上架嗎？核准後會成為正式版，所有人都會在資源中心看到。'), RC.sheetField('送審附註（選填）', note)];
    }

    // ---------- 繪製 ----------
    function render() {
      if (closed || !handle) return;
      const flow = ['uploading', 'uploadFailed', 'asked'].includes(phase);
      const reached = phase === 'asked' ? 4 : flow ? 3 : phase === 'failed' || phase === 'passed' ? 2 : 1;
      stepNodes.forEach((node, i) => node.classList.toggle('done', i < reached));
      let content;
      if (phase === 'checking') content = [el('div', { className: 'muted', 'data-role': 'checking', textContent: '檢查中…' })];
      else if (phase === 'badPath') content = [el('div', { className: 'error', 'data-role': 'path-error', textContent: message })];
      else if (phase === 'failed') content = [failureList(inspection.blocking || []), inspection.disclosures?.length ? disclosureList(inspection.disclosures, true) : null];
      else if (phase === 'passed') content = passedSummary();
      else if (phase === 'uploading') content = uploadingBox();
      else if (phase === 'uploadFailed') content = [el('div', { className: 'error', 'data-role': 'upload-error', textContent: message })];
      else if (phase === 'asked') content = askBox();
      else content = [];
      result.replaceChildren(...content.filter(Boolean));
      if ((flow ? 'flow' : 'folder') !== group) {
        group = flow ? 'flow' : 'folder';
        handle.setBody(flow ? [steps, result] : [steps, folderField, result]);
      }
      const s = inspection?.summary;
      if (phase === 'asked') handle.setTitle({ title: `已上傳 ${uploaded.version}（Preview）`, subtitle: uploaded.name });
      else if (flow && s) handle.setTitle({ title: '打包並上傳', subtitle: `${s.name} ${s.version}` });
      else handle.setTitle({ title: '打包並上傳' });
      handle.setCancel({ label: phase === 'uploading' ? '取消上傳' : phase === 'asked' ? '保持 Preview' : '取消' });
      handle.setPrimary({ label: phase === 'failed' ? '重新檢查' : phase === 'uploadFailed' ? '重試' : phase === 'asked' ? '申請上架' : '上傳', hidden: phase === 'uploading' });
    }

    // ---------- 預檢 ----------
    async function check(raw, { quiet = false, keep = false } = {}) {
      const typed = normalizePath(raw);
      if (!keep && inflight === typed && typed) return;
      const mine = ++token;
      if (!typed) { inspection = null; checkedPath = ''; phase = 'empty'; return render(); }
      inflight = typed; committed = typed;
      if (!keep) { phase = 'checking'; render(); }
      try {
        const folderInfo = await call('rc.dev.checkFolder', { path: typed });
        if (mine !== token || closed) return;
        if (!folderInfo?.exists || !folderInfo.isDirectory) {
          inspection = null; checkedPath = '';
          if (quiet) phase = 'empty'; else { phase = 'badPath'; message = folderInfo?.exists ? '這不是資料夾，請選擇資源包所在的資料夾' : '找不到這個資料夾'; }
          return render();
        }
        checkedPath = folderInfo.absolutePath || typed;
        if (pathInput.value !== checkedPath) pathInput.value = checkedPath;
        committed = checkedPath;
        const inspected = await call('rc.dev.inspect', { folder: checkedPath, mode: 'upload' });
        if (mine !== token || closed) return;
        inspection = inspected;
        phase = inspected.ok ? 'passed' : 'failed';
        render();
        if (inspected.ok) remember(checkedPath);
      } catch (e) {
        if (mine !== token || closed) return;
        if (RC.sessionLost(e)) { handle.close(); return RC.load(); }
        inspection = null; checkedPath = ''; phase = 'badPath'; message = RC.messageOf(e);
        render();
      } finally {
        if (mine === token) inflight = null;
      }
    }

    /** 預檢通過的資料夾記為「上次打包上傳的資料夾」。 */
    function remember(path) {
      if (path === lastSaved) return;
      lastSaved = path;
      call('rc.preferences.set', { lastUploadFolder: path }).catch(() => {});
    }

    async function pick() {
      if (picking || closed) return;
      picking = true; pickButton.disabled = true;
      setHint('已開啟選擇視窗；若沒看到，請查看工作列');
      try {
        const initial = normalizePath(pathInput.value);
        const picked = await call('rc.dev.pickFolder', initial ? { initialPath: initial } : {}, PICK_TIMEOUT_MS);
        if (closed) return;
        if (picked?.unavailable) setHint('這台電腦無法開啟資料夾選擇視窗，請直接貼上資料夾路徑。');
        else {
          setHint('');
          if (picked?.path) { pathInput.value = picked.path; await check(picked.path); }
        }
      } catch (e) {
        if (closed) return;
        setHint('');
        if (RC.sessionLost(e)) { handle.close(); return RC.load(); }
        handle.setError(RC.messageOf(e));
      } finally {
        picking = false; pickButton.disabled = false;
      }
    }

    // ---------- 上傳 ----------
    function stopPolling() { if (polling !== null) window.clearInterval(polling); polling = null; }

    function applyStatus(status) {
      if (status.state === 'uploaded') { stopPolling(); uploaded = status; phase = 'asked'; }
      else if (status.state === 'failed') { stopPolling(); message = status.error?.message || '打包或上傳失敗，請稍後再試'; phase = 'uploadFailed'; }
      else if (status.state === 'cancelled') { stopPolling(); phase = 'passed'; }
      else return;
      render();
    }

    async function poll() {
      const mine = jobId;
      if (pollBusy || !mine || closed) return;
      pollBusy = true;
      try {
        const status = await call('rc.dev.upload.status', { jobId: mine });
        if (!closed && jobId === mine) applyStatus(status);
      } catch (e) {
        if (closed || jobId !== mine) return;
        stopPolling();
        if (RC.sessionLost(e)) { handle.close(); return RC.load(); }
        message = RC.messageOf(e); phase = 'uploadFailed'; render();
      } finally {
        pollBusy = false;
      }
    }

    function startPolling() { stopPolling(); polling = window.setInterval(poll, POLL_MS); }

    function disposeJob() {
      const id = jobId;
      jobId = null;
      return id ? call('rc.dev.upload.dispose', { jobId: id }).catch(() => {}) : Promise.resolve();
    }

    async function startUpload() {
      await disposeJob(); // 取消後再次上傳：舊工作先清掉
      const started = await call('rc.dev.upload.start', { folder: checkedPath });
      if (closed) { call('rc.dev.upload.dispose', { jobId: started.jobId }).catch(() => {}); return false; }
      jobId = started.jobId;
      phase = 'uploading'; render(); startPolling();
      return false;
    }

    async function retryUpload() {
      try { await call('rc.dev.upload.retry', { jobId }); }
      catch (e) {
        if (e?.code !== 'invalid_params') throw e;
        return startUpload(); // 打包階段就失敗的工作沒有 ZIP 可重試：重新建立工作
      }
      phase = 'uploading'; render(); startPolling();
      return false;
    }

    async function cancelUpload() {
      if (cancelling) return false;
      cancelling = true;
      try {
        await call('rc.dev.upload.cancel', { jobId });
        applyStatus(await call('rc.dev.upload.status', { jobId }));
      } catch (e) {
        if (RC.sessionLost(e)) { handle.close(); RC.load(); } else handle.setError(RC.messageOf(e));
      } finally {
        cancelling = false;
      }
      return false;
    }

    async function submit() {
      await call('rc.dev.submitReviewByVersion', { packageKey: uploaded.packageKey, version: uploaded.version, comment: note.value.trim() });
      RC.toast('已申請上架，等待管理者審核');
    }

    // ---------- sheet ----------
    handle = RC.openSheet({
      title: '打包並上傳', body: [steps, folderField, result], primaryLabel: '上傳',
      focus: pathInput,
      validate: () => READY.has(phase),
      onPrimary: async () => {
        if (phase === 'failed') { await check(checkedPath, { keep: true }); return false; }
        if (phase === 'passed') {
          try { return await startUpload(); }
          catch (e) {
            if (e?.code !== 'invalid_package') throw e;
            await check(checkedPath, { keep: true }); // 資料夾在預檢之後又改過：重新預檢並顯示新的阻擋項
            return false;
          }
        }
        if (phase === 'uploadFailed') return retryUpload();
        if (phase === 'asked') return submit(); // 成功時關閉；失敗丟出錯誤，附註留在原處
        return false;
      },
      onCancel: () => (phase === 'uploading' ? cancelUpload() : undefined),
      onClose: ({ reset }) => {
        closed = true;
        token += 1;
        stopPolling();
        disposeJob();
        if (uploaded && !reset && RC.isShown('developer')) RC.loadDeveloper?.({ keepList: true });
      }
    });
    render();

    pathInput.addEventListener('change', () => { if (phase === 'empty' || normalizePath(pathInput.value) !== committed) check(pathInput.value); });
    pathInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault?.(); check(pathInput.value); } });
    pathInput.addEventListener('input', () => { // 路徑改了就不能再用舊的預檢結果上傳
      if (['passed', 'failed', 'badPath'].includes(phase) && normalizePath(pathInput.value) !== checkedPath) { phase = 'empty'; committed = null; render(); }
    });
    pickButton.addEventListener('click', pick);

    // 預設帶入上次打包上傳的資料夾；呼叫端指定 folder 時以它為準
    if (folder) { pathInput.value = folder; check(folder); }
    call('rc.preferences.get').then((prefs) => {
      if (closed) return;
      if (typeof prefs?.lastUploadFolder === 'string') lastSaved = prefs.lastUploadFolder;
      if (!folder && lastSaved && !pathInput.value) { pathInput.value = lastSaved; check(lastSaved, { quiet: true }); }
    }).catch(() => {});
    return handle;
  };
})();
