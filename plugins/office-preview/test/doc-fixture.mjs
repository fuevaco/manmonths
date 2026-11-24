// 測試用：用 cfb 套件組出最小的 Word 97-2003（.doc）檔案，不需要安裝 Word。
// 只填入解析器會讀的欄位（FIB 的 wIdent / flags / ccpText / fcClx / lcbClx）、Clx 與文字。

import * as CFB from 'cfb';

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/**
 * @param {{ text: string, unicode?: boolean }[]} pieces 每個片段可選 8-bit（預設）或 UTF-16
 * @param {{ encrypted?: boolean, table1?: boolean, ccpText?: number, prc?: boolean, noClx?: boolean }} [opts]
 */
export function buildDoc(pieces, opts = {}) {
  const FIB_SIZE = 0x200;
  const dataParts = [];
  const cps = [0];
  const pcds = [];
  let offset = FIB_SIZE;
  let chars = 0;
  for (const p of pieces) {
    const bytes = p.unicode ? Buffer.from(p.text, 'utf16le') : Buffer.from(p.text, 'latin1');
    const fc = p.unicode ? offset : ((offset * 2) | 0x40000000) >>> 0;
    pcds.push(Buffer.concat([u16(0), u32(fc), u16(0)]));
    dataParts.push(bytes);
    offset += bytes.length;
    chars += p.text.length;
    cps.push(chars);
  }

  const word = Buffer.alloc(FIB_SIZE);
  word.writeUInt16LE(0xa5ec, 0);
  word.writeUInt16LE((opts.encrypted ? 0x0100 : 0) | (opts.table1 ? 0x0200 : 0), 0x0a);
  word.writeUInt32LE(opts.ccpText ?? chars, 0x4c);

  const plc = Buffer.concat([...cps.map(u32), ...pcds]);
  const clxParts = [];
  if (opts.prc) clxParts.push(Buffer.from([0x01]), u16(4), Buffer.from([1, 2, 3, 4]));
  clxParts.push(Buffer.from([0x02]), u32(plc.length), plc);
  const clx = Buffer.concat(clxParts);
  word.writeUInt32LE(0, 0x1a2);
  word.writeUInt32LE(opts.noClx ? 0 : clx.length, 0x1a6);

  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/WordDocument', Buffer.concat([word, ...dataParts]));
  CFB.utils.cfb_add(cfb, opts.table1 ? '/1Table' : '/0Table', clx);
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }));
}

/** 只有 Workbook 資料流的 OLE 檔（模擬 .xls），用來測試「不是 Word」的錯誤。 */
export function buildFakeXls() {
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/Workbook', Buffer.from('not word'));
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }));
}
