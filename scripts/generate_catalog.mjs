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

function getPluginLastCommit(relPath) {
  try {
    const sha = execSync(`git log -1 --format=%H HEAD -- ${relPath}`, { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch {}
  return getGitHeadCommit();
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
  if (c.statusBarItems) {
    for (const item of c.statusBarItems) {
      items.push({ kind: 'statusBarItems', name: item.text || item.id });
    }
  }
  return items;
}

function deriveCapabilities(manifest) {
  const caps = [];
  for (const item of manifest.capabilities || []) {
    if (item && typeof item.kind === 'string' && !caps.includes(item.kind)) {
      caps.push(item.kind);
    }
  }
  return caps;
}

function deriveFileTypes(manifest) {
  const c = manifest.contributes || {};
  const fileTypes = [];
  const editorFileTypes = [];
  const norm = (ext) => (typeof ext === 'string' ? ext.replace(/^\./, '').toLowerCase() : '');
  const valid = (ext) => /^[a-z0-9][a-z0-9+_-]{0,15}$/.test(ext);
  for (const s of c.syntaxes || []) {
    for (const raw of s.extensions || []) {
      const ext = norm(raw);
      if (valid(ext) && !fileTypes.includes(ext)) fileTypes.push(ext);
    }
  }
  for (const ed of c.customEditors || []) {
    for (const raw of ed.extensions || []) {
      const ext = norm(raw);
      if (valid(ext)) {
        if (!fileTypes.includes(ext)) fileTypes.push(ext);
        if (!editorFileTypes.includes(ext)) editorFileTypes.push(ext);
      }
    }
  }
  return { fileTypes, editorFileTypes };
}

function getImageDimensions(buf, filePath) {
  // PNG: 8-byte signature + IHDR chunk (width at 16..20, height at 20..24)
  if (
    buf.length >= 24 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    buf.readUInt32BE(8) === 13 &&
    buf.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WEBP: RIFF....WEBP
  if (buf.length >= 25 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width, height };
    }
    if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  // JPEG segments include their two-byte length. Only SOF markers carry dimensions;
  // C4 (DHT), C8 (JPG), and CC (DAC) are not SOF markers.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset < buf.length) {
      if (buf[offset++] !== 0xff) break;
      while (offset < buf.length && buf[offset] === 0xff) offset++;
      if (offset >= buf.length) break;
      const marker = buf[offset++];
      if (marker === 0xda || marker === 0xd9 || marker === 0x00) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buf.length) break;
      const length = buf.readUInt16BE(offset);
      if (length < 2 || offset + length > buf.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8) break;
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        const components = buf[offset + 7];
        if (!width || !height || !components || length !== 8 + 3 * components) break;
        return { width, height };
      }
      offset += length;
    }
  }
  throw new Error(`Unsupported or invalid image format (expected PNG, WEBP or JPEG): ${filePath}`);
}

function derivePromotionalImages(manifest, pluginFolder, relPath) {
  // 取自外掛 manifest（manifestVersion 2）的 cover 與 screenshots，與 Orca 外掛頁面使用同一份宣告。
  function imageEntry(declared, kind, maxBytes, minWidth, minHeight) {
    if (!declared || typeof declared.path !== 'string' || typeof declared.alt !== 'string' || !declared.alt.trim()) {
      throw new Error(`${kind} image in ${relPath}/orca-plugin.json requires string path and alt`);
    }
    const file = declared.path.replace(/\\/g, '/');
    const absolute = join(pluginFolder, file);
    if (!existsSync(absolute)) throw new Error(`${kind} image not found: ${absolute}`);
    const buf = readFileSync(absolute);
    if (buf.length > maxBytes) {
      throw new Error(`${kind} image exceeds ${maxBytes} bytes limit (${buf.length} bytes): ${absolute}`);
    }
    const { width, height } = getImageDimensions(buf, absolute);
    if (width < minWidth || height < minHeight) {
      throw new Error(`${kind} image must be at least ${minWidth}x${minHeight} (got ${width}x${height}): ${absolute}`);
    }
    return {
      path: `${relPath}/${file}`,
      alt: declared.alt,
      sha256: createHash('sha256').update(buf).digest('hex'),
      width,
      height
    };
  }
  const images = {};
  if (manifest.cover) images.cover = imageEntry(manifest.cover, 'Cover', 1048576, 800, 500);
  const screenshots = manifest.screenshots ?? [];
  if (!Array.isArray(screenshots) || screenshots.length > 6) {
    throw new Error(`screenshots in ${relPath}/orca-plugin.json must be an array of at most 6 items`);
  }
  if (screenshots.length) {
    images.screenshots = screenshots.map((item) => imageEntry(item, 'Screenshot', 1572864, 1280, 800));
  }
  return images;
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
    // 與 Orca 官方 `orca plugin release-entry` 一致：圖示的 alt 就是外掛名稱（不加 " icon"）
    alt: manifest.name || manifest.id,
    sha256,
    width,
    height
  };
}

export function generateCatalog() {
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
    const capabilities = deriveCapabilities(manifest);
    const { fileTypes, editorFileTypes } = deriveFileTypes(manifest);
    const iconEntry = deriveIconCatalogEntry(manifest, pluginFolder, relPath);
    const images = {
      ...(iconEntry ? { icon: iconEntry } : {}),
      ...derivePromotionalImages(manifest, pluginFolder, relPath)
    };

    const publisher = manifest.publisher || 'linkchain-corp';
    const qualifiedId = `${publisher}.${manifest.id}`;

    // 預設釘選在「最後一次修改該外掛目錄」的 commit；若 contentHash 沒變且未帶 --repin，沿用既有記錄的 commit。
    const pluginCommit = getPluginLastCommit(relPath);
    let releaseCommit = pluginCommit;
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
        url: 'https://github.com/linkchain-corp/manmonths.git',
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
          ...(capabilities.length > 0 ? { capabilities } : {}),
          ...(fileTypes.length > 0 ? { fileTypes } : {}),
          ...(editorFileTypes.length > 0 ? { editorFileTypes } : {}),
          ...(Object.keys(images).length ? { images } : {})
        }
      ]
    });

    console.log(`✓ Processed ${entry.name}: ${manifest.id} (v${manifest.version}, hash: ${treeHash.hash.slice(0, 12)}...)`);
  }

  const catalog = {
    catalogVersion: 2,
    name: '人月外掛庫',
    owner: 'linkchain-corp',
    plugins: pluginEntries
  };

  writeFileSync(existingCatalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\nSuccessfully updated ${existingCatalogPath} with ${pluginEntries.length} plugin(s).`);
}

generateCatalog();
