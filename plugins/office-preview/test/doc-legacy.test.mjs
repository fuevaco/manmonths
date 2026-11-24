import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegacyDocError, buildBlocks, extractLegacyDoc } from '../src/word/doc-legacy.js';
import { buildDoc, buildFakeXls } from './doc-fixture.mjs';

const texts = (blocks) => blocks.filter((b) => b.type === 'p').map((b) => b.text);

test('讀出 8-bit（壓縮）片段的段落', () => {
  const { blocks, chars } = extractLegacyDoc(buildDoc([{ text: 'Hello World\rSecond line\r' }]));
  assert.deepEqual(texts(blocks), ['Hello World', 'Second line']);
  assert.equal(chars, 'Hello World\rSecond line\r'.length);
});

test('讀出 UTF-16 片段的中文，且能和 8-bit 片段混用', () => {
  const { blocks } = extractLegacyDoc(
    buildDoc([{ text: 'English start\r' }, { text: '繁體中文段落，測試。\r', unicode: true }, { text: 'tail\r' }])
  );
  assert.deepEqual(texts(blocks), ['English start', '繁體中文段落，測試。', 'tail']);
});

test('可略過 Clx 前面的 Prc，並支援 1Table', () => {
  const { blocks } = extractLegacyDoc(buildDoc([{ text: 'with prc\r' }], { prc: true, table1: true }));
  assert.deepEqual(texts(blocks), ['with prc']);
});

test('只取本文（ccpText），不把註腳等其他區段混進來', () => {
  const body = 'body text\r';
  const { blocks } = extractLegacyDoc(buildDoc([{ text: body + 'FOOTNOTE TEXT\r' }], { ccpText: body.length }));
  assert.deepEqual(texts(blocks), ['body text']);
});

test('windows-1252 特殊字元（智慧引號、€）', () => {
  // 0x93/0x94 = 左右雙引號、0x80 = €
  const text = `${String.fromCharCode(0x93)}quote${String.fromCharCode(0x94)} ${String.fromCharCode(0x80)}5\r`;
  const { blocks } = extractLegacyDoc(buildDoc([{ text }]));
  assert.deepEqual(texts(blocks), ['\u201cquote\u201d \u20ac5']);
});

test('buildBlocks：表格（連續兩個 \\x07 是列結尾）', () => {
  const blocks = buildBlocks('Intro\rA1\x07B1\x07\x07A2\x07B2\x07\x07After\r');
  assert.deepEqual(blocks, [
    { type: 'p', text: 'Intro' },
    {
      type: 'table',
      rows: [
        ['A1', 'B1'],
        ['A2', 'B2']
      ]
    },
    { type: 'p', text: 'After' }
  ]);
});

test('buildBlocks：欄位只保留結果，不顯示欄位代碼', () => {
  const blocks = buildBlocks('Page \x13 PAGE \\* MERGEFORMAT \x14' + '5\x15 of text\r');
  assert.deepEqual(texts(blocks), ['Page 5 of text']);
});

test('buildBlocks：欄位沒有分隔符（沒有結果）時整段丟掉', () => {
  const blocks = buildBlocks('A\x13 TOC \\o "1-3"\x15B\r');
  assert.deepEqual(texts(blocks), ['AB']);
});

test('buildBlocks：換行、分頁與控制字元', () => {
  const blocks = buildBlocks('line1\x0Bline2\r\x0Cnext page\x01\x08\r');
  assert.deepEqual(blocks, [
    { type: 'p', text: 'line1\nline2' },
    { type: 'pagebreak' },
    { type: 'p', text: 'next page' }
  ]);
});

test('buildBlocks：連續空段落只保留一個，前後空白移除', () => {
  const blocks = buildBlocks('\r\rA\r\r\r\rB\r\r');
  assert.deepEqual(blocks, [
    { type: 'p', text: 'A' },
    { type: 'p', text: '' },
    { type: 'p', text: 'B' }
  ]);
});

test('有密碼保護的文件', () => {
  assert.throws(
    () => extractLegacyDoc(buildDoc([{ text: 'secret\r' }], { encrypted: true })),
    (err) => err instanceof LegacyDocError && err.code === 'encrypted'
  );
});

test('不是 OLE 檔案', () => {
  assert.throws(
    () => extractLegacyDoc(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])),
    (err) => err instanceof LegacyDocError && err.code === 'not_cfb'
  );
});

test('OLE 檔案但不是 Word（例如 .xls）', () => {
  assert.throws(
    () => extractLegacyDoc(buildFakeXls()),
    (err) => err instanceof LegacyDocError && err.code === 'no_word_stream'
  );
});

test('Clx 遺失', () => {
  assert.throws(
    () => extractLegacyDoc(buildDoc([{ text: 'x\r' }], { noClx: true })),
    (err) => err instanceof LegacyDocError && err.code === 'bad_clx'
  );
});
