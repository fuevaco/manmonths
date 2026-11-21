// QA 發現 1：同一專案的 Codex 與 Claude Code 目標都在舊版，兩個都勾選更新時，worker 契約是否兩個都更新。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMulti, skillText } from './multi-env.mjs';

test('專案範圍：Codex 與 Claude Code 目標都在 1.0.0、兩個都勾選更新時，兩個目標都更新到 1.1.0', async (t) => {
  const e = await setupMulti(t);
  const root = path.join(e.dir, 'proj-one');
  fs.mkdirSync(root, { recursive: true });
  const { targets } = await e.worker.call('rc.deploy.listTargets', { scope: 'project', projectRoot: root });
  const ids = targets.filter(x => ['codex-cli', 'claude-code-cli'].includes(x.surfaceId)).map(x => x.id);
  assert.equal(ids.length, 2);
  const first = await e.worker.call('rc.deploy.plan', { packageKey: 'pkg-a', version: '1.0.0', scope: 'project', projectRoot: root, targets: ids });
  assert.equal((await e.worker.call('rc.deploy.apply', { planDigest: first.planDigest, targets: ids })).status, 'succeeded');

  const listed = (await e.worker.call('rc.deploy.listTargets', { scope: 'project', packageKey: 'pkg-a', version: '1.1.0' })).targets;
  const updateIds = listed.filter(x => ids.includes(x.id)).map(x => x.id);
  assert.deepEqual([...updateIds].sort(), [...ids].sort());
  const summary = await e.worker.call('rc.deploy.plan', { packageKey: 'pkg-a', version: '1.1.0', action: 'update', scope: 'project', targets: updateIds });
  assert.deepEqual(summary.unchangedDeployments, []);
  const result = await e.worker.call('rc.deploy.apply', { planDigest: summary.planDigest, targets: updateIds });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.targets.map(x => x.status), ['succeeded', 'succeeded']);
  const detail = await e.worker.call('rc.package.getDetails', { packageKey: 'pkg-a', version: '1.1.0' });
  assert.deepEqual(detail.deployments.map(d => [d.surfaceId, d.version, d.updateVersion]).sort(), [['claude-code-cli', '1.1.0', null], ['codex-cli', '1.1.0', null]]);
  assert.equal(fs.readFileSync(path.join(root, '.claude', 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), skillText('1.1.0'));
  assert.equal(fs.readFileSync(path.join(root, '.agents', 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), skillText('1.1.0'));
});
