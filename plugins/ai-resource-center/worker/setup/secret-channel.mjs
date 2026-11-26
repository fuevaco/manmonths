// 設定命令的秘密交付（對照 Setup/SetupSecretChannel.cs，ticket 02.4）。
// 秘密只透過「子行程的 redirected standard input」交付：一次性、單向、即關即棄。不進 argv、環境變數、暫存檔、Plan、
// 收據、輸出 JSON、Host 設定或 operation log。
// Wire 格式（一律 LF）：
//   LCAIPACK-SECRET-BEGIN 1
//   <parameterId> <base64(utf8(value))>
//   LCAIPACK-SECRET-END
// 值以 base64 編碼，含換行、空白或結束標記都不可能破壞框架；即使沒有任何秘密也會輸出 begin／end，讓腳本永遠面對同一個確定性協定。
import { setupSecretReference, knownUsage, includesUsage, SetupSecretStoreError } from './secrets.mjs';

export const BeginMarker = 'LCAIPACK-SECRET-BEGIN 1';
export const EndMarker = 'LCAIPACK-SECRET-END';
const LineEnding = '\n';

/**
 * 依 usage 過濾宣告後開啟通道；值在此刻自安全儲存區讀出，只留在本物件的位元組緩衝內。
 * 必填秘密不存在時以 SetupSecretStoreError 中止，不會以空值或明文來源代替。
 */
export function openSecretChannel({ manager, packageKey, scope, canonicalRoot, declarations, usage, rules }) {
  if (!knownUsage(usage)) throw new RangeError(`未知的 secretUsage：${usage}`);
  const entries = [];
  for (const declaration of declarations ?? []) {
    if (!includesUsage(declaration.usage, usage)) continue;
    const reference = setupSecretReference({ packageKey, parameterId: declaration.parameterId, scope, canonicalRoot }, rules);
    const value = manager.read(reference);
    if (typeof value !== 'string' || !value) {
      if (declaration.required !== false) throw new SetupSecretStoreError(`必填秘密參數 ${declaration.parameterId} 尚未儲存於作業系統安全儲存區；安裝必須中止。`);
      continue;
    }
    entries.push({ parameterId: declaration.parameterId, value: Buffer.from(value, 'utf8') });
  }
  let written = false, disposed = false;
  return {
    /** 本通道會交付的參數身分（不含值）；可安全顯示與記錄。 */
    get parameterIds() { return entries.map(e => e.parameterId); },
    get isEmpty() { return entries.length === 0; },
    /** 把值交給 masker 註冊，讓 log 在任何輸出寫入前就已具備遮罩能力；必須在啟動子行程之前呼叫。 */
    registerRedaction(register) {
      if (disposed) throw new Error('secret channel 已釋放');
      for (const e of entries) register(e.value.toString('utf8'));
    },
    /** 寫出秘密框架；一個通道只能寫一次，重試時重新開啟。 */
    writeTo(destination) {
      if (disposed) throw new Error('secret channel 已釋放');
      if (written) throw new Error('secret channel 只能寫出一次；重試請重新 Open。');
      written = true;
      destination.write(BeginMarker + LineEnding + entries.map(e => `${e.parameterId} ${e.value.toString('base64')}${LineEnding}`).join('') + EndMarker + LineEnding);
    },
    /** 清除本通道持有的位元組緩衝。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const e of entries) e.value.fill(0);
      entries.length = 0;
    }
  };
}
