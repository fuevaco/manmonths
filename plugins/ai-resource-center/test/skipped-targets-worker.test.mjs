import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstallService } from '../worker/install-service.mjs';
import { createCatalogTools } from '../worker/catalog-tools.mjs';

test('同次清單依序重查有略過的資源包，只規劃略過目標，不規劃其他資源包', async () => {
  const target = name => ({ id: `claude-code|claude-code-cli|global|/synthetic/${name}`,
    hostId: 'claude-code', surfaceId: 'claude-code-cli', scope: 'global', rootPath: `/synthetic/${name}` });
  const targets = ['installed', 'skipped', 'new'].map(target);
  const skippedId = targets[1].id;
  const storage = new Map(['first', 'second'].map(key => [`resource-center.lastSkipped.${key}`, { targets: [{ targetId: skippedId, version: '0.5.0' }] }]));
  const calls = [];
  let active = 0;
  const installation = createInstallService({
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value), delete: async key => storage.delete(key) },
    installed: { receipts: () => [], project: () => ({ deployments: [{ ...targets[0], version: '1.0.0' }] }) },
    createDeploy: () => ({
      listTargets: async () => ({ targets }),
      plan: async input => {
        assert.equal(active++, 0, '不能同時規劃兩個資源包');
        await new Promise(resolve => setImmediate(resolve));
        calls.push(input);
        active--;
        return { deployableCount: 1, targets: [{ id: skippedId, canApply: true, problems: [] }], problems: [] };
      },
      apply: () => assert.fail('重查不可套用')
    })
  });
  const enrich = createCatalogTools({
    packages: { details: async () => ({ versions: [{ version: '2.0.0', hosts: ['claude-code'] }] }) },
    detectTargets: () => targets,
    readReceipts: () => ['first', 'untouched', 'second'].map(packageKey => ({
      packageKey, packageVersion: '1.0.0', contentId: 'hello', kind: 'skill',
      hostId: 'claude-code', surfaceId: 'claude-code-cli', scope: 'global', canonicalRoot: '/synthetic/installed'
    })),
    refreshSkipped: installation.refreshSkipped,
    lastSkipped: installation.lastSkipped
  });
  const result = await enrich({}, ['first', 'untouched', 'second'].map(packageKey => ({ packageKey, type: 'skill', latestVisibleVersion: '2.0.0', deployments: [targets[0]] })), false);
  assert.deepEqual(calls, ['first', 'second'].map(packageKey => ({ packageKey, version: '1.0.0', previewMode: true, scope: 'global', action: 'install', targets: [skippedId] })));
  assert.ok(result.every(p => p.lastSkipped === null && p.pendingTargets.count === 2));
  assert.equal(storage.size, 0);
});
