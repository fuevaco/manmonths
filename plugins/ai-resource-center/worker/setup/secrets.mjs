// 秘密設定參數（對照 Setup/SetupSecrets.cs 與 Mcp/McpSecrets.cs）。
// - 識別：lcaipack:setup:{packageKey}:{parameterId}:{scope}:{sha256(正規化根目錄) 前 24 碼}，不含版本與原始路徑；
// - Windows：Credential Manager Generic credential（target name = key、UTF-8 blob、Persist=LocalMachine、
//   Comment "LC-AI-Pack"、UserName "lcaipack"），經 Windows PowerShell 的 P/Invoke 存取；
// - macOS：Keychain generic password（service com.linkchain.lcaipack、account = key），經 `security`。
// - Linux：Secret Service（同 service 與 account），經 `secret-tool`。
// 秘密值只經子行程 stdin 傳遞，不進命令列、環境變數、檔案或日誌；沒有任何明文替代儲存。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ErrorCode } from '../contract.mjs';
import { createPathRules } from '../deploy/canonical-root.mjs';
import { ofText } from '../deploy/digest.mjs';

export const KeyPrefix = 'lcaipack:setup:';
export const KeychainService = 'com.linkchain.lcaipack';
export const SecretUsages = Object.freeze({ setupTime: 'setup-time', runtime: 'runtime', setupAndRuntime: 'setup-and-runtime' });
export const knownUsage = u => Object.values(SecretUsages).includes(u);
export const includesUsage = (declared, usage) => declared === usage || (declared === SecretUsages.setupAndRuntime && knownUsage(usage));

/** 安全儲存區操作失敗：一律阻擋，呼叫端不得改用明文來源。訊息只含參數身分。 */
export class SetupSecretStoreError extends Error {
  constructor(message) { super(message); this.name = 'SetupSecretStoreError'; this.code = ErrorCode.secretStoreFailed; }
}

const shortHash = (value, length) => ofText(value).slice(0, length);

/** 對照 SetupSecretReference.For：根目錄先正規化再雜湊。 */
export function setupSecretReference({ packageKey, parameterId, scope, canonicalRoot }, rules = createPathRules()) {
  for (const [name, v] of Object.entries({ packageKey, parameterId, canonicalRoot })) {
    if (typeof v !== 'string' || !v.trim()) throw new TypeError(`${name} 為必填`);
  }
  const root = rules.normalize(canonicalRoot);
  return Object.freeze({ packageKey, parameterId, scope, canonicalRoot: root, key: `${KeyPrefix}${packageKey}:${parameterId}:${scope}:${shortHash(root, 24)}` });
}

/** 對照 SetupSecretManager：對外只有寫入、刪除與「有沒有」；read 只供受管 MCP 啟動通道使用。 */
export function createSecretManager(store, rules = createPathRules()) {
  const guard = (parameterId, operation, fn) => {
    try { return fn(); } catch (e) {
      if (e instanceof SetupSecretStoreError) throw e;
      throw new SetupSecretStoreError(`作業系統安全儲存區${operation}秘密參數 ${parameterId} 失敗；安裝必須中止，不會改用明文來源。`);
    }
  };
  const manager = {
    exists: ref => guard(ref.parameterId, '查詢', () => store.existsMany([ref.key])[0] === true),
    set(ref, value) {
      if (typeof value !== 'string' || value === '') throw new TypeError(`秘密參數 ${ref.parameterId} 的值不得為空`);
      guard(ref.parameterId, '寫入', () => store.set(ref.key, value));
    },
    delete: ref => guard(ref.parameterId, '刪除', () => store.delete(ref.key)),
    read: ref => guard(ref.parameterId, '讀取', () => store.get(ref.key)),
    describe(packageKey, scope, canonicalRoot, declarations, usageFilter = null) {
      if (usageFilter !== null && !knownUsage(usageFilter)) throw new RangeError(`未知的 secretUsage：${usageFilter}`);
      const selected = [];
      for (const d of declarations) {
        if (!knownUsage(d.usage)) throw new RangeError(`未知的 secretUsage：${d.usage}`);
        if (usageFilter === null || includesUsage(d.usage, usageFilter)) selected.push(d);
      }
      if (!selected.length) return [];
      const refs = selected.map(d => setupSecretReference({ packageKey, parameterId: d.parameterId, scope, canonicalRoot }, rules));
      const found = guard(selected.map(d => d.parameterId).join(', '), '查詢', () => store.existsMany(refs.map(r => r.key)));
      return selected.map((d, i) => ({ parameterId: d.parameterId, usage: d.usage, required: d.required !== false, exists: found[i] === true }));
    },
    missingRequired: (packageKey, scope, canonicalRoot, declarations, usageFilter = null) =>
      manager.describe(packageKey, scope, canonicalRoot, declarations, usageFilter).filter(s => s.required && !s.exists).map(s => s.parameterId)
  };
  return manager;
}

const defaultRun = (file, args, input) => {
  const r = spawnSync(file, args, { input, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 1 << 20 });
  if (r.error) throw new Error(`無法啟動安全儲存區程式：${path.basename(file)}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// 與 WindowsCredentialSecretStore 相同的 native 呼叫；輸入為 stdin 的 base64 行，輸出也只回到本行程。
const WINDOWS_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LcAiPackCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint BlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  static string Text(string b64) { return Encoding.UTF8.GetString(Convert.FromBase64String(b64)); }
  static string Get(string key) {
    IntPtr pointer;
    if (!CredRead(key, 1, 0, out pointer)) return null;
    try {
      Credential c = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      byte[] data = new byte[c.BlobSize];
      Marshal.Copy(c.CredentialBlob, data, 0, data.Length);
      return Encoding.UTF8.GetString(data);
    } finally { CredFree(pointer); }
  }
  static void Set(string key, string value) {
    byte[] bytes = Encoding.UTF8.GetBytes(value);
    IntPtr blob = Marshal.AllocCoTaskMem(bytes.Length);
    Marshal.Copy(bytes, 0, blob, bytes.Length);
    try {
      Credential c = new Credential();
      c.Flags = 0; c.Type = 1; c.TargetName = key; c.Comment = "LC-AI-Pack"; c.BlobSize = (uint)bytes.Length; c.CredentialBlob = blob;
      c.Persist = 2; c.AttributeCount = 0; c.Attributes = IntPtr.Zero; c.TargetAlias = ""; c.UserName = "lcaipack";
      if (!CredWrite(ref c, 0)) throw new InvalidOperationException("Windows Credential Manager write failed");
    } finally { Marshal.FreeCoTaskMem(blob); }
  }
  public static string Run(string request) {
    string[] lines = request.Replace("\r", "").Split('\n');
    StringBuilder output = new StringBuilder();
    switch (lines[0]) {
      case "exists":
        for (int i = 1; i < lines.Length; i++) if (lines[i].Length > 0) output.Append(Get(Text(lines[i])) != null ? "1\n" : "0\n");
        break;
      case "get":
        string value = Get(Text(lines[1]));
        output.Append(value == null ? "-" : Convert.ToBase64String(Encoding.UTF8.GetBytes(value))).Append('\n');
        break;
      case "set": Set(Text(lines[1]), Text(lines[2])); break;
      case "delete": CredDelete(Text(lines[1]), 1, 0); break;
      default: throw new ArgumentException("unknown operation");
    }
    return output.ToString();
  }
}
'@
[Console]::Out.Write([LcAiPackCredential]::Run([Console]::In.ReadToEnd()))
`;
const b64 = text => Buffer.from(text, 'utf8').toString('base64');

export function createWindowsCredentialStore({ run = defaultRun, systemRoot = process.env.SystemRoot ?? 'C:\\Windows' } = {}) {
  const exe = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')];
  const call = (op, ...items) => {
    const r = run(exe, args, [op, ...items.map(b64), ''].join('\n'));
    if (r.status !== 0) throw new Error(`Windows Credential Manager ${op} 失敗`);
    return r.stdout.replace(/\r/g, '').split('\n').filter(Boolean);
  };
  return {
    existsMany: keys => keys.length ? call('exists', ...keys).map(v => v === '1') : [],
    get(key) { const [v] = call('get', key); return !v || v === '-' ? null : Buffer.from(v, 'base64').toString('utf8'); },
    set: (key, value) => void call('set', key, value),
    delete: key => void call('delete', key)
  };
}

/** `security -i` 互動模式的引號；值不經命令列。 */
const quote = text => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function createMacKeychainStore({ run = defaultRun } = {}) {
  const existsResult = (result, mayBeMissing = true) => {
    if (mayBeMissing && result.status === 44) return false;
    if (result.status !== 0) throw new Error('無法存取 macOS 鑰匙圈');
    return true;
  };
  const get = key => {
    const r = run('security', ['find-generic-password', '-a', key, '-s', KeychainService, '-w'], undefined);
    return existsResult(r) ? r.stdout.replace(/\n$/, '') : null;
  };
  const exists = key => existsResult(run('security', ['find-generic-password', '-a', key, '-s', KeychainService], undefined));
  return {
    existsMany: keys => keys.map(exists),
    get,
    set(key, value) {
      if (/[\r\n]/.test(value) || /[\r\n]/.test(key)) throw new Error('macOS Keychain 的秘密值不可包含換行');
      existsResult(run('security', ['-i'], `add-generic-password -U -a ${quote(key)} -s ${quote(KeychainService)} -w ${quote(value)}\n`), false);
    },
    delete: key => { existsResult(run('security', ['delete-generic-password', '-a', key, '-s', KeychainService], undefined)); }
  };
}

/** 依作業系統選擇安全儲存區；不支援的平台直接失敗，沒有明文替代。 */
export function createDefaultSecretStore({ platform = process.platform, run } = {}) {
  if (platform === 'win32') return createWindowsCredentialStore(run ? { run } : {});
  if (platform === 'linux') return createLinuxSecretStore(run ? { run } : {});
  if (platform === 'darwin') return createMacKeychainStore(run ? { run } : {});
  throw new SetupSecretStoreError('目前只支援 Windows Credential Manager 與 macOS Keychain，以及 Linux Secret Service；不提供明文秘密儲存替代。');
}

export const LinuxKeyringHelp = '請安裝 libsecret-tools（sudo apt install libsecret-tools），並解鎖 GNOME 鑰匙圈';

/** Secret Service；值只經 stdin 寫入。lookup 原樣回傳 UTF-8，不 trim。 */
export function createLinuxSecretStore({ run = defaultRun } = {}) {
  const call = (verb, key, input) => {
    let result;
    try {
      result = run('secret-tool', [verb, ...(verb === 'store' ? ['--label=LC-AI-Pack'] : []), 'service', KeychainService, 'account', key], input);
    } catch { throw new SetupSecretStoreError(LinuxKeyringHelp); }
    // 沒有值也沒有診斷時，再查同一身分的項目，避免把鎖住而無法讀取的項目當成不存在。
    if (verb !== 'store' && result.status === 1 && !result.stderr && !result.stdout) {
      let found;
      try { found = run('secret-tool', ['search', '--all', 'service', KeychainService, 'account', key], undefined); }
      catch { throw new SetupSecretStoreError(LinuxKeyringHelp); }
      if (found.status !== 0 || found.stdout || found.stderr) throw new SetupSecretStoreError(LinuxKeyringHelp);
    }
    if (result.status !== 0 && !(verb !== 'store' && result.status === 1 && !result.stderr && !result.stdout)) {
      throw new SetupSecretStoreError(LinuxKeyringHelp);
    }
    return result;
  };
  const get = key => { const r = call('lookup', key); return r.status === 0 ? r.stdout : null; };
  return { get, existsMany: keys => keys.map(key => get(key) !== null),
    set: (key, value) => void call('store', key, value), delete: key => void call('clear', key) };
}
