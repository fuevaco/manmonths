// 工項 13：公開發布衛生檢查（對照 SecretCanaryScanTests 的精神）。
// 掃描整個外掛資料夾（原始碼、測試、測試資料、README、manifest），確認沒有組織內部位址、
// 真實帳號、本機使用者路徑或憑證；並確認第三方授權與版本號一致。
//
// 決定（寫在這裡，README「發布前檢查」也有記載）：
// - 開發用後端的測試帳號（genius／manager 與其密碼）屬於測試環境資料，整個資料夾（含測試）一律不得出現；
//   測試只使用 alice／example.invalid 這類合成資料。唯一可連的「本機」位址是 localhost 與 127.0.0.1。
// - `com.linkchain.lcaipack` 是與其他用戶端共用 Keychain 項目的協定常數，不是位址或帳號，
//   只允許出現在 worker/setup/secrets.mjs 與對應測試、README 的說明。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'test/release-hygiene.test.mjs';
const TEXT_FILE = /\.(mjs|cjs|js|json|html|css|md|txt|toml|ps1|sh)$|^LICENSE$/;

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

const files = (await walk(root)).map((full) => ({ full, rel: path.relative(root, full).split(path.sep).join('/') }));
const textFiles = [];
for (const file of files) {
  if (file.rel === SELF || !TEXT_FILE.test(path.basename(file.rel))) continue;
  textFiles.push({ ...file, text: (await fs.readFile(file.full, 'utf8')).replace(/^﻿/, '') });
}

const PUBLIC_HOSTS = new Set(['localhost', '127.0.0.1', 'github.com', 'www.w3.org', 'tools.ietf.org', 'httpstatuses.io']);
function allowedHost(host) {
  const h = host.toLowerCase();
  if (h.startsWith('$') || h.startsWith('{')) return true; // 範本字串，由執行期決定
  if (PUBLIC_HOSTS.has(h)) return true;
  return /(^|\.)example(\.(com|org|invalid|local))?$/.test(h) || /\.invalid$/.test(h);
}

function isPublicRepositoryUrl(match, line, rel) {
  const suffix = rel === 'README.md' ? '\\.git' : '';
  if (rel !== 'README.md' && rel !== 'orca-plugin.json') return false;
  const repository = new RegExp(`https:[/][/]github\\.com/linkchain-corp/manmonths${suffix}(?=["\x60\\s]|$)`, 'g');
  return [...line.matchAll(repository)].some((url) =>
    match.index >= url.index && match.index + match[0].length <= url.index + url[0].length);
}

function findings(rules, { skip = () => false } = {}) {
  const found = [];
  for (const file of textFiles) {
    file.text.split(/\r?\n/).forEach((line, index) => {
      for (const [name, pattern, allowed] of rules) {
        if (skip(file.rel, name)) continue;
        for (const match of line.matchAll(pattern)) {
          if (allowed?.(match, line, file.rel)) continue;
          found.push(`${file.rel}:${index + 1} [${name}] ${match[0].slice(0, 60)}`);
        }
      }
    });
  }
  return found;
}

test('外掛資料夾只有應發布的內容：沒有日誌、環境檔、金鑰、截圖輸出或相依套件目錄', () => {
  const banned = /(^|\/)(\.orca|node_modules|\.git|\.vs|\.idea|\.claude)(\/|$)|\.(log|pem|pfx|p12|key|env|zip|bak|tmp)$|(^|\/)(\.env.*|\.DS_Store|Thumbs\.db|npm-debug\.log.*)$/i;
  assert.deepEqual(files.filter((f) => banned.test(f.rel)).map((f) => f.rel), []);
});

test('沒有內部位址：IP 只允許 127.0.0.1，不得有內網網段、內部網域或組織網域', () => {
  const rules = [
    // 私有／連結本地網段（避免誤判版本號：前後不得緊鄰數字或點）。
    ['私有 IP', /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|169\.254)\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g],
    // 所有 URL 的主機都必須在白名單：本機、合成網域（*.example／*.invalid）與少數公開參考網址。
    ['URL 主機不在白名單', /https?:\/\/([^\/\s:"'`)<>?#\]）」，。；、]+)/gi, (m) => allowedHost(m[1])],
    // 非 URL 形式的內部網域尾碼與公司網域名稱。
    ['內部網域', /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:corp|lan|intra|intranet|com\.tw|org\.tw|gov\.tw)\b/gi],
    ['組織名稱', /linkchain|aiworkcenter|aiworkcentre/gi,
      (m, line, rel) => isPublicRepositoryUrl(m, line, rel)
        || (/com\.linkchain\.lcaipack/.test(line) && ['worker/setup/secrets.mjs', 'worker/setup/mcp-launcher/lcaipack-mcp-launch.mjs', 'test/setup-secrets.test.mjs', 'test/linux-support.test.mjs', 'README.md'].includes(rel))]
  ];
  assert.deepEqual(findings(rules), []);
});

test('沒有本機使用者路徑或機器資訊：只允許合成的 Alice／Synthetic 等示範名稱', () => {
  const synthetic = /^(?:alice|alicex|bob|synthetic|tester|fallback|a|b|dev|user|someone|example|demo|test|other|me|使用者|u[0-9a-f]{4}.*)$/i;
  const rules = [
    ['Windows 使用者目錄', /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s'"`<>{}$]+)/gi, (m) => synthetic.test(m[1])],
    ['macOS／Linux 家目錄', /(?<![\w.])\/(?:Users|home)\/([^\\/\s'"`<>{}$]+)/g, (m) => synthetic.test(m[1])],
    // 開發機常見的專案根目錄（D:\Project、D:\Git…）；測試用的 C:\projects\demo 等合成路徑不在此列。
    ['開發機專案路徑', /[A-Za-z]:[\\/]+(?:Project|Git)[\\/]+[A-Za-z0-9_.-]+/g],
    ['AppData 使用者層級', /AppData[\\/]+(?:Local|Roaming)[\\/]+[A-Za-z0-9]/gi]
  ];
  assert.deepEqual(findings(rules), []);
});

test('沒有執行測試這台機器的使用者名稱、家目錄或電腦名稱', () => {
  const generic = new Set(['user', 'users', 'test', 'tester', 'admin', 'administrator', 'root', 'runner', 'vagrant', 'ubuntu', 'github', 'default',
    'system', 'guest', 'node', 'docker', 'build', 'agent', 'localhost', 'alice', 'orca']);
  const canaries = new Set();
  const add = (value) => { if (typeof value === 'string' && value.length >= 4 && !generic.has(value.toLowerCase())) canaries.add(value); };
  try { add(os.userInfo().username); } catch { /* 沒有使用者資訊時略過 */ }
  add(os.hostname());
  add(path.basename(os.homedir()));
  const escaped = [...canaries].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const found = escaped.length === 0 ? [] : findings([['本機使用者資訊', new RegExp(`(?<![A-Za-z0-9])(?:${escaped.join('|')})(?![A-Za-z0-9])`, 'gi')]]);
  assert.deepEqual(found, [], '測試資料不得使用真人帳號或本機名稱；請改用 alice 等合成資料');
});

test('沒有真實帳號與測試後端帳密：genius／manager 測試帳號與其密碼、電子郵件', () => {
  const rules = [
    // 開發後端的繞過登入帳號與密碼（PowerShell 的 -ExecutionPolicy Bypass 為首字母大寫，不在此限）。
    ['測試後端帳密', /\bgenius\b|\bbypass\b|\bdept_manager\b/g],
    ['電子郵件', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
      (m) => /@(?:example\.(?:com|org|invalid)|users\.noreply\.github\.com)$/i.test(m[0]) || /^@/.test(m[0]) || /\.(?:png|jpg|svg)$/i.test(m[0])]
  ];
  // 第三方套件的作者資訊不在檢查範圍。
  assert.deepEqual(findings(rules, { skip: (rel, name) => rel.startsWith('worker/vendor/') && name === '電子郵件' }), []);
});

test('沒有憑證：JWT、refresh token、私密金鑰、常見雲端／平台 token、Bearer 實值', () => {
  const rules = [
    ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
    ['refresh token 實值', /\blcrt_[A-Za-z0-9]{24,}/g],
    ['私密金鑰', /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
    ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}/g],
    ['AWS 金鑰', /\bAKIA[0-9A-Z]{16}\b/g],
    ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
    ['Azure DevOps PAT 長度字串', /(?<![A-Za-z0-9])[a-z2-7]{52}(?![A-Za-z0-9])/g],
    ['Bearer 實值', /Bearer\s+(?!<|\$|\{|token\b|abc|test|fake|secret|session|old|new|valid|stale|bad|expired|access|jwt|xxx)[A-Za-z0-9._~+/=-]{24,}/gi],
    ['URL 內嵌帳密', /https?:\/\/[^\s/:@"'`]+:[^\s/@"'`]+@[A-Za-z0-9.-]+/g]
  ];
  assert.deepEqual(findings(rules), []);
});

test('第三方授權：隨附的 smol-toml 附有完整 BSD-3-Clause 授權與版權聲明，README 有第三方授權說明', async () => {
  const dir = 'worker/vendor/smol-toml';
  const license = await fs.readFile(path.join(root, dir, 'LICENSE'), 'utf8');
  assert.match(license, /Copyright \(c\) Squirrel Chat et al\./);
  assert.match(license, /Redistributions of source code must retain the above copyright notice/);
  assert.match(license, /Redistributions in binary form must reproduce the above copyright notice/);
  assert.match(license, /Neither the name of the copyright holder/);
  assert.match(license, /THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"/);
  const bundle = await fs.readFile(path.join(root, dir, 'index.cjs'), 'utf8');
  assert.match(bundle.slice(0, 400), /Copyright \(c\) Squirrel Chat/, '打包檔開頭保留版權聲明');
  assert.match(bundle.slice(0, 400), /SPDX-License-Identifier: BSD-3-Clause/);
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /smol-toml/);
  assert.match(readme, /BSD-3-Clause/);
});

test('版本一致：manifest 是唯一版本來源，收據與安裝回報的 clientVersion 由它而來，Catalog 條目與它相同', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'orca-plugin.json'), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const { pluginVersion } = await import('../worker/plugin-version.mjs');
  assert.equal(pluginVersion(), manifest.version);
  // worker 內不得寫死版本字串（Windows 與 macOS 發布共用同一個 manifest 版本）。
  const hardcoded = findings([['寫死版本', /clientVersion\s*[:=]\s*['"]\d+\.\d+\.\d+['"]/g]])
    .filter((entry) => entry.startsWith('worker/'));
  assert.deepEqual(hardcoded, []);
  const platforms = manifest.engines?.platforms ?? manifest.platforms;
  assert.equal(platforms, undefined, '不依作業系統分開發布；Windows 與 macOS 使用同一份外掛');

  const catalogPath = path.join(root, '..', '..', 'orca-catalog.json');
  let catalog = null;
  try { catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8')); } catch { /* 外掛單獨安裝時沒有 Catalog，略過這一段 */ }
  if (!catalog) return;
  const entry = catalog.plugins.find((p) => p.id === `${manifest.publisher}.${manifest.id}`);
  if (!entry) return; // 尚未登錄的提交（先提交外掛、再更新 Catalog）
  assert.equal(entry.releases[0].version, manifest.version);
  assert.equal(entry.source.path, 'plugins/ai-resource-center');
});
