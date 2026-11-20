#!/usr/bin/env node
// 把「一個放滿 skill 資料夾的目錄」轉成符合 Skills Registry API 標準 v1 的靜態檔案。
// 網店開發者可以直接拿它的輸出當作 API 回應（或對照它的格式實作自己的後端）。
//
// 用法：
//   node tools/build-registry.mjs <skills 資料夾> <輸出資料夾> [--default-version 1.0.0]
//
// 每個子資料夾是一個 skill，必須有 SKILL.md，frontmatter 需有 name、description；
// 可選 version、title、author、license、tags（逗號分隔）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SPEC_VERSION,
  NAME_RE,
  VERSION_RE,
  sha256Hex,
  computeDigest,
  parseSkillFrontmatter,
  listRunnableFiles,
  validateIndex,
  validateManifest,
  formatIssues
} from '../worker/spec.mjs';

const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git']);

async function collect(dir, prefix = '') {
  const out = [];
  for (const ent of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP.has(ent.name)) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await collect(abs, rel)));
    else if (ent.isFile()) out.push({ path: rel, abs });
  }
  return out;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * @returns {Promise<{ index: object, routes: Map<string, {body: Buffer, type: string}> }>}
 *   routes 的 key 是相對於 API 根的路徑，例如 "index.json"、"skills/foo/1.0.0/manifest.json"
 */
export async function buildRegistry(skillsDir, { defaultVersion = '1.0.0', registryName = '', now = new Date() } = {}) {
  const routes = new Map();
  const entries = [];
  const dirs = (await fs.readdir(skillsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  for (const d of dirs) {
    const root = path.join(skillsDir, d.name);
    const list = await collect(root);
    const skillMd = list.find((f) => f.path === 'SKILL.md');
    if (!skillMd) throw new Error(`${d.name}：缺少 SKILL.md`);
    const fm = parseSkillFrontmatter(await fs.readFile(skillMd.abs, 'utf8'));
    if (!fm?.name || !fm.description) throw new Error(`${d.name}/SKILL.md：frontmatter 需要 name 與 description`);
    if (fm.name !== d.name) throw new Error(`${d.name}：資料夾名稱必須與 SKILL.md 的 name「${fm.name}」相同`);
    if (!NAME_RE.test(fm.name)) throw new Error(`${d.name}：名稱必須是小寫英數與連字號`);
    const version = fm.version || defaultVersion;
    if (!VERSION_RE.test(version)) throw new Error(`${d.name}：版本「${version}」不是語意化版本`);

    const files = [];
    let newest = 0;
    for (const f of list) {
      const bytes = await fs.readFile(f.abs);
      const st = await fs.stat(f.abs);
      newest = Math.max(newest, st.mtimeMs);
      const executable = process.platform !== 'win32' && (st.mode & 0o111) !== 0;
      files.push({
        path: f.path,
        size: bytes.length,
        sha256: sha256Hex(bytes),
        url: `files/${encodePath(f.path)}`,
        ...(executable ? { executable: true } : {})
      });
      routes.set(`skills/${d.name}/${version}/files/${encodePath(f.path)}`, { body: bytes, type: 'application/octet-stream' });
    }

    const digest = computeDigest(files);
    const manifest = { specVersion: SPEC_VERSION, name: d.name, version, digest, files };
    const mv = validateManifest(manifest);
    if (!mv.ok) throw new Error(`${d.name}：產生的清單不合標準\n${formatIssues(mv.issues)}`);
    const manifestPath = `skills/${d.name}/${version}/manifest.json`;
    routes.set(manifestPath, { body: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), type: 'application/json' });

    entries.push({
      name: d.name,
      ...(fm.title ? { title: fm.title } : {}),
      description: fm.description,
      version,
      digest,
      manifestUrl: manifestPath,
      ...(fm.author ? { author: fm.author } : {}),
      ...(fm.license ? { license: fm.license } : {}),
      ...(fm.tags ? { tags: fm.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
      hasScripts: listRunnableFiles(files).length > 0,
      size: files.reduce((n, f) => n + f.size, 0),
      updatedAt: new Date(newest || now.getTime()).toISOString()
    });
  }

  const index = {
    specVersion: SPEC_VERSION,
    generatedAt: now.toISOString(),
    ...(registryName ? { name: registryName } : {}),
    skills: entries
  };
  const iv = validateIndex(index);
  if (!iv.ok) throw new Error(`產生的索引不合標準\n${formatIssues(iv.issues)}`);
  routes.set('index.json', { body: Buffer.from(JSON.stringify(index, null, 2) + '\n'), type: 'application/json' });
  return { index, routes };
}

async function main() {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (pos.length < 2) {
    console.log('用法：node tools/build-registry.mjs <skills 資料夾> <輸出資料夾> [--default-version 1.0.0] [--name 技能庫名稱]');
    process.exit(2);
  }
  const [skillsDir, outDir] = pos;
  const { index, routes } = await buildRegistry(path.resolve(skillsDir), {
    defaultVersion: opt('--default-version') || '1.0.0',
    registryName: opt('--name') || ''
  });
  for (const [rel, { body }] of routes) {
    const dest = path.join(outDir, ...rel.split('/').map(decodeURIComponent));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, body);
  }
  console.log(`已輸出 ${index.skills.length} 個 skill、${routes.size} 個檔案到 ${outDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
