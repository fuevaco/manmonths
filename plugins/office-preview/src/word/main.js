import { renderAsync } from 'docx-preview';
import JSZip from 'jszip';
import { errorMessage, formatSize, sniff } from '../common/format.js';
import { bootstrap, onClick, ui } from '../common/host.js';
import { LegacyDocError, extractLegacyDoc } from './doc-legacy.js';

const $ = (id) => document.getElementById(id);
const content = $('content');
const pages = $('pages');
const styleHost = $('docx-style');
const fitBtn = $('btn-fit');
const zoomLabel = $('btn-zoom-reset');
const pagesCount = $('pages-count');

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
let zoom = 1;
let fitMode = true;

function setZoom(value, { fit = false } = {}) {
  fitMode = fit;
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  pages.style.zoom = String(zoom);
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  fitBtn.classList.toggle('active', fitMode);
}

/** 量出紙張在 100% 時的寬度，換算出剛好塞滿視窗的縮放比例。 */
function fitZoom() {
  const paper = pages.querySelector('section.docx, .legacy-paper');
  if (!paper) return 1;
  const previous = pages.style.zoom;
  pages.style.zoom = '1';
  const paperWidth = paper.classList.contains('legacy-paper') ? 794 : paper.offsetWidth;
  pages.style.zoom = previous;
  if (!paperWidth) return 1;
  const available = content.clientWidth - 48;
  // 只縮小不放大：窄視窗時縮到塞得下，寬視窗維持 100%
  return Math.min(1, Math.max(MIN_ZOOM, available / paperWidth));
}

function applyFit() {
  setZoom(fitZoom(), { fit: true });
}

onClick('btn-zoom-in', () => setZoom(zoom * 1.15));
onClick('btn-zoom-out', () => setZoom(zoom / 1.15));
onClick('btn-zoom-reset', () => setZoom(1));
onClick('btn-fit', applyFit);

window.addEventListener('resize', () => fitMode && applyFit());
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false }
);
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    setZoom(zoom * 1.15);
  } else if (e.key === '-') {
    e.preventDefault();
    setZoom(zoom / 1.15);
  } else if (e.key === '0') {
    e.preventDefault();
    setZoom(1);
  }
});

function clear() {
  pages.replaceChildren();
  styleHost.replaceChildren();
  ui.notice('');
  pagesCount.textContent = '';
  content.scrollTo(0, 0);
}

async function renderDocx(bytes) {
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new Error(`無法解開這個檔案：它可能已損毀，或不是 Word 文件。（${errorMessage(err)}）`);
  }
  if (!zip.file('word/document.xml')) {
    throw new Error('這個檔案不是 Word 文件（找不到 word/document.xml）。它可能是 Excel、PowerPoint 或其他壓縮檔。');
  }
  await renderAsync(bytes, pages, styleHost, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreWidth: false,
    ignoreHeight: false,
    ignoreFonts: false,
    ignoreLastRenderedPageBreak: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderComments: false,
    renderChanges: false,
    useBase64URL: true, // 圖片直接內嵌，不依賴 blob: URL
    experimental: true
  });
  const count = pages.querySelectorAll('section.docx').length;
  pagesCount.textContent = count ? `${count} 頁` : '';
}

function renderLegacyBlocks(blocks) {
  const paper = document.createElement('article');
  paper.className = 'legacy-paper';
  for (const block of blocks) {
    if (block.type === 'pagebreak') {
      paper.append(document.createElement('hr'));
    } else if (block.type === 'table') {
      const table = document.createElement('table');
      const width = Math.max(...block.rows.map((r) => r.length));
      for (const row of block.rows) {
        const tr = document.createElement('tr');
        for (let i = 0; i < width; i++) {
          const td = document.createElement('td');
          td.textContent = row[i] ?? '';
          tr.append(td);
        }
        table.append(tr);
      }
      paper.append(table);
    } else {
      const p = document.createElement('p');
      if (block.text === '') p.className = 'blank';
      p.textContent = block.text;
      paper.append(p);
    }
  }
  pages.append(paper);
}

async function render({ bytes, fileType, isCurrent }) {
  clear();
  const kind = sniff(bytes);
  ui.info(`${formatSize(bytes.byteLength)}${fileType ? ` · ${fileType}` : ''}`);

  if (kind === 'zip') {
    await renderDocx(bytes);
  } else if (kind === 'ole2') {
    try {
      const { blocks } = extractLegacyDoc(bytes);
      if (!blocks.length) throw new LegacyDocError('這份文件沒有可顯示的文字內容。', 'empty');
      renderLegacyBlocks(blocks);
      ui.notice('舊版 Word 97-2003（.doc）是二進位格式：這裡只顯示純文字與簡易表格，不含圖片與格式。建議另存為 .docx 以檢視完整版面。');
    } catch (err) {
      if (err instanceof LegacyDocError) throw err;
      throw new LegacyDocError(`解析 .doc 失敗：${errorMessage(err)}`, 'parse_failed');
    }
  } else if (kind === 'rtf') {
    throw new Error('這是 RTF 文字檔（副檔名可能被改成 .doc），目前不支援預覽。請用 Word 另存為 .docx。');
  } else if (kind === 'empty') {
    throw new Error('檔案是空的（0 位元組）。');
  } else {
    throw new Error('無法辨識的檔案格式：它不是 .docx，也不是 Word 97-2003 的 .doc。');
  }

  if (!isCurrent()) return;
  applyFit();
}

bootstrap({ render, standaloneAccept: '.docx,.doc' });
