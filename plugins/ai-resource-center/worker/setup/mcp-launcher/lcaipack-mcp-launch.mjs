#!/usr/bin/env node
// 三平台獨立單檔：只載入 Node 內建模組，安裝後由 node 執行。
// 對照 ManagedMcpLaunch.cs／SetupSecretChannel.cs：秘密框架必須先於 Host stdin。
const WINDOWS_READ_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
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
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
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
  public static string Run(string request) {
    string[] lines = request.Replace("\r", "").Split('\n');
    StringBuilder output = new StringBuilder();
    switch (lines[0]) {
      case "get":
        string value = Get(Text(lines[1]));
        output.Append(value == null ? "-" : Convert.ToBase64String(Encoding.UTF8.GetBytes(value))).Append('\n');
        break;
      default: throw new ArgumentException("unknown operation");
    }
    return output.ToString();
  }
}
'@
[Console]::Out.Write([LcAiPackCredential]::Run([Console]::In.ReadToEnd()))
`;

async function main() {
  const { spawn, spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = (await import('node:path')).default;
  const os = await import('node:os');
  const { createHash } = await import('node:crypto');
  const argv = process.argv.slice(2);
  if (argv.length === 2 && argv[0] === 'mcp-launch' && argv[1] === '--probe') {
    process.stdout.write('lcaipack-mcp-launch/1\n');
    return;
  }
  const options = {};
  if (argv[0] !== 'mcp-launch' || argv.length !== 9) throw new Error('啟動引數格式錯誤');
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--package', '--content', '--scope', '--root'].includes(flag) || options[flag] || !argv[i + 1]) throw new Error('啟動引數格式錯誤');
    options[flag] = argv[i + 1];
  }
  const packageKey = options['--package'], contentId = options['--content'], scope = options['--scope'];
  if (!['global', 'project'].includes(scope) || !/^[A-Za-z0-9._-]+$/.test(contentId) || ['.', '..'].includes(contentId)) throw new Error('啟動身分格式錯誤');

  // 與 CanonicalRootResolver 相同：只解析最深已存在節點本身的連結，Linux 保留大小寫。
  function normalize(input) {
    if (typeof input !== 'string' || !input.trim()) return '';
    const full = trimEndingSeparator(resolveLinks(path.resolve(input), path), path);
    return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full;
  }
  function trimEndingSeparator(p, api) {
    const root = api.parse(p).root;
    return p.length > root.length && /[\\/]$/.test(p) ? p.slice(0, -1) : p;
  }

  function finalTarget(p, api) {
    let current = p;
    for (let i = 0; i < 40; i++) {
      let stat;
      try { stat = fs.lstatSync(current); } catch { return current; }
      if (!stat.isSymbolicLink()) return current;
      current = api.resolve(api.dirname(current), fs.readlinkSync(current));
    }
    return current;
  }

  function resolveLinks(full, api) {
    try {
      let current = full;
      while (current.length > 0) {
        let stat = null;
        try { stat = fs.statSync(current); } catch { stat = null; }
        if (stat?.isDirectory()) {
          const resolved = finalTarget(current, api);
          return current === full ? resolved : api.join(resolved, api.relative(current, full));
        }
        if (stat?.isFile()) {
          // 父層是檔案代表路徑本身無效；保留宣告形式，交給套用階段以真正的 IO 失敗處理。
          if (current !== full) return full;
          return finalTarget(current, api);
        }
        const parent = api.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch { /* 與 worker 相同：無法解析時保留原始完整路徑 */ }
    return full;
  }
  const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const root = normalize(options['--root']);
  const home = process.env.LCAIPACK_HOME || path.join(os.homedir(), '.lcaipack');
  const slug = [...packageKey].map(ch => /[A-Za-z0-9._-]/.test(ch) ? ch.toLowerCase() : '_').join('');
  const setupRoot = path.resolve(home, 'setup-roots', slug, `${scope}-${hash(root).slice(0, 16)}`);
  const descriptor = JSON.parse(fs.readFileSync(path.join(setupRoot, 'mcp', `${contentId}.json`), 'utf8').replace(/^\uFEFF/, ''));
  if (descriptor.launchFormatVersion !== 1 || descriptor.packageKey !== packageKey || descriptor.contentId !== contentId || descriptor.scope !== scope ||
      normalize(descriptor.canonicalRoot) !== root || path.resolve(descriptor.setupRoot) !== setupRoot || typeof descriptor.command !== 'string' || !descriptor.command ||
      !Array.isArray(descriptor.args) || !descriptor.args.every(a => typeof a === 'string') || !Array.isArray(descriptor.runtimeSecrets)) throw new Error('啟動描述無效，請重新安裝資源包');

  // 無環境變數測試入口；測試以 Node --require 攔截內建系統呼叫。
  function readSecret(key) {
    const run = (file, args, input) => {
      const result = spawnSync(file, args, { input, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 20, windowsHide: true });
      if (result.error) throw new Error('無法讀取作業系統秘密');
      return result;
    };
    if (process.platform === 'win32') {
      const exe = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(WINDOWS_READ_SCRIPT, 'utf16le').toString('base64')], `get\n${Buffer.from(key).toString('base64')}\n`);
      if (result.status !== 0) throw new Error('無法讀取 Windows 認證管理員');
      const [value] = result.stdout.replace(/\r/g, '').split('\n').filter(Boolean);
      return !value || value === '-' ? null : Buffer.from(value, 'base64').toString('utf8');
    }
    if (process.platform === 'darwin') {
      const result = run('security', ['find-generic-password', '-a', key, '-s', 'com.linkchain.lcaipack', '-w']);
      return result.status === 0 ? result.stdout.replace(/\n$/, '') : null;
    }
    if (process.platform !== 'linux') throw new Error('不支援的秘密儲存區');
    const result = spawnSync('secret-tool', ['lookup', 'service', 'com.linkchain.lcaipack', 'account', key], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 20, windowsHide: true
    });
    if (result.error || (result.status !== 0 && !(result.status === 1 && !result.stderr && !result.stdout))) throw new Error('請安裝 libsecret-tools（sudo apt install libsecret-tools），並解鎖 GNOME 鑰匙圈');
    if (result.status === 1) {
      const found = spawnSync('secret-tool', ['search', '--all', 'service', 'com.linkchain.lcaipack', 'account', key], { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 20, windowsHide: true });
      if (found.error || found.status !== 0 || found.stdout || found.stderr) throw new Error('無法存取鑰匙圈內的秘密');
    }
    return result.status === 0 ? result.stdout : null;
  }

  const lines = ['LCAIPACK-SECRET-BEGIN 1'];
  for (const binding of descriptor.runtimeSecrets) {
    if (typeof binding.parameterId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(binding.parameterId)) throw new Error('秘密參數身分無效');
    const key = `lcaipack:setup:${descriptor.packageKey}:${binding.parameterId}:${scope}:${hash(root).slice(0, 24)}`;
    const value = readSecret(key);
    if (!value) {
      if (binding.required !== false) throw new Error('必填執行期秘密尚未儲存，請重新設定資源包');
      continue;
    }
    lines.push(`${binding.parameterId} ${Buffer.from(value, 'utf8').toString('base64')}`);
  }
  lines.push('LCAIPACK-SECRET-END', '');
  const cwd = descriptor.cwd || path.join(descriptor.setupRoot, 'runtime');
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(descriptor.command, descriptor.args, { cwd, env: { ...process.env, ...descriptor.env },
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  const forward = signal => {
    try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch { /* 已結束 */ }
  };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => forward(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', error => { if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') forward('SIGTERM'); });
  child.once('error', () => {
    process.stderr.write('無法啟動 MCP，請重新安裝或檢查啟動命令\n');
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (signal && process.platform !== 'win32') process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  child.stdin.write(lines.join('\n'));
  lines.fill('');
  process.stdin.pipe(child.stdin);
}

main().catch(() => {
  // 不轉印底層例外（命令或診斷可能含秘密）。
  const help = process.platform === 'linux'
    ? '並安裝 libsecret-tools（sudo apt install libsecret-tools）、解鎖 GNOME 鑰匙圈' : '且作業系統秘密儲存區可用';
  process.stderr.write(`MCP 啟動失敗；請確認資源包已安裝、必填秘密已設定，${help}\n`);
  process.exitCode = 1;
});
