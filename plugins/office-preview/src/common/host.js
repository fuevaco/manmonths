// Orca 自訂編輯器 frame 的共用啟動程式：
// 取得文件位元組、跟隨 Orca 深淺主題，並提供「載入中 / 錯誤」遮罩。
// 這個外掛只做預覽：絕不呼叫 applyEdit，避免把檔案誤標成「已修改」。

import { errorMessage, toUint8 } from './format.js';

const $ = (id) => document.getElementById(id);

export const ui = {
  loading(message = '載入中…') {
    const o = $('overlay');
    if (!o) return;
    o.className = 'overlay loading';
    o.innerHTML = '';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const text = document.createElement('div');
    text.className = 'overlay-text';
    text.textContent = message;
    o.append(spinner, text);
    o.hidden = false;
  },
  error(message, detail) {
    const o = $('overlay');
    if (!o) return;
    o.className = 'overlay error';
    o.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = message;
    o.append(title);
    if (detail) {
      const d = document.createElement('div');
      d.className = 'overlay-text';
      d.textContent = detail;
      o.append(d);
    }
    o.hidden = false;
  },
  hide() {
    const o = $('overlay');
    if (o) o.hidden = true;
  },
  /** 工具列右側的小提示（例如格式資訊） */
  info(text) {
    const el = $('info');
    if (el) el.textContent = text || '';
  },
  /** 內容區頂端的提示條（例如「.doc 僅顯示純文字」） */
  notice(text) {
    const el = $('notice');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }
};

function currentScheme() {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

function applyScheme(scheme) {
  const s = scheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.scheme = s;
  return s;
}

/**
 * @param {{ render: (doc: { bytes: Uint8Array, fileType?: string, version?: number, readOnly?: boolean }) => Promise<void> | void,
 *           onTheme?: (scheme: 'light'|'dark') => void,
 *           standaloneAccept?: string }} options
 */
export function bootstrap({ render, onTheme, standaloneAccept }) {
  let seq = 0;

  async function run(doc) {
    const mine = ++seq;
    ui.loading();
    // 讓瀏覽器先把「載入中」畫出來，再開始耗時的解析
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    if (mine !== seq) return;
    try {
      await render({ ...doc, isCurrent: () => mine === seq });
      if (mine === seq) ui.hide();
    } catch (err) {
      if (mine !== seq) return;
      console.error('[office-preview] 無法預覽：', err);
      ui.error('無法預覽這個檔案', errorMessage(err));
    }
  }

  function handleDocument(doc) {
    if (!doc || !doc.content) return;
    if (doc.content.kind !== 'bytes') {
      ui.error('這個編輯器只能開啟二進位檔案', '檔案內容以文字形式傳入，無法預覽。');
      return;
    }
    let bytes;
    try {
      bytes = toUint8(doc.content.bytes);
    } catch (err) {
      ui.error('無法讀取檔案內容', errorMessage(err));
      return;
    }
    run({ bytes, fileType: doc.fileType, version: doc.version, readOnly: !!doc.readOnly });
  }

  const orca = window.orca;
  const scheme = applyScheme(currentScheme());
  onTheme?.(scheme);

  if (orca && orca.document) {
    if (typeof orca.on === 'function') {
      orca.on('theme', (theme) => {
        const s = applyScheme(theme && theme.colorScheme ? theme.colorScheme : currentScheme());
        onTheme?.(s);
      });
    }
    // onDidChange 會先送出目前的文件，之後檔案在外部變動時再送新的
    orca.document.onDidChange(handleDocument);
    return;
  }

  // 沒有 Orca（直接用瀏覽器開 html 除錯）：提供檔案選擇與拖放，也可用 ?src=檔案網址 直接載入
  const params = new URLSearchParams(location.search);
  const dark = params.get('scheme')
    ? params.get('scheme') !== 'light'
    : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  // 注意：不能寫成 onTheme?.(applyScheme(...))，onTheme 不存在時可選呼叫會連引數都不計算
  const standaloneScheme = applyScheme(dark ? 'dark' : 'light');
  onTheme?.(standaloneScheme);
  ui.error('獨立除錯模式', '請把檔案拖曳到這個視窗，或按下方按鈕選擇檔案。');
  const o = $('overlay');
  const input = document.createElement('input');
  input.type = 'file';
  if (standaloneAccept) input.accept = standaloneAccept;
  input.addEventListener('change', () => input.files[0] && openFile(input.files[0]));
  o.append(input);
  const openBuffer = (buf, name) => {
    const dot = name.lastIndexOf('.');
    handleDocument({
      version: Date.now(),
      readOnly: true,
      fileType: dot >= 0 ? name.slice(dot).toLowerCase() : undefined,
      content: { kind: 'bytes', bytes: buf }
    });
  };
  const openFile = async (file) => openBuffer(await file.arrayBuffer(), file.name);
  const src = params.get('src');
  if (src) {
    fetch(src)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`載入 ${src} 失敗（HTTP ${r.status}）`))))
      .then((buf) => openBuffer(buf, src))
      .catch((err) => ui.error('無法載入檔案', errorMessage(err)));
  }
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) openFile(f);
  });
}

/** 把工具列上的按鈕連到動作；回傳 setDisabled 供切換狀態用。 */
export function onClick(id, handler) {
  const el = $(id);
  if (el) el.addEventListener('click', handler);
  return el;
}
