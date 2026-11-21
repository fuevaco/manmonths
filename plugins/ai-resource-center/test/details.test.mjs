import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorker } from './harness.mjs';
import { startFakeMarket } from './fake-market.mjs';
import { compareVersions } from '../worker/package-service.mjs';

export async function fixture(t, versions, recommendedVersion = '1.0.0') {
  const market = await startFakeMarket();
  const worker = startWorker();
  t.after(() => { worker.dispose(); return market.close(); });
  market.override('GET /api/market/packages/demo', () => ({ status: 200, body: {
    packageKey: 'demo', name: 'Demo', type: 'skill', description: '合成說明', versions, recommendedVersion
  } }));
  for (const v of versions) market.override(`GET /api/market/packages/demo/versions/${v.version}/readme`, () => ({ status: 200, body: { readme: '# 使用說明' } }));
  await worker.call('rc.session.signIn', { marketUrl: market.url, username: 'alice', password: 'pw-alice' });
  return { worker, market };
}

export const version = (v = '1.0.0', extra = {}) => ({ version: v, isEnabled: true, channel: 'release',
  status: 'active', hosts: ['codex', 'claude-code'], changelog: '更新說明', ...extra });

test('詳情只顯示可見版本，優先市集推薦，選定版本讀取 README 與相容工具', async (t) => {
  const { worker, market } = await fixture(t, [version('2.0.0'), version(),
    version('3.0.0', { channel: 'preview', status: 'rejected' }), version('4.0.0', { isEnabled: false })]);
  const detail = await worker.call('rc.package.getDetails', { packageKey: 'demo' });
  assert.deepEqual(detail.versions.map(v => v.version), ['2.0.0', '1.0.0']);
  assert.equal(detail.selectedVersion, '1.0.0');
  assert.equal(detail.readme, '# 使用說明');
  assert.deepEqual(detail.versions[1].hosts, ['codex', 'claude-code']);
  const preview = await worker.call('rc.package.getDetails', { packageKey: 'demo', previewMode: true, version: '3.0.0' });
  assert.equal(preview.selectedVersion, '3.0.0');
  assert.deepEqual(preview.versions.map(v => v.version), ['2.0.0', '1.0.0', '3.0.0']);
  assert.ok(market.requests.some(r => r.path.endsWith('/3.0.0/readme')));
  await assert.rejects(worker.call('rc.package.getDetails', { packageKey: 'demo', version: '4.0.0' }), { code: 'version_unavailable' });
});

test('版本排序對齊 LC-AI-Pack SemVer 黃金順序、build metadata 與自然數字段回退', () => {
  const ascending = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  assert.deepEqual([...ascending].reverse().sort(compareVersions), ascending);
  for (const [a, b, expected] of [['1.0.0+build.1', '1.0.0+build.2', 0], ['1.9.9', '2.0', 1], ['0.0.1', '01.0.0', 1], ['v2', 'v10', -1], ['1.0.0.2', '1.0.0.10', -1], ['1.0.0-beta.02', '1.0.0-beta.2', 0]]) {
    assert.equal(Math.sign(compareVersions(a, b)), expected, `${a} / ${b}`);
  }
});

test('沒有可用推薦版本時整組 release 優先，Preview 審核狀態不影響可見性', async t => {
  const { worker } = await fixture(t, [version('9.0.0', { channel: 'preview', status: 'pending_review' }),
    version('1.0.0'), version('2.0.0', { status: 'rejected' })], 'missing');
  assert.equal((await worker.call('rc.package.getDetails', { packageKey: 'demo', previewMode: true })).selectedVersion, '2.0.0');
  for (const previewMode of [false, true]) for (const status of ['active', 'pending_review', 'rejected']) {
    for (const channel of ['release', 'preview']) for (const isEnabled of [false, true]) {
      const { worker: w } = await fixture(t, [version('1.0.0', { channel, status, isEnabled })]);
      const result = w.call('rc.package.getDetails', { packageKey: 'demo', previewMode });
      if (isEnabled && (channel === 'release' || previewMode)) assert.equal((await result).selectedVersion, '1.0.0');
      else await assert.rejects(result, { code: 'version_unavailable' });
    }
  }
});
