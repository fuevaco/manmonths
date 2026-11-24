import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorMessage, formatSize, sniff, toUint8 } from '../src/common/format.js';
import { buildDoc } from './doc-fixture.mjs';

const bytes = (...n) => new Uint8Array(n);

test('sniff：OOXML / ODF 的 zip 檔頭', () => {
  assert.equal(sniff(bytes(0x50, 0x4b, 0x03, 0x04, 0, 0)), 'zip');
  assert.equal(sniff(bytes(0x50, 0x4b, 0x05, 0x06)), 'zip'); // 空 zip
});

test('sniff：舊版 Office 的 OLE2 檔頭', () => {
  assert.equal(sniff(buildDoc([{ text: 'x\r' }])), 'ole2');
});

test('sniff：RTF、HTML / XML 與空檔案', () => {
  assert.equal(sniff(new TextEncoder().encode('{\\rtf1\\ansi hello}')), 'rtf');
  assert.equal(sniff(new TextEncoder().encode('\uFEFF<html><body>x</body></html>')), 'markup');
  assert.equal(sniff(new TextEncoder().encode('<?xml version="1.0"?><a/>')), 'markup');
  assert.equal(sniff(new Uint8Array(0)), 'empty');
  assert.equal(sniff(bytes(1, 2, 3, 4)), 'unknown');
});

test('toUint8：ArrayBuffer、Uint8Array 與其他 TypedArray，且不複製資料', () => {
  const buf = new Uint8Array([1, 2, 3, 4]).buffer;
  assert.deepEqual([...toUint8(buf)], [1, 2, 3, 4]);
  const view = new Uint8Array([9, 8, 7]);
  assert.equal(toUint8(view), view);
  const dv = new DataView(new Uint8Array([5, 6, 7, 8]).buffer, 1, 2);
  assert.deepEqual([...toUint8(dv)], [6, 7]);
  assert.throws(() => toUint8('text'), TypeError);
});

test('formatSize 與 errorMessage', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(null), '未知錯誤');
});
