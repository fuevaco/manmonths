import { init } from 'pptx-preview';
import JSZip from 'jszip';
import { errorMessage, formatSize, sniff } from '../common/format.js';
import { bootstrap, onClick, ui } from '../common/host.js';

const $ = (id) => document.getElementById(id);
const content = $('content');
const stage = $('stage');
const counter = $('slide-counter');
const prevBtn = $('btn-prev');
const nextBtn = $('btn-next');
const singleBtn = $('btn-single');
const listBtn = $('btn-list');
const fitBtn = $('btn-fit');
const zoomLabel = $('btn-zoom-reset');

// pptx-preview 以固定的邏輯寬度繪製投影片；縮放一律用 CSS zoom，不必重新解析檔案。
const BASE_WIDTH = 960;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const STORAGE_KEY = 'office-preview.ppt.view';

let previewer = null;
let slideCount = 0;
let index = 0;
let zoom = 1;
let fitMode = true;
let view = readView(); // 'single' | 'list'
let renderToken = 0;

function readView() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'list' ? 'list' : 'single';
  } catch {
    return 'single';
  }
}

function slideHeight() {
  const p = previewer?.pptx;
  return p && p.width ? BASE_WIDTH * (p.height / p.width) : BASE_WIDTH * 0.5625;
}

function setZoom(value, { fit = false } = {}) {
  fitMode = fit;
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  const wrapper = stage.querySelector('.pptx-preview-wrapper');
  if (wrapper) wrapper.style.zoom = String(zoom);
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  fitBtn.classList.toggle('active', fitMode);
}

function fitZoom() {
  const w = (content.clientWidth - 48) / BASE_WIDTH;
  if (view === 'list') return Math.min(1.5, Math.max(MIN_ZOOM, w));
  const h = (content.clientHeight - 48) / slideHeight();
  return Math.max(MIN_ZOOM, Math.min(w, h, 2));
}

function applyFit() {
  setZoom(fitZoom(), { fit: true });
}

function updateChrome() {
  const single = view === 'single';
  singleBtn.classList.toggle('active', single);
  listBtn.classList.toggle('active', !single);
  prevBtn.disabled = !single || index <= 0;
  nextBtn.disabled = !single || index >= slideCount - 1;
  counter.textContent = slideCount ? (single ? `${index + 1} / ${slideCount}` : `共 ${slideCount} 張`) : '';
}

function showSlide(next) {
  if (!previewer || view !== 'single') return;
  const target = Math.max(0, Math.min(slideCount - 1, next));
  index = target;
  previewer.renderSingleSlide(target);
  updateChrome();
  content.scrollTo(0, 0);
}

async function renderAll(token) {
  // 連續模式：分批繪製所有投影片，避免大型簡報卡住畫面
  const render = previewer.htmlRender;
  for (let i = 0; i < slideCount; i++) {
    if (token !== renderToken) return;
    render.renderSlide(i);
    if (i % 4 === 3) {
      ui.loading(`繪製投影片 ${i + 1} / ${slideCount}…`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

async function showView(next) {
  view = next;
  try {
    localStorage.setItem(STORAGE_KEY, view);
  } catch {
    /* 儲存失敗不影響預覽 */
  }
  if (!previewer) return;
  const token = ++renderToken;
  const wrapper = stage.querySelector('.pptx-preview-wrapper');
  wrapper?.replaceChildren();
  previewer.currentIndex = -1;
  if (view === 'single') {
    previewer.renderSingleSlide(index);
  } else {
    await renderAll(token);
    ui.hide();
    // 切到連續模式後，捲到原本看的那一張
    stage.querySelector(`.pptx-preview-slide-wrapper-${index}`)?.scrollIntoView({ block: 'start' });
  }
  updateChrome();
  applyFit();
}

onClick('btn-prev', () => showSlide(index - 1));
onClick('btn-next', () => showSlide(index + 1));
onClick('btn-single', () => view !== 'single' && showView('single'));
onClick('btn-list', () => view !== 'list' && showView('list'));
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
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '+' || e.key === '=') setZoom(zoom * 1.15);
    else if (e.key === '-') setZoom(zoom / 1.15);
    else if (e.key === '0') setZoom(1);
    else return;
    e.preventDefault();
    return;
  }
  if (view !== 'single') return;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case ' ':
      e.preventDefault();
      showSlide(index + 1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      e.preventDefault();
      showSlide(index - 1);
      break;
    case 'Home':
      e.preventDefault();
      showSlide(0);
      break;
    case 'End':
      e.preventDefault();
      showSlide(slideCount - 1);
      break;
  }
});

async function render({ bytes, fileType, isCurrent }) {
  const kind = sniff(bytes);
  if (kind === 'ole2') {
    throw new Error('這是舊版 PowerPoint 97-2003（.ppt）二進位格式，目前不支援預覽。請用 PowerPoint 另存為 .pptx。');
  }
  if (kind === 'empty') throw new Error('檔案是空的（0 位元組）。');
  if (kind !== 'zip') throw new Error('無法辨識的檔案格式：它不是 .pptx / .ppsx 簡報。');

  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new Error(`無法解開這個檔案：它可能已損毀，或不是 PowerPoint 簡報。（${errorMessage(err)}）`);
  }
  if (!zip.file('ppt/presentation.xml')) {
    throw new Error('這個檔案不是 PowerPoint 簡報（找不到 ppt/presentation.xml）。它可能是 Word、Excel 或其他壓縮檔。');
  }

  const token = ++renderToken;
  previewer?.destroy?.();
  stage.replaceChildren();
  previewer = init(stage, { width: BASE_WIDTH, mode: 'list' });
  // pptx-preview 會把輸入的 ArrayBuffer 交給 JSZip；複製一份，避免動到 Orca 傳進來的原始資料
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await previewer.load(copy);
  if (!isCurrent() || token !== renderToken) return;

  slideCount = previewer.slideCount || 0;
  if (!slideCount) throw new Error('這份簡報沒有投影片。');
  index = Math.min(index, slideCount - 1);
  ui.info(`${formatSize(bytes.byteLength)}${fileType ? ` · ${fileType}` : ''}`);

  const wrapper = stage.querySelector('.pptx-preview-wrapper');
  wrapper?.replaceChildren();
  previewer.currentIndex = -1;
  if (view === 'single') {
    previewer.renderSingleSlide(index);
  } else {
    await renderAll(token);
  }
  updateChrome();
  applyFit();
}

bootstrap({ render, standaloneAccept: '.pptx,.ppsx,.pptm' });
