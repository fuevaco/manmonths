import * as XLSX from '@e965/xlsx';
import { errorMessage, formatSize, sniff } from '../common/format.js';
import { bootstrap, ui } from '../common/host.js';
import {
  HEADER_H,
  HEADER_W,
  buildModel,
  cellAddress,
  cellAlign,
  cellEditorText,
  cellFill,
  cellText,
  colName,
  contrastColor,
  findIndex,
  getCell,
  mergeAt,
  mergesInWindow,
  rangeStats,
  rangeToTsv
} from './grid-model.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const frame = $('frame');
const spacer = $('spacer');
const tabsEl = $('tabs');
const statusEl = $('status');
const nameBox = $('namebox');
const fxText = $('fx');

/** @type {{ name: string, ws: any, model: any }[]} */
let sheets = [];
let current = -1;
let selection = { ar: 0, ac: 0, fr: 0, fc: 0 };
let dragging = false;
let scheduled = false;

const sheet = () => sheets[current];

// ---------- 載入 ----------

async function render({ bytes, fileType, isCurrent }) {
  const previousSheetName = sheet()?.name;
  const kind = sniff(bytes);
  if (kind === 'empty') throw new Error('檔案是空的（0 位元組）。');
  if (kind === 'rtf' || kind === 'unknown') {
    throw new Error('無法辨識的檔案格式：它不是 Excel（.xlsx / .xls / .xlsb / .ods）檔案。');
  }

  let wb;
  try {
    wb = XLSX.read(bytes, {
      type: 'array',
      dense: true,
      cellDates: true,
      cellNF: true,
      cellStyles: true
    });
  } catch (err) {
    const msg = errorMessage(err);
    if (/password|encrypt/i.test(msg)) throw new Error('這份活頁簿有密碼保護，無法預覽。');
    throw new Error(`無法解析這個檔案：它可能不是 Excel 活頁簿，或檔案已損毀。（${msg}）`);
  }
  if (!isCurrent()) return;

  const hiddenFlags = wb.Workbook?.Sheets ?? [];
  sheets = wb.SheetNames.map((name, i) => ({ name, ws: wb.Sheets[name], hidden: (hiddenFlags[i]?.Hidden ?? 0) !== 0, model: null }))
    .filter((s) => s.ws && !s.hidden)
    .map(({ hidden, ...rest }) => rest);
  if (!sheets.length) throw new Error('這份活頁簿沒有可顯示的工作表。');

  ui.info(`${formatSize(bytes.byteLength)}${fileType ? ` · ${fileType}` : ''} · ${sheets.length} 張工作表`);
  // 檔案在外部被改動而重新載入時，盡量停留在原本看的那張工作表
  const keep = Math.max(0, sheets.findIndex((s) => s.name === previousSheetName));
  current = -1;
  buildTabs();
  selectSheet(keep);
}

function buildTabs() {
  tabsEl.replaceChildren(
    ...sheets.map((s, i) => {
      const b = document.createElement('button');
      b.className = 'tab';
      b.type = 'button';
      b.role = 'tab';
      b.textContent = s.name;
      b.title = s.name;
      b.addEventListener('click', () => selectSheet(i));
      return b;
    })
  );
}

function selectSheet(index) {
  if (index === current && sheets[index]?.model) return;
  current = index;
  const s = sheet();
  s.model ||= buildModel(s.ws);
  [...tabsEl.children].forEach((b, i) => b.classList.toggle('active', i === index));
  selection = { ar: 0, ac: 0, fr: 0, fc: 0 };
  spacer.style.width = `${HEADER_W + s.model.colX[s.model.cols]}px`;
  spacer.style.height = `${HEADER_H + s.model.rowY[s.model.rows]}px`;
  viewport.scrollTo(0, 0);
  updateInfo();
  draw();
  viewport.focus({ preventScroll: true });
}

// ---------- 繪製（虛擬捲動）----------

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    draw();
  });
}

function el(className, left, top, width, height) {
  const d = document.createElement('div');
  d.className = className;
  d.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
  return d;
}

function selectionBounds() {
  return {
    r0: Math.min(selection.ar, selection.fr),
    r1: Math.max(selection.ar, selection.fr),
    c0: Math.min(selection.ac, selection.fc),
    c1: Math.max(selection.ac, selection.fc)
  };
}

function draw() {
  const s = sheet();
  if (!s) return;
  const { model, ws } = s;
  const W = viewport.clientWidth;
  const H = viewport.clientHeight;
  frame.style.width = `${W}px`;
  frame.style.height = `${H}px`;

  const sx = viewport.scrollLeft;
  const sy = viewport.scrollTop;
  const c0 = findIndex(model.colX, sx);
  const c1 = Math.min(model.cols - 1, findIndex(model.colX, sx + W - HEADER_W) + 1);
  const r0 = findIndex(model.rowY, sy);
  const r1 = Math.min(model.rows - 1, findIndex(model.rowY, sy + H - HEADER_H) + 1);

  const x = (c) => HEADER_W + model.colX[c] - sx;
  const y = (r) => HEADER_H + model.rowY[r] - sy;

  const merges = mergesInWindow(model.merges, r0, r1, c0, c1);
  const covered = new Set();
  const anchors = new Map();
  for (const m of merges) {
    anchors.set(m.r * 65536 + m.c, m);
    for (let r = Math.max(m.r, r0); r <= Math.min(m.r + m.rs - 1, r1); r++) {
      for (let c = Math.max(m.c, c0); c <= Math.min(m.c + m.cs - 1, c1); c++) {
        if (r !== m.r || c !== m.c) covered.add(r * 65536 + c);
      }
    }
  }

  const bounds = selectionBounds();
  const body = document.createDocumentFragment();

  const paintCell = (r, c, width, height) => {
    const cell = getCell(ws, r, c);
    const d = el('cell', x(c), y(r), width, height);
    // 文字垂直置中：行高等於列高（單行文字，超出的部分被 overflow 切掉）
    d.style.lineHeight = `${Math.max(16, Math.min(height, 60) - 1)}px`;
    if (cell) {
      d.textContent = cellText(cell);
      d.style.textAlign = cellAlign(cell);
      if (cell.t === 'e') d.classList.add('err');
      const fill = cellFill(cell);
      if (fill) {
        d.style.background = fill;
        d.style.color = contrastColor(fill);
      }
    }
    body.append(d);
  };

  for (let r = r0; r <= r1; r++) {
    const h = model.rowY[r + 1] - model.rowY[r];
    if (h <= 0) continue;
    for (let c = c0; c <= c1; c++) {
      const w = model.colX[c + 1] - model.colX[c];
      if (w <= 0) continue;
      const key = r * 65536 + c;
      if (covered.has(key) || anchors.has(key)) continue;
      paintCell(r, c, w, h);
    }
  }
  for (const m of merges) {
    const width = model.colX[m.c + m.cs] - model.colX[m.c];
    const height = model.rowY[m.r + m.rs] - model.rowY[m.r];
    if (width > 0 && height > 0) paintCell(m.r, m.c, width, height);
  }

  // 選取框
  {
    const left = x(bounds.c0);
    const top = y(bounds.r0);
    const width = model.colX[bounds.c1 + 1] - model.colX[bounds.c0];
    const height = model.rowY[bounds.r1 + 1] - model.rowY[bounds.r0];
    const sel = el('selection', left - 1, top - 1, Math.max(width, 2) + 1, Math.max(height, 2) + 1);
    body.append(sel);
  }

  // 欄名列 / 列號欄（畫在儲存格之上）
  for (let c = c0; c <= c1; c++) {
    const w = model.colX[c + 1] - model.colX[c];
    if (w <= 0) continue;
    const h = el('hdr' + (c >= bounds.c0 && c <= bounds.c1 ? ' on' : ''), x(c), 0, w, HEADER_H);
    h.textContent = colName(c);
    body.append(h);
  }
  for (let r = r0; r <= r1; r++) {
    const hgt = model.rowY[r + 1] - model.rowY[r];
    if (hgt <= 0) continue;
    const h = el('hdr' + (r >= bounds.r0 && r <= bounds.r1 ? ' on' : ''), 0, y(r), HEADER_W, hgt);
    h.style.lineHeight = `${Math.max(14, Math.min(hgt, 60) - 1)}px`;
    h.textContent = String(r + 1);
    body.append(h);
  }
  const corner = el('hdr corner', 0, 0, HEADER_W, HEADER_H);
  body.append(corner);

  frame.replaceChildren(body);
}

// ---------- 選取 / 資訊列 ----------

function updateInfo() {
  const s = sheet();
  if (!s) return;
  const { ws, model } = s;
  const b = selectionBounds();
  const single = b.r0 === b.r1 && b.c0 === b.c1;
  nameBox.textContent = single ? cellAddress(b.r0, b.c0) : `${cellAddress(b.r0, b.c0)}:${cellAddress(b.r1, b.c1)}`;
  fxText.textContent = cellEditorText(getCell(ws, selection.ar, selection.ac));

  const parts = [];
  if (!single) {
    const stats = rangeStats(ws, b.r0, b.c0, b.r1, b.c1);
    if (stats && stats.count) {
      parts.push(`計數 ${stats.count}`);
      if (stats.numeric) {
        parts.push(`總和 ${fmt(stats.sum)}`, `平均 ${fmt(stats.average)}`);
      }
    }
  }
  parts.push(model.dataRows ? `${model.dataRows.toLocaleString()} 列 × ${model.dataCols.toLocaleString()} 欄` : '空白工作表');
  statusEl.textContent = parts.join(' · ');
}

function fmt(n) {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function setSelection(next, { extend = false, reveal = false } = {}) {
  const { model } = sheet();
  const clampR = (r) => Math.max(0, Math.min(model.rows - 1, r));
  const clampC = (c) => Math.max(0, Math.min(model.cols - 1, c));
  const fr = clampR(next.r);
  const fc = clampC(next.c);
  selection = extend ? { ...selection, fr, fc } : { ar: fr, ac: fc, fr, fc };
  if (reveal) revealCell(fr, fc);
  updateInfo();
  draw();
}

function revealCell(r, c) {
  const { model } = sheet();
  const W = viewport.clientWidth - HEADER_W;
  const H = viewport.clientHeight - HEADER_H;
  const left = model.colX[c];
  const right = model.colX[c + 1];
  const top = model.rowY[r];
  const bottom = model.rowY[r + 1];
  if (left < viewport.scrollLeft) viewport.scrollLeft = left;
  else if (right > viewport.scrollLeft + W) viewport.scrollLeft = right - W;
  if (top < viewport.scrollTop) viewport.scrollTop = top;
  else if (bottom > viewport.scrollTop + H) viewport.scrollTop = bottom - H;
}

/** 視窗座標 → 儲存格。回傳 null 表示點在捲軸上。 */
function hit(e) {
  const rect = viewport.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  if (px >= viewport.clientWidth || py >= viewport.clientHeight || px < 0 || py < 0) return null;
  const { model } = sheet();
  const inHeaderX = px < HEADER_W;
  const inHeaderY = py < HEADER_H;
  const c = findIndex(model.colX, px - HEADER_W + viewport.scrollLeft);
  const r = findIndex(model.rowY, py - HEADER_H + viewport.scrollTop);
  return { r, c, inHeaderX, inHeaderY };
}

viewport.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !sheet()) return;
  const h = hit(e);
  if (!h) return;
  viewport.focus({ preventScroll: true });
  const { model } = sheet();
  if (h.inHeaderX && h.inHeaderY) {
    selection = { ar: 0, ac: 0, fr: model.rows - 1, fc: model.cols - 1 };
    updateInfo();
    draw();
    return;
  }
  if (h.inHeaderY) {
    selection = { ar: 0, ac: h.c, fr: model.rows - 1, fc: h.c };
    updateInfo();
    draw();
    return;
  }
  if (h.inHeaderX) {
    selection = { ar: h.r, ac: 0, fr: h.r, fc: model.cols - 1 };
    updateInfo();
    draw();
    return;
  }
  const m = mergeAt(model.merges, h.r, h.c);
  const target = m ? { r: m.r, c: m.c } : { r: h.r, c: h.c };
  setSelection(target, { extend: e.shiftKey });
  dragging = true;
});

window.addEventListener('mousemove', (e) => {
  if (!dragging || !sheet()) return;
  const h = hit(e);
  if (!h || h.inHeaderX || h.inHeaderY) return;
  if (h.r === selection.fr && h.c === selection.fc) return;
  setSelection({ r: h.r, c: h.c }, { extend: true });
});
window.addEventListener('mouseup', () => {
  dragging = false;
});

viewport.addEventListener('scroll', schedule, { passive: true });
window.addEventListener('resize', schedule);

viewport.addEventListener('keydown', (e) => {
  const s = sheet();
  if (!s) return;
  const { model } = s;
  const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
  const page = Math.max(1, Math.floor((viewport.clientHeight - HEADER_H) / 22) - 1);
  let target = null;
  if (step) {
    const ctrl = e.ctrlKey || e.metaKey;
    target = {
      r: ctrl && step[0] ? (step[0] < 0 ? 0 : Math.max(0, model.dataRows - 1)) : selection.fr + step[0],
      c: ctrl && step[1] ? (step[1] < 0 ? 0 : Math.max(0, model.dataCols - 1)) : selection.fc + step[1]
    };
  } else if (e.key === 'PageDown') target = { r: selection.fr + page, c: selection.fc };
  else if (e.key === 'PageUp') target = { r: selection.fr - page, c: selection.fc };
  else if (e.key === 'Home') target = { r: e.ctrlKey ? 0 : selection.fr, c: 0 };
  else if (e.key === 'End' && e.ctrlKey) target = { r: Math.max(0, model.dataRows - 1), c: Math.max(0, model.dataCols - 1) };
  else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    selection = { ar: 0, ac: 0, fr: Math.max(0, model.dataRows - 1), fc: Math.max(0, model.dataCols - 1) };
    updateInfo();
    draw();
    return;
  }
  if (!target) return;
  e.preventDefault();
  setSelection(target, { extend: e.shiftKey, reveal: true });
});

// Ctrl+C：用 copy 事件寫入剪貼簿，不需要額外權限
document.addEventListener('copy', (e) => {
  const s = sheet();
  if (!s || !e.clipboardData) return;
  const picked = window.getSelection?.()?.toString();
  if (picked) return; // 使用者選取的是公式列等一般文字，維持預設行為
  const b = selectionBounds();
  try {
    e.clipboardData.setData('text/plain', rangeToTsv(s.ws, b.r0, b.c0, b.r1, b.c1));
    e.preventDefault();
  } catch (err) {
    statusEl.textContent = errorMessage(err);
  }
});

bootstrap({ render, standaloneAccept: '.xlsx,.xlsm,.xlsb,.xls,.ods' });
