// 設定參數的非秘密值（對照 LcAiPack.Core Setup/SetupValueStore.cs、SetupJsonFile.cs，setupFormatVersion 1）。
// 全域：{home}/setup.json；專案覆寫：{projectRoot}/.lcaipack/setup.json。與 LC-AI-Pack 共用同一份檔案，
// 序列化沿用部署收據的 .NET 相容規則（JsonSerializerDefaults.Web + WriteIndented、預設 encoder、作業系統換行）。
// 秘密值永遠不進這裡：呼叫端提供秘密參數身分時，在任何 I/O 之前整批拒絕。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPathRules } from '../deploy/canonical-root.mjs';
import { jsonString, formatInstalledAt, writeTextAtomic, ProjectDirectoryName } from '../deploy/receipts.mjs';
import { ordinal } from '../deploy/digest.mjs';

export const SupportedFormatVersion = 1;
export const FileName = 'setup.json';
const DEFAULT_UPDATED_AT = '0001-01-01T00:00:00+00:00';

export class SetupFileError extends Error {
  constructor(message) { super(message); this.name = 'SetupFileError'; this.code = 'setup_file_invalid'; }
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Web 預設屬性名稱比對不分大小寫；回傳 [實際鍵, 值]。 */
const findKey = (obj, name) => Object.keys(obj).find(k => k.toLowerCase() === name.toLowerCase());

/** 依 System.Text.Json WriteIndented 的形狀輸出任意 JSON 值（用於保留未知欄位）。 */
export function writeJsonValue(value, indent, nl) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return jsonString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[${nl}${value.map(v => inner + writeJsonValue(v, inner, nl)).join(',' + nl)}${nl}${indent}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  return `{${nl}${entries.map(([k, v]) => `${inner}${jsonString(k)}: ${writeJsonValue(v, inner, nl)}`).join(',' + nl)}${nl}${indent}}`;
}

function parseEntry(raw, filePath) {
  if (!isObject(raw)) throw new SetupFileError(`setup 狀態檔內容無效：${filePath}`);
  const known = ['packageKey', 'scope', 'projectRoot', 'values', 'updatedAt'];
  const entry = { packageKey: '', scope: '', projectRoot: '', values: {}, updatedAt: DEFAULT_UPDATED_AT, extra: {} };
  for (const [key, value] of Object.entries(raw)) {
    const name = known.find(k => k.toLowerCase() === key.toLowerCase());
    if (!name) { entry.extra[key] = value; continue; }
    if (name === 'values') {
      if (value === null) continue;
      if (!isObject(value) || Object.values(value).some(v => v !== null && typeof v !== 'string')) throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`);
      entry.values = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string'));
    } else if (value !== null) {
      if (typeof value !== 'string') throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`);
      entry[name] = value;
    }
  }
  return entry;
}

/** 解析 setup.json；空白、損壞或不支援的格式版本一律明確失敗，絕不當成全新狀態。 */
export function parseSetupFile(text, filePath) {
  const body = String(text ?? '').replace(/^﻿/, '');
  if (!body.trim()) throw new SetupFileError(`setup 狀態檔是空的，無法判斷是否為既有狀態：${filePath}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`); }
  if (!isObject(parsed)) throw new SetupFileError(`setup 狀態檔反序列化為 null：${filePath}`);
  const file = { setupFormatVersion: SupportedFormatVersion, packages: [], extra: {} };
  for (const [key, value] of Object.entries(parsed)) {
    if (key.toLowerCase() === 'setupformatversion') file.setupFormatVersion = value;
    else if (key.toLowerCase() === 'packages') {
      if (value === null) continue;
      if (!Array.isArray(value)) throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`);
      file.packages = value.map(v => parseEntry(v, filePath));
    } else file.extra[key] = value;
  }
  if (file.setupFormatVersion !== SupportedFormatVersion) {
    throw new SetupFileError(`setup 檔格式版本 ${file.setupFormatVersion} 不支援（僅支援 ${SupportedFormatVersion}）：${filePath}`);
  }
  return file;
}

export function serializeSetupFile(file, nl = os.EOL) {
  const items = file.packages.map(entry => {
    const i = '      ';
    const lines = [
      `${i}"packageKey": ${jsonString(entry.packageKey)}`,
      `${i}"scope": ${jsonString(entry.scope)}`,
      `${i}"projectRoot": ${jsonString(entry.projectRoot)}`,
      `${i}"values": ${writeJsonValue(entry.values, i, nl)}`,
      // DateTimeOffset 由 .NET 以原始 ISO 文字寫出（不經字串跳脫）。
      `${i}"updatedAt": "${entry.updatedAt}"`,
      ...Object.entries(entry.extra ?? {}).map(([k, v]) => `${i}${jsonString(k)}: ${writeJsonValue(v, i, nl)}`)
    ];
    return `    {${nl}${lines.join(',' + nl)}${nl}    }`;
  });
  const packages = items.length ? `[${nl}${items.join(',' + nl)}${nl}  ]` : '[]';
  const extra = Object.entries(file.extra ?? {}).map(([k, v]) => `,${nl}  ${jsonString(k)}: ${writeJsonValue(v, '  ', nl)}`).join('');
  return `{${nl}  "setupFormatVersion": ${SupportedFormatVersion},${nl}  "packages": ${packages}${extra}${nl}}`;
}

function createStore(filePath, canonicalRoot, scope) {
  const store = {
    filePath, canonicalRoot, scope,
    load() {
      let text;
      try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return { setupFormatVersion: SupportedFormatVersion, packages: [], extra: {} };
        throw new SetupFileError(`無法讀取 setup 狀態檔：${filePath}`);
      }
      return parseSetupFile(text, filePath);
    },
    save(file, newline = os.EOL) { writeTextAtomic(filePath, serializeSetupFile(file, newline)); },
    getValues(packageKey) {
      const entry = store.load().packages.find(p => p.packageKey === packageKey);
      return entry ? { ...entry.values } : {};
    },
    /** 批次寫入非秘密值；null 代表移除（專案範圍即清除覆寫）。 */
    setValues(packageKey, values, secretParameterIds = []) {
      if (typeof packageKey !== 'string' || !packageKey.trim()) throw new TypeError('packageKey 為必填');
      const offending = Object.keys(values).filter(id => secretParameterIds.includes(id)).sort(ordinal);
      if (offending.length) throw new Error(`秘密參數不得儲存在 setup.json：${offending.join(', ')}。秘密只能寫入 OS 安全儲存區。`);
      const pairs = Object.entries(values);
      if (!pairs.length) return;
      const file = store.load();
      let entry = file.packages.find(p => p.packageKey === packageKey);
      if (!entry) {
        if (pairs.every(([, v]) => v == null)) return;
        entry = { packageKey, scope, projectRoot: canonicalRoot, values: {}, updatedAt: DEFAULT_UPDATED_AT, extra: {} };
        file.packages.push(entry);
      }
      for (const [id, value] of pairs) {
        if (typeof id !== 'string' || !id.trim()) throw new TypeError('parameterId 為必填');
        if (value == null) delete entry.values[id]; else entry.values[id] = String(value);
      }
      entry.scope = scope; entry.projectRoot = canonicalRoot; entry.updatedAt = formatInstalledAt(new Date());
      persist(file);
    },
    clearPackage(packageKey) {
      const file = store.load();
      const before = file.packages.length;
      file.packages = file.packages.filter(p => p.packageKey !== packageKey);
      if (file.packages.length !== before) persist(file);
    }
  };
  function persist(file) {
    file.packages = file.packages.filter(p => Object.keys(p.values).length > 0).sort((a, b) => ordinal(a.packageKey, b.packageKey));
    store.save(file);
  }
  return store;
}

export const SetupValueStore = Object.freeze({
  forGlobal({ home, userProfile = os.homedir(), rules = createPathRules() }) {
    return createStore(path.resolve(home, FileName), rules.normalize(userProfile), 'global');
  },
  forProject({ projectRoot, rules = createPathRules() }) {
    return createStore(path.resolve(projectRoot, ProjectDirectoryName, FileName), rules.normalize(projectRoot), 'project');
  },
  forScope({ scope, projectRoot, home, userProfile, rules }) {
    if (scope === 'global') return SetupValueStore.forGlobal({ home, userProfile, rules });
    if (!projectRoot) throw new TypeError('Project scope 必須提供 project root');
    return SetupValueStore.forProject({ projectRoot, rules });
  }
});

/** 疊合全域與專案覆寫：專案有值就贏，沒有的參數回落到全域（對照 SetupValueResolver）。 */
export function resolveSetupValues(globalStore, projectStore, packageKey) {
  const resolved = {};
  for (const [id, value] of Object.entries(globalStore.getValues(packageKey))) resolved[id] = { value, origin: 'Global' };
  if (projectStore) for (const [id, value] of Object.entries(projectStore.getValues(packageKey))) resolved[id] = { value, origin: 'ProjectOverride' };
  return resolved;
}
