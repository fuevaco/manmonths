// 工項 07：Markdown 渲染模組（panel/markdown.js）。以最小假 DOM 驗證節點結構與安全性。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sourcePath = new URL('../panel/markdown.js', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const { render, slugify } = require('../panel/markdown.js');

// ---------- 最小假 DOM：任何字串注入 API、on*、style、href、src、target 一律丟錯 ----------
const FORBIDDEN_ATTR = /^(on.*|style|href|src|srcdoc|target|formaction|action)$/i;
class FakeText {
  constructor(data) { this.nodeType = 3; this.data = String(data); }
  get textContent() { return this.data; }
}
class FakeElement {
  constructor(tag) { this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attrs = new Map(); this.childNodes = []; }
  appendChild(child) { this.childNodes.push(child); return child; }
  append(...nodes) { this.childNodes.push(...nodes); }
  setAttribute(name, value) {
    if (FORBIDDEN_ATTR.test(name)) throw new Error(`禁止設定屬性 ${name}`);
    this.attrs.set(name, String(value));
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  get innerHTML() { throw new Error('禁止使用 innerHTML'); }
  set innerHTML(_) { throw new Error('禁止使用 innerHTML'); }
  get outerHTML() { throw new Error('禁止使用 outerHTML'); }
  set outerHTML(_) { throw new Error('禁止使用 outerHTML'); }
  insertAdjacentHTML() { throw new Error('禁止使用 insertAdjacentHTML'); }
}
function makeDocument() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text),
    write() { throw new Error('禁止使用 document.write'); }
  };
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function ser(node) {
  if (node.nodeType === 3) return esc(node.data);
  const tag = node.tagName.toLowerCase();
  const attrs = [...node.attrs.entries()].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
  const inner = node.childNodes.map(ser).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}
const root = (md) => render(md, makeDocument());
const html = (md) => root(md).childNodes.map(ser).join('');
const LINK = (href, text, extra = '') =>
  `<a data-action="external-link" data-href="${href}" role="link" tabindex="0"${extra}>${text}</a>`;
const walk = (node, fn) => { fn(node); (node.childNodes ?? []).forEach(c => walk(c, fn)); };
const tagsOf = (node) => { const set = new Set(); node.childNodes.forEach(c => walk(c, n => { if (n.nodeType === 1) set.add(n.tagName.toLowerCase()); })); return set; };

// ---------- 容器與基本 ----------
test('render 回傳容器元素並標記 rc-markdown 類別', () => {
  const el = root('hi');
  assert.equal(el.tagName, 'DIV');
  assert.equal(el.getAttribute('class'), 'rc-markdown');
  assert.equal(html('hi'), '<p>hi</p>');
});

test('空字串與非字串輸入回傳空容器', () => {
  for (const input of ['', '   \n\n', null, undefined, 42]) assert.equal(html(input), '');
});

test('CRLF 與 CR 換行視同 LF', () => {
  assert.equal(html('# A\r\n\r\nb\r\nc'), '<h1 data-anchor="a">A</h1><p>b\nc</p>');
});

// ---------- 標題 ----------
test('ATX 標題 1 到 6 級，含結尾 # 與前導空白', () => {
  assert.equal(html('# One'), '<h1 data-anchor="one">One</h1>');
  assert.equal(html('###### Six'), '<h6 data-anchor="six">Six</h6>');
  assert.equal(html('  ## Two ##  '), '<h2 data-anchor="two">Two</h2>');
  assert.equal(html('### C# language'), '<h3 data-anchor="c-language">C# language</h3>');
});

test('七個 # 或 # 後無空白不是標題', () => {
  assert.equal(html('####### x'), '<p>####### x</p>');
  assert.equal(html('#hashtag'), '<p>#hashtag</p>');
});

test('標題內可有行內格式；重複標題的錨點加序號；中文標題保留中文', () => {
  assert.equal(html('## Hi `code` **b**'), '<h2 data-anchor="hi-code-b">Hi <code>code</code> <strong>b</strong></h2>');
  assert.equal(html('# A\n# A\n# A'), '<h1 data-anchor="a">A</h1><h1 data-anchor="a-1">A</h1><h1 data-anchor="a-2">A</h1>');
  assert.equal(html('## 使用 說明'), '<h2 data-anchor="使用-說明">使用 說明</h2>');
  assert.equal(slugify('Hello, World! 2'), 'hello-world-2');
});

test('Setext 標題', () => {
  assert.equal(html('Title\n====='), '<h1 data-anchor="title">Title</h1>');
  assert.equal(html('Sub\n---'), '<h2 data-anchor="sub">Sub</h2>');
});

// ---------- 行內 ----------
test('粗體、斜體、刪除線與行內程式碼', () => {
  assert.equal(html('a **b** *c* _d_ __e__ ~~f~~ `g`'),
    '<p>a <strong>b</strong> <em>c</em> <em>d</em> <strong>e</strong> <del>f</del> <code>g</code></p>');
});

test('強調可巢狀；單字內底線不算斜體', () => {
  assert.equal(html('***both***'), '<p><em><strong>both</strong></em></p>');
  assert.equal(html('**bold *and em* text**'), '<p><strong>bold <em>and em</em> text</strong></p>');
  assert.equal(html('snake_case_name and 2*3*4'), '<p>snake_case_name and 2<em>3</em>4</p>');
  assert.equal(html('a * b * c'), '<p>a * b * c</p>');
  assert.equal(html('**unclosed'), '<p>**unclosed</p>');
});

test('中日文與全形標點旁的粗體仍可成立', () => {
  assert.equal(html('**中文**內容'), '<p><strong>中文</strong>內容</p>');
  assert.equal(html('請**「引用」**文字'), '<p>請<strong>「引用」</strong>文字</p>');
});

test('行內程式碼：多重反引號、保留內容、不解析內部標記', () => {
  assert.equal(html('`` a`b ``'), '<p><code>a`b</code></p>');
  assert.equal(html('`**not bold** <b>`'), '<p><code>**not bold** &lt;b&gt;</code></p>');
  assert.equal(html('`unclosed'), '<p>`unclosed</p>');
});

test('反斜線跳脫與換行', () => {
  assert.equal(html('\\*lit\\* \\# \\\\ \\a'), '<p>*lit* # \\ \\a</p>');
  assert.equal(html('a  \nb'), '<p>a<br></br>b</p>');
  assert.equal(html('a\\\nb'), '<p>a<br></br>b</p>');
  assert.equal(html('a\nb'), '<p>a\nb</p>');
});

test('常見 HTML 實體會解碼成文字', () => {
  assert.equal(html('a &amp; b &lt;c&gt; &#169; &#x41; &nbsp;x &bogus;'), '<p>a &amp; b &lt;c&gt; © A \u00a0x &amp;bogus;</p>');
});

// ---------- 連結 ----------
test('行內連結：data-href、data-action、title，沒有 href 與 target', () => {
  const out = html('[t](https://docs.example/x "ti")');
  assert.equal(out, `<p>${LINK('https://docs.example/x', 't', ' title="ti"')}</p>`);
  assert.ok(!/ href=| target=/.test(out));
});

test('data-href 以 URL 解析後正規化（主機小寫、空白編碼、補斜線）', () => {
  assert.equal(html('[x](HTTPS://Docs.EXAMPLE)'), `<p>${LINK('https://docs.example/', 'x')}</p>`);
  assert.equal(html('[x](<https://a.example.com/a b>)'), `<p>${LINK('https://a.example.com/a%20b', 'x')}</p>`);
  assert.equal(html('[x](https://a.example.com/p?q=1&r=2#h)'), `<p>${LINK('https://a.example.com/p?q=1&amp;r=2#h', 'x')}</p>`);
  assert.equal(html('[x](https://a.example.com/f_(1))'), `<p>${LINK('https://a.example.com/f_(1)', 'x')}</p>`);
});

test('mailto 允許；文件內錨點使用 anchor-link 且小寫', () => {
  assert.equal(html('[mail](mailto:a@example.com)'), `<p>${LINK('mailto:a@example.com', 'mail')}</p>`);
  assert.equal(html('[go](#My-Section)'),
    '<p><a data-action="anchor-link" data-href="#my-section" role="link" tabindex="0">go</a></p>');
});

test('危險或不支援的協定、相對路徑只留純文字，不產生連結節點', () => {
  const bad = [
    'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
    '\u0001javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///C:/x', 'vbscript:x',
    'ftp://a.example.com/x', './docs/a.md', '/abs/path', '//evil.example.com/x', '&#106;avascript:alert(1)', ['https:', '', 'u:p@' + 'example.com/'].join('/'), 'http:' + '///'
  ];
  for (const href of bad) {
    const el = root(`[label](<${href}>)`);
    let anchors = 0; walk(el, n => { if (n.tagName === 'A') anchors += 1; });
    assert.equal(anchors, 0, `不應產生連結：${JSON.stringify(href)}`);
    assert.ok(el.textContent.includes('label'), `連結文字仍要顯示：${JSON.stringify(href)}`);
  }
  assert.equal(html('[x](javascript:alert(1))'), '<p>x</p>');
  assert.equal(html('[**x**](data:text/html;base64,AAAA)'), '<p><strong>x</strong></p>');
});

test('尖括號自動連結與裸網址（去除結尾標點）', () => {
  assert.equal(html('<https://a.example.com/x>'), `<p>${LINK('https://a.example.com/x', 'https://a.example.com/x')}</p>`);
  assert.equal(html('<me@example.com>'), `<p>${LINK('mailto:me@example.com', 'me@example.com')}</p>`);
  assert.equal(html('see https://a.example.com/x, ok'), `<p>see ${LINK('https://a.example.com/x', 'https://a.example.com/x')}, ok</p>`);
  assert.equal(html('(https://a.example.com/b) and https://a.example.com/c.'),
    `<p>(${LINK('https://a.example.com/b', 'https://a.example.com/b')}) and ${LINK('https://a.example.com/c', 'https://a.example.com/c')}.</p>`);
  assert.equal(html('go www.example.com now'), `<p>go ${LINK('http://www.example.com/', 'www.example.com')} now</p>`);
  assert.equal(html('網址https://a.example.com/x，請看'), `<p>網址${LINK('https://a.example.com/x', 'https://a.example.com/x')}，請看</p>`);
  assert.equal(html('https://a.example.com/a_b_c'), `<p>${LINK('https://a.example.com/a_b_c', 'https://a.example.com/a_b_c')}</p>`);
  assert.equal(html('<javascript:alert(1)>'), '<p>&lt;javascript:alert(1)&gt;</p>');
  assert.equal(html('xhttps://a.example.com'), '<p>xhttps://a.example.com</p>');
});

test('參照式連結', () => {
  assert.equal(html('[a][r] [b] [c][]\n\n[r]: https://a.example.com "T"\n[b]: <https://b.example.com>\n[c]: <https://c.example.com>'),
    `<p>${LINK('https://a.example.com/', 'a', ' title="T"')} ${LINK('https://b.example.com/', 'b')} ${LINK('https://c.example.com/', 'c')}</p>`);
  assert.equal(html('[missing][x]'), '<p>[missing][x]</p>');
});

test('圖片以替代文字加連結呈現，不產生 img；相對路徑只留替代文字', () => {
  assert.equal(html('![logo](https://x.example.com/a.png)'),
    '<p><a class="rc-md-image" data-action="external-link" data-href="https://x.example.com/a.png" role="link" tabindex="0">logo</a></p>');
  assert.equal(html('![](https://x.example.com/pic.png)').includes('>pic.png</a>'), true);
  assert.equal(html('![local](./a.png)'), '<p>local</p>');
  assert.equal(html('![x](data:image/png;base64,AAAA)'), '<p>x</p>');
  // 徽章：連結包圖片 -> 只有一層連結
  assert.equal(html('[![build](https://i.example.com/b.svg)](https://x.example.com/ci)'), `<p>${LINK('https://x.example.com/ci', 'build')}</p>`);
  assert.ok(!tagsOf(root('![a](https://x.example.com/a.png)')).has('img'));
});

// ---------- 清單 ----------
test('無序清單（- * + 皆可）與有序清單（含起始數字與 ) 分隔）', () => {
  assert.equal(html('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(html('* a\n+ b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(html('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(html('3) a\n4) b'), '<ol start="3"><li>a</li><li>b</li></ol>');
});

test('巢狀清單：2 空白、4 空白、混合有序與無序', () => {
  assert.equal(html('- a\n  - b\n    - c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
  assert.equal(html('1. a\n    - b\n    - c\n2. d'), '<ol><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ol>');
  assert.equal(html('1. a\n  - b\n2. c'), '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>');
});

test('任務清單', () => {
  assert.equal(html('- [ ] todo\n- [x] done\n- [X] Done2\n- [y] plain'),
    '<ul class="rc-md-tasks"><li class="rc-md-task"><input disabled="" type="checkbox"></input> todo</li>' +
    '<li class="rc-md-task"><input checked="" disabled="" type="checkbox"></input> done</li>' +
    '<li class="rc-md-task"><input checked="" disabled="" type="checkbox"></input> Done2</li>' +
    '<li>[y] plain</li></ul>');
});

test('鬆散清單（項目間空行）以段落包裹，緊密清單不包', () => {
  assert.equal(html('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  assert.equal(html('- a\n\n  more\n- b'), '<ul><li><p>a</p><p>more</p></li><li><p>b</p></li></ul>');
});

test('清單項目可含程式碼區塊與引言；懶惰續行；清單後接段落', () => {
  assert.equal(html('- a\n\n  ```js\n  x();\n  ```\n- b'),
    '<ul><li><p>a</p><pre><code class="language-js" data-lang="js">x();</code></pre></li><li><p>b</p></li></ul>');
  assert.equal(html('- a\n  b\nc'), '<ul><li>a\nb\nc</li></ul>');
  assert.equal(html('- a\n\npara'), '<ul><li>a</li></ul><p>para</p>');
  assert.equal(html('text\n- a\n- b'), '<p>text</p><ul><li>a</li><li>b</li></ul>');
});

test('清單項目可為空，且 2. 不會打斷段落', () => {
  assert.equal(html('-\n- b'), '<ul><li></li><li>b</li></ul>');
  assert.equal(html('abc\n2. not list'), '<p>abc\n2. not list</p>');
});

// ---------- 引言 ----------
test('引言含段落、巢狀引言、清單與懶惰續行', () => {
  assert.equal(html('> a\n> b'), '<blockquote><p>a\nb</p></blockquote>');
  assert.equal(html('> a\nb'), '<blockquote><p>a\nb</p></blockquote>');
  assert.equal(html('> a\n>\n> b'), '<blockquote><p>a</p><p>b</p></blockquote>');
  assert.equal(html('> a\n> > b'), '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>');
  assert.equal(html('> - x\n> - y\n\nafter'), '<blockquote><ul><li>x</li><li>y</li></ul></blockquote><p>after</p>');
});

// ---------- 程式碼區塊 ----------
test('``` 與 ~~~ 程式碼區塊，含語言標記；內容原樣保留', () => {
  assert.equal(html('```js\nconst a = 1;\n```'), '<pre><code class="language-js" data-lang="js">const a = 1;</code></pre>');
  assert.equal(html('~~~\nplain\n~~~'), '<pre><code>plain</code></pre>');
  assert.equal(html('``` python title="x"\nprint(1)\n```'), '<pre><code class="language-python" data-lang="python">print(1)</code></pre>');
});

test('程式碼區塊內容完全不解析：HTML、Markdown、縮排、Tab、空行都保留', () => {
  const body = '<script>alert(1)</script>\n**not bold** [x](javascript:1)\n\n    indented\n\ttabbed\n# not heading\n- not list\n| a | b |';
  assert.equal(html('```\n' + body + '\n```'), `<pre><code>${esc(body)}</code></pre>`);
});

test('較長的圍欄可包含較短的圍欄；不同字元不會結束；未關閉者延伸到結尾', () => {
  assert.equal(html('````\n```\ninner\n```\n````'), '<pre><code>```\ninner\n```</code></pre>');
  assert.equal(html('```\na\n~~~\nb\n```'), '<pre><code>a\n~~~\nb</code></pre>');
  assert.equal(html('```\nnever closed\n\nstill code'), '<pre><code>never closed\n\nstill code</code></pre>');
  assert.equal(html('```\n```'), '<pre><code></code></pre>');
});

test('語言標記只接受安全字元', () => {
  assert.equal(html('```"><img>\nx\n```'), '<pre><code>x</code></pre>');
  assert.equal(html('```c++\nx\n```'), '<pre><code class="language-c++" data-lang="c++">x</code></pre>');
});

test('縮排程式碼區塊（4 空白）', () => {
  assert.equal(html('para\n\n    code <b>\n\n    more\n\nafter'), '<p>para</p><pre><code>code &lt;b&gt;\n\nmore</code></pre><p>after</p>');
});

// ---------- 表格 ----------
test('GFM 表格：結構與對齊', () => {
  assert.equal(html('| A | B | C | D |\n|---|:--|:-:|--:|\n| 1 | 2 | 3 | 4 |\n| x | y | z | w |'),
    '<div class="rc-md-table-wrap"><table><thead><tr>' +
    '<th>A</th><th data-align="left">B</th><th data-align="center">C</th><th data-align="right">D</th></tr></thead>' +
    '<tbody><tr><td>1</td><td data-align="left">2</td><td data-align="center">3</td><td data-align="right">4</td></tr>' +
    '<tr><td>x</td><td data-align="left">y</td><td data-align="center">z</td><td data-align="right">w</td></tr></tbody></table></div>');
});

test('表格：無外框管線、補齊與截斷列、儲存格內行內格式與跳脫管線', () => {
  assert.equal(html('a | b\n--|--\n`x` | **y**\nonly\n1 | 2 | 3'),
    '<div class="rc-md-table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>' +
    '<tr><td><code>x</code></td><td><strong>y</strong></td></tr>' +
    '<tr><td>only</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table></div>');
  assert.equal(html('| a |\n|---|\n| x \\| y |'),
    '<div class="rc-md-table-wrap"><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>x | y</td></tr></tbody></table></div>');
});

test('表格：只有表頭沒有 tbody；欄數不符不是表格；後接空行結束', () => {
  assert.equal(html('| a | b |\n|---|---|'),
    '<div class="rc-md-table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead></table></div>');
  assert.equal(html('| a | b |\n|---|'), '<p>| a | b |\n|---|</p>');
  assert.equal(html('| a |\n|---|\n| 1 |\n\nafter'),
    '<div class="rc-md-table-wrap"><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></div><p>after</p>');
  assert.equal(html('para\n| a |\n|---|\n| 1 |').startsWith('<p>para</p><div class="rc-md-table-wrap">'), true);
});

// ---------- 水平線 ----------
test('水平線的各種寫法', () => {
  for (const hr of ['---', '***', '___', '- - -', ' * * *', '------']) assert.equal(html(`a\n\n${hr}\n\nb`), '<p>a</p><hr></hr><p>b</p>', hr);
  assert.equal(html('--'), '<p>--</p>');
});

// ---------- 原始 HTML 一律當純文字 ----------
test('原始 HTML、script、事件屬性當純文字顯示，不產生對應節點', () => {
  const dangerous = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)" onclick="x()">click</a>',
    '<iframe src="https://evil.example.invalid"></iframe>',
    '<div style="x" onmouseover="y()">hi</div>',
    '<!-- comment --><style>*{display:none}</style>',
    '<svg onload=alert(1)></svg>'
  ];
  for (const raw of dangerous) {
    const el = root(raw);
    assert.equal(el.textContent, raw, `應原樣顯示成文字：${raw}`);
    const tags = tagsOf(el);
    for (const t of ['script', 'img', 'iframe', 'style', 'svg', 'div', 'a']) assert.ok(!tags.has(t), `不應出現 <${t}>：${raw}`);
  }
  assert.equal(html('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('標題、清單、引言、表格、連結文字與程式碼中的 HTML 同樣是純文字', () => {
  const el = root('# <b onclick=x>H</b>\n\n- <script>a</script>\n\n> <img src=x onerror=y>\n\n| <i>h</i> |\n|---|\n| <u>c</u> |\n\n[<s>t</s>](https://a.example.com)');
  const tags = tagsOf(el);
  for (const t of ['b', 'script', 'img', 'i', 'u', 's']) assert.ok(!tags.has(t), `不應出現 <${t}>`);
  assert.ok(el.textContent.includes('<script>a</script>'));
  assert.ok(el.textContent.includes('<u>c</u>'));
});

test('輸出只用白名單標籤，且完全沒有 on*、style、href、src、target 屬性', () => {
  const readme = [
    '# T', '', 'p **b** *i* ~~d~~ `c` [l](https://a.example.com) <https://b.example.com> ![i](https://a.example.com/i.png) www.a.example.com', '',
    '- [ ] t', '  1. n', '', '> q', '', '```js', 'x', '```', '', '| a | b |', '|:-|-:|', '| 1 | 2 |', '', '---',
    '<script>alert(1)</script> <img onerror=x>'
  ].join('\n');
  const el = root(readme);
  const allow = new Set(['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li',
    'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input']);
  for (const t of tagsOf(el)) assert.ok(allow.has(t), `非白名單標籤 ${t}`);
  walk(el, n => { if (n.attrs) for (const k of n.attrs.keys()) assert.ok(!FORBIDDEN_ATTR.test(k), `不應有屬性 ${k}`); });
});

// ---------- 靜態檢查 ----------
test('原始碼不含 innerHTML、outerHTML、insertAdjacentHTML、document.write、eval、new Function、style 設定', () => {
  for (const pattern of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\s*\.\s*write/, /\beval\s*\(/, /new\s+Function/, /\.style\b/, /setAttribute\(\s*['"]on/i, /setAttribute\(\s*['"]style/i, /\.on[a-z]+\s*=[^=]/, /createContextualFragment/, /DOMParser/, /srcdoc/]) {
    assert.ok(!pattern.test(source), `原始碼不應符合 ${pattern}`);
  }
});

// ---------- 載入方式 ----------
test('classic script：在只有 window 的環境載入後提供 window.RcMarkdown.render', () => {
  const window = {};
  vm.runInNewContext(source, { window, URL });
  assert.equal(typeof window.RcMarkdown.render, 'function');
  assert.equal(window.RcMarkdown.render('**x**', makeDocument()).childNodes.map(ser).join(''), '<p><strong>x</strong></p>');
});

test('classic script：以 vm 在無 module 的全域環境載入不會丟錯', () => {
  assert.doesNotThrow(() => vm.runInNewContext(source, { window: {}, URL }));
});

// ---------- 效能與韌性 ----------
function within(ms, label, fn) {
  const t0 = performance.now(); fn(); const spent = performance.now() - t0;
  assert.ok(spent < ms, `${label} 花了 ${Math.round(spent)} ms（上限 ${ms} ms）`);
}

test('數百行 README 在合理時間內完成', () => {
  const chunk = '# Title\n\nSome **bold** text with `code` and [a link](https://docs.example/x) and *emphasis*.\n\n- item one\n  - nested\n- item two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n> quote\n\n';
  const readme = chunk.repeat(60);
  assert.ok(readme.split('\n').length > 1000);
  within(1500, '1000+ 行', () => render(readme, makeDocument()));
});

test('病態輸入不會造成指數或二次爆炸', () => {
  const n = 20000;
  const cases = {
    '重複 *': 'a*'.repeat(n), '重複 _': '_a'.repeat(n), '重複 ~~': '~~a'.repeat(n / 2), '重複 [': '['.repeat(n), '重複 ![': '!['.repeat(n),
    '重複 [a](': '[a]('.repeat(n / 2), '重複 [a](((': '[a](((((('.repeat(n / 6), '重複反引號': '`a``'.repeat(n / 2), '重複 <': '<a'.repeat(n),
    '重複 <http': '<http://docs.example'.repeat(n / 4), '重複 http://': 'http://a.example.com/'.repeat(n / 8), '重複管線': '|'.repeat(n), '表格重複': ('| a | b |\n|---|---|\n').repeat(n / 20),
    '深層引言': '> '.repeat(5000) + 'x', '深層清單': Array.from({ length: 300 }, (_, i) => ' '.repeat(i * 2) + '- x').join('\n'),
    '重複標題': '# a\n'.repeat(n / 4), '許多空行': '\n'.repeat(n * 5), '長行': 'x'.repeat(n * 20), '重複 \\': '\\'.repeat(n * 5), '重複 &': '&#x;'.repeat(n)
  };
  for (const [label, input] of Object.entries(cases)) within(2500, label, () => render(input, makeDocument()));
});
