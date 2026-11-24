// Excel 預覽的純資料邏輯（不碰 DOM，方便用 Node 直接測試）。
// 試算表用「虛擬捲動」繪製：只畫視窗內看得到的儲存格，所以幾萬列的表格也不會卡。

export const HEADER_W = 52; // 列號欄寬
export const HEADER_H = 26; // 欄名列高
export const DEFAULT_COL_W = 88;
export const DEFAULT_ROW_H = 22;
export const MIN_ROW_H = 20;
export const MIN_ROWS = 40;
export const MIN_COLS = 14;
export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

/** 0 → A、25 → Z、26 → AA */
export function colName(index) {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function cellAddress(r, c) {
  return `${colName(c)}${r + 1}`;
}

export function parseColName(name) {
  let n = 0;
  for (const ch of name) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "B2:F10" 或 "C3" → { s:{r,c}, e:{r,c} }；無法解析回傳 null */
export function decodeRef(ref) {
  if (typeof ref !== 'string') return null;
  const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(ref.trim());
  if (!m) return null;
  const s = { r: Number(m[2]) - 1, c: parseColName(m[1].toUpperCase()) };
  const e = m[3] ? { r: Number(m[4]) - 1, c: parseColName(m[3].toUpperCase()) } : { ...s };
  if (s.r < 0 || e.r < 0 || s.c < 0 || e.c < 0) return null;
  return { s: { r: Math.min(s.r, e.r), c: Math.min(s.c, e.c) }, e: { r: Math.max(s.r, e.r), c: Math.max(s.c, e.c) } };
}

/** SheetJS 的 dense 工作表把資料放在 ws['!data'][r][c]；非 dense 則是 ws['A1']。兩種都支援。 */
export function getCell(ws, r, c) {
  const data = ws['!data'];
  if (data) return data[r]?.[c];
  return ws[cellAddress(r, c)];
}

export function cellText(cell) {
  if (!cell) return '';
  if (cell.w != null) return String(cell.w);
  if (cell.v == null) return '';
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  return String(cell.v);
}

/** 公式列顯示的內容：有公式就顯示 =公式，否則顯示儲存格的值。 */
export function cellEditorText(cell) {
  if (!cell) return '';
  if (cell.f) return `=${cell.f}`;
  if (cell.t === 'd' || cell.w != null) return cellText(cell);
  return cell.v == null ? '' : String(cell.v);
}

export function cellAlign(cell) {
  if (!cell) return 'left';
  switch (cell.t) {
    case 'n':
    case 'd':
      return 'right';
    case 'b':
    case 'e':
      return 'center';
    default:
      return 'left';
  }
}

/** 讀取儲存格底色（SheetJS 只解析得出 rgb 的純色填滿；主題色 / 索引色略過）。 */
export function cellFill(cell) {
  const s = cell?.s;
  if (!s || s.patternType === 'none') return null;
  const rgb = s.fgColor?.rgb;
  if (typeof rgb !== 'string' || !/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(rgb)) return null;
  const hex = rgb.length === 8 ? rgb.slice(2) : rgb;
  return `#${hex.toLowerCase()}`;
}

/** 依底色亮度挑黑或白字，確保有底色的儲存格在深淺主題都讀得到。 */
export function contrastColor(hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1f1f1f' : '#ffffff';
}

function colWidth(ws, c) {
  const col = ws['!cols']?.[c];
  if (!col) return DEFAULT_COL_W;
  if (col.hidden) return 0;
  if (col.wpx > 0) return Math.min(col.wpx, 800);
  if (col.wch > 0) return Math.min(Math.round(col.wch * 7 + 5), 800);
  return DEFAULT_COL_W;
}

function rowHeight(ws, r) {
  const row = ws['!rows']?.[r];
  if (!row) return DEFAULT_ROW_H;
  if (row.hidden) return 0;
  // 其他軟體（例如 LibreOffice）存出的預設列高常只有 17px，放進我們的字級會被切掉，所以設下限
  if (row.hpx > 0) return Math.max(MIN_ROW_H, Math.min(row.hpx, 600));
  if (row.hpt > 0) return Math.max(MIN_ROW_H, Math.min(Math.round((row.hpt * 96) / 72), 600));
  return DEFAULT_ROW_H;
}

/**
 * 建立一張工作表的版面模型：欄寬 / 列高的累計位置、合併儲存格、實際資料範圍。
 * colX[i] 是第 i 欄左邊緣的 x（colX[cols] = 總寬）；rowY 同理。
 */
export function buildModel(ws) {
  const range = decodeRef(ws['!ref']);
  const dataRows = range ? Math.min(range.e.r + 1, MAX_ROWS) : 0;
  const dataCols = range ? Math.min(range.e.c + 1, MAX_COLS) : 0;
  const rows = Math.max(dataRows, MIN_ROWS);
  const cols = Math.max(dataCols, MIN_COLS);

  const colX = new Float64Array(cols + 1);
  for (let c = 0; c < cols; c++) colX[c + 1] = colX[c] + colWidth(ws, c);
  const rowY = new Float64Array(rows + 1);
  for (let r = 0; r < rows; r++) rowY[r + 1] = rowY[r] + rowHeight(ws, r);

  const merges = [];
  for (const m of ws['!merges'] ?? []) {
    if (!m?.s || !m?.e) continue;
    const r = m.s.r;
    const c = m.s.c;
    const rs = m.e.r - m.s.r + 1;
    const cs = m.e.c - m.s.c + 1;
    if (r < 0 || c < 0 || r >= rows || c >= cols || (rs === 1 && cs === 1)) continue;
    merges.push({ r, c, rs: Math.min(rs, rows - r), cs: Math.min(cs, cols - c) });
  }

  return { rows, cols, dataRows, dataCols, colX, rowY, merges, ref: ws['!ref'] ?? null };
}

/** 累計位置陣列中，最後一個「起點 <= pos」的索引（夾在 0..n-1）。 */
export function findIndex(prefix, pos) {
  const n = prefix.length - 1;
  if (n <= 0) return 0;
  if (pos <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 與視窗範圍有重疊的合併儲存格。 */
export function mergesInWindow(merges, r0, r1, c0, c1) {
  return merges.filter((m) => m.r <= r1 && m.r + m.rs - 1 >= r0 && m.c <= c1 && m.c + m.cs - 1 >= c0);
}

/** 找出涵蓋 (r, c) 的合併儲存格（沒有則回傳 null）。 */
export function mergeAt(merges, r, c) {
  for (const m of merges) {
    if (r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs) return m;
  }
  return null;
}

/** 選取範圍轉成 TSV（貼到 Excel / 試算表時會自動分欄）。 */
export function rangeToTsv(ws, r0, c0, r1, c1, maxCells = 500_000) {
  if ((r1 - r0 + 1) * (c1 - c0 + 1) > maxCells) {
    throw new Error('選取範圍太大，無法複製（請縮小範圍）。');
  }
  const lines = [];
  for (let r = r0; r <= r1; r++) {
    const cells = [];
    for (let c = c0; c <= c1; c++) {
      const text = cellText(getCell(ws, r, c));
      cells.push(/[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

/** 選取範圍的數值統計（和試算表狀態列的「計數 / 總和 / 平均」一樣）。 */
export function rangeStats(ws, r0, c0, r1, c1, maxCells = 200_000) {
  if ((r1 - r0 + 1) * (c1 - c0 + 1) > maxCells) return null;
  let count = 0;
  let numeric = 0;
  let sum = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = getCell(ws, r, c);
      if (!cell || cell.v == null || cell.v === '') continue;
      count++;
      if (cell.t === 'n' && Number.isFinite(cell.v)) {
        numeric++;
        sum += cell.v;
      }
    }
  }
  return { count, numeric, sum, average: numeric ? sum / numeric : 0 };
}
