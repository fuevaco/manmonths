#!/usr/bin/env node
// 驗證一個 Skills Registry API 是否符合標準 v1。
//
//   node tools/verify-api.mjs <API 網址> [--token <token>] [--require-auth] [--insecure-tls]
//                             [--allow-http] [--max-skills 50] [--json]
//
// Token 也可用環境變數 SKILLS_TOKEN 傳入（避免留在 shell 歷史紀錄）。
// 結束碼：0 全部通過（可能有建議事項）、1 有不符合標準的項目、2 用法錯誤。

import { verifyApi } from '../worker/conformance.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const baseUrl = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] || '').match(/^--(token|max-skills)$/));

if (!baseUrl) {
  console.log('用法：node tools/verify-api.mjs <API 網址> [--token <token>] [--require-auth] [--insecure-tls] [--allow-http] [--max-skills 50] [--json]');
  process.exit(2);
}

const ICON = { pass: '✓', fail: '✗', warn: '!', skip: '-' };
const report = await verifyApi(
  {
    baseUrl,
    token: opt('--token') || process.env.SKILLS_TOKEN || '',
    insecureTls: flag('--insecure-tls'),
    allowHttp: flag('--allow-http')
  },
  {
    requireAuth: flag('--require-auth'),
    maxSkills: Number(opt('--max-skills')) || 50,
    onProgress: flag('--json')
      ? undefined
      : (c) => {
          console.log(`${ICON[c.status]} ${c.title}`);
          if (c.detail && c.status !== 'pass') console.log(c.detail.split('\n').map((l) => `    ${l}`).join('\n'));
          else if (c.detail) console.log(`    ${c.detail}`);
        }
  }
);

if (flag('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const s = report.summary;
  console.log(`\n${report.ok ? '符合標準 v1' : '不符合標準 v1'}：通過 ${s.pass}、失敗 ${s.fail}、建議 ${s.warn}、略過 ${s.skip}`);
}
process.exit(report.ok ? 0 : 1);
