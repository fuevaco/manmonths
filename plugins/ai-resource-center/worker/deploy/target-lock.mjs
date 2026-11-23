// 部署目標鎖定（對照 Deployment/TargetLock.cs）：{資料目錄}/locks/{sha256(targetKey) 前 32 碼}.lock。
//
// 與 其他用戶端使用同一個鎖定檔位置。Node 無法以 .NET FileShare.None 的方式獨占開檔，因此：
// - 在 Windows，其他用戶端持有鎖時開檔會失敗（EBUSY），這裡會等待至逾時後回報無法取得鎖定；
// - 同一個 Orca worker 內以記憶體集合避免重入；
// - Orca 持有時其他用戶端無法察覺（跨用戶端共用寫入鎖依規格延後處理，ADR 0001）。
import fs from 'node:fs';
import path from 'node:path';
import { ofText } from './digest.mjs';

const held = new Set();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function lockFilePath(lockDirectory, targetKey) {
  return path.join(lockDirectory, `${ofText(targetKey).slice(0, 32)}.lock`);
}

/** 嘗試取得鎖定；逾時回傳 null，呼叫端產生 deployment.lock-unavailable。 */
export function tryAcquireTargetLock(lockDirectory, targetKey, timeoutMs = 15000) {
  fs.mkdirSync(lockDirectory, { recursive: true });
  const filePath = lockFilePath(lockDirectory, targetKey);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!held.has(filePath)) {
      try {
        const fd = fs.openSync(filePath, 'a+');
        held.add(filePath);
        return { filePath, release() { try { fs.closeSync(fd); } finally { held.delete(filePath); } } };
      } catch (e) {
        if (e.code === 'EACCES' || e.code === 'EPERM') return null;
        if (!['EBUSY', 'ETXTBSY'].includes(e.code)) throw e;
      }
    }
    if (Date.now() >= deadline) return null;
    sleep(50);
  }
}
