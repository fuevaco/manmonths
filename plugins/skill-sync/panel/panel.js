(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // 所有動態內容都用 textContent 建立，技能庫回傳的文字不會被當成 HTML 執行
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) if (c) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    return node;
  }

  const S = {
    cfg: null,
    skills: [],
    targets: null,
    selected: new Set(),
    selection: { global: true, projectIds: new Set() },
    rows: [],
    filter: 'all',
    query: '',
    review: null,
    busy: false
  };

  // ---------- 與 worker 溝通 ----------
  function call(method, input, timeoutMs) {
    if (!window.orca?.plugin) return Promise.reject(new Error('Orca Plugin Bridge 尚未就緒'));
    return window.orca.plugin.request(method, input, timeoutMs ? { timeoutMs } : undefined);
  }
  const selectionPayload = () => ({ global: S.selection.global, projectIds: [...S.selection.projectIds] });

  // ---------- 畫面切換 ----------
  const VIEWS = ['settings', 'main', 'review', 'result'];
  function showView(name) {
    for (const v of VIEWS) $(`view-${v}`).classList.toggle('hidden', v !== name);
    $('actionbar').classList.toggle('hidden', name !== 'main');
  }
  function banner(msg, kind = 'info') {
    const b = $('banner');
    if (!msg) return b.classList.add('hidden');
    b.textContent = msg;
    b.className = `banner ${kind}`;
  }
  const setStatus = (s) => ($('status-dot').className = `status-dot ${s}`);
  const applyTheme = (scheme) => {
    document.body.classList.toggle('light', scheme === 'light');
    document.documentElement.classList.toggle('light', scheme === 'light');
  };

  // ---------- 設定 ----------
  async function loadConfigIntoForm() {
    const cfg = await call('skills.getConfig');
    S.cfg = cfg;
    $('cfg-url').value = cfg.baseUrl;
    $('cfg-token').value = '';
    $('cfg-token').placeholder = cfg.hasToken ? '已儲存（留空代表不變更）' : '貼上 API Token';
    $('cfg-linkdirs').value = cfg.linkDirs;
    $('cfg-gitexclude').checked = cfg.gitExclude;
    $('cfg-tls').checked = cfg.allowInsecureTls;
    $('cfg-http').checked = cfg.allowHttp;
    return cfg;
  }

  const formConfig = () => ({
    baseUrl: $('cfg-url').value.trim(),
    token: $('cfg-token').value,
    linkDirs: $('cfg-linkdirs').value,
    gitExclude: $('cfg-gitexclude').checked,
    allowInsecureTls: $('cfg-tls').checked,
    allowHttp: $('cfg-http').checked
  });

  async function saveAndLoad() {
    const f = formConfig();
    if (!f.baseUrl) return banner('請先填入技能庫 API 網址。', 'error');
    await call('skills.saveConfig', f);
    await loadConfigIntoForm();
    banner('');
    await loadAll({ refresh: true });
  }

  const V_ICON = { pass: '✓', fail: '✗', warn: '!', skip: '–' };
  async function verifyApi() {
    const box = $('verify-result');
    box.classList.remove('hidden');
    box.replaceChildren(el('div', { class: 'muted', text: '驗證中…（會下載每個 skill 並核對雜湊，可能需要一點時間）' }));
    $('btn-verify').disabled = true;
    try {
      const f = formConfig();
      const rep = await call('skills.verifyApi', f, 120000);
      const rows = rep.checks.map((c) =>
        el('div', { class: 'vrow' },
          el('span', { class: `v-${c.status}`, text: V_ICON[c.status] }),
          el('span', { text: c.title }),
          c.detail ? el('div', { class: 'v-detail', text: c.detail }) : null)
      );
      const s = rep.summary;
      rows.push(el('div', {
        class: `verify-summary ${rep.ok ? 'v-pass' : 'v-fail'}`,
        text: `${rep.ok ? '符合標準 v1' : '不符合標準 v1'}：通過 ${s.pass}、失敗 ${s.fail}、建議 ${s.warn}、略過 ${s.skip}`
      }));
      box.replaceChildren(...rows);
    } catch (e) {
      box.replaceChildren(el('div', { class: 'v-fail', text: e.message || String(e) }));
    } finally {
      $('btn-verify').disabled = false;
    }
  }

  // ---------- 資料載入 ----------
  async function loadAll({ refresh = false } = {}) {
    if (!S.cfg?.baseUrl) return showView('settings');
    setStatus('');
    banner('正在讀取技能庫…');
    try {
      const [idx, tg] = await Promise.all([call('skills.fetchIndex', { refresh }, 60000), call('skills.listTargets')]);
      S.skills = idx.skills;
      S.targets = tg;
      $('title-text').textContent = idx.name ? `Skill 同步 · ${idx.name}` : 'Skill 同步';
      // 技能庫已下架的 skill 不再保留在「已選」
      const names = new Set(S.skills.map((s) => s.name));
      for (const n of [...S.selected]) if (!names.has(n)) S.selected.delete(n);
      const valid = new Set(tg.projects.map((p) => p.id));
      for (const id of [...S.selection.projectIds]) if (!valid.has(id)) S.selection.projectIds.delete(id);
      setStatus('connected');
      banner(idx.warnings?.length ? `技能庫格式建議：${idx.warnings.map((w) => `${w.path} ${w.message}`).join('；')}` : '');
      showView('main');
      renderTargets();
      await refreshPlan();
    } catch (e) {
      setStatus('error');
      banner(e.message || String(e), 'error');
      showView(S.skills.length ? 'main' : 'settings');
    }
  }

  async function refreshPlan() {
    const hasTarget = S.selection.global || S.selection.projectIds.size > 0;
    if (!hasTarget || !S.skills.length) {
      S.rows = [];
    } else {
      try {
        S.rows = (await call('skills.plan', { selection: selectionPayload() }, 60000)).rows;
      } catch (e) {
        S.rows = [];
        banner(`讀取本機狀態失敗：${e.message || e}`, 'error');
      }
    }
    renderList();
  }

  let saveTimer = null;
  function saveProfileSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      call('skills.saveProfile', { subscriptions: [...S.selected], selection: selectionPayload() }).catch(() => {});
    }, 400);
  }

  // ---------- 目標 ----------
  function renderTargets() {
    $('tgt-global').checked = S.selection.global;
    const q = $('proj-search').value.trim().toLowerCase();
    const list = $('proj-list');
    const projects = S.targets.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
    const nodes = projects.map((p) =>
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', 'data-id': p.id, ...(S.selection.projectIds.has(p.id) ? { checked: true } : {}) }),
        el('span', { text: p.name }),
        el('span', { class: 'sub', text: `${p.paths.length} 個資料夾` }))
    );
    if (S.targets.remote.length) {
      nodes.push(el('div', { class: 'hint', text: `另有 ${S.targets.remote.length} 個遠端專案不支援寫入。` }));
    }
    list.replaceChildren(...(nodes.length ? nodes : [el('div', { class: 'hint', text: '沒有符合的專案' })]));
    updateTargetsSummary();
  }
  function updateTargetsSummary() {
    const parts = [];
    if (S.selection.global) parts.push('全域');
    if (S.selection.projectIds.size) parts.push(`${S.selection.projectIds.size} 個專案`);
    $('targets-summary').textContent = parts.length ? `· ${parts.join(' + ')}` : '· 尚未選擇';
  }

  // ---------- 清單 ----------
  function statsFor(name) {
    const s = { absent: 0, update: 0, current: 0, conflict: 0, error: 0, total: 0, installedVersion: null };
    for (const r of S.rows) {
      if (r.name !== name) continue;
      s.total++;
      if (r.state === 'absent') s.absent++;
      else if (r.state === 'update') s.update++;
      else if (r.state === 'current') s.current++;
      else if (r.state === 'modified' || r.state === 'foreign') s.conflict++;
      else s.error++;
      if (r.installedVersion) s.installedVersion = r.installedVersion;
    }
    return s;
  }

  function chipFor(st) {
    if (!st.total) return null;
    if (st.conflict) return el('span', { class: 'chip bad', text: `有衝突 ${st.conflict}` });
    if (st.update) return el('span', { class: 'chip warn', text: `有更新 ${st.update}` });
    if (st.absent) return el('span', { class: st.current ? 'chip warn' : 'chip new', text: st.current ? `缺 ${st.absent} 處` : '新' });
    if (st.error) return el('span', { class: 'chip bad', text: '檢查失敗' });
    return el('span', { class: 'chip ok', text: '已同步' });
  }

  function visibleSkills() {
    const q = S.query.trim().toLowerCase();
    return S.skills.filter((s) => {
      if (q) {
        const hay = [s.name, s.title, s.description, ...(s.tags || [])].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const st = statsFor(s.name);
      switch (S.filter) {
        case 'new': return st.absent > 0;
        case 'update': return st.update > 0;
        case 'conflict': return st.conflict > 0;
        case 'selected': return S.selected.has(s.name);
        default: return true;
      }
    });
  }

  function renderList() {
    const list = visibleSkills();
    $('count').textContent = `${list.length} / ${S.skills.length}`;
    const box = $('skill-list');
    if (!list.length) {
      box.replaceChildren(el('div', { class: 'empty', text: S.skills.length ? '沒有符合條件的 skill' : '技能庫目前沒有 skill' }));
    } else {
      box.replaceChildren(...list.map(skillCard));
    }
    const allSel = list.length > 0 && list.every((s) => S.selected.has(s.name));
    $('sel-all').checked = allSel;
    updateActionBar();
  }

  function skillCard(s) {
    const st = statsFor(s.name);
    const sel = S.selected.has(s.name);
    const ver = st.installedVersion && st.installedVersion !== s.version ? `${st.installedVersion} → ${s.version}` : s.version;
    return el('div', { class: `skill${sel ? ' selected' : ''}` },
      el('input', { type: 'checkbox', 'data-name': s.name, 'aria-label': `選取 ${s.name}`, ...(sel ? { checked: true } : {}) }),
      el('div', {},
        el('div', { class: 'skill-head' },
          el('span', { class: 'skill-name', text: s.title || s.name }),
          el('span', { class: 'skill-ver', text: `v${ver}` }),
          chipFor(st)),
        el('div', { class: 'skill-desc', text: s.description }),
        el('div', { class: 'skill-meta' },
          s.title && s.title !== s.name ? el('span', { class: 'chip', text: s.name }) : null,
          s.hasScripts ? el('span', { class: 'chip warn', text: '⚠ 含指令碼' }) : null,
          (s.tags || []).map((t) => el('span', { class: 'chip', text: t })),
          s.author ? el('span', { class: 'chip', text: s.author }) : null)));
  }

  function updateActionBar() {
    const n = S.selected.size;
    $('sel-count').textContent = n ? `已選 ${n} 個` : '尚未選擇 skill';
    const noTarget = !S.selection.global && S.selection.projectIds.size === 0;
    $('btn-sync').disabled = S.busy || n === 0 || noTarget;
    $('btn-remove').disabled = S.busy || n === 0 || noTarget;
    $('btn-sync').title = noTarget ? '請先在上方選擇同步目標' : '';
  }

  // ---------- 檢閱 ----------
  const ACTION_TEXT = { install: '新增', update: '更新', adopt: '認養（內容已相同）', none: '無變更', conflict: '衝突' };
  const STATE_REASON = {
    modified: '安裝後被你改過',
    foreign: '已有同名資料夾（不是由本外掛安裝）',
    error: '檢查失敗'
  };
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  async function startReview() {
    if (S.busy) return;
    S.busy = true;
    updateActionBar();
    banner('正在向技能庫取得清單並比對本機狀態…');
    try {
      const names = [...S.selected];
      const res = await call('skills.plan', { names, selection: selectionPayload(), describe: true }, 90000);
      banner('');
      S.review = { names, ...res };
      renderReview();
      showView('review');
    } catch (e) {
      banner(e.message || String(e), 'error');
    } finally {
      S.busy = false;
      updateActionBar();
    }
  }

  function renderReview() {
    const { names, rows, details } = S.review;
    const body = $('review-body');
    const totals = { install: 0, update: 0, adopt: 0, none: 0, conflict: 0 };
    const nodes = [];
    let needAck = false;

    for (const name of names) {
      const entry = S.skills.find((s) => s.name === name);
      const d = (details || []).find((x) => x.name === name) || {};
      const mine = rows.filter((r) => r.name === name);
      const counts = { install: 0, update: 0, adopt: 0, none: 0, conflict: 0 };
      for (const r of mine) {
        const a = r.state === 'error' ? 'conflict' : r.action;
        counts[a] = (counts[a] || 0) + 1;
        totals[a] = (totals[a] || 0) + 1;
      }
      const card = el('div', { class: 'rv-skill' },
        el('h4', { text: `${entry?.title || name}  v${entry?.version || ''}` }));
      if (d.error) {
        card.append(el('div', { class: 'rv-conflict', text: `無法取得清單：${d.error}` }));
      } else {
        card.append(el('div', { class: 'rv-list', text: `${d.fileCount} 個檔案，${fmtBytes(d.bytes || 0)}` }));
        if (d.runnable?.length) {
          needAck = true;
          card.append(el('div', { class: 'rv-warn' },
            '⚠ 包含 Agent 可能以你的權限執行的檔案：',
            el('div', {}, d.runnable.map((p, i) => [i ? '、' : '', el('code', { text: p })]))));
        }
        card.append(el('details', { class: 'rv-list' }, el('summary', { text: '檔案清單' }), el('div', {}, d.files.map((p) => el('div', {}, el('code', { text: p }))))));
      }
      card.append(el('div', { class: 'rv-summary', text: `新增 ${counts.install}・更新 ${counts.update}・無變更 ${counts.none + counts.adopt}・衝突 ${counts.conflict}` }));
      for (const r of mine.filter((x) => x.downgrade)) {
        card.append(el('div', { class: 'rv-list', text: `${r.label}：技能庫版本（${r.remoteVersion}）比本機（${r.installedVersion}）舊` }));
      }
      for (const r of mine.filter((x) => x.action === 'conflict')) {
        card.append(el('label', { class: 'rv-conflict check' },
          el('input', { type: 'checkbox', class: 'force', 'data-key': `${r.name}|${r.baseKey}` }),
          el('span', { text: `${r.label}：${STATE_REASON[r.state] || r.state}。勾選＝取代（舊的先備份）；不勾＝略過` })));
      }
      nodes.push(card);
    }

    const actionable = totals.install + totals.update + totals.adopt;
    const head = el('div', { class: 'rv-summary', text: `將在 ${S.review.bases.length} 個目標處理 ${names.length} 個 skill：新增 ${totals.install}、更新 ${totals.update}、衝突 ${totals.conflict}、無變更 ${totals.none + totals.adopt}。` });
    const ack = needAck
      ? el('label', { class: 'check rv-warn' }, el('input', { type: 'checkbox', id: 'rv-ack' }), el('span', { text: '我已檢閱上面會被執行的檔案，信任這個技能庫' }))
      : null;
    body.replaceChildren(head, ...nodes, ack);
    const confirm = $('btn-review-confirm');
    const refreshConfirm = () => {
      const ackOk = !needAck || $('rv-ack').checked;
      const anyForce = body.querySelector('.force:checked');
      confirm.disabled = !ackOk || (actionable === 0 && !anyForce);
    };
    body.onchange = refreshConfirm;
    refreshConfirm();
  }

  // ---------- 同步 ----------
  const RES_TEXT = { installed: '已新增', updated: '已更新', adopted: '已認養', unchanged: '無變更', skipped: '已略過', removed: '已移除', error: '失敗' };
  const RES_CLASS = { installed: 'v-pass', updated: 'v-pass', adopted: 'v-pass', removed: 'v-pass', unchanged: 'v-skip', skipped: 'v-warn', error: 'v-fail' };

  function resultReason(r) {
    const parts = [];
    if (r.reason) parts.push(STATE_REASON[r.reason] || r.reason);
    if (r.backup) parts.push(`原內容已備份到 ${r.backup}`);
    for (const l of r.links || []) {
      if (l.mode === 'conflict') parts.push(`${l.dir} 已有同名項目，未建立連結`);
      if (l.mode === 'copy') parts.push(`${l.dir} 無法建立連結，改用複製`);
    }
    return parts.join('；');
  }

  function showResults(title, results) {
    $('result-title').textContent = title;
    const counts = {};
    for (const r of results) counts[r.action] = (counts[r.action] || 0) + 1;
    const summary = Object.entries(counts).map(([a, n]) => `${RES_TEXT[a] || a} ${n}`).join('・');
    const interesting = results.filter((r) => r.action !== 'unchanged');
    const rows = interesting.map((r) => {
      const reason = resultReason(r);
      return el('div', { class: 'res-row' },
        el('span', { class: RES_CLASS[r.action] || '', text: RES_TEXT[r.action] || r.action }),
        el('span', { text: `${r.name} → ${r.label}` }),
        reason ? el('div', { class: 'res-detail', text: reason }) : null);
    });
    $('result-body').replaceChildren(
      el('div', { class: 'rv-summary', text: summary || '沒有任何變更' }),
      ...(rows.length ? rows : [el('div', { class: 'hint', text: '全部都已是最新。' })]));
    showView('result');
  }

  async function confirmSync() {
    if (S.busy || !S.review) return;
    S.busy = true;
    const force = [...document.querySelectorAll('#review-body .force:checked')].map((c) => c.getAttribute('data-key'));
    const names = S.review.names;
    const results = [];
    $('btn-review-confirm').disabled = true;
    try {
      for (let i = 0; i < names.length; i++) {
        banner(`同步中 ${i + 1}/${names.length}：${names[i]}…`);
        try {
          const res = await call('skills.sync', { names: [names[i]], selection: selectionPayload(), force }, 120000);
          results.push(...res.results);
        } catch (e) {
          results.push({ name: names[i], label: '（全部目標）', action: 'error', reason: e.message || String(e) });
        }
      }
      banner('');
      const c = (a) => results.filter((r) => r.action === a).length;
      call('skills.notify', {
        title: 'Skill 同步完成',
        body: `新增 ${c('installed') + c('adopted')}、更新 ${c('updated')}、略過 ${c('skipped')}、失敗 ${c('error')}`
      }).catch(() => {});
      showResults('同步結果', results);
    } finally {
      S.busy = false;
    }
  }

  // ---------- 移除（兩段式確認，不依賴 window.confirm） ----------
  let removeArmedAt = 0;
  async function removeSelected() {
    if (S.busy) return;
    const btn = $('btn-remove');
    if (Date.now() - removeArmedAt > 4000) {
      removeArmedAt = Date.now();
      btn.textContent = `再按一次確認移除 ${S.selected.size} 個`;
      setTimeout(() => { if (Date.now() - removeArmedAt >= 3900) btn.textContent = '移除'; }, 4100);
      return;
    }
    removeArmedAt = 0;
    btn.textContent = '移除';
    S.busy = true;
    updateActionBar();
    try {
      const res = await call('skills.remove', { names: [...S.selected], selection: selectionPayload() }, 120000);
      showResults('移除結果', res.results);
    } catch (e) {
      banner(e.message || String(e), 'error');
    } finally {
      S.busy = false;
      updateActionBar();
    }
  }

  // ---------- 事件 ----------
  function setupEvents() {
    $('btn-settings').addEventListener('click', async () => {
      await loadConfigIntoForm().catch(() => {});
      showView('settings');
    });
    $('btn-close-settings').addEventListener('click', () => (S.skills.length ? showView('main') : null));
    $('btn-refresh').addEventListener('click', () => loadAll({ refresh: true }));
    $('btn-save').addEventListener('click', () => saveAndLoad().catch((e) => banner(e.message || String(e), 'error')));
    $('btn-verify').addEventListener('click', verifyApi);
    $('btn-clear-token').addEventListener('click', async () => {
      await call('skills.clearToken');
      await loadConfigIntoForm();
      banner('已清除 Token。', 'success');
    });

    $('tgt-global').addEventListener('change', (e) => {
      S.selection.global = e.target.checked;
      updateTargetsSummary();
      saveProfileSoon();
      refreshPlan();
    });
    $('proj-list').addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-id');
      if (!id) return;
      e.target.checked ? S.selection.projectIds.add(id) : S.selection.projectIds.delete(id);
      updateTargetsSummary();
      saveProfileSoon();
      refreshPlan();
    });
    $('proj-search').addEventListener('input', renderTargets);
    const bulk = (all) => {
      const q = $('proj-search').value.trim().toLowerCase();
      for (const p of S.targets.projects) {
        if (q && !p.name.toLowerCase().includes(q)) continue;
        all ? S.selection.projectIds.add(p.id) : S.selection.projectIds.delete(p.id);
      }
      renderTargets();
      saveProfileSoon();
      refreshPlan();
    };
    $('btn-proj-all').addEventListener('click', () => bulk(true));
    $('btn-proj-none').addEventListener('click', () => bulk(false));

    $('search').addEventListener('input', (e) => { S.query = e.target.value; renderList(); });
    $('filter-pills').addEventListener('click', (e) => {
      const f = e.target.getAttribute('data-filter');
      if (!f) return;
      S.filter = f;
      for (const b of $('filter-pills').children) b.classList.toggle('active', b === e.target);
      renderList();
    });
    $('skill-list').addEventListener('change', (e) => {
      const name = e.target.getAttribute('data-name');
      if (!name) return;
      e.target.checked ? S.selected.add(name) : S.selected.delete(name);
      saveProfileSoon();
      renderList();
    });
    $('sel-all').addEventListener('change', (e) => {
      for (const s of visibleSkills()) e.target.checked ? S.selected.add(s.name) : S.selected.delete(s.name);
      saveProfileSoon();
      renderList();
    });

    $('btn-sync').addEventListener('click', startReview);
    $('btn-remove').addEventListener('click', removeSelected);
    $('btn-review-confirm').addEventListener('click', confirmSync);
    const backToMain = () => showView('main');
    $('btn-review-back').addEventListener('click', backToMain);
    $('btn-review-cancel').addEventListener('click', backToMain);
    const doneResult = async () => { showView('main'); await refreshPlan(); };
    $('btn-result-close').addEventListener('click', doneResult);
    $('btn-result-done').addEventListener('click', doneResult);
  }

  // ---------- 啟動 ----------
  async function init() {
    applyTheme(document.documentElement.classList.contains('light') ? 'light' : 'dark');
    window.orca?.on?.('theme', (t) => t?.colorScheme && applyTheme(t.colorScheme));
    setupEvents();
    try {
      const cfg = await loadConfigIntoForm();
      S.selected = new Set(cfg.profile?.subscriptions || []);
      S.selection = { global: cfg.profile?.selection?.global !== false, projectIds: new Set(cfg.profile?.selection?.projectIds || []) };
      if (!cfg.baseUrl) {
        showView('settings');
        banner('請先填入技能庫 API 網址與 Token。', 'info');
      } else {
        await loadAll();
      }
    } catch (e) {
      showView('settings');
      banner(e.message || String(e), 'error');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
