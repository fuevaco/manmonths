import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogTools } from '../worker/catalog-tools.mjs';

// 相容工具依平台過濾：Linux 沒有官方 Claude Desktop（ADR-0005），含 MCP 的資源包也不顯示 Desktop。
for (const [platform, expected] of [['linux', ['codex', 'claude-code']], ['win32', ['codex', 'claude-code', 'claude-desktop']], ['darwin', ['codex', 'claude-code', 'claude-desktop']]]) {
  test(`${platform} 的 MCP 資源包相容工具為 ${expected.join('、')}`, async () => {
    const enrich = createCatalogTools({
      platform,
      packages: { details: async () => ({ versions: [{ version: '1.0.0', hosts: ['codex', 'claude-code'] }] }) },
      detectTargets: () => []
    });
    const [result] = await enrich({}, [{ packageKey: 'synthetic.mcp', type: 'mcp', latestVisibleVersion: '1.0.0' }], false);
    assert.deepEqual(result.tools.map(t => t.hostId), expected);
  });
}
