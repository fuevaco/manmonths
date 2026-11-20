// 同步的規劃與執行。所有外部依賴（API 用戶端、目標資料夾、已安裝紀錄）都由呼叫端注入，
// 因此可以用本機模擬伺服器 + 暫存資料夾完整測試，不需要 Orca。

import path from 'node:path';
import os from 'node:os';
import { inspectSkill, installSkill, removeSkill, ensureGitExclude } from './installer.mjs';
import { compareVersions, listRunnableFiles } from './spec.mjs';
import { GLOBAL_KEY } from './targets.mjs';

export const recordKey = (base, name) =>
  `${process.platform === 'win32' ? path.resolve(base).toLowerCase() : path.resolve(base)}|${name}`;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

// 每個「skill × 目標」一列：目前狀態與建議動作
export async function planSync({ entries, bases, store }) {
  const jobs = [];
  for (const entry of entries) for (const b of bases) jobs.push({ entry, b });
  const rows = await mapLimit(jobs, 8, async ({ entry, b }) => {
    const record = await store.get(recordKey(b.base, entry.name));
    let state;
    try {
      ({ state } = await inspectSkill({ base: b.base, name: entry.name, record, remoteDigest: entry.digest }));
    } catch (e) {
      return { name: entry.name, baseKey: b.key, label: b.label, state: 'error', action: 'none', error: e.message };
    }
    const installedVersion = record?.version || null;
    const action =
      state === 'absent' ? 'install'
      : state === 'update' ? 'update'
      : state === 'current' ? (record ? 'none' : 'adopt')
      : 'conflict';
    return {
      name: entry.name,
      baseKey: b.key,
      label: b.label,
      state,
      action,
      installedVersion,
      remoteVersion: entry.version,
      downgrade: Boolean(installedVersion && compareVersions(installedVersion, entry.version) > 0)
    };
  });
  return rows;
}

// 安裝前預覽：取得清單（已驗證格式與摘要），列出檔案數、大小與會被 Agent 執行的檔案
export async function describeSkills({ client, entries }) {
  return mapLimit(entries, 4, async (entry) => {
    try {
      const { manifest } = await client.getManifest(entry);
      return {
        name: entry.name,
        version: entry.version,
        fileCount: manifest.files.length,
        bytes: manifest.files.reduce((n, f) => n + f.size, 0),
        runnable: listRunnableFiles(manifest.files),
        files: manifest.files.map((f) => f.path)
      };
    } catch (e) {
      return { name: entry.name, version: entry.version, error: e.message };
    }
  });
}

/**
 * @param force  Set<string> of `${name}|${baseKey}`，使用者在面板明確同意「取代我改過的副本」的項目
 */
export async function runSync({
  client,
  entries,
  bases,
  store,
  linkDirs = [],
  gitExclude = true,
  force = new Set(),
  homeDir = os.homedir(),
  onProgress
}) {
  const results = [];
  for (const entry of entries) {
    const plan = await planSync({ entries: [entry], bases, store });
    const todo = plan.filter(
      (r) => ['install', 'update', 'adopt'].includes(r.action) || (r.action === 'conflict' && force.has(`${r.name}|${r.baseKey}`))
    );
    for (const r of plan) {
      if (!todo.includes(r)) {
        results.push({
          name: r.name, baseKey: r.baseKey, label: r.label,
          action: r.action === 'conflict' ? 'skipped' : r.action === 'none' ? 'unchanged' : 'error',
          reason: r.action === 'conflict' ? r.state : r.error
        });
      }
    }
    if (!todo.length) continue;

    let files;
    try {
      onProgress?.({ name: entry.name, phase: 'download' });
      const { manifest, manifestUrl } = await client.getManifest(entry);
      files = (await client.downloadSkill(manifest, manifestUrl)).files;
    } catch (e) {
      for (const r of todo) {
        results.push({ name: r.name, baseKey: r.baseKey, label: r.label, action: 'error', reason: e.message });
      }
      continue;
    }

    for (const r of todo) {
      const b = bases.find((x) => x.key === r.baseKey);
      try {
        onProgress?.({ name: entry.name, phase: 'install', label: b.label });
        const key = recordKey(b.base, entry.name);
        const res = await installSkill({
          base: b.base,
          name: entry.name,
          version: entry.version,
          digest: entry.digest,
          files,
          linkDirs,
          record: await store.get(key),
          force: force.has(`${r.name}|${r.baseKey}`),
          homeDir
        });
        if (res.record) await store.set(key, res.record);
        if (gitExclude && b.key !== GLOBAL_KEY && res.action !== 'skipped' && res.action !== 'unchanged') {
          await ensureGitExclude(b.base, entry.name, linkDirs);
        }
        results.push({
          name: r.name, baseKey: r.baseKey, label: r.label,
          action: res.action, reason: res.reason, backup: res.backup, links: res.links
        });
      } catch (e) {
        results.push({ name: r.name, baseKey: r.baseKey, label: r.label, action: 'error', reason: e.message });
      }
    }
  }
  return results;
}

export async function runRemove({ names, bases, store, force = new Set(), homeDir = os.homedir() }) {
  const results = [];
  for (const name of names) {
    for (const b of bases) {
      const key = recordKey(b.base, name);
      try {
        const record = await store.get(key);
        const res = await removeSkill({ base: b.base, name, record, force: force.has(`${name}|${b.key}`), homeDir });
        if (res.action === 'removed') await store.delete(key);
        results.push({ name, baseKey: b.key, label: b.label, action: res.action, reason: res.reason, backup: res.backup });
      } catch (e) {
        results.push({ name, baseKey: b.key, label: b.label, action: 'error', reason: e.message });
      }
    }
  }
  return results;
}
