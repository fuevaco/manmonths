import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseJson } from './http.mjs';
import { startChild } from './process-spawner.mjs';
import { startCodexAppServer } from './ai-codex-app-server.mjs';
import { LOCAL_TOOL_PLATFORMS as platforms } from './ai-local-tool-platforms.mjs';

const emailOf = value => typeof value === 'string' ? value : '';
const windowsEnv = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MODEL_LIST_PAGES = 10;

export async function createLocalToolCwd() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'rc-ai-'));
  return { cwd, remove: () => rm(cwd, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }) };
}

export async function withLocalToolCwd(run) {
  const { cwd, remove } = await createLocalToolCwd();
  try { return await run(cwd); }
  finally { await remove(); }
}

async function readCommand(spawn, file, args, { env, cwd, signal, osPlatform }) {
  let stdout = '', size = 0, overflow = false;
  const run = startChild(spawn, file, args, { cwd, env, signal, osPlatform, stdin: 'ignore', stderr: false, onStdout: chunk => {
    if (overflow) return;
    size += Buffer.byteLength(chunk);
    if (size <= MAX_OUTPUT_BYTES) stdout += chunk;
    else { overflow = true; run.terminate(); }
  } });
  const { code, error } = await run.closed;
  if (signal.aborted) throw signal.reason;
  if (overflow) throw new Error('CLI 輸出超過限制');
  if (error) throw error;
  return { code, stdout };
}

function sanitizedEnv(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(?:ORCA_|(?:CLAUDE_CONFIG_DIR|CODEX_HOME|ELECTRON_RUN_AS_NODE)$)/i.test(key)));
}

function isOlder(version, testedVersion) {
  const [core, prerelease] = version.split('+')[0].split('-', 2);
  const current = core.split('.').map(Number);
  for (const [index, tested] of testedVersion.split('.').map(Number).entries()) {
    if (current[index] !== tested) return current[index] < tested;
  }
  return Boolean(prerelease);
}

/** osPlatform 是作業系統（process.platform），tool 是本機 AI 工具的平台（claude-code、codex）。 */
export function createAiLocalTools({ spawn, env = process.env, osPlatform = process.platform, execPath = process.execPath, userHome = homedir() }) {
  const windows = osPlatform === 'win32';
  const hostPath = windows ? path.win32 : path.posix;
  const resources = osPlatform === 'darwin' ? hostPath.join('..', 'Resources') : 'resources';
  const orca = hostPath.join(hostPath.dirname(execPath), resources, 'bin', windows ? 'orca.exe' : 'orca');

  function baseEnv() {
    const clean = sanitizedEnv(env);
    if (windows && !windowsEnv(clean, 'APPDATA')) {
      clean.APPDATA = hostPath.join(windowsEnv(clean, 'USERPROFILE') || userHome, 'AppData', 'Roaming');
    }
    return clean;
  }

  function orcaUserData(env) {
    if (windows) return hostPath.join(windowsEnv(env, 'APPDATA'), 'orca');
    if (osPlatform === 'darwin') return hostPath.join(userHome, 'Library', 'Application Support', 'orca');
    if (osPlatform === 'linux') {
      const config = env.XDG_CONFIG_HOME || '';
      return hostPath.join(hostPath.isAbsolute(config) ? config : hostPath.join(userHome, '.config'), 'orca');
    }
    throw new Error('Orca userData');
  }

  const run = (file, args, env, signal) => withLocalToolCwd(cwd => readCommand(spawn, file, args, { cwd, env, signal, osPlatform }));

  async function probe(tool, env, signal, cwd) {
    const { command, testedVersion } = platforms[tool];
    try {
      const args = ['--version'];
      const { code, stdout } = await (cwd ? readCommand(spawn, command, args, { cwd, env, signal, osPlatform }) : run(command, args, env, signal));
      if (code === 0) {
        const version = stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?\b/)?.[0] ?? '';
        const versionWarning = version && isOlder(version, testedVersion) ? `低於實測版本 ${testedVersion}，建議更新` : '';
        return { installed: true, version, versionWarning };
      }
    } catch { /* 無法啟動或完成版本查詢 */ }
    return { installed: false, version: '', versionWarning: '' };
  }

  async function detect(signal) {
    const cleanEnv = baseEnv();
    const entries = await withLocalToolCwd(cwd => Promise.all(Object.keys(platforms).map(async tool =>
      [tool, await probe(tool, cleanEnv, signal, cwd)])));
    return Object.fromEntries(entries);
  }

  async function resolveAccount(tool, signal) {
    const env = baseEnv();
    const { code, stdout } = await run(orca, ['account', 'list', '--json'], env, signal);
    const body = parseJson(stdout);
    const claude = tool === 'claude-code';
    const provider = claude ? body?.result?.claude : body?.result?.codex;
    if (code !== 0 || body?.ok !== true || !Array.isArray(provider?.accounts)) throw new Error('Orca account list');
    const id = provider.activeAccountIdsByRuntime?.host ?? provider.activeAccountId;
    if (id != null && typeof id !== 'string') throw new Error('Orca account id');
    const selected = id ? provider.accounts.find(account => account?.id === id) : null;
    if (claude) {
      // ADR-0007：使用中的帳號不在清單時報錯，不退回系統預設帳號。
      if (id && !selected) throw new Error('Orca account missing');
      if (!selected || selected.runsOnSystemDefault === true) return { env, account: emailOf(provider.systemDefaultEmail) };
      if (typeof selected.home !== 'string' || !hostPath.isAbsolute(selected.home)) throw new Error('Orca account home');
      env.CLAUDE_CONFIG_DIR = selected.home;
    } else {
      if (!id) return { env, account: emailOf(provider.systemDefault?.email) };
      if (/[/\\:\x00]/.test(id) || /[. ]$/.test(id)) throw new Error('Orca account id');
      env.CODEX_HOME = hostPath.join(orcaUserData(env), 'codex-accounts', id, 'home');
    }
    return { env, account: emailOf(selected?.email) };
  }

  /** 另外啟動一次 app-server 取回 Codex 的模型清單，不呼叫模型、不耗額度。 */
  function listCodexModels(env, signal) {
    return withLocalToolCwd(async cwd => {
      const app = startCodexAppServer(spawn, { cwd, env, signal, osPlatform });
      try {
        await app.initialize();
        const models = [];
        let cursor = null;
        for (let page = 0; page < MODEL_LIST_PAGES; page++) {
          const result = await app.request('model/list', cursor ? { cursor } : {});
          if (!Array.isArray(result?.data)) throw new Error('Invalid model/list response');
          models.push(...result.data.filter(model => typeof model?.model === 'string' && model.model && model.hidden !== true));
          cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
          if (!cursor) break;
        }
        return {
          models: [...new Set(models.map(model => model.model))],
          defaultModel: models.find(model => model.isDefault === true)?.model ?? ''
        };
      } finally { await app.close(); }
    });
  }

  async function check(tool, signal, { listModels = false } = {}) {
    const { command, label, authArgs } = platforms[tool];
    const details = { platform: tool, platformLabel: label, account: '', version: '', versionWarning: '' };
    const status = (reasonCode = '', reason = '') => ({ ...details, state: reasonCode ? 'error' : 'ok', reasonCode, reason });
    let resolved;
    try { resolved = await resolveAccount(tool, signal); }
    catch { return status('account-unavailable', '無法向 Orca 查詢目前的帳號，請確認 Orca 運作正常'); }
    details.account = resolved.account;
    const { installed, version, versionWarning } = await probe(tool, resolved.env, signal);
    if (!installed) return status('missing-cli', '找不到 ' + label + '，請先安裝');
    Object.assign(details, { version, versionWarning });
    try {
      const { code, stdout } = await run(command, authArgs, resolved.env, signal);
      if (code === 0 && (tool === 'codex' || parseJson(stdout)?.loggedIn === true)) {
        if (!listModels || tool !== 'codex') return status();
        const listed = await listCodexModels(resolved.env, signal).catch(() => ({ models: [], defaultModel: '' }));
        return { ...status(), ...listed };
      }
    } catch (error) {
      if (error.code === 'ENOENT') return status('missing-cli', '找不到 ' + label + '，請先安裝');
    }
    return status('not-signed-in', label + ' 未登入' + (details.account ? '（' + details.account + '）' : ''));
  }

  /** 只讀模型清單，不檢查登入、不呼叫模型。Claude Code 的別名由面板提供，所以回傳空清單。失敗時回傳原因，不丟例外。 */
  async function listModels(tool, signal) {
    const empty = (reason = '') => ({ models: [], defaultModel: '', reason });
    if (tool !== 'codex') return empty();
    try {
      const { env } = await resolveAccount(tool, signal);
      return { ...await listCodexModels(env, signal), reason: '' };
    } catch { return empty('無法取得模型清單'); }
  }

  return { detect, check, resolveAccount, listModels };
}
