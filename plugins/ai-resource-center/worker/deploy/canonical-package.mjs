// 已驗證的 canonical 資源包（對照 LcAiPack.Core Deployment/CanonicalPackage.cs、
// Contract/FrontmatterParser.cs、SkillFrontmatterContract.cs）。讀取階段完全不寫入部署目標。
import { ofBytes, ordinal } from './digest.mjs';
import { ErrorCode } from '../contract.mjs';
import { readPackageZip } from '../package-validator.mjs';
import { parseManifest, validateManifest } from '../manifest-validator.mjs';
import { ProblemCodes } from './problems.mjs';

export class CanonicalPackageError extends Error {
  constructor(code, message, details = []) { super(message); this.name = 'CanonicalPackageError'; this.code = code; this.details = details; }
  toProblem() {
    return { code: this.code, severity: 'Blocking', summary: this.message, explanation: this.details.length ? this.details.join('\n') : this.message, resolutions: [] };
  }
}

// ---------- frontmatter（平面 key: value，支援 | 與 > 區塊純量） ----------
export function splitFrontmatter(markdown) {
  const text = (markdown ?? '').replaceAll('\r\n', '\n').replace(/^﻿+/, '');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const frontmatter = text.slice(4, end + 1);
  const afterMarker = text.indexOf('\n', end + 1);
  return { frontmatter, body: afterMarker < 0 ? '' : text.slice(afterMarker + 1).trim() };
}

const isWhite = (ch) => /\s/.test(ch);
export function parseFrontmatter(frontmatter) {
  const keys = [], fields = new Map(), duplicateKeys = [], unparsableLines = [];
  const lines = (frontmatter ?? '').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trimEnd();
    if (!line.length || line.trimStart().startsWith('#')) continue;
    if (isWhite(line[0]) || line.trimStart().startsWith('- ')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) { unparsableLines.push(line); continue; }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    let value;
    if (rawValue === '|' || rawValue === '>') {
      const continuation = [];
      let j = index + 1;
      for (; j < lines.length; j++) {
        const c = lines[j];
        if (!c.length) { continuation.push(''); continue; }
        if (!isWhite(c[0])) break;
        continuation.push(c.trim());
      }
      index = j - 1;
      const joined = continuation.join(' ').trim();
      value = joined.length ? joined : null;
    } else {
      const trimmed = rawValue.replace(/^["']+|["']+$/g, '');
      value = trimmed.length ? trimmed : null;
    }
    keys.push(key);
    if (fields.has(key)) duplicateKeys.push(key); else fields.set(key, value);
  }
  return { keys, fields, duplicateKeys, unparsableLines };
}

const REQUIRED_KEYS = new Set(['name', 'description']);
const EXTENDED_KEYS = new Set(['license', 'compatibility', 'metadata', 'allowed-tools', 'disable-model-invocation', 'argument-hint']);

/** SKILL.md portable profile 檢查（SkillFrontmatterContract.Inspect）。 */
export function inspectSkill(markdown) {
  const split = splitFrontmatter(markdown);
  if (!split) return { errors: ['SKILL.md 必須以 --- 包夾的 YAML frontmatter 開頭'], name: null, description: null, nonStandardKeys: [] };
  const parsed = parseFrontmatter(split.frontmatter);
  const errors = [];
  for (const line of parsed.unparsableLines) errors.push(`SKILL.md frontmatter 無法解析：${line}`);
  for (const key of parsed.duplicateKeys) errors.push(`SKILL.md frontmatter 欄位重複：${key}`);
  const name = parsed.fields.get('name') ?? null, description = parsed.fields.get('description') ?? null;
  if (!name || !name.trim()) errors.push('SKILL.md frontmatter 缺少有效的 name');
  if (!description || !description.trim()) errors.push('SKILL.md frontmatter 缺少有效的 description');
  if (!split.body.trim()) errors.push('SKILL.md 的流程 body 不可為空');
  const nonStandardKeys = [...new Set(parsed.fields.keys())].filter(k => !REQUIRED_KEYS.has(k) && !EXTENDED_KEYS.has(k)).sort(ordinal);
  return { errors, name, description, nonStandardKeys };
}

const normalize = (p) => p.replaceAll('\\', '/').replace(/^\/+/, '');

/**
 * 開啟並驗證資源包。
 * @param {{bytes: Buffer, expectedSha256: string}} artifact
 */
export function openCanonicalPackage(artifact) {
  const actual = ofBytes(artifact.bytes);
  if (typeof artifact.expectedSha256 !== 'string' || actual !== artifact.expectedSha256.toLowerCase()) {
    throw new CanonicalPackageError(ProblemCodes.sourceChanged, `資源包 SHA256 與預期不符（預期 ${artifact.expectedSha256}，實際 ${actual}）`);
  }
  let files;
  try { files = readPackageZip(artifact.bytes); } catch (e) {
    throw new CanonicalPackageError(e.code === ErrorCode.unsafePath ? ProblemCodes.pathEscape : ProblemCodes.invalidPackage, e.message);
  }
  const entries = new Map([...files].filter(([name]) => !name.endsWith('/')));
  if (!entries.has('README.md')) throw new CanonicalPackageError(ProblemCodes.invalidPackage, '資源包根目錄必須包含大寫 README.md');
  if (!entries.has('lcpack.json')) throw new CanonicalPackageError(ProblemCodes.invalidPackage, '資源包根目錄缺少 lcpack.json');
  let manifest;
  try { manifest = parseManifest(entries.get('lcpack.json').toString('utf8')); } catch (e) {
    throw new CanonicalPackageError(ProblemCodes.invalidPackage, `lcpack.json 不是有效的 JSON：${e.message}`);
  }
  try { validateManifest(manifest); } catch (e) { throw new CanonicalPackageError(ProblemCodes.invalidPackage, 'lcpack.json 驗證失敗', [e.message]); }

  const contents = [], errors = [];
  for (const c of manifest.contents) {
    let name = c.name ?? null, description = c.description ?? null, nonStandardFrontmatterKeys = [], ignoredFrontmatterKeys = [];
    if (c.kind !== 'mcp') {
      const p = normalize(c.path);
      if (c.kind === 'skill') {
        const prefix = p.replace(/\/+$/, '') + '/';
        if (![...entries.keys()].some(n => n.startsWith(prefix))) errors.push(`contents '${c.id}' 宣告的 Skill 目錄不存在於 zip：${c.path}`);
        else if (!entries.has(prefix + 'SKILL.md')) errors.push(`contents '${c.id}' 的 Skill 目錄缺少 SKILL.md`);
        else {
          const profile = inspectSkill(entries.get(prefix + 'SKILL.md').toString('utf8'));
          errors.push(...profile.errors.map(err => `contents '${c.id}'：${err}`));
          name ??= profile.name; description ??= profile.description;
          nonStandardFrontmatterKeys = profile.nonStandardKeys;
        }
      } else if (!entries.has(p)) errors.push(`contents '${c.id}' 宣告的來源不存在於 zip：${c.path}`);
      else if (c.kind === 'agent') {
        const split = splitFrontmatter(entries.get(p).toString('utf8'));
        if (split) {
          const parsed = parseFrontmatter(split.frontmatter);
          name ??= parsed.fields.get('name');
          description = parsed.fields.get('description') ?? description ?? c.name ?? null;
          ignoredFrontmatterKeys = [...parsed.fields.keys()].filter(k => !REQUIRED_KEYS.has(k)).sort(ordinal);
        } else description ??= c.name ?? null;
      }
    }
    contents.push(Object.freeze({ id: c.id, kind: c.kind, name: name ?? c.id, description, sourcePath: c.kind === 'mcp' ? null : normalize(c.path),
      definition: c.definition ?? null, hostOverrides: c.hosts ?? {}, ignoredFrontmatterKeys, nonStandardFrontmatterKeys }));
  }
  if (errors.length) throw new CanonicalPackageError(ProblemCodes.invalidPackage, errors[0], errors);
  contents.sort((a, b) => ordinal(a.id, b.id));

  return Object.freeze({
    identity: Object.freeze({ key: manifest.key, version: manifest.version, type: manifest.type, name: manifest.name }),
    sha256: actual, manifest, contents,
    readFile(relativePath) {
      const data = entries.get(normalize(relativePath));
      if (!data) throw new CanonicalPackageError(ProblemCodes.invalidPackage, `zip 內找不到宣告的來源：${relativePath}`);
      return data;
    },
    /** 讀取某目錄的整棵檔案，依相對路徑排序。 */
    readTree(relativeDirectory) {
      const prefix = normalize(relativeDirectory).replace(/\/+$/, '') + '/';
      const tree = [...entries].filter(([n]) => n.startsWith(prefix)).map(([n, content]) => ({ relativePath: n.slice(prefix.length), content }))
        .sort((a, b) => ordinal(a.relativePath, b.relativePath));
      if (!tree.length) throw new CanonicalPackageError(ProblemCodes.invalidPackage, `zip 內找不到宣告的來源目錄：${relativeDirectory}`);
      return tree;
    }
  });
}
