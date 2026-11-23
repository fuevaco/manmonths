// 三平台共用的原生資料夾選擇器；不用 shell，路徑不做 trim。
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { badParams, RcError } from './contract.mjs';

export const FolderPickerTimeoutMs = 115000;

export function createFolderPickerService({ platform = process.platform, spawn = nodeSpawn, timeoutMs = FolderPickerTimeoutMs } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  function run(file, args, signal) {
    return new Promise((resolve, reject) => {
      let child, timer, output = '', done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => { child?.kill(); finish(null, { cancelled: true }); };
      if (signal?.aborted) return abort();
      try { child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch (error) { finish(error); return; }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 65536) { child.kill(); finish(new RcError('folder_picker_failed', '資料夾選擇器回傳的路徑過長')); }
      });
      child.once('error', error => finish(error));
      child.once('close', code => finish(null, { code, output }));
      timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async function pickFolder(input = {}, { signal } = {}) {
    if (input.initialPath !== undefined && typeof input.initialPath !== 'string') throw badParams('initialPath 必須是文字');
    const initial = input.initialPath || '';
    let commands;
    if (platform === 'win32') {
      const encodedPath = Buffer.from(initial, 'utf8').toString('base64');
      const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.SelectedPath = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
try { if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) } else { exit 1 } } finally { $d.Dispose() }`;
      commands = [['powershell', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]]];
    } else if (platform === 'darwin') {
      const script = `on run argv
if (count of argv) > 0 and item 1 of argv is not "" then
return POSIX path of (choose folder default location (POSIX file (item 1 of argv)))
else
return POSIX path of (choose folder)
end if
end run`;
      commands = [['osascript', ['-e', script, initial]]];
    } else if (platform === 'linux') {
      commands = [['zenity', ['--file-selection', '--directory', ...(initial ? [`--filename=${initial.endsWith('/') ? initial : initial + '/'}`] : [])]],
        ['kdialog', ['--getexistingdirectory', ...(initial ? [initial] : [])]]];
    } else return { unavailable: true };
    for (const [file, args] of commands) {
      let result;
      try { result = await run(file, args, signal); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw new RcError('folder_picker_failed', '無法開啟資料夾選擇器');
      }
      if (result.cancelled || result.code === 1 || result.code === 130 || (platform === 'darwin' && result.code !== 0)) return { cancelled: true };
      if (result.code !== 0) throw new RcError('folder_picker_failed', '資料夾選擇器執行失敗');
      const selected = platform === 'win32' ? result.output : result.output.replace(/\r?\n$/, '');
      return selected ? { path: selected } : { cancelled: true };
    }
    return { unavailable: true };
  }
  async function checkFolder(input = {}) {
    if (typeof input.path !== 'string' || !input.path || input.path.includes('\0')) throw badParams('請提供資料夾路徑');
    const absolutePath = paths.resolve(input.path);
    try {
      const stat = await fs.stat(absolutePath);
      return { exists: true, isDirectory: stat.isDirectory(), absolutePath };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { exists: false, isDirectory: false, absolutePath };
      throw new RcError('folder_check_failed', '無法檢查資料夾路徑');
    }
  }
  return { pickFolder, checkFolder };
}
