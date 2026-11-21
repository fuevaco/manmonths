import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startWorker } from './harness.mjs';

async function environment(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-kinds-'));
  const userHome = path.join(dir, 'home'), lcaipackHome = path.join(dir, 'state');
  await mkdir(userHome); await mkdir(lcaipackHome);
  const root = async (name, marker = 'settings.json') => {
    const p = path.join(userHome, name); await mkdir(p, { recursive: true });
    if (marker) await writeFile(path.join(p, marker), '{}');
    return p;
  };
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, userHome, lcaipackHome, root };
}

test('Claude Code 只枚舉第一層有效設定根，合併環境與手動根、排除備份與使用者排除根', async t => {
  const e = await environment(t);
  const primary = await e.root('.claude');
  const work = await e.root('.claude-work', '.claude.json');
  await e.root('.claude-empty', null);
  await e.root('.claude.bak-lcaipack-20260101');
  await e.root('.claude-worktrees/repo/.claude');
  const excluded = await e.root('.claude-excluded');
  const custom = await e.root('custom-profile');
  await writeFile(path.join(e.lcaipackHome, 'config.json'), JSON.stringify({ manualClientRoots: { 'claude-code': [custom, work] }, excludedClientRoots: { 'claude-code': [excluded] } }));
  const w = startWorker({ deps: { ...e, env: { CLAUDE_CONFIG_DIR: primary } } }); t.after(w.dispose);
  const { targets } = await w.call('rc.deploy.listTargets', {});
  assert.deepEqual(targets.map(t => t.rootPath), [primary, work, custom]);
  assert.equal(new Set(targets.map(t => t.id)).size, 3);
  assert.ok(targets.every(t => t.hostId === 'claude-code' && t.surfaceId === 'claude-code-cli' && t.scope === 'global'));
  assert.equal(targets[0].origin, 'ConfigDirEnvironment');
  assert.equal(targets[1].origin, 'ManualInclude', '手動增列會升級掃描來源');
  const project = await w.call('rc.deploy.listTargets', { scope: 'project', projectRoot: e.userHome });
  assert.deepEqual(project.targets.map(t => t.hostId), ['codex', 'claude-code']);
});
import { startFakeMarket } from './fake-market.mjs';
import { zip } from './zip-fixture.mjs';
import { createHash } from 'node:crypto';
const hash = b => createHash('sha256').update(b).digest('hex');
const skill = '---\nname: demo-skill\ndescription: Synthetic\ncustom-flag: true\n---\nBody\n';
async function marketplace(t, e, contents, files) {
  const manifest = { packageFormatVersion: 1, key: 'synthetic-kit', name: 'Synthetic kit', description: 'Synthetic', type: 'bundle', version: '1.0.0', contents };
  const bytes = zip({ 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Synthetic', ...files });
  const market = await startFakeMarket();
  market.override('GET /api/market/packages/synthetic-kit', () => ({ status: 200, body: { packageKey: manifest.key, name: manifest.name, type: 'bundle', versions: [{ version: '1.0.0', channel: 'release', isEnabled: true, sha256: hash(bytes), hosts: ['codex', 'claude-code'] }] } }));
  market.override('GET /api/market/packages/synthetic-kit/versions/1.0.0/download', () => ({ status: 200, raw: bytes, headers: { 'X-Checksum-Sha256': hash(bytes) } }));
  const w = startWorker({ deps: { ...e, env: {} } });
  t.after(async () => { w.dispose(); await market.close(); });
  await w.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return w;
}
const selection = { packageKey: 'synthetic-kit', version: '1.0.0' };

test('同一次確認可將 Skill 部署到 Codex 與兩個 Claude Code 根，未選根不寫入且收據可讀回', async t => {
  const e = await environment(t);
  await e.root('.codex', 'config.toml'); await e.root('.claude'); await e.root('.claude-work');
  const untouched = await e.root('.claude-unselected');
  const w = await marketplace(t, e, [{ id: 'demo-skill', kind: 'skill', path: 'resources/skill' }], { 'resources/skill/SKILL.md': skill, 'resources/skill/assets/icon.bin': Buffer.from([0, 255, 1]) });
  const { targets } = await w.call('rc.deploy.listTargets', {});
  const ids = targets.filter(t => t.rootPath !== untouched).map(t => t.id);
  const plan = await w.call('rc.deploy.plan', { ...selection, targets: ids });
  assert.equal(plan.canApply, true); assert.equal(plan.targets.length, 3);
  const result = await w.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: ids });
  assert.equal(result.status, 'succeeded');
  const receipts = JSON.parse(await readFile(path.join(e.lcaipackHome, 'receipts.json'), 'utf8')).receipts;
  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts.map(r => r.targetKey).sort(), [...ids].sort());
  for (const r of receipts) {
    assert.equal(await readFile(path.join(r.destinationPath, 'SKILL.md'), 'utf8'), skill);
    assert.deepEqual(await readFile(path.join(r.destinationPath, 'assets/icon.bin')), Buffer.from([0, 255, 1]));
    assert.equal(r.targetKey, `${r.hostId}|${r.surfaceId}|global|${r.canonicalRoot}`);
  }
  await assert.rejects(readFile(path.join(untouched, 'skills/demo-skill/SKILL.md')), { code: 'ENOENT' });
  const again = await w.call('rc.deploy.plan', { ...selection, targets: ids });
  assert.ok(again.targets.every(t => t.changes[0].change === 'NoOp'));
});

for (const scope of ['global', 'project']) test(`Prompt 與 Command 在 ${scope} 範圍依工具載入面寫入，正規化 BOM／換行並寫收據`, async t => {
  const e = await environment(t); await e.root('.codex', 'config.toml'); await e.root('.claude');
  const w = await marketplace(t, e, ['prompt', 'command'].map(kind => ({ id: `demo-${kind}`, name: kind, kind, path: `resources/${kind}.md` })), {
    'resources/prompt.md': '\uFEFF# Prompt\r\nBody\r\n\r\n', 'resources/command.md': '# Command\rBody\r'
  });
  const options = scope === 'project' ? { scope, projectRoot: e.userHome } : {};
  const { targets } = await w.call('rc.deploy.listTargets', options);
  const ids = targets.map(t => t.id);
  const plan = await w.call('rc.deploy.plan', { ...selection, ...options, targets: ids });
  assert.equal(plan.canApply, true, JSON.stringify(plan.problems));
  assert.equal(plan.targets.length, 2);
  const result = await w.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: ids });
  assert.equal(result.status, 'succeeded');
  for (const target of targets) for (const kind of ['prompt', 'command']) {
    const folder = target.hostId === 'codex' ? 'prompts' : 'commands';
    const prefix = scope === 'project' ? (target.hostId === 'codex' ? '.codex' : '.claude') : '';
    const destination = path.join(target.canonicalRoot, prefix, folder, `demo-${kind}.md`);
    assert.equal(await readFile(destination, 'utf8'), `# ${kind === 'prompt' ? 'Prompt' : 'Command'}\nBody\n`);
    assert.ok(plan.targets.find(t => t.id === target.id).changes.some(c => c.destinationPath === destination));
  }
  const receiptsPath = scope === 'global' ? path.join(e.lcaipackHome, 'receipts.json') : path.join(e.userHome, '.lcaipack/receipts.json');
  const receipts = JSON.parse(await readFile(receiptsPath, 'utf8')).receipts;
  assert.equal(receipts.length, 4); assert.ok(receipts.every(r => r.mutationKind === 'WriteFile'));
  const again = await w.call('rc.deploy.plan', { ...selection, ...options, targets: ids });
  assert.ok(again.targets.every(t => t.changes.every(c => c.change === 'NoOp')));
});
for (const scope of ['global', 'project']) test(`Agent 在 ${scope} 範圍採用 native 語法、frontmatter 描述與每平台覆寫，揭露未落地欄位`, async t => {
  const e = await environment(t); await e.root('.codex', 'config.toml'); await e.root('.claude');
  const w = await marketplace(t, e, [{ id: 'demo-agent', kind: 'agent', name: 'Manifest name', description: 'Manifest description', path: 'resources/agent.md', hosts: {
    codex: { tools: ['future-tool'], model: 'future-model' }, 'claude-code': { tools: ['Read', 'Grep'], model: 'sonnet' }
  } }], { 'resources/agent.md': '---\nname: display-only\ndescription: Frontmatter description\npermissionMode: bypassPermissions\n---\n\nUse "quotes" and \\path.\n' });
  const options = scope === 'project' ? { scope, projectRoot: e.userHome } : {};
  const { targets } = await w.call('rc.deploy.listTargets', options); const ids = targets.map(t => t.id);
  const plan = await w.call('rc.deploy.plan', { ...selection, ...options, targets: ids });
  assert.equal(plan.canApply, true);
  for (const target of plan.targets) {
    assert.ok(target.problems.some(p => p.severity === 'Warning' && /permissionMode/.test(p.explanation + p.summary)));
    if (target.id.startsWith('codex|')) assert.ok(target.problems.some(p => /tools/.test(p.explanation + p.summary)));
  }
  const result = await w.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: ids }); assert.equal(result.status, 'succeeded');
  for (const target of targets) {
    const codex = target.hostId === 'codex';
    const prefix = scope === 'project' ? (codex ? '.codex' : '.claude') : '';
    const text = await readFile(path.join(target.canonicalRoot, prefix, 'agents', `demo-agent.${codex ? 'toml' : 'md'}`), 'utf8');
    assert.doesNotMatch(text, /permissionMode|bypassPermissions|display-only|Manifest description/);
    if (codex) {
      assert.match(text, /name = "demo-agent"/); assert.match(text, /description = "Frontmatter description"/);
      assert.match(text, /model = "future-model"/); assert.match(text, /developer_instructions = /); assert.doesNotMatch(text, /tools/);
    } else assert.equal(text, '---\nname: "demo-agent"\ndescription: "Frontmatter description"\ntools: ["Read", "Grep"]\nmodel: "sonnet"\n---\n\nUse "quotes" and \\path.\n');
  }
});
test('目標選項依確切 ZIP 的 MCP 能力篩選，只列支援路由', async t => {
  const e = await environment(t); await e.root('.codex', 'config.toml'); await e.root('.claude');
  const w = await marketplace(t, e, [{ id: 'demo-mcp', kind: 'mcp', name: 'Synthetic MCP', definition: { command: 'synthetic', args: [] } }], {});
  const result = await w.call('rc.deploy.listTargets', selection);
  assert.deepEqual(result.targets.map(t => t.surfaceId).sort(), ['claude-code-cli', 'codex-cli']);
  await assert.rejects(w.call('rc.deploy.listTargets', { ...selection, version: 123 }), { code: 'invalid_params' });
});


test('檔案類部署中途寫入失敗時，還原先前寫入且不留下新版收據', async t => {
  const e = await environment(t); await e.root('.claude');
  const w = await marketplace(t, e, [
    { id: 'demo-agent', kind: 'agent', name: 'Agent', path: 'resources/agent.md' },
    { id: 'demo-prompt', kind: 'prompt', name: 'Prompt', path: 'resources/prompt.md' }
  ], { 'resources/agent.md': '# Agent', 'resources/prompt.md': '# Prompt' });
  const { targets } = await w.call('rc.deploy.listTargets', selection); const ids = targets.map(t => t.id);
  const plan = await w.call('rc.deploy.plan', { ...selection, targets: ids }); assert.equal(plan.canApply, true);
  const changes = plan.targets[0].changes;
  await writeFile(path.dirname(changes[1].destinationPath), 'blocked-parent');
  const result = await w.call('rc.deploy.apply', { planDigest: plan.planDigest, targets: ids });
  assert.equal(result.status, 'failed'); assert.equal(result.targets[0].status, 'rolledBack');
  await assert.rejects(readFile(changes[0].destinationPath), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(e.lcaipackHome, 'receipts.json')), { code: 'ENOENT' });
});

