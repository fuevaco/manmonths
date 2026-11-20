import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSafePath, computeDigest, compareVersions, validateIndex, validateManifest,
  sha256Hex, isRunnableFile, parseSkillFrontmatter
} from '../worker/spec.mjs';

const file = (p, content = p) => ({ path: p, size: Buffer.byteLength(content), sha256: sha256Hex(content), url: `files/${p}` });
const goodManifest = () => {
  const files = [file('SKILL.md'), file('ref/a.md')];
  return { specVersion: 1, name: 'demo', version: '1.0.0', digest: computeDigest(files), files };
};

test('checkSafePath 拒絕跳出資料夾與 Windows 不合法路徑', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', 'C:/x', 'a/./b', '.git/config', 'a/.git/x',
    'con', 'a/NUL.txt', 'a/b.', 'a/b ', 'a/b?c', 'x\u0000y']) {
    assert.ok(checkSafePath(bad), `應拒絕：${JSON.stringify(bad)}`);
  }
  for (const good of ['SKILL.md', 'scripts/run.sh', 'ref/深度.md', 'a-b/c_d.e.txt', '.hidden/ok']) {
    assert.equal(checkSafePath(good), null, `應接受：${good}`);
  }
});

test('computeDigest 與順序無關，且路徑或內容改變就不同', () => {
  const a = [file('a'), file('b')];
  assert.equal(computeDigest(a), computeDigest([...a].reverse()));
  assert.notEqual(computeDigest(a), computeDigest([file('a'), file('c')]));
  assert.notEqual(computeDigest(a), computeDigest([file('a', 'x'), file('b')]));
  assert.match(computeDigest(a), /^sha256:[0-9a-f]{64}$/);
});

test('computeDigest 的排序是 UTF-8 位元組順序（與 Python 的碼點排序一致）', () => {
  // U+FF5E（全形～，BMP）與 U+1F600（😀，補充平面）：UTF-16 順序會把 😀 排前面，UTF-8 / 碼點順序則排後面
  const files = [file('\u{1F600}.md'), file('～.md'), file('a.md')];
  const manual = [...files].sort((a, b) => [...a.path][0].codePointAt(0) - [...b.path][0].codePointAt(0));
  assert.deepEqual(manual.map((f) => f.path), ['a.md', '～.md', '\u{1F600}.md']);
  const expected = `sha256:${sha256Hex(manual.map((f) => `${f.path}\0${f.sha256}\n`).join(''))}`;
  assert.equal(computeDigest(files), expected);
});

test('compareVersions 依 semver 排序', () => {
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0+build5'), 0);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
});

test('isRunnableFile：看副檔名與 executable 旗標', () => {
  assert.ok(isRunnableFile({ path: 'scripts/x.sh' }));
  assert.ok(isRunnableFile({ path: 'bin/tool.EXE' }));
  assert.ok(isRunnableFile({ path: 'run', executable: true }));
  assert.ok(!isRunnableFile({ path: 'SKILL.md' }));
  assert.ok(!isRunnableFile({ path: 'data.json' }));
});

test('parseSkillFrontmatter', () => {
  assert.deepEqual(parseSkillFrontmatter('---\nname: a\ndescription: "b c"\n---\nbody'), { name: 'a', description: 'b c' });
  assert.equal(parseSkillFrontmatter('no frontmatter'), null);
  assert.equal(parseSkillFrontmatter('\uFEFF---\nname: z\n---\n').name, 'z');
});

test('validateIndex：合法索引通過', () => {
  const m = goodManifest();
  const r = validateIndex({
    specVersion: 1,
    skills: [{ name: 'demo', description: 'd', version: '1.0.0', digest: m.digest, manifestUrl: 'skills/demo/1.0.0/manifest.json' }]
  });
  assert.ok(r.ok, JSON.stringify(r.issues));
});

test('validateIndex：各種錯誤都被抓到', () => {
  const entry = { name: 'demo', description: 'd', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, manifestUrl: 'm.json' };
  const cases = {
    '版本不對': { specVersion: 2, skills: [] },
    'skills 不是陣列': { specVersion: 1, skills: {} },
    '名稱含大寫': { specVersion: 1, skills: [{ ...entry, name: 'Demo' }] },
    '名稱重複': { specVersion: 1, skills: [entry, entry] },
    '版本不是 semver': { specVersion: 1, skills: [{ ...entry, version: 'latest' }] },
    'digest 格式': { specVersion: 1, skills: [{ ...entry, digest: 'abc' }] },
    '缺 description': { specVersion: 1, skills: [{ ...entry, description: '' }] },
    '缺 manifestUrl': { specVersion: 1, skills: [{ ...entry, manifestUrl: undefined }] },
    'tags 型別': { specVersion: 1, skills: [{ ...entry, tags: [1] }] }
  };
  for (const [label, doc] of Object.entries(cases)) {
    assert.equal(validateIndex(doc).ok, false, label);
  }
  assert.equal(validateIndex(null).ok, false);
  assert.equal(validateIndex([]).ok, false);
});

test('validateManifest：合法通過、與索引不一致被抓到', () => {
  const m = goodManifest();
  assert.ok(validateManifest(m, { name: 'demo', version: '1.0.0', digest: m.digest }).ok);
  assert.equal(validateManifest(m, { version: '9.9.9' }).ok, false);
});

test('validateManifest：摘要被改、檔案被換、路徑危險都不通過', () => {
  const m = goodManifest();
  assert.equal(validateManifest({ ...m, digest: `sha256:${'0'.repeat(64)}` }).ok, false, '摘要不符');
  const swapped = { ...m, files: [file('SKILL.md', 'evil'), m.files[1]] };
  assert.equal(validateManifest(swapped).ok, false, '檔案內容換掉但摘要沒改');
  for (const p of ['../escape', '/abs', 'a\\b', 'a/../../b']) {
    const files = [file('SKILL.md'), file(p)];
    assert.equal(validateManifest({ ...m, files, digest: computeDigest(files) }).ok, false, p);
  }
  const noSkill = [file('README.md')];
  assert.equal(validateManifest({ ...m, files: noSkill, digest: computeDigest(noSkill) }).ok, false, '沒有 SKILL.md');
  const dup = [file('SKILL.md'), file('A.md'), file('a.md')];
  assert.equal(validateManifest({ ...m, files: dup, digest: computeDigest(dup) }).ok, false, '大小寫重複');
  const big = [file('SKILL.md'), { ...file('big.bin'), size: 6 * 1024 * 1024 }];
  assert.equal(validateManifest({ ...m, files: big, digest: computeDigest(big) }).ok, false, '單檔過大');
});
