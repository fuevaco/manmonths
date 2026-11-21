// 對照 LC-AI-Pack CanonicalRootResolver、LcAiPackHome、CodexRootLocator／CodexRootLayout：
// Windows 與 macOS 的規則都以注入平台的方式在任一作業系統驗證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';
import { locateCodexRoots, memoryProbe } from '../worker/deploy/codex-roots.mjs';
import { resolveLcAiPackHome } from '../worker/paths.mjs';
import { HostProfiles } from '../worker/deploy/host-profiles.mjs';
import { resolveDestination } from '../worker/deploy/resource-drivers.mjs';

test('Windows 與 macOS 的正規化根目錄一律小寫、去除結尾分隔符；Linux 保留大小寫', () => {
  const win = createPathRules({ platform: 'win32', resolveLinks: false });
  assert.equal(win.normalize('C:\\Users\\Alice\\.Codex\\'), 'c:\\users\\alice\\.codex');
  assert.equal(win.normalize('C:/Users/Alice/./x/../.codex'), 'c:\\users\\alice\\.codex');
  assert.equal(win.normalize('C:\\'), 'c:\\');
  const mac = createPathRules({ platform: 'darwin', resolveLinks: false });
  assert.equal(mac.normalize('/Users/Alice/.Codex/'), '/users/alice/.codex');
  assert.equal(mac.normalize('/'), '/');
  const linux = createPathRules({ platform: 'linux', resolveLinks: false });
  assert.equal(linux.normalize('/home/Alice/.codex'), '/home/Alice/.codex');
  assert.equal(win.isWithin('C:\\Users\\Alice', 'c:\\users\\alice\\.codex\\skills'), true);
  assert.equal(win.isWithin('C:\\Users\\Alice', 'C:\\Users\\AliceX'), false);
  assert.equal(mac.isWithin('/Users/a/.codex', '/users/a/.codex'), true);
});

test('macOS 的 LC-AI-Pack 資料目錄為 ~/.lcaipack，LCAIPACK_HOME 有值時覆寫', () => {
  assert.equal(resolveLcAiPackHome({ env: {}, platform: 'darwin', homedir: '/Users/alice' }), '/Users/alice/.lcaipack');
  assert.equal(resolveLcAiPackHome({ env: { LCAIPACK_HOME: '/tmp/lc' }, platform: 'darwin', homedir: '/Users/alice' }), '/tmp/lc');
});

test('只解析最深一層已存在節點本身的連結；不存在的尾端保持宣告形式', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-canon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'Real');
  await mkdir(real);
  const link = path.join(dir, 'link');
  await symlink(real, link, 'junction');
  const rules = createPathRules();
  const fold = (p) => (['win32', 'darwin'].includes(process.platform) ? p.toLowerCase() : p);
  assert.equal(rules.normalize(path.join(link, 'skills', 'x')), fold(path.join(real, 'skills', 'x')));
  assert.equal(rules.normalize(path.join(dir, 'missing', 'y')), fold(path.join(dir, 'missing', 'y')));
});

test('Codex 根目錄：家目錄第一層 .codex* 且含 config.toml 或 auth.json；排除工具備份；主根優先', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'rc-codex-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [name, marker] of [['.codex', 'config.toml'], ['.codex-work', 'auth.json'], ['.codex-empty', null], ['.codex.bak-lcaipack-20260101000000', 'config.toml']]) {
    await mkdir(path.join(home, name));
    if (marker) await writeFile(path.join(home, name, marker), '');
  }
  await writeFile(path.join(home, '.codexrc'), '');
  const roots = locateCodexRoots({ userHome: home, env: {} });
  const rules = createPathRules();
  assert.deepEqual(roots.map(r => r.canonicalRoot), [rules.normalize(path.join(home, '.codex')), rules.normalize(path.join(home, '.codex-work'))]);
  assert.deepEqual(roots.map(r => r.isPrimary), [true, false]);
  assert.equal(roots[0].origin, 'HomeScan');
});

test('CODEX_HOME 指定的設定根也會列出，來源記為環境指定', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'rc-codex-env-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const custom = path.join(home, 'elsewhere', 'codex-profile');
  await mkdir(custom, { recursive: true });
  await writeFile(path.join(custom, 'config.toml'), '');
  const roots = locateCodexRoots({ userHome: home, env: { CODEX_HOME: custom } });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].origin, 'ConfigDirEnvironment');
  assert.equal(roots[0].displayPath, custom);
});

test('macOS 的 Codex 全域 Skill 目的地：設定根與舊式家目錄根皆使用 ~/.agents/skills/{id}', () => {
  const rules = createPathRules({ platform: 'darwin', resolveLinks: false });
  const route = HostProfiles.findRoute(HostProfiles.find('codex').findSurface('codex-cli'), 'skill');
  const ctx = (root) => ({ scope: 'global', canonicalRoot: rules.normalize(root), userHome: rules.normalize('/Users/Alice'), rules, host: { hostId: 'codex', surfaceId: 'codex-cli' } });
  assert.equal(resolveDestination(route, ctx('/Users/Alice/.codex'), 'hello').destination, '/users/alice/.agents/skills/hello');
  assert.equal(resolveDestination(route, ctx('/Users/Alice'), 'hello').destination, '/users/alice/.agents/skills/hello');});

test('macOS 的 Codex 根目錄偵測與正規化（不需 macOS 主機）', () => {
  const probe = memoryProbe({
    dirs: ['/Users/Alice', '/Users/Alice/.codex', '/Users/Alice/.codex-b', '/Volumes/Data/Codex'],
    files: ['/Users/Alice/.codex/config.toml', '/Users/Alice/.codex-b/auth.json', '/Volumes/Data/Codex/config.toml']
  });
  const roots = locateCodexRoots({ userHome: '/Users/Alice', env: { CODEX_HOME: '/Volumes/Data/Codex' }, platform: 'darwin', probe });
  assert.deepEqual(roots.map(r => [r.canonicalRoot, r.displayPath, r.isPrimary, r.origin]), [
    ['/users/alice/.codex', '/Users/Alice/.codex', true, 'HomeScan'],
    ['/users/alice/.codex-b', '/Users/Alice/.codex-b', false, 'HomeScan'],
    ['/volumes/data/codex', '/Volumes/Data/Codex', false, 'ConfigDirEnvironment']
  ]);
});
