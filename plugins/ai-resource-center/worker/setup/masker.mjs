// Core 層集中的秘密遮罩（對照 LcAiPack.Core Setup/SetupSecretMasker.cs）。
// 兩層防護：已知值（含其 base64 形式，因為秘密以 base64 交付給腳本、腳本可能原樣回吐）逐字取代；
// 常見鍵值樣式（token=、pat:、password=…）涵蓋平台不知道的第三方秘密。刻意不設最短長度門檻：吵雜遠優於外洩。
export const Placeholder = '<redacted>';

const KEY_VALUE = /(pat|token|password|secret|api[-_]?key)([=:]\s*)[^\s&"']+/gi;
const QUERY = /([?&](?:token|pat|password|secret|key)=)[^&\s]+/gi;

export function createSecretMasker() {
  const values = [];
  const masker = {
    /** 目前已註冊的最長秘密長度；串流遮罩用它決定要保留多少尾端 buffer。 */
    longestSecretLength: 0,
    /** 註冊一個已知秘密值；必須在任何 log 寫入之前呼叫。 */
    register(secret) {
      if (typeof secret !== 'string' || !secret) return;
      for (const value of [secret, Buffer.from(secret, 'utf8').toString('base64')]) {
        if (values.includes(value)) continue;
        values.push(value);
        // 長的先取代，避免短秘密剛好是長秘密的子字串時留下殘片。
        values.sort((a, b) => b.length - a.length);
        masker.longestSecretLength = Math.max(masker.longestSecretLength, value.length);
      }
    },
    mask(text) {
      if (typeof text !== 'string' || !text) return '';
      let masked = text;
      for (const value of values) masked = masked.split(value).join(Placeholder);
      masked = masked.replace(KEY_VALUE, `$1$2${Placeholder}`);
      return masked.replace(QUERY, `$1${Placeholder}`);
    }
  };
  return masker;
}
