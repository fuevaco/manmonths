// 多部署目標測試環境（工項 12）：假市集＋臨時家目錄＋三個全域部署目標（Codex、Claude Code 主根、Claude Code 第二根）。
// 全部是合成資料；套用與回報都走 worker 請求契約。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeMarket } from './fake-market.mjs';
import { startWorker } from './harness.mjs';
import { zip } from './zip-fixture.mjs';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';

export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const rules = createPathRules();
export const skillText = (version) => `---\nname: demo-skill\ndescription: Synthetic skill\n---\nVersion ${version}\n`;

export function build(key, version) {
  const manifest = { packageFormatVersion: 1, key, name: key, type: 'skill', version, description: 'Synthetic',
    contents: [{ id: 'demo-skill', kind: 'skill', path: 'resources/skills/demo-skill' }] };
  return zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# 合成', 'resources/skills/demo-skill/SKILL.md': skillText(version),
    'resources/skills/demo-skill/notes.md': `notes ${version}` });
}

/**
 * @param {object} t  node:test context
 * @param {{packages?: Record<string, string[]>, workerDeps?: object}} [options]
 */
export async function setupMulti(t, { packages = { 'pkg-a': ['1.0.0', '1.1.0'] }, workerDeps = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-multi-'));
  const userHome = path.join(dir, 'home');
  const roots = { codex: path.join(userHome, '.codex'), claude: path.join(userHome, '.claude'), claudeWork: path.join(userHome, '.claude-work') };
  fs.mkdirSync(roots.codex, { recursive: true });
  fs.writeFileSync(path.join(roots.codex, 'config.toml'), 'model = "synthetic"\n');
  for (const root of [roots.claude, roots.claudeWork]) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'settings.json'), '{}'); }
  const lcaipackHome = path.join(dir, 'lcaipack');
  // 套件值可以是版本陣列（合成單一 Skill 的資源包），或 { 版本: ZIP bytes }（自備 ZIP，例如含設定命令的組合包）。
  const versionsOf = (spec) => Array.isArray(spec) ? spec : Object.keys(spec);
  const market = await startFakeMarket({ packages: Object.entries(packages).map(([k, v]) => ({ packageKey: k, name: k, type: 'skill', description: 'Synthetic', latestReleaseVersion: versionsOf(v).at(-1) })) });
  const installs = [];
  for (const [key, spec] of Object.entries(packages)) {
    const versions = versionsOf(spec);
    const zips = Array.isArray(spec) ? Object.fromEntries(versions.map(v => [v, build(key, v)])) : spec;
    market.override(`GET /api/market/packages/${key}`, () => ({ status: 200, body: { packageKey: key, name: key, type: 'skill', description: 'Synthetic',
      recommendedVersion: versions.at(-1), versions: versions.map(v => ({ version: v, isEnabled: true, channel: 'release', status: 'active', hosts: ['codex', 'claude-code'], sha256: sha(zips[v]) })) } }));
    for (const v of versions) {
      market.override(`GET /api/market/packages/${key}/versions/${v}/readme`, () => ({ status: 200, body: { readme: '# 合成' } }));
      market.override(`GET /api/market/packages/${key}/versions/${v}/download`, () => ({ status: 200, raw: zips[v], headers: { 'X-Checksum-Sha256': sha(zips[v]) }, contentType: 'application/zip' }));
      market.override(`POST /api/market/packages/${key}/versions/${v}/installs`, (_req, body) => { installs.push({ key, version: v, body }); return { status: 200, body: { installCount: installs.length } }; });
    }
  }
  const worker = startWorker({ deps: { lcaipackHome, userHome, env: {}, ...workerDeps } });
  t.after(async () => { worker.dispose(); await market.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  const receipts = () => { try { return JSON.parse(fs.readFileSync(path.join(lcaipackHome, 'receipts.json'), 'utf8')).receipts; } catch { return []; } };
  const dest = (root, name = 'demo-skill') => path.join(rules.normalize(root), 'skills', name);

  /** 以三個全域目標規劃：回傳每個根的目標 id。 */
  async function targets(extra = {}) {
    const { targets: list } = await worker.call('rc.deploy.listTargets', extra);
    const byRoot = (root) => list.find(x => rules.normalize(x.rootPath) === rules.normalize(root) && x.surfaceId !== 'claude-desktop');
    return { list, codex: byRoot(roots.codex), claude: byRoot(roots.claude), claudeWork: byRoot(roots.claudeWork) };
  }
  async function plan(packageKey, version, targetIds, extra = {}) {
    return worker.call('rc.deploy.plan', { packageKey, version, targets: targetIds, ...extra });
  }
  const apply = (summary, targetIds) => worker.call('rc.deploy.apply', { planDigest: summary.planDigest, targets: targetIds });
  return { dir, userHome, roots, lcaipackHome, market, installs, worker, receipts, dest, targets, plan, apply };
}
