// 同步目標：全域（家目錄）或 Orca 的各個專案。
//
// 專案的每個 Git 工作樹（worktree）都是獨立的資料夾，主 repo 的 .agents/skills 不會出現在
// 其他工作樹裡，所以選一個專案＝寫入該專案的專案根目錄 + 它底下所有本機工作區。
// 只處理本機路徑；SSH / 遠端執行環境的專案只列出、不寫入。

import os from 'node:os';
import path from 'node:path';

export const GLOBAL_KEY = 'global';

const isLocalHost = (hostId) => !hostId || hostId === 'local';
const normKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

export async function listTargets(orca) {
  const [projRes, wsRes] = await Promise.all([
    orca.host.call('project.list').catch(() => ({ projects: [] })),
    orca.host.call('workspace.list').catch(() => ({ workspaces: [] }))
  ]);
  const workspaces = wsRes?.workspaces || [];
  const projects = [];
  const remote = [];
  for (const p of projRes?.projects || []) {
    if (p.hidden) continue;
    if (!isLocalHost(p.hostId)) {
      remote.push({ id: p.id, name: p.name, hostId: p.hostId });
      continue;
    }
    const own = workspaces.filter((w) => w.projectId === p.id && isLocalHost(w.hostId) && w.path);
    const paths = new Map();
    if (p.path) paths.set(normKey(p.path), p.path);
    for (const w of own) paths.set(normKey(w.path), w.path);
    projects.push({
      id: p.id,
      name: p.name,
      kind: p.kind,
      paths: [...paths.values()],
      workspaces: own.map((w) => ({ id: w.id, name: w.name, branch: w.branch, path: w.path }))
    });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return { global: { key: GLOBAL_KEY, path: os.homedir() }, projects, remote };
}

// selection: { global: boolean, projectIds: string[] } → [{ key, label, base }]
export function resolveBases(targets, selection) {
  const bases = [];
  if (selection?.global) bases.push({ key: GLOBAL_KEY, label: '全域（所有專案）', base: targets.global.path });
  const ids = new Set(selection?.projectIds || []);
  const seen = new Set(bases.map((b) => normKey(b.base)));
  for (const p of targets.projects) {
    if (!ids.has(p.id)) continue;
    for (const dir of p.paths) {
      const k = normKey(dir);
      if (seen.has(k)) continue;
      seen.add(k);
      bases.push({ key: dir, label: `${p.name}（${path.basename(dir)}）`, base: dir, projectId: p.id });
    }
  }
  return bases;
}
