// 對照 Deployment/OrcaClaudeMcpCleanup.cs。只清理 Windows Orca 帳號中與主根相同的殘留。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ProblemCodes, warning } from './problems.mjs';

const configName = '.claude.json';
const nodePrefix = 'mcpServers.';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (missing(error)) return null; throw error; }
}

// 正規化無法由 JS number 精確往返的 JSON 數值，避免誤刪顯示相同但實際不同的設定。
function decimalKey(text) {
  const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.replace(/^-/, '').split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/, '');
  const shifted = BigInt(exponent) + BigInt(digits.length - significant.length - fraction.length);
  return `${mantissa.startsWith('-') ? '-' : ''}${significant}e${shifted}`;
}

function parse(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), (_key, value, context) => {
      if (typeof value !== 'number') return value;
      if (!context?.source || !JSON.rawJSON) return value || 0;
      const exact = decimalKey(context.source);
      if (Number.isFinite(value) && exact === decimalKey(JSON.stringify(value))) return value || 0;
      return JSON.rawJSON(exact);
    });
  } catch { return null; }
}

function serversOf(document) {
  return isObject(document?.mcpServers) && !JSON.isRawJSON?.(document.mcpServers) ? document.mcpServers : null;
}

export function resolveWindowsOrcaAppData(platform, env, userHome) {
  if (platform !== 'win32' || !env?.APPDATA?.trim() || !path.isAbsolute(env.APPDATA)) return null;
  if (env === process.env && path.resolve(userHome).toLowerCase() !== path.resolve(os.homedir()).toLowerCase()) return null;
  return env.APPDATA;
}

export function createOrcaClaudeMcpCleanup(target, { userHome, windowsOrcaAppDataDirectory } = {}) {
  const removed = new Map();
  const problems = [];
  const enabled = target.host.hostId === 'claude-code' && target.host.surfaceId === 'claude-code-cli' &&
    target.scope === 'global' && windowsOrcaAppDataDirectory?.trim();
  const main = enabled ? path.resolve(userHome, configName).toLowerCase() : null;
  const warn = (summary, file) => problems.push(warning(ProblemCodes.orcaClaudeMcpCleanupSkipped, summary, file,
    { host: target.host, scope: target.scope, path: file }));

  function cleanProfile(file, directories) {
    const read = () => {
      if (!directories.every(directory => stat(directory)?.isDirectory()) || !stat(file)?.isFile()) return null;
      try { return fs.readFileSync(file); }
      catch (error) { if (missing(error)) return null; throw error; }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = read();
      if (!before) return;
      const document = parse(before);
      const servers = serversOf(document);
      if (!servers) return;
      const matched = [], different = [];
      for (const [server, value] of removed) {
        if (!Object.hasOwn(servers, server)) continue;
        if (isDeepStrictEqual(servers[server], value)) matched.push(server);
        else different.push(server);
      }
      if (matched.length) {
        for (const server of matched) delete servers[server];
        // 暫存檔放在 Orca 目錄之外的同磁碟，只有已存在的設定檔會被替換。
        const temp = path.join(windowsOrcaAppDataDirectory, `.lcaipack-orca-cleanup-${randomUUID()}.tmp`);
        const descriptor = fs.openSync(temp, 'wx', 0o600);
        try {
          try { fs.writeFileSync(descriptor, JSON.stringify(document, null, 2)); }
          finally { fs.closeSync(descriptor); }
          const latest = read();
          if (!latest) return;
          if (!latest.equals(before)) continue;
          fs.renameSync(temp, file);
        } finally {
          try { fs.unlinkSync(temp); }
          catch (error) { if (!missing(error)) throw error; }
        }
      }
      for (const server of different) warn(`Orca Claude 已保留設定不同的 MCP「${server}」。`, file);
      return;
    }
    warn('Orca Claude 帳號設定持續變動，已略過 MCP 殘留清理。', file);
  }

  return {
    recordRemoval(file, nodePath, before, after) {
      if (!main || !nodePath.startsWith(nodePrefix) || path.resolve(file).toLowerCase() !== main) return;
      const server = nodePath.slice(nodePrefix.length);
      const old = serversOf(parse(before)), current = serversOf(parse(after));
      if (old && Object.hasOwn(old, server) && current && !Object.hasOwn(current, server)) removed.set(server, old[server]);
    },
    run() {
      if (!removed.size) return problems;
      const orca = path.join(windowsOrcaAppDataDirectory, 'orca');
      const profiles = path.join(orca, 'claude-profiles');
      try {
        if (!stat(orca)?.isDirectory() || !stat(profiles)?.isDirectory()) return problems;
        for (const account of fs.readdirSync(profiles, { withFileTypes: true })) {
          if (!account.isDirectory()) continue;
          const profile = path.join(profiles, account.name);
          const home = path.join(profile, 'home');
          const file = path.join(home, configName);
          try { cleanProfile(file, [orca, profiles, profile, home]); }
          catch { warn('無法清理 Orca Claude 帳號的 MCP 殘留。', file); }
        }
      } catch (error) {
        if (!missing(error)) warn('無法讀取 Orca Claude 帳號資料夾以清理 MCP 殘留。', profiles);
      }
      return problems;
    }
  };
}
