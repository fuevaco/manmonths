// 判斷檔案的真實格式（看檔頭 magic bytes，不看副檔名）。
// 副檔名常常不可靠：例如被誤命名成 .doc 的 .docx，或是 .xls 其實是 HTML。

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** 把 Orca 給的 ArrayBuffer / Uint8Array / 其他 TypedArray 統一成 Uint8Array（不複製資料）。 */
export function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  // cfb 等套件有時回傳一般的 number[]
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  // 跨 frame 傳來的 ArrayBuffer 可能不是同一個 realm 的 instance
  if (bytes && typeof bytes.byteLength === 'number' && typeof bytes.slice === 'function') {
    return new Uint8Array(bytes);
  }
  throw new TypeError('不是有效的二進位內容');
}

/**
 * @returns {'zip' | 'ole2' | 'rtf' | 'markup' | 'empty' | 'unknown'}
 *   zip   = OOXML（docx / xlsx / pptx）或 ODF（ods）
 *   ole2  = 舊版 Office 二進位（doc / xls / ppt）
 *   rtf   = RTF 文字
 *   markup= HTML / XML 文字（例如把 HTML 存成 .xls）
 */
export function sniff(bytes) {
  const b = toUint8(bytes);
  if (b.length === 0) return 'empty';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    return 'zip';
  }
  if (b.length >= 8 && OLE2_MAGIC.every((v, i) => b[i] === v)) return 'ole2';
  const head = headText(b, 64).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('{\\rtf')) return 'rtf';
  if (head.startsWith('<?xml') || head.startsWith('<html') || head.startsWith('<!doctype html') || head.startsWith('<table')) {
    return 'markup';
  }
  return 'unknown';
}

function headText(b, n) {
  // 略過 UTF-8 BOM（EF BB BF）
  const start = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  let s = '';
  const end = Math.min(start + n, b.length);
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function errorMessage(err) {
  if (!err) return '未知錯誤';
  if (typeof err === 'string') return err;
  return err.message ? String(err.message) : String(err);
}
