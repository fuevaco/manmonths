// 對照 LC-AI-Pack LcAiPackHome：預設 ~/.lcaipack，可用 LCAIPACK_HOME 覆寫。以模擬目錄涵蓋 Windows 與 macOS。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLcAiPackHome } from '../worker/paths.mjs';

test('macOS：預設為家目錄下的 .lcaipack', () => {
  assert.equal(resolveLcAiPackHome({ env: {}, platform: 'darwin', homedir: '/Users/tester' }), '/Users/tester/.lcaipack');
});

test('Windows：預設為使用者設定檔目錄下的 .lcaipack', () => {
  assert.equal(resolveLcAiPackHome({ env: {}, platform: 'win32', homedir: 'C:\\Users\\tester' }), 'C:\\Users\\tester\\.lcaipack');
});

test('LCAIPACK_HOME 有值時直接使用；空字串視為未設定', () => {
  assert.equal(resolveLcAiPackHome({ env: { LCAIPACK_HOME: '/tmp/lc' }, platform: 'darwin', homedir: '/Users/tester' }), '/tmp/lc');
  assert.equal(resolveLcAiPackHome({ env: { LCAIPACK_HOME: 'D:\\lc' }, platform: 'win32', homedir: 'C:\\Users\\tester' }), 'D:\\lc');
  assert.equal(resolveLcAiPackHome({ env: { LCAIPACK_HOME: '' }, platform: 'darwin', homedir: '/Users/tester' }), '/Users/tester/.lcaipack');
});
