// 兩個 CLI 傳輸共用的部分：提示的組法、帳號解析、系統提示檔，以及錯誤對應成草圖文字。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AiTransportError } from './ai-transport-error.mjs';
import { LOCAL_TOOL_PLATFORMS } from './ai-local-tool-platforms.mjs';

const NO_TOOLS = '你沒有任何工具，不要呼叫工具，直接以文字回答。';
export const systemPrompt = system => NO_TOOLS + '\n' + system;

export function flattenHistory(messages) {
  const history = messages.slice(0, -1).map(({ role, content }) =>
    (role === 'user' ? '先前的提問：' : '先前的回答：') + content);
  const question = messages.at(-1).content;
  return history.length ? [...history, '本次提問：' + question].join('\n\n') : question;
}

/** 系統提示寫進暫存資料夾內的檔案，回傳檔案路徑。 */
export async function writeSystemPrompt(cwd, system) {
  const file = path.join(cwd, 'system-prompt.txt');
  await writeFile(file, systemPrompt(system), 'utf8');
  return file;
}

/** 向 Orca 解析目前的帳號。失敗時直接報錯，不呼叫 CLI，也不改用其他帳號。 */
export async function resolveChatAccount(localTools, platform, signal) {
  try { return await localTools.resolveAccount(platform, signal); }
  catch {
    signal.throwIfAborted();
    throw new AiTransportError(`無法向 Orca 查詢目前的 ${LOCAL_TOOL_PLATFORMS[platform].label} 帳號，請確認 Orca 運作正常後再試。`);
  }
}

export const missingCliError = platform =>
  new AiTransportError(`找不到 ${LOCAL_TOOL_PLATFORMS[platform].label}，請先安裝，或到 AI 設定改用其他端點。`);

/**
 * 把未登入、用量上限、版本過舊對應成草圖文字，無法辨識時回傳 null。
 * signedOut、limited 是平台自己的錯誤代碼判斷，diagnostic 是要比對的錯誤文字。
 */
export function cliError(platform, { diagnostic = '', signedOut = false, limited = false, account = '', version = '' }) {
  const { label, testedVersion, errors } = LOCAL_TOOL_PLATFORMS[platform];
  if (signedOut || errors.signedOut.test(diagnostic)) {
    return new AiTransportError(`${label}${account ? ' 的 ' + account : ''} 尚未登入，請在 Orca 登入後再試。`);
  }
  if (limited || errors.limited.test(diagnostic)) {
    return new AiTransportError(`${label} 已達用量上限，請稍後再試，或到 AI 設定改用其他端點。`);
  }
  if (errors.outdated.test(diagnostic)) {
    return new AiTransportError(`${label} 版本過舊${version ? '（' + version + '）' : ''}，請更新到 ${testedVersion} 以上。`);
  }
  return null;
}
