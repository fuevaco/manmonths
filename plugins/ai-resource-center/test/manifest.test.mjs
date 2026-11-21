// 外掛資訊與發布內容：識別、面板、能力宣告，以及公開內容沒有預設的內部網址。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'orca-plugin.json'), 'utf8'));

test('外掛說明保留人月、市集與獨立登入，介紹一鍵安裝而不提供下載', () => {
  assert.match(manifest.description, /^人月維護/);
  assert.match(manifest.description, /有權使用的資源市集.*獨立登入/);
  assert.match(manifest.description, /一鍵安裝 Skills、Agents、MCP 與組合包到 Codex、Claude Code 與桌面工具/);
  assert.doesNotMatch(manifest.description, /下載/);
});

test('外掛識別、入口與右側欄面板「資源中心」', async () => {
  assert.equal(manifest.id, 'ai-resource-center');
  assert.equal(manifest.publisher, 'manmonths');
  assert.equal(manifest.execution, 'trusted-worker');
  assert.equal(manifest.main, 'worker/index.mjs');
  const [panel] = manifest.contributes.panels;
  assert.equal(panel.id, 'ai-resource-center');
  assert.equal(panel.title, '資源中心');
  await fs.access(path.join(root, panel.entry));
  await fs.access(path.join(root, manifest.main));
  await fs.access(path.join(root, manifest.icon));
});

test('市集網址設定預設為空，憑證不放在設定中', () => {
  const setting = manifest.contributes.settings.find((s) => s.key === 'marketUrl');
  assert.equal(setting.default, '');
  assert.equal(manifest.contributes.settings.some((s) => /token|password|secret/i.test(s.key)), false);
  const kinds = manifest.capabilities.map((c) => c.kind);
  assert.ok(kinds.includes('secrets:own'));
  assert.ok(kinds.includes('settings:own'));
});

test('外掛內容沒有預設的市集或內部網址', async () => {
  const allowed = /^https?:\/\/(market\.example(\.com)?|[a-z.]*\.example|127\.0\.0\.1|localhost|github\.com\/fuevaco|www\.w3\.org|tools\.ietf\.org|httpstatuses\.io)\b/i;
  const offenders = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(mjs|js|json|html|css|md)$/.test(e.name)) {
        const text = await fs.readFile(p, 'utf8');
        for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
          if (!allowed.test(m[0])) offenders.push(`${path.relative(root, p)}: ${m[0]}`);
        }
      }
    }
  }
  await walk(root);
  assert.deepEqual(offenders, []);
});
