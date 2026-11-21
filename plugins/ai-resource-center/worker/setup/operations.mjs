// 安裝操作狀態的持久層（對照 LcAiPack.Core Setup/SetupOperations.cs，operationFormatVersion 1）：
// {home}/operations/{operationId}.json，log 是同目錄的 {operationId}.log。
// operation state 一律放在使用者 home，即使是 Project 範圍也一樣——Project 移除不可能影響 Global，也不會連帶刪掉歷史 log。
// create 在回傳前就已落檔，呼叫端可以安全地遵守「任何外部副作用前先持久化 operation」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPathRules } from '../deploy/canonical-root.mjs';
import { jsonString, formatInstalledAt, writeTextAtomic } from '../deploy/receipts.mjs';
import { ordinal } from '../deploy/digest.mjs';
import { SetupFileError, writeJsonValue } from './values.mjs';
import { createSecretMasker } from './masker.mjs';

export const SupportedFormatVersion = 1;
export const DirectoryName = 'operations';
export const OperationIdPattern = /^op-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
export const OperationState = Object.freeze({ planned: 'planned', running: 'running', incomplete: 'incomplete', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', timedOut: 'timed-out' });
const STATES = new Set(Object.values(OperationState));
const KINDS = new Set(['install', 'update', 'reconfigure', 'remove']);
const MAX_SUMMARY = 2000;
// Unicode 換行序列（對照 ReplaceLineEndings）：CRLF、LF、CR、VT、FF、NEL、LS、PS。
const LINE_BREAKS = new RegExp("\r\n|[\n\r\v\f\u0085\u2028\u2029]", "g");
const DEFAULT_TIME = '0001-01-01T00:00:00+00:00';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const FIELDS = ['operationFormatVersion', 'operationId', 'kind', 'packageKey', 'packageVersion', 'scope', 'projectRoot', 'state', 'checkpoint', 'targets', 'logPath', 'sessionCount',
  'failureSummary', 'localSourcePath', 'createdAt', 'updatedAt'];

function safeSummary(summary, masker) {
  const masked = (masker ?? createSecretMasker()).mask(summary).replace(LINE_BREAKS, " ").trim();
  return masked.length <= MAX_SUMMARY ? masked : `${masked.slice(0, MAX_SUMMARY)}…`;
}

function serialize(record, nl) {
  const lines = [
    `  "operationFormatVersion": ${SupportedFormatVersion}`, `  "operationId": ${jsonString(record.operationId)}`, `  "kind": ${jsonString(record.kind)}`,
    `  "packageKey": ${jsonString(record.packageKey)}`, `  "packageVersion": ${jsonString(record.packageVersion)}`, `  "scope": ${jsonString(record.scope)}`,
    `  "projectRoot": ${jsonString(record.projectRoot)}`, `  "state": ${jsonString(record.state)}`, `  "checkpoint": ${jsonString(record.checkpoint)}`,
    `  "targets": ${writeJsonValue(record.targets.map(t => ({ targetKey: t.targetKey, result: t.result, detail: t.detail ?? null })), '  ', nl)}`,
    `  "logPath": ${jsonString(record.logPath)}`, `  "sessionCount": ${record.sessionCount}`,
    `  "failureSummary": ${record.failureSummary == null ? 'null' : jsonString(record.failureSummary)}`,
    `  "localSourcePath": ${record.localSourcePath == null ? 'null' : jsonString(record.localSourcePath)}`,
    // DateTimeOffset 由 .NET 以原始 ISO 文字寫出（不經字串跳脫）。
    `  "createdAt": "${record.createdAt}"`, `  "updatedAt": "${record.updatedAt}"`,
    ...Object.entries(record.extra ?? {}).map(([k, v]) => `  ${jsonString(k)}: ${writeJsonValue(v, '  ', nl)}`)
  ];
  return `{${nl}${lines.join(',' + nl)}${nl}}`;
}

/**
 * @param {object} options
 * @param {string} options.home  LC-AI-Pack 家目錄
 * @param {() => Date} [options.now]  時間來源（測試用）
 */
export function createOperationStore({ home, now = () => new Date(), rules = createPathRules() }) {
  const directoryPath = path.resolve(home, DirectoryName);
  const ensureValidId = operationId => {
    if (typeof operationId !== 'string' || !OperationIdPattern.test(operationId)) throw new Error(`不是合法的 OperationId：${operationId}`);
    return operationId;
  };
  const getStatePath = id => path.join(directoryPath, `${ensureValidId(id)}.json`);
  const getLogPath = id => path.join(directoryPath, `${ensureValidId(id)}.log`);
  const stamp = () => formatInstalledAt(now());

  function parse(text, filePath) {
    const body = String(text ?? '').replace(/^﻿/, '');
    if (!body.trim()) throw new SetupFileError(`setup 狀態檔是空的，無法判斷是否為既有狀態：${filePath}`);
    let parsed;
    try { parsed = JSON.parse(body); } catch { throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`); }
    if (!isObject(parsed)) throw new SetupFileError(`setup 狀態檔反序列化為 null：${filePath}`);
    const record = { operationFormatVersion: SupportedFormatVersion, operationId: '', kind: '', packageKey: '', packageVersion: '', scope: '', projectRoot: '', state: '', checkpoint: '',
      targets: [], logPath: '', sessionCount: 0, failureSummary: null, localSourcePath: null, createdAt: DEFAULT_TIME, updatedAt: DEFAULT_TIME, extra: {} };
    for (const [key, value] of Object.entries(parsed)) {
      const name = FIELDS.find(f => f.toLowerCase() === key.toLowerCase());
      if (!name) { record.extra[key] = value; continue; }
      if (value === null) { if (name === 'failureSummary' || name === 'localSourcePath') record[name] = null; continue; }
      if (name === 'targets') {
        if (!Array.isArray(value) || value.some(t => !isObject(t))) throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`);
        record.targets = value.map(t => ({ targetKey: String(t.targetKey ?? ''), result: String(t.result ?? ''), detail: t.detail ?? null }));
      } else if (name === 'operationFormatVersion' || name === 'sessionCount') {
        if (!Number.isInteger(value)) throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`);
        record[name] = value;
      } else if (typeof value !== 'string') throw new SetupFileError(`setup 狀態檔不是有效的 JSON：${filePath}`);
      else record[name] = value;
    }
    if (record.operationFormatVersion !== SupportedFormatVersion) throw new SetupFileError(`operation 檔格式版本 ${record.operationFormatVersion} 不支援（僅支援 ${SupportedFormatVersion}）：${filePath}`);
    return record;
  }

  const store = {
    directoryPath, ensureValidId, getStatePath, getLogPath,
    isTerminal: record => [OperationState.succeeded, OperationState.failed, OperationState.cancelled, OperationState.timedOut].includes(record.state),
    /** 建立並立即落檔一筆 operation（狀態 planned）；呼叫端必須在任何外部副作用之前呼叫。 */
    create({ kind, packageKey, packageVersion, scope, projectRoot = null, checkpoint = 'created', localSourcePath = null }) {
      if (!KINDS.has(kind)) throw new RangeError(`未知的 operation 種類：${kind}`);
      if (typeof packageKey !== 'string' || !packageKey.trim()) throw new TypeError('packageKey 為必填');
      if (scope === 'project' && !(typeof projectRoot === 'string' && projectRoot.trim())) throw new TypeError('Project scope 必須提供 project root');
      const operationId = `op-${now().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${randomBytes(4).toString('hex')}`;
      const record = { operationFormatVersion: SupportedFormatVersion, operationId, kind, packageKey, packageVersion, scope, projectRoot: projectRoot == null ? '' : rules.normalize(projectRoot),
        state: OperationState.planned, checkpoint, targets: [], logPath: getLogPath(operationId), sessionCount: 0, failureSummary: null, localSourcePath, createdAt: stamp(), updatedAt: stamp(), extra: {} };
      store.save(record);
      return record;
    },
    /** 讀取單一 operation；不存在回傳 null，內容壞掉則明確失敗。 */
    get(operationId) {
      const filePath = getStatePath(operationId);
      let text;
      try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw new SetupFileError(`無法讀取 setup 狀態檔：${filePath}`);
      }
      return parse(text, filePath);
    },
    /** 列出所有 operation，最新在前。 */
    list() {
      let names;
      try { names = fs.readdirSync(directoryPath); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const records = [];
      for (const name of names) {
        const match = /^(op-.*)\.json$/.exec(name);
        if (!match || !OperationIdPattern.test(match[1])) continue;
        const record = store.get(match[1]);
        if (record) records.push(record);
      }
      return records.sort((a, b) => ordinal(b.operationId, a.operationId));
    },
    save(record) {
      record.operationFormatVersion = SupportedFormatVersion;
      record.updatedAt = stamp();
      writeTextAtomic(getStatePath(record.operationId), serialize(record, os.EOL));
    },
    /** 狀態轉移。succeeded 是不可離開的終局；其餘終局狀態可因重試回到 running，沿用同一 OperationId 與同一 log。 */
    transition(operationId, state, checkpoint = null, failureSummary = null, masker = null) {
      if (!STATES.has(state)) throw new RangeError(`未知的 operation 狀態：${state}`);
      const record = store.get(operationId);
      if (!record) throw new Error(`找不到 operation：${operationId}`);
      if (record.state === OperationState.succeeded && state !== OperationState.succeeded) throw new Error(`operation ${operationId} 已成功結案，不能再轉移到 ${state}`);
      record.state = state;
      if (checkpoint !== null && checkpoint !== undefined) record.checkpoint = checkpoint;
      if (failureSummary !== null && failureSummary !== undefined) record.failureSummary = safeSummary(failureSummary, masker);
      store.save(record);
      return record;
    },
    /** 開始一個新的執行 session（首次執行或重試），回傳 session 序號。 */
    beginSession(operationId) {
      const record = store.get(operationId);
      if (!record) throw new Error(`找不到 operation：${operationId}`);
      record.sessionCount += 1;
      record.state = OperationState.running;
      store.save(record);
      return record.sessionCount;
    },
    /** 寫入或更新單一 target 的結果摘要。 */
    recordTarget(operationId, { targetKey, result, detail = null }) {
      const record = store.get(operationId);
      if (!record) throw new Error(`找不到 operation：${operationId}`);
      record.targets = [...record.targets.filter(t => t.targetKey !== targetKey), { targetKey, result, detail }].sort((a, b) => ordinal(a.targetKey, b.targetKey));
      store.save(record);
      return record;
    }
  };
  return store;
}
