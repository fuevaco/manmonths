// 舊版 Word（.doc，OLE2 二進位）的「純文字」擷取。
//
// 純前端沒有能高保真排版 .doc 的引擎，所以這裡只做一件事：從 WordDocument 資料流
// 依照 FIB 與 Piece Table（Clx）把文件本文的文字挖出來，並用控制字元還原段落與簡易表格。
// 不含圖片、字型、顏色與版面。規格見 [MS-DOC]（2.5 FIB、2.9.38 Clx、2.9.177 PlcPcd）。

import * as CFB from 'cfb';
import { toUint8 } from '../common/format.js';

const FIB_WIDENT = 0xa5ec;
const FIB_FLAGS_OFFSET = 0x0a;
const FIB_CCP_TEXT_OFFSET = 0x4c; // FibRgLw97.ccpText
const FIB_FC_CLX_OFFSET = 0x1a2; // FibRgFcLcb97.fcClx
const FIB_LCB_CLX_OFFSET = 0x1a6;
const FLAG_ENCRYPTED = 0x0100;
const FLAG_WHICH_TABLE = 0x0200;

const MAX_PIECES = 1_000_000;

export class LegacyDocError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LegacyDocError';
    this.code = code;
  }
}

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function findStream(cfb, name) {
  const entry = CFB.find(cfb, name);
  if (!entry || !entry.content) return null;
  return toUint8(entry.content);
}

/**
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {{ blocks: Block[], chars: number }}
 *
 * @typedef {{ type: 'p', text: string } | { type: 'table', rows: string[][] } | { type: 'pagebreak' }} Block
 */
export function extractLegacyDoc(input) {
  let cfb;
  try {
    cfb = CFB.read(toUint8(input), { type: 'array' });
  } catch (err) {
    throw new LegacyDocError(`不是有效的 Word 97-2003 檔案（${err.message || err}）`, 'not_cfb');
  }

  const word = findStream(cfb, 'WordDocument');
  if (!word) {
    throw new LegacyDocError('這個 OLE 檔案裡沒有 WordDocument 資料流，可能是 Excel / PowerPoint 或其他格式。', 'no_word_stream');
  }
  if (word.length < FIB_LCB_CLX_OFFSET + 4 || u16(word, 0) !== FIB_WIDENT) {
    throw new LegacyDocError('Word 檔案標頭（FIB）不正確或版本太舊（僅支援 Word 97-2003）。', 'bad_fib');
  }

  const flags = u16(word, FIB_FLAGS_OFFSET);
  if (flags & FLAG_ENCRYPTED) {
    throw new LegacyDocError('這份文件有密碼保護，無法預覽。', 'encrypted');
  }

  const table = findStream(cfb, flags & FLAG_WHICH_TABLE ? '1Table' : '0Table');
  if (!table) {
    throw new LegacyDocError('找不到文件的資料表（Table stream），檔案可能已損毀。', 'no_table_stream');
  }

  const ccpText = u32(word, FIB_CCP_TEXT_OFFSET);
  const fcClx = u32(word, FIB_FC_CLX_OFFSET);
  const lcbClx = u32(word, FIB_LCB_CLX_OFFSET);
  if (lcbClx === 0 || fcClx + lcbClx > table.length) {
    throw new LegacyDocError('文件的文字段落表（Clx）損毀或遺失。', 'bad_clx');
  }

  const raw = readText(word, table, fcClx, lcbClx, ccpText);
  return { blocks: buildBlocks(raw), chars: raw.length };
}

function readText(word, table, fcClx, lcbClx, ccpText) {
  // Clx = 0 或多個 Prc（clxt=1），接著一個 Pcdt（clxt=2）
  let pos = fcClx;
  const end = fcClx + lcbClx;
  let plcStart = -1;
  let plcLen = 0;
  while (pos < end) {
    const clxt = table[pos];
    if (clxt === 0x01) {
      pos += 3 + u16(table, pos + 1);
    } else if (clxt === 0x02) {
      plcLen = u32(table, pos + 1);
      plcStart = pos + 5;
      break;
    } else {
      throw new LegacyDocError('文字段落表（Clx）格式無法辨識。', 'bad_clx');
    }
  }
  if (plcStart < 0 || plcStart + plcLen > table.length) {
    throw new LegacyDocError('文字段落表（PlcPcd）遺失或損毀。', 'bad_plcpcd');
  }

  // PlcPcd = (n+1) 個 CP（4 bytes）+ n 個 PCD（8 bytes）
  const n = Math.floor((plcLen - 4) / 12);
  if (n < 1 || n > MAX_PIECES) {
    throw new LegacyDocError('文字段落表的片段數量不合理，檔案可能已損毀。', 'bad_plcpcd');
  }
  const pcdBase = plcStart + 4 * (n + 1);
  const latin = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  const parts = [];
  let total = 0;

  for (let i = 0; i < n && total < ccpText; i++) {
    const cpStart = u32(table, plcStart + 4 * i);
    const cpEnd = u32(table, plcStart + 4 * (i + 1));
    if (cpEnd <= cpStart) continue;
    const want = Math.min(cpEnd, ccpText) - cpStart;
    if (want <= 0) continue;
    const fc = u32(table, pcdBase + 8 * i + 2);
    const compressed = (fc & 0x40000000) !== 0;
    const offset = compressed ? (fc & 0x3fffffff) >>> 1 : fc & 0x3fffffff;
    const byteLen = compressed ? want : want * 2;
    if (offset + byteLen > word.length) {
      throw new LegacyDocError('文字內容超出檔案範圍，檔案可能已損毀。', 'text_out_of_range');
    }
    const slice = word.subarray(offset, offset + byteLen);
    parts.push(compressed ? latin.decode(slice) : utf16.decode(slice));
    total += want;
  }
  return parts.join('');
}

/**
 * 把含控制字元的原始文字轉成區塊。
 *   \r      段落結尾
 *   \x07    儲存格 / 列結尾（連續兩個 = 列結尾）
 *   \x0B    換行      \x0C 分頁      \x13..\x14..\x15 欄位（只留結果）
 */
export function buildBlocks(raw) {
  /** @type {Block[]} */
  const blocks = [];
  const fieldStack = [];
  let cur = '';
  let tableRows = null;
  let rowCells = [];
  let lastTokenWasCellEnd = false;

  const hidden = () => fieldStack.some((f) => f.code);

  const flushTable = () => {
    if (rowCells.length) {
      tableRows.push(rowCells);
      rowCells = [];
    }
    if (tableRows && tableRows.length) blocks.push({ type: 'table', rows: tableRows });
    tableRows = null;
  };

  const endParagraph = () => {
    if (tableRows) flushTable();
    blocks.push({ type: 'p', text: cur });
    cur = '';
    lastTokenWasCellEnd = false;
  };

  const endCell = () => {
    if (!tableRows) tableRows = [];
    if (cur === '' && lastTokenWasCellEnd) {
      // 連續兩個 \x07：列結尾
      if (rowCells.length) {
        tableRows.push(rowCells);
        rowCells = [];
      }
    } else {
      rowCells.push(cur.trim());
    }
    cur = '';
    lastTokenWasCellEnd = true;
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const code = raw.charCodeAt(i);
    switch (code) {
      case 0x0d:
        if (!hidden()) endParagraph();
        break;
      case 0x07:
        if (!hidden()) endCell();
        break;
      case 0x0b:
        if (!hidden()) cur += '\n';
        break;
      case 0x0c:
        if (!hidden()) {
          if (cur) endParagraph();
          else if (tableRows) flushTable();
          blocks.push({ type: 'pagebreak' });
        }
        break;
      case 0x13:
        fieldStack.push({ code: true });
        break;
      case 0x14:
        if (fieldStack.length) fieldStack[fieldStack.length - 1].code = false;
        break;
      case 0x15:
        fieldStack.pop();
        break;
      case 0x1e:
        if (!hidden()) cur += '-';
        break;
      case 0x09:
        if (!hidden()) cur += '\t';
        break;
      default:
        if (hidden()) break;
        // 其餘控制字元（圖片 / 註解 / 註腳參照等佔位符）直接略過
        if (code < 0x20) break;
        cur += ch;
        lastTokenWasCellEnd = false;
    }
  }
  if (tableRows) flushTable();
  if (cur) blocks.push({ type: 'p', text: cur });

  return collapseBlankBlocks(blocks);
}

/** 連續的空段落最多保留 1 個，避免 .doc 常見的大段空白。 */
function collapseBlankBlocks(blocks) {
  const out = [];
  let blank = 0;
  for (const b of blocks) {
    if (b.type === 'p' && b.text.trim() === '') {
      blank++;
      if (blank > 1) continue;
      out.push({ type: 'p', text: '' });
    } else {
      blank = 0;
      out.push(b);
    }
  }
  while (out.length && out[0].type === 'p' && out[0].text === '') out.shift();
  while (out.length && out[out.length - 1].type === 'p' && out[out.length - 1].text === '') out.pop();
  return out;
}
