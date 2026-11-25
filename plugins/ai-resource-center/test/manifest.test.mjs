// 外掛資訊與發布內容：識別、面板、能力宣告，以及公開內容沒有預設的內部網址。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'orca-plugin.json'), 'utf8'));

test('狀態列只宣告一個無點擊動作的項目；不帶文字與圖示，Orca 啟動時不顯示', () => {
  assert.equal(manifest.contributes.statusBarItems?.length, 1);
  const [item] = manifest.contributes.statusBarItems;
  assert.match(item.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(item.id.length <= 64);
  assert.ok(!['__proto__', 'prototype', 'constructor'].includes(item.id));
  assert.ok(Object.keys(item).every(k => ['id', 'text', 'icon', 'tone', 'tooltip'].includes(k)));
  // Orca 不畫沒有文字也沒有圖示的項目；圖示由 worker 顯示時才帶上。
  assert.equal(Object.hasOwn(item, 'icon'), false);
  assert.equal(item.text, '');
  assert.equal(Object.hasOwn(item, 'command'), false);
  assert.equal(typeof item.text, 'string');
  assert.ok(item.text.length <= 64);
  assert.ok(!item.tooltip || item.tooltip.length <= 256);
  assert.ok(!item.tone || ['neutral', 'accent', 'success', 'warning', 'danger'].includes(item.tone));
});

test('外掛說明以資源中心開頭、不含維護者名稱，保留市集與獨立登入，介紹一鍵安裝而不提供下載', () => {
  assert.match(manifest.description, /^AI 資源中心：/);
  // 中性寫法：發布內容不帶維護者或組織名稱（release-hygiene 也掃描整個資料夾）
  assert.doesNotMatch(manifest.description, /人月|維護/);
  assert.match(manifest.description, /有權使用的資源市集.*獨立登入/);
  assert.match(manifest.description, /一鍵安裝 Skills、Agents、MCP 與組合包到 Codex、Claude Code 與桌面工具/);
  assert.doesNotMatch(manifest.description, /下載/);
});

test('外掛識別、入口與右側欄面板「資源中心」', async () => {
  assert.equal(manifest.id, 'ai-resource-center');
  // publisher 已被 Orca 棄用（以儲存庫擁有者識別外掛），且這個外掛資料夾不放組織名稱，所以不宣告
  assert.equal(manifest.publisher, undefined);
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
          const docsRepository = (p === path.join(root, 'orca-plugin.json') && m[0] === manifest.repository)
            || (p === path.join(root, 'README.md') && m[0] === `${manifest.repository}.git`);
          if (!docsRepository && !allowed.test(m[0])) offenders.push(`${path.relative(root, p)}: ${m[0]}`);
        }
      }
    }
  }
  await walk(root);
  assert.deepEqual(offenders, []);
});
