import test from 'node:test';
import assert from 'node:assert/strict';
import { locateClaudeDesktop } from '../worker/deploy/claude-desktop-roots.mjs';

test('Linux Desktop stays undetected even if a Windows package is supplied', () => {
  const result = locateClaudeDesktop({ platform: 'linux', userHome: '/home/synthetic', environment: {
    package: { packageFamilyName: 'Claude_demo', installedAtLocal: new Date(2026, 7, 7) },
    appDataDirectory: '/synthetic/roaming', localAppDataDirectory: '/synthetic/local', selfReportLogLines: []
  }, probe: { isDirectory: () => true, isFile: () => true } });
  assert.deepEqual(result, { isDetected: false, configDirectory: null, configFilePath: null, source: 'PackageMissing', disclosures: [], canonicalConfigDirectory: null });
});

// MacClaudeDesktopLocatorTests：由注入 platform/home/probe 驗證，與執行測試的 OS 無關。
test('macOS Desktop requires the exact config file, preserves display casing and creates nothing', () => {
  const files = new Set(); let probes = [];
  const probe = { isFile: p => { probes.push(p); return files.has(p); } };
  const options = { platform: 'darwin', userHome: '/Users/Synthetic', env: { APPDATA: '/wrong' }, probe };
  const file = '/Users/Synthetic/Library/Application Support/Claude/claude_desktop_config.json';
  for (const wrong of ['claude_desktop_config.json', 'Claude/claude_desktop_config.json', 'Library/Claude/claude_desktop_config.json', 'Library/Application Support/claude_desktop_config.json', 'Library/Application Support/Claude-3p/claude_desktop_config.json']) files.add('/Users/Synthetic/' + wrong);
  assert.deepEqual(locateClaudeDesktop(options), { isDetected: false, configDirectory: null, configFilePath: null, source: 'ConfigFileProbe', disclosures: [], canonicalConfigDirectory: null });
  files.add(file);
  const detected = locateClaudeDesktop(options);
  assert.equal(detected.isDetected, true);
  assert.equal(detected.configFilePath, file);
  assert.equal(detected.configDirectory, '/Users/Synthetic/Library/Application Support/Claude');
  assert.equal(detected.canonicalConfigDirectory, '/users/synthetic/library/application support/claude');
  assert.deepEqual(probes, [file, file]);
});

test('Windows Desktop trusts only fresh verdicts, rejects Claude-3p and discloses directory contradictions', () => {
  const appDataDirectory = 'C:\\Synthetic\\Roaming', localAppDataDirectory = 'C:\\Synthetic\\Local';
  const candidate = localAppDataDirectory + '\\Packages\\Claude_demo\\LocalCache\\Roaming\\Claude';
  const base = { package: { packageFamilyName: 'Claude_demo', installedAtLocal: new Date(2026, 7, 7, 1), installedAtIsAuthoritative: true }, appDataDirectory, localAppDataDirectory, selfReportLogLines: [] };
  const resolve = (environment, present = false) => locateClaudeDesktop({ platform: 'win32', environment, probe: { isDirectory: p => present && p === candidate } });
  assert.equal(resolve({ ...base, package: null }).isDetected, false);
  assert.equal(resolve(base).configDirectory, appDataDirectory + '\\Claude');
  assert.equal(resolve(base, true).configDirectory, candidate);
  const line = (time, location, state = 'present') => `2026-08-07 ${time} [info] [MSIX] Filesystem — ${location} ${state}`;
  const fresh = line('02:00:00', candidate);
  assert.equal(resolve({ ...base, selfReportLogLines: [fresh] }).configDirectory, candidate);
  assert.equal(resolve({ ...base, selfReportLogLines: [fresh] }).source, 'SelfReportLog');
  assert.match(resolve({ ...base, selfReportLogLines: [fresh] }).disclosures.join(' '), /不一致/);
  for (const time of ['00:59:59', '01:00:00']) {
    const d = resolve({ ...base, selfReportLogLines: [line(time, candidate)] });
    assert.equal(d.source, 'DirectoryProbe'); assert.match(d.disclosures.join(' '), /過期/);
  }
  const last = resolve({ ...base, selfReportLogLines: [fresh, line('02:01:00', candidate, 'ABSENT')] }, true);
  assert.equal(last.configDirectory, appDataDirectory + '\\Claude');
  const forbidden = resolve({ ...base, selfReportLogLines: [line('02:01:00', 'C:\\Data\\Claude-3p')] });
  assert.equal(forbidden.configDirectory, appDataDirectory + '\\Claude');
  assert.match(forbidden.disclosures.join(' '), /拒絕/);
  assert.equal(resolve({ ...base, selfReportLogLines: [line('02:01:00', 'C:\\Data\\Claude-3p-other')] }).configDirectory, 'C:\\Data\\Claude-3p-other');
  assert.match(resolve({ ...base, package: { ...base.package, installedAtIsAuthoritative: false }, selfReportLogLines: [fresh] }).disclosures.join(' '), /替代時間/);
  assert.equal(resolve({ ...base, selfReportLogLines: [fresh.replace('—', '-'), '2026-08-07 02:00:00 [MSIX] native API: Claude_demo', '[MSIX] — C:\\Data present'] }).source, 'DirectoryProbe');
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureDesktopEnvironment } from '../worker/deploy/claude-desktop-roots.mjs';

test('Desktop environment provider chooses ordinal package/version and collects recognized logs oldest first, read only', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-08-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const appDataDirectory = path.join(dir, 'roaming'), localAppDataDirectory = path.join(dir, 'local'), windowsAppsDirectory = path.join(dir, 'apps');
  const options = { appDataDirectory, localAppDataDirectory, windowsAppsDirectory };
  assert.equal(captureDesktopEnvironment(options).package, null);
  for (const name of ['Other_demo', 'Claude_z', 'Claude_demo']) fs.mkdirSync(path.join(localAppDataDirectory, 'Packages', name), { recursive: true });
  fs.writeFileSync(path.join(localAppDataDirectory, 'Packages', 'Claude_aaa-file'), '');
  const fallback = captureDesktopEnvironment(options);
  assert.equal(fallback.package.packageFamilyName, 'Claude_demo');
  assert.equal(fallback.package.installedAtIsAuthoritative, false);
  for (const name of ['Claude_1_x64__demo', 'Claude_2_x64__demo', 'Claude_9_x64__other']) fs.mkdirSync(path.join(windowsAppsDirectory, name), { recursive: true });
  const first = path.join(appDataDirectory, 'Claude', 'logs'), second = path.join(localAppDataDirectory, 'Packages', 'Claude_demo', 'LocalCache', 'Roaming', 'Claude', 'logs');
  for (const d of [first, second]) fs.mkdirSync(d, { recursive: true });
  const newer = '2026-08-07 03:00:00 [info] [MSIX] Filesystem — C:\\Virtual Path\\Claude present';
  const older = '2026-08-07 02:00:00 [info] [MSIX] Filesystem — C:\\Virtual Path\\Claude absent';
  fs.writeFileSync(path.join(first, 'main.log'), newer + '\nordinary line\n[MSIX] no timestamp');
  fs.writeFileSync(path.join(second, 'main-old.log'), older);
  fs.writeFileSync(path.join(second, 'renderer.log'), newer);
  const before = fs.readdirSync(dir, { recursive: true });
  const result = captureDesktopEnvironment(options);
  assert.deepEqual(result.selfReportLogLines, [older, newer]);
  assert.equal(result.package.installedAtIsAuthoritative, true);
  assert.equal(+result.package.installedAtLocal, +fs.statSync(path.join(windowsAppsDirectory, 'Claude_2_x64__demo')).birthtime);
  assert.deepEqual(fs.readdirSync(dir, { recursive: true }), before);
});

import { parseDesktopVerdict } from '../worker/deploy/claude-desktop-roots.mjs';
test('Desktop log parser rejects invalid calendar timestamps and recognizes only exact verdict syntax', () => {
  const line = '2026-08-07 02:25:24 [info] [MSIX] Filesystem not virtualized — C:\\Program Data\\Claude absent (upgrade)';
  assert.equal(parseDesktopVerdict(line).virtualizedPath, 'C:\\Program Data\\Claude');
  assert.equal(parseDesktopVerdict(line).virtualizedPathPresent, false);
  assert.equal(parseDesktopVerdict(line.replace('absent', 'PRESENT')).virtualizedPathPresent, true);
  for (const invalid of [null, '', line.replace('2026-08-07', '2026-02-30'), line.replace('[MSIX]', '[info]'), line.slice(20), line.replace('—', '-'), line.replace('absent', 'unknown'), line.replace('C:\\Program Data\\Claude', '')]) assert.equal(parseDesktopVerdict(invalid), null);
});

test('macOS Desktop missing or inaccessible home/config stays undetected; blank home uses injected profile', () => {
  const file = '/Users/Fallback/Library/Application Support/Claude/claude_desktop_config.json';
  const options = { platform: 'darwin', userHome: ' ', homedir: () => '/Users/Fallback', env: {} };
  assert.equal(locateClaudeDesktop({ ...options, probe: { isFile: p => p === file } }).configFilePath, file);
  assert.equal(locateClaudeDesktop({ ...options, probe: { isFile: () => false } }).isDetected, false);
  assert.equal(locateClaudeDesktop({ ...options, probe: { isFile: () => { throw new Error('denied'); } } }).isDetected, false);
});
