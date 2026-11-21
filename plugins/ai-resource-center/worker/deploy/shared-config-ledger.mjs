// 同一 Apply 自己造成的節點變動不算外部修改；只容許完全相同的 rendered hash。
export function createSharedConfigLedger(rules) {
  const written = new Map();
  const key = m => `${rules.normalize(m.destinationPath)}#${m.ownedFieldPaths[0] ?? m.contentId}`;
  const semantics = m => JSON.stringify([m.mutationKind, m.change, m.willBackup, m.renderedSha256, m.before.sha256,
    m.before.treeSha256, m.before.state, rules.normalize(m.destinationPath)]);
  return {
    record(target) { for (const m of target.mutations) if (m.mutationKind === 'PatchConfig') written.set(key(m), m.renderedSha256); },
    explainsDifference(reviewed, fresh) {
      if (reviewed.targetKey !== fresh.targetKey || reviewed.hostProfileVersion !== fresh.hostProfileVersion || reviewed.mutations.length !== fresh.mutations.length || reviewed.problems.length !== fresh.problems.length) return false;
      let explained = false;
      for (const f of fresh.mutations) {
        const r = reviewed.mutations.find(m => m.contentId === f.contentId);
        if (!r) return false;
        if (semantics(r) === semantics(f)) continue;
        if (f.mutationKind !== 'PatchConfig' || r.mutationKind !== 'PatchConfig' || f.change !== 'NoOp' ||
          r.renderedSha256 !== f.renderedSha256 || rules.normalize(r.destinationPath) !== rules.normalize(f.destinationPath) || written.get(key(f)) !== f.renderedSha256) return false;
        explained = true;
      }
      const problems = t => t.problems.map(p => `${p.code}|${p.severity}|${p.contentId}`).sort().join('\n');
      return explained && problems(reviewed) === problems(fresh);
    }
  };
}
