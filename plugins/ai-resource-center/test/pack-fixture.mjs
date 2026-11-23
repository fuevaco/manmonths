import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export const skill = '---\nname: example\ndescription: 範例流程\n---\n依序完成工作。\r\n';
export const command = () => ({ commandId: 'prepare', name: '準備', runner: 'powershell', script: 'setup/install.ps1', payloads: ['payload'] });
export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-pack-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'source'), output = path.join(root, 'output');
  const write = async (name, bytes) => { const file = path.join(folder, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  const manifest = { packageFormatVersion: 1, key: 'example.test', name: '測試資源包', version: '1.2.3', description: '合成測試資料', type: 'bundle', contents: [{ id: 'example', kind: 'skill', path: 'skills/example' }] };
  const save = () => write('lcpack.json', JSON.stringify(manifest));
  await save(); await write('README.md', '# 說明\r\n'); await write('skills/example/SKILL.md', skill);
  return { root, folder, output, manifest, write, save };
}
