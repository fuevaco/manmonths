// 設定命令完成狀態（對照 LcAiPack.Core Setup/SetupCommandCompletionStore.cs，setupFormatVersion 1）。
// 全域：{home}/setup-commands.json；專案：{projectRoot}/.lcaipack/setup-commands.json。
// identity 是資源包 × 範圍 × commandId，不含版本；紀錄只有版本、腳本雜湊與成功與否，絕不儲存參數或秘密。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPathRules } from '../deploy/canonical-root.mjs';
import { jsonString, formatInstalledAt, writeTextAtomic, ProjectDirectoryName } from '../deploy/receipts.mjs';
import { ordinal } from '../deploy/digest.mjs';
import { SetupFileError, writeJsonValue } from './values.mjs';

export const SupportedFormatVersion = 1;
export const FileName = 'setup-commands.json';

/** 觸發設定命令判斷的意圖（對照 SetupCommandIntent；值即 .NET 列舉名稱，會進入計畫摘要）。 */
export const SetupIntent = Object.freeze({ install: 'Install', reinstall: 'Reinstall', update: 'Update', reconfigure: 'Reconfigure', repair: 'Repair' });

/** 執行或略過的理由（對照 SetupCommandRunReason）。 */
export const RunReason = Object.freeze({
  firstRun: 'FirstRun', previousFailure: 'PreviousFailure', scriptChanged: 'ScriptChanged', reconfigure: 'Reconfigure',
  updateRunOnUpdate: 'UpdateRunOnUpdate', skippedAlreadySucceeded: 'SkippedAlreadySucceeded', skippedUpdateWithoutRunOnUpdate: 'SkippedUpdateWithoutRunOnUpdate'
});

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const KNOWN = ['packageKey', 'scope', 'commandId', 'packageVersion', 'scriptSha256', 'succeeded', 'completedAt', 'operationId'];
const DEFAULT_COMPLETED_AT = '0001-01-01T00:00:00+00:00';

function parseCompletion(raw, filePath) {
  if (!isObject(raw)) throw new SetupFileError(`setup 狀態檔內容無效：${filePath}`);
  const entry = { packageKey: '', scope: '', commandId: '', packageVersion: '', scriptSha256: '', succeeded: false, completedAt: DEFAULT_COMPLETED_AT, operationId: '', extra: {} };
  for (const [key, value] of Object.entries(raw)) {
    const name = KNOWN.find(k => k.toLowerCase() === key.toLowerCase());
    if (!name) { entry.extra[key] = value; continue; }
    if (value === null) continue;
    if (name === 'succeeded' ? typeof value !== 'boolean' : typeof value !== 'string') throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`);
    entry[name] = value;
  }
  return entry;
}

function parseFile(text, filePath) {
  const body = String(text ?? '').replace(/^﻿/, '');
  if (!body.trim()) throw new SetupFileError(`setup 狀態檔是空的，無法判斷是否為既有狀態：${filePath}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`); }
  if (!isObject(parsed)) throw new SetupFileError(`setup 狀態檔反序列化為 null：${filePath}`);
  const file = { setupFormatVersion: SupportedFormatVersion, completions: [], extra: {} };
  for (const [key, value] of Object.entries(parsed)) {
    if (key.toLowerCase() === 'setupformatversion') file.setupFormatVersion = value;
    else if (key.toLowerCase() === 'completions') {
      if (value === null) continue;
      if (!Array.isArray(value)) throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`);
      file.completions = value.map(v => parseCompletion(v, filePath));
    } else file.extra[key] = value;
  }
  if (file.setupFormatVersion !== SupportedFormatVersion) {
    throw new SetupFileError(`setup command 完成狀態檔格式版本 ${file.setupFormatVersion} 不支援（僅支援 ${SupportedFormatVersion}）：${filePath}`);
  }
  return file;
}

function serialize(file, nl) {
  const items = file.completions.map(entry => {
    const i = '      ';
    const lines = [
      `${i}"packageKey": ${jsonString(entry.packageKey)}`, `${i}"scope": ${jsonString(entry.scope)}`, `${i}"commandId": ${jsonString(entry.commandId)}`,
      `${i}"packageVersion": ${jsonString(entry.packageVersion)}`, `${i}"scriptSha256": ${jsonString(entry.scriptSha256)}`, `${i}"succeeded": ${entry.succeeded ? 'true' : 'false'}`,
      // DateTimeOffset 由 .NET 以原始 ISO 文字寫出（不經字串跳脫）。
      `${i}"completedAt": "${entry.completedAt}"`, `${i}"operationId": ${jsonString(entry.operationId)}`,
      ...Object.entries(entry.extra ?? {}).map(([k, v]) => `${i}${jsonString(k)}: ${writeJsonValue(v, i, nl)}`)
    ];
    return `    {${nl}${lines.join(',' + nl)}${nl}    }`;
  });
  const completions = items.length ? `[${nl}${items.join(',' + nl)}${nl}  ]` : '[]';
  const extra = Object.entries(file.extra ?? {}).map(([k, v]) => `,${nl}  ${jsonString(k)}: ${writeJsonValue(v, '  ', nl)}`).join('');
  return `{${nl}  "setupFormatVersion": ${SupportedFormatVersion},${nl}  "completions": ${completions}${extra}${nl}}`;
}

function createStore(filePath, scope) {
  const store = {
    filePath, scope,
    load() {
      let text;
      try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return { setupFormatVersion: SupportedFormatVersion, completions: [], extra: {} };
        throw new SetupFileError(`無法讀取 setup 狀態檔：${filePath}`);
      }
      return parseFile(text, filePath);
    },
    get: (packageKey, commandId) => store.load().completions.find(c => c.packageKey === packageKey && c.commandId === commandId) ?? null,
    forPackage: packageKey => store.load().completions.filter(c => c.packageKey === packageKey).sort((a, b) => ordinal(a.commandId, b.commandId)),
    /** 記錄一次執行結果；同資源包與命令覆寫。 */
    record(packageKey, commandId, packageVersion, scriptSha256, succeeded, operationId, completedAt = new Date()) {
      if (typeof packageKey !== 'string' || !packageKey.trim()) throw new TypeError('packageKey 為必填');
      if (typeof commandId !== 'string' || !commandId.trim()) throw new TypeError('commandId 為必填');
      const file = store.load();
      file.completions = file.completions.filter(c => !(c.packageKey === packageKey && c.commandId === commandId));
      file.completions.push({ packageKey, scope, commandId, packageVersion, scriptSha256, succeeded: succeeded === true, completedAt: formatInstalledAt(completedAt), operationId, extra: {} });
      persist(file);
    },
    clearPackage(packageKey) {
      const file = store.load();
      const before = file.completions.length;
      file.completions = file.completions.filter(c => c.packageKey !== packageKey);
      if (file.completions.length !== before) persist(file);
    },
    /**
     * 回答「這個命令這次要不要跑」；規則順序固定且每個分支都有可揭露的理由：
     * 重新設定 → 沒有紀錄 → 上次未成功 → 腳本雜湊改變 → 版本改變或意圖是更新（只有 runOnUpdate 才跑）→ 其餘略過。
     */
    decide({ packageKey, commandId, packageVersion, scriptSha256, intent, runOnUpdate }) {
      if (intent === SetupIntent.reconfigure) return { commandId, shouldRun: true, reason: RunReason.reconfigure };
      const completion = store.get(packageKey, commandId);
      if (!completion) return { commandId, shouldRun: true, reason: RunReason.firstRun };
      if (!completion.succeeded) return { commandId, shouldRun: true, reason: RunReason.previousFailure };
      if (completion.scriptSha256.toLowerCase() !== String(scriptSha256).toLowerCase()) return { commandId, shouldRun: true, reason: RunReason.scriptChanged };
      if (completion.packageVersion !== packageVersion || intent === SetupIntent.update) {
        return runOnUpdate ? { commandId, shouldRun: true, reason: RunReason.updateRunOnUpdate } : { commandId, shouldRun: false, reason: RunReason.skippedUpdateWithoutRunOnUpdate };
      }
      return { commandId, shouldRun: false, reason: RunReason.skippedAlreadySucceeded };
    }
  };
  function persist(file) {
    file.completions.sort((a, b) => ordinal(a.packageKey, b.packageKey) || ordinal(a.commandId, b.commandId));
    writeTextAtomic(filePath, serialize(file, os.EOL));
  }
  return store;
}

export const SetupCommandCompletionStore = Object.freeze({
  forGlobal: ({ home }) => createStore(path.resolve(home, FileName), 'global'),
  forProject({ projectRoot }) {
    if (!projectRoot) throw new TypeError('Project scope 必須提供 project root');
    return createStore(path.resolve(projectRoot, ProjectDirectoryName, FileName), 'project');
  },
  forScope: ({ scope, projectRoot, home }) => scope === 'global' ? SetupCommandCompletionStore.forGlobal({ home }) : SetupCommandCompletionStore.forProject({ projectRoot })
});
