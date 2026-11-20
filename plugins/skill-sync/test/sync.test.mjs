import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/mock-server.mjs';
import { createClient } from '../worker/api-client.mjs';
import { planSync, runSync, runRemove } from '../worker/sync-core.mjs';
import { installSkill } from '../worker/installer.mjs';
import { sha256Hex } from '../worker/spec.mjs';

const exampleSkills = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'skills');
const cleanup = [];
const mkTmp = async (label) => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `skill-sync-${label}-`));
  cleanup.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};
after(async () => { for (const c of cleanup) await c(); });

const memStore = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) || null, set: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k), map: m };
};

// 建立一份可修改的 skills 副本 + 對應的模擬伺服器
async function registry(mutate) {
  const dir = await mkTmp('reg');
  await fs.cp(exampleSkills, dir, { recursive: true });
  await mutate?.(dir);
  const srv = await startServer({ skillsDir: dir, token: 't', prefix: '/v1' });
  cleanup.push(() => srv.close());
  const client = createClient({ baseUrl: srv.url, token: 't' });
  const { index } = await client.getIndex();
  return { dir, srv, client, entries: index.skills };
}

const exists = (p) => fs.lstat(p).then(() => true, () => false);

async function project({ withClaude = true, git = false } = {}) {
  const base = await mkTmp('proj');
  if (withClaude) await fs.mkdir(path.join(base, '.claude'));
  if (git) spawnSync('git', ['init', '-q'], { cwd: base });
  return { key: base, label: path.basename(base), base };
}

test('全新安裝：實體檔案在 .agents/skills，並連結到已存在的 .claude/skills', async () => {
  const { client, entries } = await registry();
  const store = memStore();
  const home = await mkTmp('home');
  const b = await project();
  const res = await runSync({ client, entries, bases: [b], store, linkDirs: ['.claude/skills'], gitExclude: false, homeDir: home });
  assert.deepEqual(res.map((r) => r.action).sort(), ['installed', 'installed']);
  const real = path.join(b.base, '.agents', 'skills', 'hello-skill', 'SKILL.md');
  assert.match(await fs.readFile(real, 'utf8'), /Hello Skill/);
  // 透過連結讀得到同一份內容
  assert.match(await fs.readFile(path.join(b.base, '.claude', 'skills', 'hello-skill', 'SKILL.md'), 'utf8'), /Hello Skill/);
  assert.ok((await fs.lstat(path.join(b.base, '.claude', 'skills', 'hello-skill'))).isSymbolicLink());
  assert.ok(await exists(path.join(b.base, '.agents', 'skills', 'commit-helper', 'scripts', 'summarize.sh')));
  // 沒有殘留暫存資料夾
  assert.deepEqual((await fs.readdir(path.join(b.base, '.agents', 'skills'))).filter((n) => n.includes('tmp') || n.includes('.old-')), []);
});

test('專案沒有 .claude 資料夾就不替它建立（與 Orca 行為一致）', async () => {
  const { client, entries } = await registry();
  const b = await project({ withClaude: false });
  await runSync({ client, entries, bases: [b], store: memStore(), linkDirs: ['.claude/skills'], gitExclude: false });
  assert.ok(await exists(path.join(b.base, '.agents', 'skills', 'hello-skill')));
  assert.equal(await exists(path.join(b.base, '.claude')), false);
});

test('重複同步不變；遠端有新版就更新，並保留紀錄', async () => {
  const store = memStore();
  const b = await project();
  const v1 = await registry();
  const opts = { bases: [b], store, linkDirs: ['.claude/skills'], gitExclude: false };
  await runSync({ client: v1.client, entries: v1.entries, ...opts });
  const again = await runSync({ client: v1.client, entries: v1.entries, ...opts });
  assert.ok(again.every((r) => r.action === 'unchanged'), JSON.stringify(again));

  const v2 = await registry(async (dir) => {
    const f = path.join(dir, 'hello-skill', 'SKILL.md');
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('version: 1.0.0', 'version: 1.1.0') + '\n新增一行。\n');
  });
  const plan = await planSync({ entries: v2.entries, bases: [b], store });
  assert.equal(plan.find((r) => r.name === 'hello-skill').action, 'update');
  assert.equal(plan.find((r) => r.name === 'commit-helper').action, 'none');
  const res = await runSync({ client: v2.client, entries: v2.entries, ...opts });
  assert.equal(res.find((r) => r.name === 'hello-skill').action, 'updated');
  assert.match(await fs.readFile(path.join(b.base, '.claude', 'skills', 'hello-skill', 'SKILL.md'), 'utf8'), /新增一行/);
  assert.equal((await store.get([...store.map.keys()].find((k) => k.endsWith('|hello-skill')))).version, '1.1.0');
});

test('安裝後被你改過的副本：預設不覆蓋；明確同意才取代並備份', async () => {
  const store = memStore();
  const home = await mkTmp('home');
  const b = await project();
  const v1 = await registry();
  const opts = { bases: [b], store, linkDirs: [], gitExclude: false, homeDir: home };
  await runSync({ client: v1.client, entries: v1.entries, ...opts });
  const mine = path.join(b.base, '.agents', 'skills', 'hello-skill', 'SKILL.md');
  await fs.appendFile(mine, '\n我自己加的筆記\n');

  const v2 = await registry(async (dir) => {
    await fs.appendFile(path.join(dir, 'hello-skill', 'SKILL.md'), '\n遠端新內容\n');
  });
  const plan = await planSync({ entries: v2.entries, bases: [b], store });
  assert.equal(plan.find((r) => r.name === 'hello-skill').state, 'modified');
  const skipped = await runSync({ client: v2.client, entries: v2.entries, ...opts });
  assert.equal(skipped.find((r) => r.name === 'hello-skill').action, 'skipped');
  assert.match(await fs.readFile(mine, 'utf8'), /我自己加的筆記/);

  const forced = await runSync({ client: v2.client, entries: v2.entries, ...opts, force: new Set([`hello-skill|${b.key}`]) });
  const r = forced.find((x) => x.name === 'hello-skill');
  assert.equal(r.action, 'updated');
  assert.ok(r.backup, '取代前必須備份');
  assert.match(await fs.readFile(path.join(r.backup, 'SKILL.md'), 'utf8'), /我自己加的筆記/);
  assert.match(await fs.readFile(mine, 'utf8'), /遠端新內容/);
});

test('已有同名、非本外掛安裝的資料夾（foreign）：不動它；內容相同則直接認養', async () => {
  const { client, entries } = await registry();
  const store = memStore();
  const b = await project();
  const dir = path.join(b.base, '.agents', 'skills', 'hello-skill');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), '我自己寫的同名 skill');
  const res = await runSync({ client, entries, bases: [b], store, gitExclude: false });
  assert.equal(res.find((r) => r.name === 'hello-skill').action, 'skipped');
  assert.equal(res.find((r) => r.name === 'hello-skill').reason, 'foreign');
  assert.equal(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), '我自己寫的同名 skill');

  // 內容與遠端完全一致（例如先前用 Orca 裝過）→ 認養，不重寫
  const b2 = await project();
  const first = await runSync({ client, entries, bases: [b2], store: memStore(), gitExclude: false });
  const store3 = memStore();
  const adopt = await runSync({ client, entries, bases: [b2], store: store3, gitExclude: false });
  assert.ok(first.every((r) => r.action === 'installed'));
  assert.ok(adopt.every((r) => r.action === 'adopted'), JSON.stringify(adopt));
});

test('寫入 .git/info/exclude：同步後 git status 乾淨，且 .gitignore 沒被動到', async () => {
  const { client, entries } = await registry();
  const b = await project({ git: true });
  await runSync({ client, entries, bases: [b], store: memStore(), linkDirs: ['.claude/skills'], gitExclude: true });
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: b.base, encoding: 'utf8' }).stdout;
  assert.equal(status.trim(), '', `git status 應為空，實際：\n${status}`);
  assert.equal(await exists(path.join(b.base, '.gitignore')), false);
});

test('移除：沒改過的連同連結一起移除；改過的保留', async () => {
  const { client, entries } = await registry();
  const store = memStore();
  const home = await mkTmp('home');
  const b = await project();
  await runSync({ client, entries, bases: [b], store, linkDirs: ['.claude/skills'], gitExclude: false });
  await fs.appendFile(path.join(b.base, '.agents', 'skills', 'commit-helper', 'SKILL.md'), '\n改過\n');

  const res = await runRemove({ names: ['hello-skill', 'commit-helper'], bases: [b], store, homeDir: home });
  assert.equal(res.find((r) => r.name === 'hello-skill').action, 'removed');
  assert.equal(res.find((r) => r.name === 'commit-helper').action, 'skipped');
  assert.equal(await exists(path.join(b.base, '.agents', 'skills', 'hello-skill')), false);
  assert.equal(await exists(path.join(b.base, '.claude', 'skills', 'hello-skill')), false, '連結也要一起移除');
  assert.ok(await exists(path.join(b.base, '.agents', 'skills', 'commit-helper')));

  const forced = await runRemove({ names: ['commit-helper'], bases: [b], store, homeDir: home, force: new Set([`commit-helper|${b.key}`]) });
  assert.ok(forced[0].backup);
  assert.equal(await exists(path.join(b.base, '.agents', 'skills', 'commit-helper')), false);
});

test('移除不會碰到不是我們建立的 .claude/skills 同名項目', async () => {
  const { client, entries } = await registry();
  const store = memStore();
  const b = await project();
  const theirs = path.join(b.base, '.claude', 'skills', 'hello-skill');
  await fs.mkdir(theirs, { recursive: true });
  await fs.writeFile(path.join(theirs, 'SKILL.md'), '別人的');
  const res = await runSync({ client, entries, bases: [b], store, linkDirs: ['.claude/skills'], gitExclude: false });
  const links = res.find((r) => r.name === 'hello-skill').links;
  assert.equal(links[0].mode, 'conflict');
  await runRemove({ names: ['hello-skill'], bases: [b], store });
  assert.equal(await fs.readFile(path.join(theirs, 'SKILL.md'), 'utf8'), '別人的');
});

test('安裝器拒絕危險路徑，且失敗不留下半套檔案', async () => {
  const b = await project();
  const bytes = Buffer.from('x');
  await assert.rejects(
    installSkill({
      base: b.base, name: 'evil', version: '1.0.0', digest: 'sha256:' + '0'.repeat(64),
      files: [{ path: 'SKILL.md', bytes }, { path: '../../escape.txt', bytes }]
    })
  );
  assert.equal(await exists(path.join(b.base, 'escape.txt')), false);
  assert.equal(await exists(path.join(b.base, '..', 'escape.txt')), false);
  const root = path.join(b.base, '.agents', 'skills');
  assert.deepEqual(await fs.readdir(root), [], '暫存資料夾必須被清掉');
  await assert.rejects(installSkill({ base: b.base, name: '../bad', version: '1.0.0', digest: sha256Hex('x'), files: [] }));
});

test('單一 skill 下載失敗不影響其他 skill，且失敗者不會寫入', async () => {
  const s = await startServer({ skillsDir: exampleSkills, token: 't', prefix: '/v1', tamper: 'hello-skill', tamperMode: 'flip' });
  cleanup.push(() => s.close());
  const client = createClient({ baseUrl: s.url, token: 't' });
  const { index } = await client.getIndex();
  const b = await project();
  const res = await runSync({ client, entries: index.skills, bases: [b], store: memStore(), gitExclude: false });
  assert.equal(res.find((r) => r.name === 'hello-skill').action, 'error');
  assert.equal(res.find((r) => r.name === 'commit-helper').action, 'installed');
  assert.equal(await exists(path.join(b.base, '.agents', 'skills', 'hello-skill')), false);
});
