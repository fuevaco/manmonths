// 對照 scripts/zh-TW-glossary.md：save 一律翻成「儲存」，不是「保存」。面板、README 與 worker 字串都要遵守。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = (dir) => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  if (name === 'vendor') return [];
  return statSync(full).isDirectory() ? files(full) : [full];
});

test('面板、README 與 worker 沒有「保存」（詞彙表：save → 儲存）', () => {
  const offenders = [path.join(root, 'README.md'), ...files(path.join(root, 'panel')), ...files(path.join(root, 'worker'))]
    .filter(file => /\.(md|html|css|js|mjs)$/.test(file) && readFileSync(file, 'utf8').includes('保存'));
  assert.deepEqual(offenders.map(f => path.relative(root, f)), []);
});
