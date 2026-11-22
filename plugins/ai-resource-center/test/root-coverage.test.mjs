import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMulti, build, rules } from './multi-env.mjs';
import { zip } from './zip-fixture.mjs';

const key = 'coverage-kit';
const skill = { kind: 'skill', id: 'demo-skill', path: 'resources/demo-skill' };
const mcp = { kind: 'mcp', id: 'echo', name: 'Echo', definition: { command: 'echo', args: ['hello'] } };

function deploymentPackage(type, contents, version = '1.0.0') {
  return zip({ 'lcpack.json': JSON.stringify({ packageFormatVersion: 1, key, name: 'Coverage', description: 'Synthetic', type, version, contents }),
    'README.md': '# Coverage', 'resources/demo-skill/SKILL.md': '---\nname: demo-skill\ndescription: Synthetic\n---\nHello\n' });
}

test('updating an MCP-only package also installs a newly added shared Codex skill', async t => {
  const e = await setupMulti(t, { packages: { [key]: {
    '1.0.0': deploymentPackage('mcp', [mcp]), '2.0.0': deploymentPackage('bundle', [mcp, skill], '2.0.0')
  } } });
  assert.equal((await e.run(key)).ok, true);
  e.recommend(key, '2.0.0');

  const result = await e.run(key, 'update');

  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(path.join(e.userHome, '.agents', 'skills', skill.id, 'SKILL.md'), 'utf8'), /Hello/);
  assert.equal(e.receipts().filter(r => r.hostId === 'codex' && r.kind === 'skill').length, 1);
});

function addRoot(e, name) {
  const dir = path.join(e.userHome, name);
  fs.mkdirSync(dir);
  const codex = name.startsWith('.codex');
  fs.writeFileSync(path.join(dir, codex ? 'config.toml' : 'settings.json'), codex ? '' : '{}');
  return dir;
}

for (const [type, contents] of [['skill', [skill]], ['bundle', [skill, mcp]], ['mcp', [mcp]]]) {
  test(`pending roots need root-specific content from a ${type} package`, async t => {
    const e = await setupMulti(t, { packages: { [key]: { '1.0.0': type === 'skill' ? build(key, '1.0.0') : deploymentPackage(type, contents) } } });
    assert.equal((await e.run(key)).ok, true);
    const codex = addRoot(e, '.codex-new');
    const claude = addRoot(e, '.claude-new');
    const detail = async () => e.worker.call('rc.package.getDetails', { packageKey: key });
    const expected = (type === 'skill' ? [claude] : [claude, codex]).sort();
    assert.deepEqual((await detail()).pendingTargets.targets.map(target => target.rootPath).sort(), expected);
    assert.deepEqual((await e.worker.call('rc.catalog.list')).data[0].pendingTargets.targets.map(target => target.rootPath).sort(), expected);

    const shared = path.join(e.userHome, '.agents', 'skills', skill.id, 'SKILL.md');
    if (contents.includes(skill)) fs.unlinkSync(shared);
    assert.equal((await e.run(key, 'fillPending')).ok, true);
    assert.equal((await detail()).pendingTargets.count, 0);
    assert.equal(fs.existsSync(shared), false);
    assert.equal(fs.existsSync(path.join(claude, 'skills', skill.id, 'SKILL.md')), contents.includes(skill));
    assert.equal(fs.existsSync(path.join(claude, '.claude.json')), contents.includes(mcp));
    assert.equal(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8').includes('[mcp_servers.echo]'), contents.includes(mcp));
  });
}

test('partial Claude coverage fills only missing entries and leaves a modified installed skill untouched', async t => {
  const e = await setupMulti(t, { packages: { [key]: { '1.0.0': deploymentPackage('bundle', [skill, mcp]) } } });
  assert.equal((await e.run(key)).ok, true);
  const receiptFile = path.join(e.lcaipackHome, 'receipts.json');
  const ledger = JSON.parse(fs.readFileSync(receiptFile));
  const root = rules.normalize(e.roots.claudeWork);
  ledger.receipts = ledger.receipts.filter(receipt => !(receipt.kind === 'mcp' && receipt.canonicalRoot === root));
  fs.writeFileSync(receiptFile, JSON.stringify(ledger));
  fs.unlinkSync(path.join(e.roots.claudeWork, '.claude.json'));
  const skillPath = path.join(e.roots.claudeWork, 'skills', skill.id, 'SKILL.md');
  fs.writeFileSync(skillPath, 'local edit');

  const detail = async () => e.worker.call('rc.package.getDetails', { packageKey: key });
  assert.deepEqual((await detail()).pendingTargets.targets.map(target => target.rootPath), [e.roots.claudeWork]);
  const result = await e.run(key, 'fillPending');
  assert.equal(result.ok, true);
  assert.deepEqual(result.backups, []);
  assert.equal(fs.readFileSync(skillPath, 'utf8'), 'local edit');
  assert.equal((await detail()).pendingTargets.count, 0);
});
