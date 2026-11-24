import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_COL_W,
  DEFAULT_ROW_H,
  MIN_COLS,
  MIN_ROWS,
  MIN_ROW_H,
  buildModel,
  cellAddress,
  cellAlign,
  cellEditorText,
  cellFill,
  cellText,
  colName,
  contrastColor,
  decodeRef,
  findIndex,
  getCell,
  mergeAt,
  mergesInWindow,
  rangeStats,
  rangeToTsv
} from '../src/excel/grid-model.js';

test('欄名與位址互轉', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(701), 'ZZ');
  assert.equal(colName(702), 'AAA');
  assert.equal(colName(16383), 'XFD');
  assert.equal(cellAddress(0, 0), 'A1');
  assert.equal(cellAddress(9, 27), 'AB10');
});

test('decodeRef', () => {
  assert.deepEqual(decodeRef('A1:F7'), { s: { r: 0, c: 0 }, e: { r: 6, c: 5 } });
  assert.deepEqual(decodeRef('$B$2'), { s: { r: 1, c: 1 }, e: { r: 1, c: 1 } });
  assert.deepEqual(decodeRef('c3:a1'), { s: { r: 0, c: 0 }, e: { r: 2, c: 2 } });
  assert.equal(decodeRef('nonsense'), null);
  assert.equal(decodeRef(undefined), null);
});

test('buildModel：欄寬 / 列高 / 隱藏 / 最小尺寸', () => {
  const ws = {
    '!ref': 'A1:C3',
    '!cols': [{ wpx: 100 }, { hidden: true }, { wch: 10 }],
    '!rows': [{ hpx: 40 }, { hidden: true }]
  };
  const m = buildModel(ws);
  assert.equal(m.dataRows, 3);
  assert.equal(m.dataCols, 3);
  assert.equal(m.rows, MIN_ROWS);
  assert.equal(m.cols, MIN_COLS);
  assert.equal(m.colX[1], 100); // A = 100
  assert.equal(m.colX[2], 100); // B 隱藏 = 0
  assert.equal(m.colX[3], 100 + 75); // C = 10 * 7 + 5
  assert.equal(m.colX[4], 100 + 75 + DEFAULT_COL_W);
  assert.equal(m.rowY[1], 40);
  assert.equal(m.rowY[2], 40); // 第 2 列隱藏
  assert.equal(m.rowY[3], 40 + DEFAULT_ROW_H);
});

test('buildModel：列高有下限（避免其他軟體存出的 17px 預設列高把文字切掉）', () => {
  const m = buildModel({ '!ref': 'A1:A3', '!rows': [{ hpt: 12.8 }, { hpx: 17 }, { hpt: 30 }] });
  assert.equal(m.rowY[1], MIN_ROW_H);
  assert.equal(m.rowY[2] - m.rowY[1], MIN_ROW_H);
  assert.equal(m.rowY[3] - m.rowY[2], 40); // 30pt = 40px，高於下限就照原值
});

test('buildModel：空白工作表與合併儲存格', () => {
  const empty = buildModel({});
  assert.equal(empty.dataRows, 0);
  assert.equal(empty.rows, MIN_ROWS);

  const m = buildModel({
    '!ref': 'A1:E5',
    '!merges': [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
      { s: { r: 3, c: 3 }, e: { r: 3, c: 3 } }, // 單格不算合併
      { s: { r: 2, c: 1 }, e: { r: 4, c: 2 } }
    ]
  });
  assert.deepEqual(m.merges, [
    { r: 0, c: 0, rs: 1, cs: 3 },
    { r: 2, c: 1, rs: 3, cs: 2 }
  ]);
  assert.deepEqual(mergeAt(m.merges, 0, 2), m.merges[0]);
  assert.deepEqual(mergeAt(m.merges, 4, 2), m.merges[1]);
  assert.equal(mergeAt(m.merges, 1, 0), null);
  assert.deepEqual(mergesInWindow(m.merges, 3, 6, 0, 0), []);
  assert.deepEqual(mergesInWindow(m.merges, 3, 6, 2, 8), [m.merges[1]]);
});

test('findIndex：二分搜尋，含 0 寬度（隱藏）與邊界', () => {
  const prefix = new Float64Array([0, 10, 10, 30, 60]); // 4 欄：10, 0, 20, 30
  assert.equal(findIndex(prefix, -5), 0);
  assert.equal(findIndex(prefix, 0), 0);
  assert.equal(findIndex(prefix, 9.9), 0);
  assert.equal(findIndex(prefix, 10), 2); // 隱藏的第 1 欄不會被選到
  assert.equal(findIndex(prefix, 29), 2);
  assert.equal(findIndex(prefix, 30), 3);
  assert.equal(findIndex(prefix, 9999), 3);
  assert.equal(findIndex(new Float64Array([0]), 5), 0);
});

test('getCell 同時支援 dense 與一般工作表', () => {
  const dense = { '!data': [[{ v: 1 }, { v: 2 }], [undefined, { v: 4 }]] };
  assert.equal(getCell(dense, 0, 1).v, 2);
  assert.equal(getCell(dense, 1, 0), undefined);
  assert.equal(getCell(dense, 5, 5), undefined);
  const sparse = { B2: { v: 'x' } };
  assert.equal(getCell(sparse, 1, 1).v, 'x');
});

test('儲存格文字、公式列內容與對齊', () => {
  assert.equal(cellText(undefined), '');
  assert.equal(cellText({ t: 'n', v: 1234.5, w: '1,234.50' }), '1,234.50');
  assert.equal(cellText({ t: 's', v: 'abc' }), 'abc');
  assert.equal(cellText({ t: 'b', v: false }), 'false');
  assert.equal(cellEditorText({ f: 'SUM(A1:A3)', v: 6, w: '6' }), '=SUM(A1:A3)');
  assert.equal(cellEditorText({ t: 'n', v: 0.5, w: '50%' }), '50%');
  assert.equal(cellEditorText({ t: 'n', v: 0.1234567 }), '0.1234567');
  assert.equal(cellAlign({ t: 'n' }), 'right');
  assert.equal(cellAlign({ t: 'd' }), 'right');
  assert.equal(cellAlign({ t: 'b' }), 'center');
  assert.equal(cellAlign({ t: 'e' }), 'center');
  assert.equal(cellAlign({ t: 's' }), 'left');
  assert.equal(cellAlign(undefined), 'left');
});

test('底色與對比文字色', () => {
  assert.equal(cellFill({ s: { patternType: 'solid', fgColor: { rgb: 'FF2F5597' } } }), '#2f5597');
  assert.equal(cellFill({ s: { patternType: 'solid', fgColor: { rgb: 'FFF2CC' } } }), '#fff2cc');
  assert.equal(cellFill({ s: { patternType: 'none', fgColor: { rgb: 'FF000000' } } }), null);
  assert.equal(cellFill({ s: { fgColor: { theme: 4 } } }), null);
  assert.equal(cellFill({ s: {} }), null);
  assert.equal(cellFill(undefined), null);
  assert.equal(contrastColor('#2f5597'), '#ffffff');
  assert.equal(contrastColor('#fff2cc'), '#1f1f1f');
});

test('複製為 TSV（含引號 / 換行的轉義）與範圍上限', () => {
  const ws = {
    '!data': [
      [{ t: 's', v: 'a', w: 'a' }, { t: 's', v: 'b\tc', w: 'b\tc' }],
      [{ t: 'n', v: 2, w: '2' }, { t: 's', v: 'say "hi"\nnow', w: 'say "hi"\nnow' }]
    ]
  };
  assert.equal(rangeToTsv(ws, 0, 0, 1, 1), 'a\t"b\tc"\n2\t"say ""hi""\nnow"');
  assert.equal(rangeToTsv(ws, 1, 0, 1, 0), '2');
  assert.throws(() => rangeToTsv(ws, 0, 0, 1000, 1000, 10), /範圍太大/);
});

test('範圍統計：計數 / 總和 / 平均只算數字', () => {
  const ws = {
    '!data': [
      [{ t: 'n', v: 10 }, { t: 's', v: 'x' }],
      [{ t: 'n', v: 20 }, undefined]
    ]
  };
  assert.deepEqual(rangeStats(ws, 0, 0, 1, 1), { count: 3, numeric: 2, sum: 30, average: 15 });
  assert.equal(rangeStats(ws, 0, 0, 1000, 1000, 10), null);
});
