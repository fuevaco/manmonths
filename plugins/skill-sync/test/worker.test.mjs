import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import activate from '../worker/index.mjs';
import { startServer } from '../tools/mock-server.mjs';

const skillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'skills');
const cleanup = [];
after(async () => { for (const c of cleanup) await c(); });

// 最小的假 Orca：儲存、設定、祕密都放記憶體，host.call 回傳測試用的專案與工作區
function fakeOrca({ projects, workspaces }) {
  const handlers = new Map();
  const mem = (init = {}) => { const m = new Map(Object.entries(init)); return m; };
  const settings = mem({ baseUrl: '', linkDirs: '.claude/skills', gitExclude: false, allowInsecureTls: false, allowHttp: false });
  const secrets = mem();
  const storage = mem();
  const notified = [];
  const orca = {
    log() {},
    settings: {
      get: async (k) => (k ? settings.get(k) : Object.fromEntries(settings)),
      set: async (k, v) => void settings.set(k, v)
    },
    secrets: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) },
    storage: { get: async (k) => storage.get(k) ?? null, set: async (k, v) => void storage.set(k, JSON.parse(JSON.stringify(v))), delete: async (k) => void storage.delete(k) },
    host: {
      call: async (method, params) => {
        if (method === 'project.list') return { projects, truncated: false };
        if (method === 'workspace.list') return { workspaces, truncated: false };
        if (method === 'notifications.show') { notified.push(params); return { delivered: true }; }
        throw new Error(`unexpected host call ${method}`);
      }
    },
    panels: { handle: (name, fn) => handlers.set(name, fn), post() {} }
  };
  activate(orca);
  return { call: (name, input) => handlers.get(name)(input, { panel: { id: 'p1' } }), handlers, notified, secrets, settings, storage };
}

test('worker 完整流程：設定 → 驗證 → 清單 → 規劃 → 同步 → 再同步 → 移除', async () => {
  const srv = await startServer({ skillsDir, token: 'tok', prefix: '/api/v1' });
  cleanup.push(() => srv.close());

  const repoA = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-A-'));
  const wtA = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-A-wt-'));
  const repoB = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-B-'));
  for (const d of [repoA, wtA, repoB]) cleanup.push(() => fs.rm(d, { recursive: true, force: true }));
  await fs.mkdir(path.join(repoA, '.claude'));
  await fs.mkdir(path.join(wtA, '.claude'));

  const w = fakeOrca({
    projects: [
      { id: 'pA', name: 'Alpha', kind: 'git', hostId: 'local', path: repoA },
      { id: 'pB', name: 'Beta', kind: 'git', hostId: 'local', path: repoB },
      { id: 'pR', name: 'Remote', kind: 'git', hostId: 'ssh:box', path: '/srv/x' },
      { id: 'pH', name: 'Hidden', kind: 'git', hostId: 'local', path: '/nowhere', hidden: true }
    ],
    workspaces: [
      { id: 'w1', kind: 'worktree', name: 'main', projectId: 'pA', path: repoA, branch: 'main', hostId: 'local' },
      { id: 'w2', kind: 'worktree', name: 'feat', projectId: 'pA', path: wtA, branch: 'feat', hostId: 'local' }
    ]
  });

  // 沒設定時給清楚的錯誤
  await assert.rejects(w.call('skills.fetchIndex', {}), /API 網址/);

  await w.call('skills.saveConfig', { baseUrl: srv.url, token: 'tok' });
  const cfg = await w.call('skills.getConfig');
  assert.equal(cfg.hasToken, true);
  assert.equal('token' in cfg, false, 'Token 不可回傳給面板');
  assert.equal(w.secrets.get('registry_token'), 'tok');

  const rep = await w.call('skills.verifyApi', {});
  assert.ok(rep.ok, JSON.stringify(rep.checks.filter((c) => c.status === 'fail')));

  const idx = await w.call('skills.fetchIndex', { refresh: true });
  assert.deepEqual(idx.skills.map((s) => s.name).sort(), ['commit-helper', 'hello-skill']);

  const targets = await w.call('skills.listTargets');
  assert.deepEqual(targets.projects.map((p) => p.name), ['Alpha', 'Beta'], '隱藏的專案不列出');
  assert.equal(targets.remote.length, 1);
  assert.equal(targets.projects[0].paths.length, 2, 'Alpha = 專案根目錄 + 另一個工作樹');

  const selection = { global: false, projectIds: ['pA', 'pB'] };
  const plan = await w.call('skills.plan', { names: ['hello-skill'], selection, describe: true });
  assert.equal(plan.rows.length, 3);
  assert.ok(plan.rows.every((r) => r.action === 'install'));
  assert.equal(plan.details[0].runnable.length, 0);
  const plan2 = await w.call('skills.plan', { names: ['commit-helper'], selection, describe: true });
  assert.deepEqual(plan2.details[0].runnable, ['scripts/summarize.sh'], '含指令碼的 skill 必須在預覽中標出');

  const res = await w.call('skills.sync', { names: ['hello-skill', 'commit-helper'], selection });
  assert.equal(res.results.filter((r) => r.action === 'installed').length, 6);
  for (const d of [repoA, wtA, repoB]) {
    assert.ok(await fs.stat(path.join(d, '.agents', 'skills', 'hello-skill', 'SKILL.md')));
  }
  assert.ok(await fs.lstat(path.join(wtA, '.claude', 'skills', 'hello-skill')), '有 .claude 的目標建立連結');
  await assert.rejects(fs.lstat(path.join(repoB, '.claude')), '沒有 .claude 的專案不被建立');

  const again = await w.call('skills.sync', { names: ['hello-skill'], selection });
  assert.ok(again.results.every((r) => r.action === 'unchanged'));

  await w.call('skills.saveProfile', { subscriptions: ['hello-skill'], selection });
  assert.deepEqual((await w.call('skills.getConfig')).profile.subscriptions, ['hello-skill']);

  const rm = await w.call('skills.remove', { names: ['hello-skill'], selection });
  assert.ok(rm.results.every((r) => r.action === 'removed'));
  await assert.rejects(fs.lstat(path.join(repoA, '.agents', 'skills', 'hello-skill')));

  await assert.rejects(w.call('skills.sync', { names: ['no-such-skill'], selection }), /沒有/);
  await assert.rejects(w.call('skills.sync', { names: ['hello-skill'], selection: { global: false, projectIds: [] } }), /目標/);

  await w.call('skills.notify', { title: 'x', body: 'y' });
  assert.equal(w.notified.length, 1);

  await w.call('skills.clearToken');
  assert.equal((await w.call('skills.getConfig')).hasToken, false);
});
