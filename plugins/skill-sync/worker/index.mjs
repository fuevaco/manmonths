import { createClient } from './api-client.mjs';
import { verifyApi } from './conformance.mjs';
import { listTargets, resolveBases } from './targets.mjs';
import { planSync, runSync, runRemove, describeSkills } from './sync-core.mjs';

const SECRET_TOKEN = 'registry_token';
const STORE_INSTALLED = 'installed.v1';
const STORE_PROFILE = 'profile.v1';

const badParams = (message) => Object.assign(new Error(message), { code: 'invalid_params' });

// 已安裝紀錄（用來判斷「有更新」與「安裝後被改過」）。寫入排隊，避免同時同步時互相覆蓋。
function createInstalledStore(orca) {
  let cache = null;
  let chain = Promise.resolve();
  const load = async () => (cache ??= (await orca.storage.get(STORE_INSTALLED)) || {});
  const mutate = (fn) => {
    const run = chain.then(async () => {
      const map = await load();
      fn(map);
      await orca.storage.set(STORE_INSTALLED, map);
    });
    chain = run.catch(() => {});
    return run;
  };
  return {
    get: async (key) => (await load())[key] || null,
    set: (key, value) => mutate((m) => { m[key] = value; }),
    delete: (key) => mutate((m) => { delete m[key]; })
  };
}

const normalizeSelection = (sel) => ({
  global: Boolean(sel?.global),
  projectIds: Array.isArray(sel?.projectIds) ? sel.projectIds.filter((x) => typeof x === 'string') : []
});

const splitLinkDirs = (raw) =>
  String(raw || '').split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);

export default function activate(orca) {
  orca.log('Skill Sync worker activated.');
  const store = createInstalledStore(orca);
  let indexCache = { key: '', index: null, etag: null };

  async function loadConfig() {
    const s = await orca.settings.get();
    const token = await orca.secrets.get(SECRET_TOKEN);
    return {
      baseUrl: String(s.baseUrl || '').trim(),
      allowInsecureTls: Boolean(s.allowInsecureTls),
      allowHttp: Boolean(s.allowHttp),
      linkDirs: splitLinkDirs(s.linkDirs),
      linkDirsRaw: String(s.linkDirs ?? ''),
      gitExclude: s.gitExclude !== false,
      token: token || ''
    };
  }

  const makeClient = (cfg) =>
    createClient({ baseUrl: cfg.baseUrl, token: cfg.token, insecureTls: cfg.allowInsecureTls, allowHttp: cfg.allowHttp });

  async function ensureIndex(cfg, { refresh = false } = {}) {
    const client = makeClient(cfg);
    const key = `${client.indexUrl}|${cfg.token ? 't' : ''}`;
    if (indexCache.key !== key) indexCache = { key, index: null, etag: null };
    if (indexCache.index && !refresh) return { client, index: indexCache.index, warnings: [] };
    const res = await client.getIndex({ etag: refresh ? indexCache.etag : null });
    if (res.notModified && indexCache.index) return { client, index: indexCache.index, warnings: [] };
    indexCache = { key, index: res.index, etag: res.etag };
    return { client, index: res.index, warnings: res.warnings || [] };
  }

  async function pickEntries(index, names) {
    if (!Array.isArray(names) || !names.length) throw badParams('請至少選一個 skill');
    const want = new Set(names);
    const entries = index.skills.filter((s) => want.has(s.name));
    const missing = names.filter((n) => !entries.some((e) => e.name === n));
    if (missing.length) throw badParams(`技能庫目前沒有：${missing.join('、')}（可能已下架，請重新整理）`);
    return entries;
  }

  async function basesFor(selection) {
    const targets = await listTargets(orca);
    return { targets, bases: resolveBases(targets, normalizeSelection(selection)) };
  }

  // ---------- 設定 ----------

  orca.panels.handle('skills.getConfig', async () => {
    const cfg = await loadConfig();
    const profile = (await orca.storage.get(STORE_PROFILE)) || { subscriptions: [], selection: { global: true, projectIds: [] } };
    return {
      baseUrl: cfg.baseUrl,
      hasToken: Boolean(cfg.token),
      allowInsecureTls: cfg.allowInsecureTls,
      allowHttp: cfg.allowHttp,
      linkDirs: cfg.linkDirsRaw,
      gitExclude: cfg.gitExclude,
      profile
    };
  });

  orca.panels.handle('skills.saveConfig', async (input = {}) => {
    if (typeof input.baseUrl === 'string') await orca.settings.set('baseUrl', input.baseUrl.trim());
    if (typeof input.allowInsecureTls === 'boolean') await orca.settings.set('allowInsecureTls', input.allowInsecureTls);
    if (typeof input.allowHttp === 'boolean') await orca.settings.set('allowHttp', input.allowHttp);
    if (typeof input.linkDirs === 'string') await orca.settings.set('linkDirs', input.linkDirs);
    if (typeof input.gitExclude === 'boolean') await orca.settings.set('gitExclude', input.gitExclude);
    if (typeof input.token === 'string' && input.token.trim()) await orca.secrets.set(SECRET_TOKEN, input.token.trim());
    indexCache = { key: '', index: null, etag: null };
    return { ok: true };
  });

  orca.panels.handle('skills.clearToken', async () => {
    await orca.secrets.delete(SECRET_TOKEN);
    indexCache = { key: '', index: null, etag: null };
    return { ok: true };
  });

  orca.panels.handle('skills.saveProfile', async (input = {}) => {
    const subscriptions = Array.isArray(input.subscriptions) ? input.subscriptions.filter((x) => typeof x === 'string') : [];
    await orca.storage.set(STORE_PROFILE, { subscriptions, selection: normalizeSelection(input.selection) });
    return { ok: true };
  });

  // ---------- API 驗證 ----------

  orca.panels.handle('skills.verifyApi', async (input = {}) => {
    const saved = await loadConfig();
    const cfg = {
      ...saved,
      ...(typeof input.baseUrl === 'string' && input.baseUrl.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(typeof input.token === 'string' && input.token.trim() ? { token: input.token.trim() } : {}),
      ...(typeof input.allowInsecureTls === 'boolean' ? { allowInsecureTls: input.allowInsecureTls } : {}),
      ...(typeof input.allowHttp === 'boolean' ? { allowHttp: input.allowHttp } : {})
    };
    return verifyApi(
      { baseUrl: cfg.baseUrl, token: cfg.token, insecureTls: cfg.allowInsecureTls, allowHttp: cfg.allowHttp },
      { maxSkills: 30 }
    );
  });

  // ---------- 清單 / 目標 ----------

  orca.panels.handle('skills.fetchIndex', async (input = {}) => {
    const cfg = await loadConfig();
    const { index, warnings } = await ensureIndex(cfg, { refresh: Boolean(input.refresh) });
    return {
      name: index.name || '',
      generatedAt: index.generatedAt || null,
      skills: index.skills,
      warnings
    };
  });

  orca.panels.handle('skills.listTargets', async () => {
    const t = await listTargets(orca);
    return {
      global: { path: t.global.path },
      projects: t.projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind, paths: p.paths, workspaceCount: p.workspaces.length })),
      remote: t.remote
    };
  });

  // ---------- 規劃 / 同步 / 移除 ----------

  orca.panels.handle('skills.plan', async (input = {}) => {
    const cfg = await loadConfig();
    const { index } = await ensureIndex(cfg);
    const names = Array.isArray(input.names) && input.names.length ? input.names : index.skills.map((s) => s.name);
    const entries = await pickEntries(index, names);
    const { bases } = await basesFor(input.selection);
    const rows = await planSync({ entries, bases, store });
    const details = input.describe ? await describeSkills({ client: makeClient(cfg), entries }) : undefined;
    return { rows, bases: bases.map((b) => ({ key: b.key, label: b.label })), ...(details ? { details } : {}) };
  });

  orca.panels.handle('skills.sync', async (input = {}, ctx) => {
    const cfg = await loadConfig();
    const { client, index } = await ensureIndex(cfg, { refresh: true });
    const entries = await pickEntries(index, input.names);
    const { bases } = await basesFor(input.selection);
    if (!bases.length) throw badParams('請至少選一個同步目標（全域或專案）');
    const force = new Set(Array.isArray(input.force) ? input.force.filter((x) => typeof x === 'string') : []);
    const results = await runSync({
      client, entries, bases, store, force,
      linkDirs: cfg.linkDirs,
      gitExclude: cfg.gitExclude,
      onProgress: (p) => orca.panels.post('skills.progress', p, { panel: ctx?.panel?.id })
    });
    return { results };
  });

  // 面板逐個 skill 呼叫 skills.sync（每次請求有逾時上限），全部完成後再通知一次
  orca.panels.handle('skills.notify', async (input = {}) => {
    const title = String(input.title || 'Skill 同步').slice(0, 80);
    const body = String(input.body || '').slice(0, 200);
    await orca.host.call('notifications.show', { title, body }).catch(() => {});
    return { ok: true };
  });

  orca.panels.handle('skills.remove', async (input = {}) => {
    if (!Array.isArray(input.names) || !input.names.length) throw badParams('請至少選一個 skill');
    const { bases } = await basesFor(input.selection);
    if (!bases.length) throw badParams('請至少選一個目標');
    const force = new Set(Array.isArray(input.force) ? input.force.filter((x) => typeof x === 'string') : []);
    return { results: await runRemove({ names: input.names, bases, store, force }) };
  });
}
