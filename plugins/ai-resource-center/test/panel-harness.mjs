import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

class Element {
  value = ''; textContent = ''; children = []; disabled = false;
  listeners = new Map(); classes = new Set();
  classList = {
    add: (v) => this.classes.add(v), remove: (v) => this.classes.delete(v),
    contains: (v) => this.classes.has(v),
    toggle: (v, on) => on ? this.classes.add(v) : this.classes.delete(v)
  };
  addEventListener(event, fn) { this.listeners.set(event, fn); }
  focus() {}
  setAttribute(key, value) { this[key] = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  fire(event) { return this.listeners.get(event)?.({ preventDefault() {} }); }
}

export const settle = () => new Promise((resolve) => setImmediate(resolve));
export async function startPanel(request) {
  const html = await readFile(new URL('../panel/index.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  const document = { body: new Element(), documentElement: new Element(), readyState: 'complete',
    getElementById: (id) => nodes.get(id), createElement: (tagName) => Object.assign(new Element(), { tagName }) };
  const window = { orca: { plugin: { request }, on() {} } };
  vm.runInNewContext(await readFile(new URL('../panel/panel.js', import.meta.url), 'utf8'), { window, document, setTimeout, clearTimeout });
  await settle();
  return { get: (id) => nodes.get(id) };
}
/** 可展開區塊（details）的標題與內文，供驗證「明細可展開」。 */
export function detailsOf(node) {
  return [...(node.tagName === 'details' ? [{ summary: textOf(node.children[0]), body: node.children.slice(1).map(textOf).join(' ') }] : []), ...node.children.flatMap(detailsOf)];
}
export function textOf(node) { return [node.textContent, ...node.children.map(textOf)].join(' '); }
