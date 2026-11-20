import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = dirname(__dirname);
const PLUGINS_DIR = join(ROOT_DIR, 'plugins');

function hashLength(hash, length) {
  const framedLength = Buffer.allocUnsafe(8);
  framedLength.writeBigUInt64BE(BigInt(length));
  hash.update(framedLength);
}

function hashPluginTree(root) {
  const files = [];
  function collect(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.orca') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(full);
      } else if (entry.isFile()) {
        const stat = statSync(full);
        files.push({ full, rel: relative(root, full).replace(/\\/g, '/'), size: stat.size });
      }
    }
  }
  collect(root);
  const hash = createHash('sha256');
  hash.update('orca-plugin-tree-v1\0');
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    hashLength(hash, Buffer.byteLength(file.rel, 'utf8'));
    hash.update(file.rel, 'utf8');
    hashLength(hash, file.size);
    hash.update(readFileSync(file.full));
  }
  return { hash: hash.digest('hex'), files: files.length, totalBytes };
}

// Orca 安裝外掛時，會對下載到的檔案「原始位元組」重算 contentHash 並與 catalog 比對。
// 因此 contentHash 必須來自 Git 實際存的內容：若工作目錄的檔案被換行轉換（core.autocrlf）
// 或有未提交的修改，算出來的值別人就驗證不過（Orca 會顯示「無法讀取其存取權限」）。
// 這裡在計算前逐檔核對：工作目錄的每個檔案，位元組必須與 HEAD 提交裡的 blob 完全相同。
function gitBlobSha1(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function assertPluginMatchesGit(pluginFolder, relPath) {
  let out;
  try {
    out = execSync(`git ls-tree -r -z HEAD -- ${relPath}`, { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new Error(`無法讀取 ${relPath} 在 HEAD 的內容。請先把外掛提交（commit）後再產生 catalog。`);
  }
  const committed = new Map();
  for (const rec of out.split('\0').filter(Boolean)) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(rec);
    if (m) committed.set(m[2], m[1]);
  }
  const problems = [];
  const seen = new Set();
  (function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.orca') continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const rel = relative(ROOT_DIR, full).replace(/\\/g, '/');
        seen.add(rel);
        const want = committed.get(rel);
        if (!want) problems.push(`${rel}（尚未提交）`);
        else if (gitBlobSha1(readFileSync(full)) !== want) problems.push(`${rel}（與已提交內容不同：未提交的修改或換行被轉換）`);
      }
    }
  })(pluginFolder);
  for (const rel of committed.keys()) if (!seen.has(rel)) problems.push(`${rel}（已提交但工作目錄沒有）`);
  if (problems.length) {
    throw new Error(
      `${relPath} 的工作目錄與 Git 內容不一致，已中止（否則 contentHash 會讓使用者驗證失敗）：\n  - ` +
        problems.slice(0, 10).join('\n  - ') +
        (problems.length > 10 ? `\n  …另外 ${problems.length - 10} 個` : '') +
        '\n請先 commit 所有修改；若是換行問題，請確認根目錄 .gitattributes 有 `plugins/** -text`，並重新 checkout 該資料夾。'
    );
  }
}

function getGitHeadCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  } catch (error) {
    return '0'.repeat(40);
  }
}

function deriveCatalogTypes(manifest) {
  const types = new Set();
  const c = manifest.contributes || {};
  if (c.languagePacks?.length) types.add('interface-language');
  if (c.themes?.length) types.add('app-theme');
  if (c.terminalThemes?.length) types.add('terminal-theme');
  if (c.iconThemes?.length) types.add('icon-theme');
  if (c.syntaxes?.length) types.add('syntax');
  if (c.vmRecipes?.length) types.add('instructions');
  if (c.panels?.length) types.add('panel');
  if (c.customEditors?.length) types.add('editor');
  if (manifest.main) types.add('worker');
  return Array.from(types);
}

function deriveContributionSummary(manifest) {
  const items = [];
  const c = manifest.contributes || {};
  if (c.languagePacks) {
    for (const p of c.languagePacks) items.push({ kind: 'languagePacks', name: p.locale });
  }
  if (c.themes) {
    for (const t of c.themes) items.push({ kind: 'themes', name: t.title || t.id });
  }
  if (c.terminalThemes) {
    for (const t of c.terminalThemes) items.push({ kind: 'terminalThemes', name: t.title || t.id });
  }
  if (c.iconThemes) {
    for (const t of c.iconThemes) items.push({ kind: 'iconThemes', name: t.title || t.id });
  }
  if (c.syntaxes) {
    for (const s of c.syntaxes) items.push({ kind: 'syntaxes', name: s.title || s.id });
  }
  if (c.panels) {
    for (const p of c.panels) items.push({ kind: 'panels', name: p.title || p.id });
  }
  if (c.commands) {
    for (const cmd of c.commands) items.push({ kind: 'commands', name: cmd.title || cmd.id });
  }
  if (c.keybindings) {
    for (const k of c.keybindings) items.push({ kind: 'keybindings', name: k.key });
  }
  if (c.customEditors) {
    for (const ed of c.customEditors) {
      const detail = [...(ed.extensions || []), ...(ed.filenames || [])].join(', ') || undefined;
      items.push({ kind: 'customEditors', name: ed.title || ed.id, ...(detail ? { detail } : {}) });
    }
  }
  return items;
}

function getImageDimensions(buf, filePath) {
  // PNG: 8-byte signature + IHDR chunk (width at 16..20, height at 20..24)
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WEBP: RIFF....WEBP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width, height };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  throw new Error(`Unsupported or invalid icon image format (expected PNG or WEBP): ${filePath}`);
}

function deriveIconCatalogEntry(manifest, pluginFolder, relPath) {
  if (!manifest.icon) return null;
  const iconRel = manifest.icon.replace(/\\/g, '/');
  const iconAbs = join(pluginFolder, iconRel);
  if (!existsSync(iconAbs)) {
    throw new Error(`Icon file not found: ${iconAbs}`);
  }
  const buf = readFileSync(iconAbs);
  if (buf.length > 256 * 1024) {
    throw new Error(`Icon exceeds 256 KB limit (${buf.length} bytes): ${iconAbs}`);
  }
  const { width, height } = getImageDimensions(buf, iconAbs);
  if (width !== height || width < 128) {
    throw new Error(`Icon must be square and at least 128x128 (got ${width}x${height}): ${iconAbs}`);
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return {
    path: `${relPath}/${iconRel}`,
    alt: `${manifest.name || manifest.id} icon`,
    sha256,
    width,
    height
  };
}

export function generateCatalog() {
  const commit = getGitHeadCommit();
  if (!existsSync(PLUGINS_DIR)) {
    console.error('Plugins directory not found:', PLUGINS_DIR);
    return;
  }

  const existingCatalogPath = join(ROOT_DIR, 'orca-catalog.json');
  let existingCatalog = null;
  if (existsSync(existingCatalogPath)) {
    try {
      existingCatalog = JSON.parse(readFileSync(existingCatalogPath, 'utf8'));
    } catch {}
  }

  const pluginEntries = [];
  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginFolder = join(PLUGINS_DIR, entry.name);
    const manifestPath = join(pluginFolder, 'orca-plugin.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const relPath = `plugins/${entry.name}`;
    assertPluginMatchesGit(pluginFolder, relPath);
    const treeHash = hashPluginTree(pluginFolder);
    const types = deriveCatalogTypes(manifest);
    const summary = deriveContributionSummary(manifest);
    const iconEntry = deriveIconCatalogEntry(manifest, pluginFolder, relPath);

    const publisher = manifest.publisher || 'manmonths';
    const qualifiedId = `${publisher}.${manifest.id}`;

    // Look up previous release commit if contentHash didn't change
    // （--repin：不沿用舊 commit，全部改指向目前 HEAD；內容沒變時 hash 也不會變）
    let releaseCommit = commit;
    if (!process.argv.includes('--repin') && existingCatalog?.plugins) {
      const prev = existingCatalog.plugins.find((p) => p.id === qualifiedId);
      if (prev?.releases?.[0] && prev.releases[0].contentHash === treeHash.hash) {
        releaseCommit = prev.releases[0].commit;
      }
    }

    pluginEntries.push({
      id: qualifiedId,
      source: {
        kind: 'git',
        url: 'https://github.com/fuevaco/manmonths.git',
        ref: 'main',
        path: relPath
      },
      description: manifest.description || '',
      categories: types.includes('interface-language') ? ['languages'] : ['tools'],
      releases: [
        {
          version: manifest.version,
          commit: releaseCommit,
          contentHash: treeHash.hash,
          execution: manifest.execution || 'data',
          minimumOrca: manifest.engines?.orca?.replace(/^>=/, '') || '1.4.0',
          ...(manifest.name ? { name: manifest.name } : {}),
          ...(types.length > 0 ? { types } : { types: ['interface-language'] }),
          ...(summary.length > 0 ? { contributes: summary } : {}),
          ...(iconEntry ? { images: { icon: iconEntry } } : {})
        }
      ]
    });

    console.log(`✓ Processed ${entry.name}: ${manifest.id} (v${manifest.version}, hash: ${treeHash.hash.slice(0, 12)}...)`);
  }

  const catalog = {
    catalogVersion: 2,
    name: '人月外掛庫',
    owner: 'manmonths',
    plugins: pluginEntries
  };

  writeFileSync(existingCatalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\nSuccessfully updated ${existingCatalogPath} with ${pluginEntries.length} plugin(s).`);
}

generateCatalog();
