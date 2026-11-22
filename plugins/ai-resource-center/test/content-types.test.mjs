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
    if (marker) await writeFile(path.join(p, marker), marker === 'config.toml' ? '' : '{}');
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
  const w = await marketplace(t,e,[{id:'demo-skill',kind:'skill',path:'resources/skill'}],{'resources/skill/SKILL.md':skill});
  // 全域偵測仍需環境變數：重開已登入的 worker。
  w.dispose();
  const worker = startWorker({ state:w.state, deps:{...e,env:{CLAUDE_CONFIG_DIR:primary}} }); t.after(()=>worker.dispose());
  const result = await worker.call('rc.install.run',{packageKey:'synthetic-kit',action:'install'});
  assert.equal(result.ok,true);
  assert.deepEqual(result.succeeded.map(t=>t.rootPath).sort(),[primary,work,custom].sort());
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

test('一鍵將 Skill 部署到所有 Codex 與 Claude Code 根，收據與二進位資產可讀回', async t => {
  const e = await environment(t);
  await e.root('.codex', 'config.toml'); await e.root('.claude'); await e.root('.claude-work');
  const untouched = await e.root('.claude-unselected');
  const w = await marketplace(t, e, [{ id: 'demo-skill', kind: 'skill', path: 'resources/skill' }], { 'resources/skill/SKILL.md': skill, 'resources/skill/assets/icon.bin': Buffer.from([0, 255, 1]) });
  const result = await w.call('rc.install.run',{packageKey:selection.packageKey,action:'install'});
  assert.equal(result.ok,true);
  const ids = result.succeeded.map(t=>t.targetId);
  const receipts = JSON.parse(await readFile(path.join(e.lcaipackHome, 'receipts.json'), 'utf8')).receipts;
  assert.equal(receipts.length, 4);
  assert.deepEqual(receipts.map(r => r.targetKey).sort(), [...ids].sort());
  for (const r of receipts) {
    assert.equal(await readFile(path.join(r.destinationPath, 'SKILL.md'), 'utf8'), skill);
    assert.deepEqual(await readFile(path.join(r.destinationPath, 'assets/icon.bin')), Buffer.from([0, 255, 1]));
    assert.equal(r.targetKey, `${r.hostId}|${r.surfaceId}|global|${r.canonicalRoot}`);
  }
  assert.deepEqual((await w.call('rc.install.run',{packageKey:selection.packageKey,action:'install'})).backups,[]);
});

for (const scope of ['global']) test(`Prompt 與 Command 在 ${scope} 範圍依工具載入面寫入，正規化 BOM／換行並寫收據`, async t => {
  const e = await environment(t); await e.root('.codex', 'config.toml'); await e.root('.claude');
  const w = await marketplace(t, e, ['prompt', 'command'].map(kind => ({ id: `demo-${kind}`, name: kind, kind, path: `resources/${kind}.md` })), {
    'resources/prompt.md': '\uFEFF# Prompt\r\nBody\r\n\r\n', 'resources/command.md': '# Command\rBody\r'
  });
  const result = await w.call('rc.install.run',{packageKey:selection.packageKey,action:'install'});
  assert.equal(result.ok,true); assert.equal(result.succeeded.length,2);
  const targets = result.succeeded.map(t=>({...t,id:t.targetId,canonicalRoot:t.rootPath}));
  for (const target of targets) for (const kind of ['prompt', 'command']) {
    const folder = target.hostId === 'codex' ? 'prompts' : 'commands';
    const prefix = scope === 'project' ? (target.hostId === 'codex' ? '.codex' : '.claude') : '';
    const destination = path.join(target.canonicalRoot, prefix, folder, `demo-${kind}.md`);
    assert.equal(await readFile(destination, 'utf8'), `# ${kind === 'prompt' ? 'Prompt' : 'Command'}\nBody\n`);
  }
  const receiptsPath = scope === 'global' ? path.join(e.lcaipackHome, 'receipts.json') : path.join(e.userHome, '.lcaipack/receipts.json');
  const receipts = JSON.parse(await readFile(receiptsPath, 'utf8')).receipts;
  assert.equal(receipts.length, 4); assert.ok(receipts.every(r => r.mutationKind === 'WriteFile'));
  assert.deepEqual((await w.call('rc.install.run',{packageKey:selection.packageKey,action:'install'})).backups,[]);
});
for (const scope of ['global']) test(`Agent 在 ${scope} 範圍採用 native 語法、frontmatter 描述與每平台覆寫，揭露未落地欄位`, async t => {
  const e = await environment(t); await e.root('.codex', 'config.toml'); await e.root('.claude');
  const w = await marketplace(t, e, [{ id: 'demo-agent', kind: 'agent', name: 'Manifest name', description: 'Manifest description', path: 'resources/agent.md', hosts: {
    codex: { tools: ['future-tool'], model: 'future-model' }, 'claude-code': { tools: ['Read', 'Grep'], model: 'sonnet' }
  } }], { 'resources/agent.md': '---\nname: display-only\ndescription: Frontmatter description\npermissionMode: bypassPermissions\n---\n\nUse "quotes" and \\path.\n' });
  const result = await w.call('rc.install.run',{packageKey:selection.packageKey,action:'install'}); assert.equal(result.ok,true);
  const targets = result.succeeded.map(t=>({...t,canonicalRoot:t.rootPath}));
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
  const result = await w.call('rc.install.run',{packageKey:selection.packageKey,action:'install'});
  assert.equal(result.ok,true); assert.deepEqual(result.succeeded.map(t=>t.hostId).sort(),['claude-code','codex']);

});


test('檔案類部署中途寫入失敗時，還原先前寫入且不留下新版收據', async t => {
  const e = await environment(t); await e.root('.claude');
  const w = await marketplace(t, e, [
    { id: 'demo-agent', kind: 'agent', name: 'Agent', path: 'resources/agent.md' },
    { id: 'demo-prompt', kind: 'prompt', name: 'Prompt', path: 'resources/prompt.md' }
  ], { 'resources/agent.md': '# Agent', 'resources/prompt.md': '# Prompt' });
  await writeFile(path.join(e.userHome,'.claude','commands'),'blocked-parent');
  const result = await w.call('rc.install.run',{packageKey:selection.packageKey,action:'install'});
  assert.equal(result.ok,false); assert.equal(result.failed.length,1);
  await assert.rejects(readFile(path.join(e.userHome,'.claude','agents','demo-agent.md')),{code:'ENOENT'});
  await assert.rejects(readFile(path.join(e.lcaipackHome,'receipts.json')),{code:'ENOENT'});

});

