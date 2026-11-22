// 部署收據（對照 LcAiPack.Core Deployment/DeploymentReceipts.cs，receiptFormatVersion 2）。
// 與 LC-AI-Pack 共用同一份檔案（ADR 0001），因此序列化必須與 .NET System.Text.Json
// （JsonSerializerDefaults.Web + WriteIndented）逐位元組相同：
// - 欄位順序固定，含唯讀計算欄位 targetKey；source／sourcePath 為 null 時省略；
// - 兩格縮排，換行用作業系統預設（Windows CRLF、macOS LF），檔尾無換行；
// - 字串採預設 JavaScriptEncoder：非 ASCII 與 <>&'"+` 一律 \uXXXX（大寫十六進位）；
// - 寫檔：UTF-8 無 BOM、唯一暫存檔後原子替換，替換遇暫時鎖定有界重試。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ErrorCode } from '../contract.mjs';
import { createPathRules } from './canonical-root.mjs';
import { ordinal } from './digest.mjs';

export const SupportedFormatVersion = 2;
export const ProjectDirectoryName = '.lcaipack';
export const FileName = 'receipts.json';

const STRING_FIELDS = ['packageKey', 'packageVersion', 'packageSha256', 'channel', 'contentId', 'kind', 'hostId', 'surfaceId', 'scope',
  'canonicalRoot', 'normalizedAddress', 'destinationPath', 'mutationKind', 'sourceSha256', 'installedSha256'];
const originalProjectEntry = Symbol('originalProjectEntry');
const DEFAULT_INSTALLED_AT = '0001-01-01T00:00:00+00:00';

export class ReceiptFileError extends Error {
  constructor(message, unsupportedFormatVersion = false) { super(message); this.name = 'ReceiptFileError'; this.code = ErrorCode.receiptInvalid; this.unsupportedFormatVersion = unsupportedFormatVersion; }
}

export const targetKeyOf = (r) => `${r.hostId}|${r.surfaceId}|${r.scope}|${r.canonicalRoot}`;

/** .NET 預設 JavaScriptEncoder 的字串跳脫。 */
export function jsonString(value) {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ch = value[i];
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || c > 0x7e || '<>&\'"+`'.includes(ch)) out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/** DateTimeOffset（UTC）以 System.Text.Json 的格式輸出：小數秒去除結尾 0，時區 +00:00。 */
export function formatInstalledAt(date) {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  const fraction = iso.slice(20, 23).replace(/0+$/, '');
  return `${iso.slice(0, 19)}${fraction ? '.' + fraction : ''}+00:00`;
}

function normalizeReceipt(raw) {
  const r = {};
  for (const key of STRING_FIELDS) r[key] = typeof raw?.[key] === 'string' ? raw[key] : '';
  r.ownedConfigFields = Array.isArray(raw?.ownedConfigFields) ? raw.ownedConfigFields.filter(v => typeof v === 'string') : [];
  r.baseValueHashes = Array.isArray(raw?.baseValueHashes) ? raw.baseValueHashes.filter(v => typeof v === 'string') : [];
  r.installedAt = typeof raw?.installedAt === 'string' && /^[0-9][0-9T:.+Z-]*$/.test(raw.installedAt) ? raw.installedAt : DEFAULT_INSTALLED_AT;
  r.clientVersion = typeof raw?.clientVersion === 'string' ? raw.clientVersion : '';
  r.hostProfileVersion = typeof raw?.hostProfileVersion === 'string' ? raw.hostProfileVersion : '';
  if (typeof raw?.source === 'string') r.source = raw.source;
  if (typeof raw?.sourcePath === 'string') r.sourcePath = raw.sourcePath;
  if (r.scope === 'project') Object.defineProperty(r, originalProjectEntry, { value: structuredClone(raw) });
  return r;
}

/** 解析收據檔文字；空白、null、損壞或不支援的格式版本一律明確失敗。 */
export function parseReceiptFile(text, filePath) {
  if (!text || !text.replace(/^﻿/, '').trim()) throw new ReceiptFileError(`部署收據檔是空的，無法判斷是否為既有狀態：${filePath}`);
  let parsed;
  try { parsed = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new ReceiptFileError(`部署收據檔不是有效的 JSON：${filePath}`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ReceiptFileError(`部署收據檔內容無效：${filePath}`);
  const version = Object.hasOwn(parsed, 'receiptFormatVersion') ? parsed.receiptFormatVersion : 1;
  if (version !== 1 && version !== SupportedFormatVersion)
    throw new ReceiptFileError(`部署收據檔格式版本 ${version} 不支援：${filePath}`, Number.isInteger(version) && version > SupportedFormatVersion);
  const receipts = parsed.receipts == null ? [] : parsed.receipts;
  if (!Array.isArray(receipts)) throw new ReceiptFileError(`部署收據檔內容無效：${filePath}`);
  return { receiptFormatVersion: version, receipts: receipts.map(normalizeReceipt) };
}

function stringArray(values, indent, nl) {
  if (values.length === 0) return '[]';
  return '[' + nl + values.map(v => indent + '  ' + jsonString(v)).join(',' + nl) + nl + indent + ']';
}

export function serializeReceiptFile(file, newline = os.EOL) {
  const nl = newline;
  const items = file.receipts.map((r) => {
    if (r[originalProjectEntry]) return JSON.stringify(r[originalProjectEntry], null, 2).split('\n').map(line => '    ' + line).join(nl);
    const i = '      ';
    const lines = STRING_FIELDS.map(k => `${i}${jsonString(k)}: ${jsonString(r[k] ?? '')}`);
    lines.push(`${i}"ownedConfigFields": ${stringArray(r.ownedConfigFields ?? [], i, nl)}`);
    lines.push(`${i}"baseValueHashes": ${stringArray(r.baseValueHashes ?? [], i, nl)}`);
    // DateTimeOffset 由 .NET 以原始 ISO 文字寫出（不經字串跳脫）。
    lines.push(`${i}"installedAt": "${r.installedAt ?? DEFAULT_INSTALLED_AT}"`);
    lines.push(`${i}"clientVersion": ${jsonString(r.clientVersion ?? '')}`);
    lines.push(`${i}"hostProfileVersion": ${jsonString(r.hostProfileVersion ?? '')}`);
    if (typeof r.source === 'string') lines.push(`${i}"source": ${jsonString(r.source)}`);
    if (typeof r.sourcePath === 'string') lines.push(`${i}"sourcePath": ${jsonString(r.sourcePath)}`);
    lines.push(`${i}"targetKey": ${jsonString(targetKeyOf(r))}`);
    return `    {${nl}${lines.join(',' + nl)}${nl}    }`;
  });
  const receipts = items.length ? `[${nl}${items.join(',' + nl)}${nl}  ]` : '[]';
  return `{${nl}  "receiptFormatVersion": ${file.receiptFormatVersion ?? SupportedFormatVersion},${nl}  "receipts": ${receipts}${nl}}`;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 原子寫入狀態檔（對照 FileSystemStateFileStore.WriteTextAtomic）。 */
export function writeTextAtomic(filePath, content, { attempts = 5 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid.toString(16)}-${randomUUID().replaceAll('-', '')}.part`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    for (let attempt = 1; ; attempt++) {
      try { fs.renameSync(temporary, filePath); return; } catch (e) {
        if (attempt >= attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        sleep(attempt * 20);
      }
    }
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* 狀態檔已寫成功 */ }
  }
}

/** 建立穩定 ownership address：platform、surface、scope、canonical root、contentId（設定欄位另附設定檔路徑）。 */
export function ownershipAddress(rules, host, scope, canonicalRoot, contentId, configPath = null) {
  const address = `${host.hostId}|${host.surfaceId}|${scope}|${rules.normalize(canonicalRoot)}|${contentId}`;
  return configPath == null ? address : `${address}|${rules.normalize(configPath)}`;
}

function createStore(filePath, canonicalRoot, scope, rules, newline) {
  const store = {
    filePath: rules.path.resolve(filePath), canonicalRoot: rules.normalize(canonicalRoot), scope,
    load() {
      let text;
      try { text = fs.readFileSync(store.filePath, 'utf8'); } catch (e) {
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(e.code)) return { receiptFormatVersion: SupportedFormatVersion, receipts: [] };
        throw e;
      }
      return parseReceiptFile(text, store.filePath);
    },
    save(file) {
      store.load();
      writeTextAtomic(store.filePath, serializeReceiptFile({ receiptFormatVersion: SupportedFormatVersion, receipts: file.receipts }, newline));
    },
    forTarget(host, targetScope, root) {
      const key = `${host.hostId}|${host.surfaceId}|${targetScope}|${rules.normalize(root)}`;
      return store.load().receipts.filter(r => targetKeyOf(r) === key);
    },
    upsert(receipts) {
      if (receipts.length === 0) return;
      const file = store.load();
      for (const r of receipts) {
        file.receipts = file.receipts.filter(e => (scope === 'global' && e.scope === 'project') || e.normalizedAddress !== r.normalizedAddress);
        file.receipts.push(r);
      }
      sort(file);
      store.save(file);
    },
    removeAddresses(addresses) {
      const set = new Set(addresses);
      if (set.size === 0) return;
      const file = store.load();
      file.receipts = file.receipts.filter(r => (scope === 'global' && r.scope === 'project') || !set.has(r.normalizedAddress));
      sort(file);
      store.save(file);
    }
  };
  return store;
}

function sort(file) {
  file.receipts.sort((a, b) => ordinal(a.normalizedAddress, b.normalizedAddress));
}

export const ReceiptStore = Object.freeze({
  /** 使用者全域：{LC-AI-Pack 資料目錄}/receipts.json，正規化根目錄為使用者家目錄。 */
  forGlobal({ home, userProfile = os.homedir(), rules = createPathRules(), newline = os.EOL }) {
    return createStore(rules.path.join(home, FileName), userProfile, 'global', rules, newline);
  },
  /** 專案：{專案}/.lcaipack/receipts.json。 */
  forProject({ projectRoot, rules = createPathRules(), newline = os.EOL }) {
    if (!projectRoot) throw new Error('Project scope 必須提供 project root');
    return createStore(rules.path.join(projectRoot, ProjectDirectoryName, FileName), projectRoot, 'project', rules, newline);
  }
});
