// 模擬 Azure DevOps / TFS REST API，供測試工項查詢使用（只實作面板會呼叫到的端點）。
// 刻意貼近真實行為：WIQL 只回傳 id、依 $top 截斷；工項批次端點一次最多 200 筆。

import http from 'node:http';

export const COLLECTION = '/tfs/DefaultCollection';
export const STATES = ['已提議', '作用中', '已解決', '已關閉'];

// 產生測試資料：id 越大越新（ChangedDate 越近）
export function makeItems({ perProject = { ProjA: 200, ProjB: 120, ProjC: 30 } } = {}) {
  const items = [];
  let id = 1000;
  for (const [project, n] of Object.entries(perProject)) {
    for (let i = 0; i < n; i++) {
      id++;
      items.push({
        id,
        project,
        type: id % 3 === 0 ? 'Bug' : 'Task',
        state: STATES[id % STATES.length],
        title: `工項 ${id} ${project}`
      });
    }
  }
  // 依 ChangedDate 由新到舊（這裡以 id 代表時間先後，且讓各專案交錯）
  items.sort((a, b) => ((b.id * 7919) % 10007) - ((a.id * 7919) % 10007));
  items.forEach((it, i) => { it.changed = new Date(Date.UTC(2026, 10, 20) - i * 60000).toISOString(); });
  return items;
}

const parseList = (s) => [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));

function applyQuery(items, query) {
  let out = items;
  const proj = /\[System\.TeamProject\] = '((?:[^']|'')*)'/.exec(query);
  if (proj) out = out.filter((i) => i.project === proj[1].replace(/''/g, "'"));
  const typeEq = /\[System\.WorkItemType\] = '(\w+)'/.exec(query);
  const typeIn = /\[System\.WorkItemType\] IN \(([^)]*)\)/.exec(query);
  if (typeEq) out = out.filter((i) => i.type === typeEq[1]);
  else if (typeIn) out = out.filter((i) => parseList(typeIn[1]).includes(i.type));
  const notIn = /\[System\.State\] NOT IN \(([^)]*)\)/.exec(query);
  if (notIn) out = out.filter((i) => !parseList(notIn[1]).includes(i.state));
  const stIn = /AND \[System\.State\] IN \(([^)]*)\)/.exec(query);
  const stEq = /AND \[System\.State\] = '((?:[^']|'')*)'/.exec(query);
  if (stIn) out = out.filter((i) => parseList(stIn[1]).includes(i.state));
  else if (stEq) out = out.filter((i) => i.state === stEq[1].replace(/''/g, "'"));
  const title = /\[System\.Title\] CONTAINS '((?:[^']|'')*)'/.exec(query);
  if (title) out = out.filter((i) => i.title.includes(title[1].replace(/''/g, "'")));
  return out.slice().sort((a, b) => (a.changed < b.changed ? 1 : -1));
}

export async function startMockTfs({ items = makeItems(), onRequest } = {}) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    log.push({ method: req.method, path: url.pathname, search: url.search, body });
    onRequest?.(req, url);
    const json = (status, obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length });
      res.end(b);
    };
    const p = url.pathname.replace(COLLECTION, '');

    if (p === '/_apis/projects') {
      const names = [...new Set(items.map((i) => i.project))];
      return json(200, { value: names.map((n) => ({ id: `id-${n}`, name: n, description: `${n} 專案說明` })) });
    }
    if (/\/_apis\/wit\/workitemtypes\/\w+\/states$/.test(p)) {
      return json(200, { value: STATES.map((name) => ({ name })) });
    }
    if (/\/_apis\/wit\/wiql$/.test(p) && req.method === 'POST') {
      const { query } = JSON.parse(body);
      let rows = applyQuery(items, query);
      const top = Number(url.searchParams.get('$top'));
      // 真實伺服器：超過 20000 筆的查詢會失敗；有 $top 就截斷
      if (!top && rows.length > 20000) return json(400, { message: 'VS402337: 查詢超過 20000 筆上限' });
      if (top) rows = rows.slice(0, top);
      return json(200, { workItems: rows.map((r) => ({ id: r.id })) });
    }
    const single = /^\/_apis\/wit\/workitems\/(\d+)$/.exec(p);
    if (single) {
      const it = items.find((i) => i.id === Number(single[1]));
      if (!it) return json(404, { message: 'TF401232: 找不到工項' });
      return json(200, {
        id: it.id,
        rev: 1,
        fields: {
          'System.Id': it.id, 'System.TeamProject': it.project, 'System.Title': it.title,
          'System.WorkItemType': it.type, 'System.State': it.state, 'System.ChangedDate': it.changed
        }
      });
    }
    if (p === '/_apis/wit/workitems') {
      const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean).map(Number);
      if (ids.length > 200) return json(400, { message: 'VS403474: 一次最多只能取得 200 筆工項' });
      const byId = new Map(items.map((i) => [i.id, i]));
      return json(200, {
        count: ids.length,
        value: ids.filter((i) => byId.has(i)).map((i) => {
          const it = byId.get(i);
          return {
            id: it.id,
            rev: 1,
            fields: {
              'System.Id': it.id,
              'System.TeamProject': it.project,
              'System.Title': it.title,
              'System.WorkItemType': it.type,
              'System.State': it.state,
              'System.ChangedDate': it.changed,
              'System.CreatedDate': it.changed
            }
          };
        })
      });
    }
    return json(404, { message: `mock 沒有實作：${req.method} ${url.pathname}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}${COLLECTION}`,
    items,
    log,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  };
}
