import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const dataAttribute = (name) => `data-${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;

export class Element {
  value = ''; textContent = ''; children = []; disabled = false; scrollTop = 0; scrolledIntoView = 0;
  listeners = new Map(); classes = new Set(); attributes = new Map();
  dataset = new Proxy({}, {
    get: (_, name) => typeof name === 'string' ? this.attributes.get(dataAttribute(name)) : undefined,
    set: (_, name, value) => { this.attributes.set(dataAttribute(name), String(value)); return true; }
  });
  classList = {
    add: (v) => this.classes.add(v), remove: (v) => this.classes.delete(v),
    contains: (v) => this.classes.has(v),
    toggle: (v, on) => on ? this.classes.add(v) : this.classes.delete(v)
  };
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
  }
  removeEventListener(event, fn) { this.listeners.get(event)?.delete(fn); }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  focus() {}
  scrollIntoView() { this.scrolledIntoView += 1; }
  appendChild(node) { this.adopt(node); this.children.push(node); return node; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  append(...nodes) { nodes.forEach(n => this.adopt(n)); this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children.forEach(n => { if (n.parent === this) n.parent = null; }); nodes.forEach(n => this.adopt(n)); this.children = nodes; }
  adopt(node) { if (node && typeof node === 'object') node.parent = this; }
  /** 支援逗號分隔的簡單選擇器：tag、.class、[attr]、[attr="value"]，可組合（例如 button[type]）。 */
  matches(selector) {
    return String(selector).split(',').map(s => s.trim()).filter(Boolean).some((part) => {
      const m = part.match(/^([\w-]*)((?:\.[\w-]+|\[[\w-]+(?:=(?:"[^"]*"|[^\]]*))?\])*)$/);
      if (!m) throw new Error(`harness 不支援的選擇器：${part}`);
      if (m[1] && String(this.tagName ?? '').toLowerCase() !== m[1].toLowerCase()) return false;
      return [...m[2].matchAll(/\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]/g)].every(([, cls, attr, quoted, bare]) => {
        if (cls) return this.classes.has(cls);
        const actual = this.getAttribute(attr);
        return actual !== null && ((quoted === undefined && bare === undefined) || actual === (quoted ?? bare));
      });
    });
  }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  contains(other) { for (let node = other; node; node = node.parent) if (node === this) return true; return false; }
  /** 模擬使用者真的點擊／按鍵：事件從這個節點開始往父節點冒泡，並遵守 stopPropagation。 */
  dispatch(event, props = {}) {
    let stopped = false;
    const results = [];
    for (let node = this; node && !stopped; node = node.parent) {
      for (const fn of [...(node.listeners.get(event) ?? [])]) {
        results.push(fn({ type: event, target: this, currentTarget: node, preventDefault() {}, stopPropagation() { stopped = true; }, ...props }));
      }
    }
    return Promise.all(results);
  }
  fire(event, props = {}) {
    return Promise.all([...(this.listeners.get(event) ?? [])].map(fn => fn({ type: event, target: this, preventDefault() {}, ...props })));
  }
}

/** 包含 root 本身的子樹查找；name 使用 data- 後方的名稱（例如 target-id）。 */
export function findAllByData(root, name, value) {
  if (!root) return [];
  const actual = root.getAttribute(`data-${name}`);
  const matches = actual !== null && (value === undefined || actual === String(value));
  return [...(matches ? [root] : []), ...root.children.flatMap(child => findAllByData(child, name, value))];
}
export function findByData(root, name, value) { return findAllByData(root, name, value)[0] ?? null; }

/** 不啟動真實 interval；測試可依 id 觸發，clear 後不再執行。 */
export function createManualIntervals() {
  const active = new Map(), calls = [];
  let nextId = 1;
  return {
    active, calls,
    setInterval(fn, delay, ...args) {
      const id = nextId++;
      active.set(id, () => fn(...args));
      calls.push({ method: 'setInterval', id, delay });
      return id;
    },
    clearInterval(id) { calls.push({ method: 'clearInterval', id }); active.delete(id); },
    async fire(id) { await active.get(id)?.(); await settle(); }
  };
}

/** 不啟動真實 timeout（例如短提示幾秒後消失）；測試以 fireAll 觸發到期。 */
export function createManualTimeouts() {
  const active = new Map(), calls = [];
  let nextId = 1;
  return {
    active, calls,
    setTimeout(fn, delay, ...args) {
      const id = nextId++;
      active.set(id, () => fn(...args));
      calls.push({ method: 'setTimeout', id, delay });
      return id;
    },
    clearTimeout(id) { active.delete(id); },
    async fireAll() { const due = [...active.values()]; active.clear(); for (const fn of due) await fn(); await settle(); }
  };
}

/** index.html 以 <script src> 載入的檔案（相對於 panel/），依出現順序。 */
export const panelScripts = (html) => [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
/** 面板腳本（markdown.js 以外）的原始碼，依載入順序串接；供檢查已移除的字串。 */
export async function panelSource() {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const files = panelScripts(html).filter(f => f !== 'markdown.js');
  return (await Promise.all(files.map(f => readFile(new URL(`../panel/${f}`, import.meta.url), 'utf8')))).join('\n');
}

export const settle = () => new Promise((resolve) => setImmediate(resolve));
export async function startPanel(request, { openExternal = async () => ({ opened: true }), timers = createManualIntervals(), timeouts = createManualTimeouts() } = {}) {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  // 下拉選單的 <option> 也照 index.html 建成子節點：面板從選項讀取可選的值（排序欄位、檢查更新頻率）
  for (const [, id, body] of html.matchAll(/<select[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    nodes.get(id).children = [...body.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(([, attrs, text]) => {
      const own = attrs.match(/\bid="([^"]+)"/)?.[1];
      const option = Object.assign(own ? nodes.get(own) : new Element(), { tagName: 'option', textContent: text });
      option.setAttribute('value', attrs.match(/\bvalue="([^"]*)"/)?.[1] ?? text);
      return option;
    });
  }
  const document = Object.assign(new Element(), { body: new Element(), documentElement: new Element(), readyState: 'complete',
    visibilityState: 'visible', hidden: false,
    getElementById: (id) => nodes.get(id), createElement: (tagName) => Object.assign(new Element(), { tagName }),
    createTextNode: (text) => Object.assign(new Element(), { tagName: '#text', textContent: String(text) }),
    createElementNS: (namespace, tagName) => Object.assign(new Element(), { tagName, namespace }) });
  const externalUrls = [];
  // 可由測試推進的時鐘（面板以 Date.now() 判斷「已準備好」的有效期限）
  const clock = { now: Date.now(), advance(ms) { clock.now += ms; } };
  class FakeDate extends Date { static now() { return clock.now; } }
  const window = { orca: { plugin: { request }, on() {}, shell: {
    openExternal: async (url) => { externalUrls.push(url); return openExternal(url); }
  } }, setTimeout: timeouts.setTimeout, clearTimeout: timeouts.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval };
  const context = vm.createContext({ window, document, URL, Date: FakeDate, URLSearchParams,
    setTimeout: timeouts.setTimeout, clearTimeout: timeouts.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  // 與實際載入一致：依 index.html 的 <script src> 順序執行所有面板腳本
  for (const file of panelScripts(html)) vm.runInContext(await readFile(new URL(`../panel/${file}`, import.meta.url), 'utf8'), context, { filename: `panel/${file}` });
  await settle();
  return { get: (id) => nodes.get(id), window, document, externalUrls, timers, timeouts, clock,
    setVisibility: async (state) => {
      document.visibilityState = state; document.hidden = state === 'hidden';
      await document.fire('visibilitychange'); await settle();
    } };
}
/** 可展開區塊（details）的標題與內文，供驗證「明細可展開」。 */
export function detailsOf(node) {
  const summary = node.children.find(child => child.tagName === 'summary');
  return [...(node.tagName === 'details' ? [{ summary: summary ? textOf(summary) : '', body: node.children.filter(child => child !== summary).map(textOf).join(' ') }] : []), ...node.children.flatMap(detailsOf)];
}
export function textOf(node) { return [node.textContent, ...node.children.map(textOf)].join(' '); }
