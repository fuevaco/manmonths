import test from 'node:test';
import assert from 'node:assert/strict';
import { locateClaudeCodeRoots } from '../worker/deploy/claude-code-roots.mjs';
import { memoryProbe } from '../worker/deploy/codex-roots.mjs';

test('macOS Claude Code preserves home scan casing while preferring the environment origin', () => {
  const userHome = '/Users/Synthetic';
  const scanned = `${userHome}/.CLAUDE`;
  const override = `${userHome.toLowerCase()}/.claude`;
  const alternative = `${userHome}/.Claude-Team`;
  const manual = `${userHome.toLowerCase()}/.claude-team`;
  const paths = [scanned, override, alternative, manual];
  const roots = locateClaudeCodeRoots({ platform: 'darwin', userHome, env: { CLAUDE_CONFIG_DIR: override },
    manualRoots: [manual, scanned], probe: memoryProbe({ dirs: [userHome, ...paths], files: paths.map(p => `${p}/settings.json`) }) });
  assert.deepEqual(roots, [
    { canonicalRoot: override, displayPath: scanned, isPrimary: true, origin: 'ConfigDirEnvironment' },
    { canonicalRoot: manual, displayPath: alternative, isPrimary: false, origin: 'ManualInclude' }
  ]);
});

test('Linux Claude Code treats an explicitly included mixed-case basename as a separate non-primary root', () => {
  const userHome = '/home/synthetic';
  const primary = `${userHome}/.claude`;
  const manual = `${userHome}/.CLAUDE`;
  const roots = locateClaudeCodeRoots({ platform: 'linux', userHome, env: {}, manualRoots: [manual],
    probe: memoryProbe({ dirs: [userHome, primary, manual], files: [`${primary}/settings.json`, `${manual}/settings.json`] }) });
  assert.deepEqual(roots, [
    { canonicalRoot: primary, displayPath: primary, isPrimary: true, origin: 'HomeScan' },
    { canonicalRoot: manual, displayPath: manual, isPrimary: false, origin: 'ManualInclude' }
  ]);
});
