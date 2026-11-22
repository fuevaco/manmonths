// 每個 OperationId 一個 UTF-8（無 BOM）log 檔，永遠追加不覆寫（對照 LcAiPack.Core Setup/SetupOperationLog.cs）。
// 重試沿用同一個檔案，只追加一段 session header。遮罩是串流的：子行程的 stdout／stderr 是任意切分的 chunk，秘密很可能被切成兩半，
// 因此把 chunk 併進 pending buffer、對整個 buffer 遮罩、只輸出「最後一個換行之前，且距離結尾至少留下（最長秘密長度 − 1）個字元」的部分。
import fs from 'node:fs';
import path from 'node:path';

const MAX_PENDING_CHARACTERS = 64 * 1024;

/** .NET DateTimeOffset.ToString("O")：七位小數與 +00:00。 */
const formatRoundTrip = date => `${date.toISOString().slice(0, 19)}.${String(date.getUTCMilliseconds()).padStart(3, '0')}0000+00:00`;
const minutes = ms => String(Math.round(ms / 60000 * 100) / 100);

export function openOperationLog({ logPath, masker, sessionNumber, reason, now = () => new Date() }) {
  if (typeof logPath !== 'string' || !logPath.trim()) throw new TypeError('logPath 為必填');
  const filePath = path.resolve(logPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'a');
  let closed = false;
  const stamp = () => formatRoundTrip(now());
  // 一行是一次不可分割的同步寫入：stdout 與 stderr 的 data 事件交錯時行邊界也不會壞。
  const writeRaw = line => { if (closed) throw new Error('operation log 已關閉'); fs.writeSync(fd, `${line}\n`); };
  const writeLine = (channel, text) => writeRaw(`[${stamp()}] [${channel}] ${masker.mask(text)}`);

  function maskedStream(channel) {
    let pending = '';
    const emit = text => { for (const line of text.split('\n')) if (line.length) writeRaw(`[${stamp()}] [${channel}] ${line.replace(/\r+$/, '')}`); };
    return {
      append(chunk) {
        if (!chunk) return;
        // 先對整個 buffer 遮罩：已遮罩的文字不含完整秘密，再遮一次也是冪等的。
        pending = masker.mask(pending + chunk);
        // 尾端保留（最長秘密長度 − 1）個字元，任何被切半的秘密都還沒被輸出。
        const keep = Math.max(masker.longestSecretLength - 1, 0);
        const emitLimit = pending.length - keep;
        if (emitLimit <= 0) return;
        let cut = pending.lastIndexOf('\n', emitLimit - 1);
        if (cut < 0) {
          // 沒有換行的超長輸出仍必須前進，否則記憶體無上限成長。
          if (pending.length <= MAX_PENDING_CHARACTERS) return;
          cut = emitLimit - 1;
        }
        emit(pending.slice(0, cut + 1));
        pending = pending.slice(cut + 1);
      },
      flush() { if (!pending.length) return; emit(masker.mask(pending)); pending = ''; }
    };
  }
  const stdout = maskedStream('stdout'), stderr = maskedStream('stderr');
  const flushStreams = () => { stdout.flush(); stderr.flush(); };

  writeRaw(`=== session ${sessionNumber} | ${stamp()} | ${masker.mask(reason)} ===`);
  return {
    filePath,
    writeNote: text => writeLine('note', text),
    /** argv 逐項遮罩後記錄；秘密本來就不允許出現在 argv，這裡再遮一次是縱深防禦。 */
    writeCommandStart(commandId, runner, scriptPath, args) {
      writeLine('command-start', `${commandId} runner=${runner} script=${scriptPath} argv=[${args.map(a => masker.mask(a)).join(' ')}]`);
    },
    writeStdout: chunk => stdout.append(chunk),
    writeStderr: chunk => stderr.append(chunk),
    writeCommandEnd(commandId, exitCode, durationMs) { flushStreams(); writeLine('command-end', `${commandId} exitCode=${exitCode} durationMs=${Math.trunc(durationMs)}`); },
    writeCancelled(commandId, durationMs) { flushStreams(); writeLine('cancelled', `${commandId} durationMs=${Math.trunc(durationMs)}`); },
    writeTimedOut(commandId, timeoutMs) { flushStreams(); writeLine('timed-out', `${commandId} timeoutMinutes=${minutes(timeoutMs)}`); },
    writeTargetResult(targetKey, result, detail) { writeLine('target', `${targetKey} result=${result}${detail ? ` detail=${masker.mask(detail)}` : ''}`); },
    flushStreams,
    /** 沖出殘餘內容並關閉檔案；log 檔本身永遠保留。 */
    close() { if (closed) return; flushStreams(); closed = true; fs.closeSync(fd); }
  };
}
