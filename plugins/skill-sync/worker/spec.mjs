// Skills Registry API 標準 v1 的「可執行版本」：
// 索引（index.json）與清單（manifest.json）的驗證、摘要（digest）計算、路徑安全檢查。
// 外掛 worker、tools/verify-api.mjs、tools/build-registry.mjs 與測試共用同一份，
// 所以「外掛認得的格式」和「驗證工具檢查的格式」不會分歧。
// 對應文件：docs/SKILLS-API-SPEC.md

import { createHash } from 'node:crypto';

export const SPEC_VERSION = 1;

export const LIMITS = Object.freeze({
  maxIndexBytes: 5 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxIndexSkills: 2000,
  maxFiles: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxPathLength: 200
});

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// ---------- 路徑安全 ----------

// 回傳錯誤訊息；合法則回傳 null。
// 規則：相對路徑、正斜線分隔、不可跳出資料夾，並避開 Windows 不能建立的名稱。
export function checkSafePath(p) {
  if (typeof p !== 'string' || p.length === 0) return '路徑必須是非空字串';
  if (p.length > LIMITS.maxPathLength) return `路徑超過 ${LIMITS.maxPathLength} 字元`;
  if (p.startsWith('/')) return '不可使用絕對路徑';
  if (p.includes('\\')) return '請使用正斜線 / 分隔，不可含反斜線';
  if (p.includes(':')) return '路徑不可含冒號（避免磁碟機代號與資料流名稱）';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return '路徑不可含控制字元';
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return `路徑含不合法的段落「${seg}」`;
    if (/[. ]$/.test(seg)) return `段落「${seg}」不可以句點或空白結尾（Windows 不支援）`;
    if (/[<>"|?*]/.test(seg)) return `段落「${seg}」含 Windows 不允許的字元`;
    if (WINDOWS_RESERVED.test(seg)) return `段落「${seg}」是 Windows 保留名稱`;
    if (seg.toLowerCase() === '.git') return '路徑不可進入 .git';
  }
  return null;
}

// ---------- 摘要 ----------

// skill 內容摘要：把檔案依路徑排序，每個檔案組成「路徑 \0 sha256 \n」後整體再雜湊。
// 只與「路徑 + 內容」有關，與檔案順序、大小欄位、下載網址無關。
// 排序用路徑的 UTF-8 位元組順序（等同 Unicode 碼點順序），不依賴任何語言的字串比較慣例，
// 這樣 Python、PHP、Go 等語言的實作都能算出同樣的結果。
export function computeDigest(files) {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const h = createHash('sha256');
  for (const f of sorted) h.update(`${f.path}\0${f.sha256}\n`, 'utf8');
  return `sha256:${h.digest('hex')}`;
}

// ---------- 版本 ----------

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v));
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

// semver 比較（忽略 build metadata）：a<b 回 -1，相等 0，a>b 回 1；無法解析時回 0
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1; // 正式版大於預覽版
  if (!pb.pre.length) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ---------- 檔案分類（客戶端自行判斷，不信任伺服器的 hasScripts 宣告） ----------

const RUNNABLE_EXT = new Set([
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'vbs', 'py', 'rb', 'pl', 'php',
  'js', 'mjs', 'cjs', 'ts', 'exe', 'dll', 'com', 'msi', 'jar', 'app', 'scr', 'so', 'dylib'
]);

export function isRunnableFile(file) {
  if (file.executable) return true;
  const base = String(file.path).split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false;
  return RUNNABLE_EXT.has(base.slice(dot + 1).toLowerCase());
}

export function listRunnableFiles(files) {
  return files.filter(isRunnableFile).map((f) => f.path);
}

// ---------- SKILL.md frontmatter ----------

// 只解析最常見的「key: value」純量欄位；足夠讀出 name / description。
export function parseSkillFrontmatter(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[kv[1]] = val;
  }
  return out;
}

// ---------- 驗證 ----------

class Issues {
  constructor() {
    this.list = [];
  }
  error(path, message) {
    this.list.push({ level: 'error', path, message });
  }
  warn(path, message) {
    this.list.push({ level: 'warning', path, message });
  }
  get errors() {
    return this.list.filter((i) => i.level === 'error');
  }
  get warnings() {
    return this.list.filter((i) => i.level === 'warning');
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isIsoDate = (v) => isStr(v) && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v);

function checkSpecVersion(obj, issues) {
  if (obj.specVersion !== SPEC_VERSION) {
    issues.error('specVersion', `必須是 ${SPEC_VERSION}（收到 ${JSON.stringify(obj.specVersion)}）`);
  }
}

function checkCommon(entry, at, issues) {
  if (!isStr(entry.name) || !NAME_RE.test(entry.name)) {
    issues.error(`${at}.name`, '必須是小寫英數與連字號（1–64 字元，不可以連字號開頭或結尾）');
  }
  if (!isStr(entry.version) || !VERSION_RE.test(entry.version)) {
    issues.error(`${at}.version`, '必須是語意化版本，例如 1.2.0');
  }
  if (!isStr(entry.digest) || !DIGEST_RE.test(entry.digest)) {
    issues.error(`${at}.digest`, '必須是 "sha256:" 加 64 位小寫十六進位');
  }
}

export function validateIndex(json) {
  const issues = new Issues();
  if (!isObj(json)) {
    issues.error('', '索引必須是 JSON 物件');
    return { ok: false, issues: issues.list, index: null };
  }
  checkSpecVersion(json, issues);
  if (json.generatedAt !== undefined && !isIsoDate(json.generatedAt)) {
    issues.warn('generatedAt', '建議使用 ISO 8601 時間，例如 2026-01-01T00:00:00Z');
  }
  if (json.name !== undefined && !isStr(json.name)) issues.error('name', '必須是字串');
  if (!Array.isArray(json.skills)) {
    issues.error('skills', '必須是陣列');
    return { ok: false, issues: issues.list, index: null };
  }
  if (json.skills.length > LIMITS.maxIndexSkills) {
    issues.error('skills', `最多 ${LIMITS.maxIndexSkills} 筆`);
  }
  const seen = new Set();
  json.skills.forEach((s, i) => {
    const at = `skills[${i}]`;
    if (!isObj(s)) {
      issues.error(at, '必須是物件');
      return;
    }
    checkCommon(s, at, issues);
    if (isStr(s.name)) {
      if (seen.has(s.name)) issues.error(`${at}.name`, `名稱「${s.name}」重複（索引中每個名稱只列最新的一筆）`);
      seen.add(s.name);
    }
    if (!isStr(s.description) || !s.description.trim()) {
      issues.error(`${at}.description`, '必須是非空字串');
    } else if (s.description.length > 1024) {
      issues.warn(`${at}.description`, '超過 1024 字元，面板會截斷');
    }
    if (!isStr(s.manifestUrl) || !s.manifestUrl) issues.error(`${at}.manifestUrl`, '必須是非空字串');
    if (s.title !== undefined && !isStr(s.title)) issues.error(`${at}.title`, '必須是字串');
    if (s.author !== undefined && !isStr(s.author)) issues.error(`${at}.author`, '必須是字串');
    if (s.license !== undefined && !isStr(s.license)) issues.error(`${at}.license`, '必須是字串');
    if (s.homepage !== undefined && !isStr(s.homepage)) issues.error(`${at}.homepage`, '必須是字串');
    if (s.tags !== undefined && !(Array.isArray(s.tags) && s.tags.every(isStr))) {
      issues.error(`${at}.tags`, '必須是字串陣列');
    }
    if (s.hasScripts !== undefined && typeof s.hasScripts !== 'boolean') {
      issues.error(`${at}.hasScripts`, '必須是布林值');
    }
    if (s.size !== undefined && !(Number.isInteger(s.size) && s.size >= 0)) {
      issues.error(`${at}.size`, '必須是非負整數（位元組）');
    }
    if (s.updatedAt !== undefined && !isIsoDate(s.updatedAt)) {
      issues.warn(`${at}.updatedAt`, '建議使用 ISO 8601 時間');
    }
  });
  return { ok: issues.errors.length === 0, issues: issues.list, index: json };
}

// expect: { name?, version?, digest? }（通常來自索引項目，要求清單與索引一致）
export function validateManifest(json, expect = {}) {
  const issues = new Issues();
  if (!isObj(json)) {
    issues.error('', '清單必須是 JSON 物件');
    return { ok: false, issues: issues.list, manifest: null };
  }
  checkSpecVersion(json, issues);
  checkCommon(json, '', issues);
  for (const key of ['name', 'version', 'digest']) {
    if (expect[key] !== undefined && json[key] !== expect[key]) {
      issues.error(key, `與索引不一致（索引：${expect[key]}，清單：${json[key]}）`);
    }
  }
  if (!Array.isArray(json.files)) {
    issues.error('files', '必須是陣列');
    return { ok: false, issues: issues.list, manifest: null };
  }
  if (json.files.length === 0) issues.error('files', '至少要有 SKILL.md');
  if (json.files.length > LIMITS.maxFiles) issues.error('files', `最多 ${LIMITS.maxFiles} 個檔案`);

  const seen = new Set();
  let total = 0;
  json.files.forEach((f, i) => {
    const at = `files[${i}]`;
    if (!isObj(f)) {
      issues.error(at, '必須是物件');
      return;
    }
    const pathErr = checkSafePath(f.path);
    if (pathErr) issues.error(`${at}.path`, pathErr);
    else {
      const k = f.path.toLowerCase();
      if (seen.has(k)) issues.error(`${at}.path`, `路徑「${f.path}」重複（Windows 不分大小寫）`);
      seen.add(k);
    }
    if (!(Number.isInteger(f.size) && f.size >= 0)) {
      issues.error(`${at}.size`, '必須是非負整數');
    } else {
      if (f.size > LIMITS.maxFileBytes) issues.error(`${at}.size`, `單檔上限 ${LIMITS.maxFileBytes} 位元組`);
      total += f.size;
    }
    if (!isStr(f.sha256) || !SHA256_RE.test(f.sha256)) {
      issues.error(`${at}.sha256`, '必須是 64 位小寫十六進位');
    }
    if (!isStr(f.url) || !f.url) issues.error(`${at}.url`, '必須是非空字串（絕對網址，或相對於清單網址）');
    if (f.executable !== undefined && typeof f.executable !== 'boolean') {
      issues.error(`${at}.executable`, '必須是布林值');
    }
  });
  if (total > LIMITS.maxTotalBytes) issues.error('files', `總大小上限 ${LIMITS.maxTotalBytes} 位元組`);
  if (!json.files.some((f) => isObj(f) && f.path === 'SKILL.md')) {
    issues.error('files', '根目錄必須有 SKILL.md');
  }
  // 摘要要能由檔案清單重新算出來，這是完整性驗證的核心
  const filesOk = json.files.every(
    (f) => isObj(f) && isStr(f.path) && isStr(f.sha256) && SHA256_RE.test(f.sha256)
  );
  if (filesOk && isStr(json.digest) && DIGEST_RE.test(json.digest)) {
    const actual = computeDigest(json.files);
    if (actual !== json.digest) issues.error('digest', `與檔案清單算出的摘要不符（應為 ${actual}）`);
  }
  return { ok: issues.errors.length === 0, issues: issues.list, manifest: json };
}

export function formatIssues(issues) {
  return issues.map((i) => `${i.level === 'error' ? '✗' : '!'} ${i.path || '(根)'}：${i.message}`).join('\n');
}
