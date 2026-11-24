// 把 src/*/main.js 打包成 editor/dist/*.js（單一檔案、離線可用，沒有任何外部載入）。
// 用法：node build.mjs [--watch]
//
// 為什麼要把打包結果也 commit：Orca 安裝外掛時只抓 Git 裡的檔案，使用者端不會跑 npm / esbuild。

import { build, context } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchThirdParty } from './patches.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const entries = {
  word: 'src/word/main.js',
  excel: 'src/excel/main.js',
  ppt: 'src/ppt/main.js'
};

const options = {
  entryPoints: Object.fromEntries(
    Object.entries(entries)
      .filter(([, file]) => existsSync(join(ROOT, file)))
      .map(([name, file]) => [name, join(ROOT, file)])
  ),
  outdir: join(ROOT, 'editor', 'dist'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  legalComments: 'none', // 授權文字改由 THIRD-PARTY-LICENSES.txt 統一附上
  logLevel: 'info',
  plugins: [patchThirdParty],
  // 這些套件在瀏覽器裡用不到 Node 內建模組
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' }
};

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license'];

/** 收集打包進來的第三方套件授權（Apache-2.0 / MIT / ISC 都要求保留授權聲明）。 */
function writeLicenses() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const names = new Set(Object.keys(pkg.dependencies || {}));
  // 連同傳遞性相依一起列出（排除只在建置時用的 esbuild）
  for (const key of Object.keys(lock.packages || {})) {
    if (!key.startsWith('node_modules/')) continue;
    const info = lock.packages[key];
    if (info.dev || info.devOptional) continue;
    names.add(key.replace(/^node_modules\//, ''));
  }

  const parts = [
    '本外掛打包了下列第三方開源套件，各套件的授權聲明如下。',
    '（此檔由 build.mjs 自動產生，請勿手動修改。）\n'
  ];
  for (const name of [...names].sort()) {
    const dir = join(ROOT, 'node_modules', name);
    const meta = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
    const licenseFile = readdirSync(dir).find((f) => LICENSE_FILES.includes(f)) ?? readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    parts.push('='.repeat(78));
    parts.push(`${name}@${meta.version ?? '?'}  (${typeof meta.license === 'string' ? meta.license : JSON.stringify(meta.license ?? 'unknown')})`);
    if (meta.repository) parts.push(typeof meta.repository === 'string' ? meta.repository : meta.repository.url ?? '');
    parts.push('='.repeat(78));
    parts.push(licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').replace(/\r\n/g, '\n').trim() : '（此套件未附授權檔案，授權見上方 package.json 的 license 欄位）');
    parts.push('');
  }
  writeFileSync(join(ROOT, 'THIRD-PARTY-LICENSES.txt'), parts.join('\n') + '\n', 'utf8');
}

mkdirSync(options.outdir, { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  const result = await build({ ...options, metafile: true });
  for (const [file, info] of Object.entries(result.metafile.outputs)) {
    console.log(`${file}  ${(info.bytes / 1024).toFixed(0)} KB`);
  }
  writeLicenses();
}
