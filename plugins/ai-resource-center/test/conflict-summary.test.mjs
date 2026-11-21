// 載入優先順序明細（工項 11、ADR 0002）：各 AI 工具對同名資源的載入規則，依官方文件；文件未明訂的組合如實標示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLoadPrecedence, backupReasonOf, loadRuleFor } from '../worker/deploy/conflict-summary.mjs';

const claude = { hostId: 'claude-code', surfaceId: 'claude-code-cli' };
const codex = { hostId: 'codex', surfaceId: 'codex-cli' };
const shadowTarget = (host, scope, kind, otherScope) => ({
  host, scope, canonicalRoot: 'c:/root',
  mutations: [{ contentId: 'x', kind, destinationPath: `c:/root/${scope}/x` }],
  problems: [{ code: 'deployment.scope-shadowing', severity: 'Warning', contentId: 'x',
    shadowed: [{ contentId: 'x', kind, scope: otherScope, destinationPath: `c:/root/${otherScope}/x`, packageKey: 'p', packageVersion: '1.0.0' }] }]
});

test('Claude Code：Skill 全域優先於專案，Agent 與 MCP 專案優先於全域；Prompt 與 Command 官方未明訂', () => {
  const rows = [['skill', 'globalFirst', 'global'], ['agent', 'projectFirst', 'project'], ['mcp', 'projectFirst', 'project'],
    ['prompt', 'undocumented', 'unknown'], ['command', 'undocumented', 'unknown']];
  for (const [kind, rule, winner] of rows) {
    const [entry] = describeLoadPrecedence(shadowTarget(claude, 'project', kind, 'global'), '2.0.0');
    assert.deepEqual([entry.rule, entry.winner], [rule, winner], kind);
    assert.deepEqual(entry.locations.map(l => l.scopeLabel), ['全域', '專案']);
    assert.deepEqual(entry.locations.map(l => l.version), ['1.0.0', '2.0.0']);
  }
  const [skill] = describeLoadPrecedence(shadowTarget(claude, 'project', 'skill', 'global'), '2.0.0');
  assert.match(skill.text, /專案內實際使用全域版本 1\.0\.0/);
  const [agent] = describeLoadPrecedence(shadowTarget(claude, 'project', 'agent', 'global'), '2.0.0');
  assert.match(agent.text, /專案內實際使用專案版本 2\.0\.0/);
});

test('Codex：Skill 兩份都載入不合併，MCP 專案設定優先，其餘未明訂；從全域端看結果相同', () => {
  assert.equal(loadRuleFor(codex, 'skill'), 'bothLoaded');
  assert.equal(loadRuleFor(codex, 'mcp'), 'projectFirst');
  assert.equal(loadRuleFor(codex, 'agent'), 'undocumented');
  const [fromGlobal] = describeLoadPrecedence(shadowTarget(codex, 'global', 'mcp', 'project'), '2.0.0');
  assert.equal(fromGlobal.winner, 'project');
  assert.deepEqual(fromGlobal.locations.map(l => [l.scope, l.current]), [['global', true], ['project', false]]);
  assert.match(describeLoadPrecedence(shadowTarget(codex, 'global', 'agent', 'project'), '2.0.0')[0].text, /沒有明訂/);
});

test('備份原因只在計畫實際會備份時給出，且以可解決衝突的警告為準', () => {
  const warn = (code) => ({ code, severity: 'Warning', contentId: 'x' });
  assert.equal(backupReasonOf({ contentId: 'x', willBackup: true }, [warn('deployment.unmanaged-collision')]), 'unmanaged');
  assert.equal(backupReasonOf({ contentId: 'x', willBackup: true }, [warn('deployment.local-modification')]), 'localModification');
  assert.equal(backupReasonOf({ contentId: 'x', willBackup: false }, [warn('deployment.local-modification')]), null);
  assert.equal(backupReasonOf({ contentId: 'y', willBackup: true }, [warn('deployment.local-modification')]), null);
});
