/* 資源中心：Markdown 渲染模組（classic script，面板以 <script src="markdown.js"> 載入）。
 *
 * 用法：const el = window.RcMarkdown.render(markdownText, document);  // 回傳 <div class="rc-markdown">
 *
 * 安全設計：
 *  - 只用 createElement / createTextNode / setAttribute 建立節點，不使用任何把字串解析成 HTML 的 API；
 *    Markdown 內的原始 HTML（含 script、事件屬性）一律成為純文字節點。
 *  - 連結只接受 http:、https:、mailto: 與文件內錨點 #；其餘（javascript:、data:、file:、相對路徑…）只留文字。
 *  - 不設定 href / target / src / on* / style。連結節點帶 data-href（正規化網址）與 data-action，
 *    由面板攔截點擊（external-link 以 window.orca.shell.openExternal 開啟；anchor-link 在文件內捲動到
 *    data-anchor 相同的標題）。
 *  - 圖片不載入，改以「替代文字＋連結」呈現。
 *  - 所有掃描皆為線性或有界，避免病態輸入造成指數或二次爆炸。
 */
(function (root) {
  'use strict';

  const MAX_BLOCK_DEPTH = 12;
  const MAX_INPUT = 1000000;
  const MAX_URL = 4096;
  const MAX_TABLE_COLS = 100;
  const EXTERNAL_ACTION = 'external-link';
  const ANCHOR_ACTION = 'anchor-link';

  // ------------------------------------------------------------------ 字元工具

  const ASCII_PUNCT = /^[!-\/:-@\[-`{-~]$/;
  const UNESCAPE_RE = /\\([!-\/:-@\[-`{-~])/g;
  const unescapeMd = (s) => (s.indexOf('\\') === -1 ? s : s.replace(UNESCAPE_RE, '$1'));

  const WS_RE = /\s/;
  const PUNCT_RE = /[\p{P}\p{S}]/u;
  const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  // 0 = 空白（含字串邊界）、1 = 標點（中日韓文字視同標點，讓「**「引用」**文字」能成立）、2 = 一般字元
  const charKind = (ch) => (!ch || WS_RE.test(ch) ? 0 : (PUNCT_RE.test(ch) || CJK_RE.test(ch) ? 1 : 2));
  function charBefore(s, i) {
    if (i <= 0) return '';
    const c = s.charCodeAt(i - 1);
    return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? s.slice(i - 2, i) : s[i - 1];
  }
  function charAfter(s, i) {
    if (i >= s.length) return '';
    const cp = s.codePointAt(i);
    return String.fromCodePoint(cp);
  }

  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
    mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', middot: '·', times: '×' };
  const ENTITY_RE = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/;
  function decodeEntity(s, i) {
    const m = ENTITY_RE.exec(s.slice(i, i + 12));
    if (!m) return null;
    let text = null;
    if (m[3]) text = NAMED_ENTITIES[m[3]] ?? null;
    else {
      const cp = m[1] ? parseInt(m[1], 10) : parseInt(m[2], 16);
      if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) text = String.fromCodePoint(cp);
    }
    return text === null ? null : { text, length: m[0].length };
  }

  // ------------------------------------------------------------------ 網址消毒

  const SCHEME_PROBE = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;
  const CONTROL_CHARS = /[\u0000- \u007f-\u009f]/g;

  /** 回傳 { href, kind: 'external' | 'anchor' }；不允許的網址回傳 null。 */
  function normalizeUrl(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text || text.length > MAX_URL) return null;
    if (text[0] === '#') {
      let frag = text.slice(1);
      try { frag = decodeURIComponent(frag); } catch { /* 保留原樣 */ }
      frag = frag.trim().toLowerCase();
      return frag ? { href: '#' + frag, kind: 'anchor' } : null;
    }
    // 瀏覽器解析網址時會忽略內嵌的 Tab／換行，所以判斷協定前先移除所有控制與空白字元
    const probe = SCHEME_PROBE.exec(text.replace(CONTROL_CHARS, ''));
    if (!probe) return null;
    const scheme = probe[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return null;
    if (typeof URL !== 'function') return null;
    let u;
    try { u = new URL(text); } catch { return null; }
    if (u.protocol !== scheme + ':') return null;
    if (scheme === 'mailto') return u.pathname ? { href: u.href, kind: 'external' } : null;
    if (!u.hostname || u.username || u.password) return null;
    return { href: u.href, kind: 'external' };
  }

  function slugify(text) {
    return String(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
  }

  // ------------------------------------------------------------------ 行內解析

  const SPECIAL_RE = /[\\`*_~\[!<&\nhHwW]/g;
  const URL_END_RE = /[\s<　-〿＀-￯]/g;
  const ANGLE_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.\-]{1,31}:[^\s<>]*$/;
  const ANGLE_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
  const isSpaceCode = (c) => c === 32 || c === 9 || c === 10;

  function normalizeLabel(label) { return label.trim().replace(/\s+/g, ' ').toLowerCase(); }

  function plainText(nodes) {
    let out = '';
    for (const n of nodes) {
      if (n.t === 'text' || n.t === 'code') out += n.v;
      else if (n.t === 'br') out += ' ';
      else if (n.kids) out += plainText(n.kids);
    }
    return out;
  }

  function mergeText(nodes) {
    const out = [];
    for (const n of nodes) {
      const last = out[out.length - 1];
      if (n.t === 'text' && last && last.t === 'text') last.v += n.v;
      else out.push(n);
    }
    return out;
  }

  function delimToText(token) { return token.t === 'delim' ? { t: 'text', v: token.ch.repeat(token.n) } : token; }

  /**
   * 依 CommonMark 的分隔符號規則（簡化）配對強調；比對範圍有界以避免病態輸入。
   * 被配對取代的一定是已處理序列的尾端，所以用堆疊只動尾端，整體為線性；
   * 在陣列中間 splice 會讓「a*a*a*…」這類輸入變成二次方。
   */
  function resolveEmphasis(tokens) {
    const out = [];
    for (const c of tokens) {
      if (c.t !== 'delim' || !c.canClose || c.n === 0) { out.push(c); continue; }
      for (;;) {
        let found = -1;
        for (let j = out.length - 1, stop = Math.max(0, out.length - 400); j >= stop; j -= 1) {
          const o = out[j];
          if (o.t !== 'delim' || o.ch !== c.ch || !o.canOpen || o.n === 0) continue;
          if ((o.canClose || c.canOpen) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
          found = j; break;
        }
        if (found < 0) { out.push(c); break; }
        const o = out[found];
        const use = c.ch === '~' ? 2 : (o.n >= 2 && c.n >= 2 ? 2 : 1);
        const kids = out.splice(found + 1).map(delimToText);
        out.push({ t: c.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em'), kids });
        o.n -= use; c.n -= use;
        if (o.n === 0) out.splice(found, 1);
        if (c.n === 0) break;
      }
    }
    return mergeText(out.map(delimToText));
  }

  /** 解析 (url "title")；回傳 { url, title, end } 或 null。每次最多往後看約 2000 字元。 */
  function parseDestination(s, p) {
    const limit = Math.min(s.length, p + 2100);
    while (p < limit && isSpaceCode(s.charCodeAt(p))) p += 1;
    let url;
    if (s[p] === '<') {
      let q = p + 1;
      while (q < limit && s[q] !== '>' && s[q] !== '<' && s[q] !== '\n') { if (s[q] === '\\') q += 1; q += 1; }
      if (s[q] !== '>') return null;
      url = unescapeMd(s.slice(p + 1, q));
      p = q + 1;
    } else {
      let q = p, depth = 0;
      while (q < limit) {
        const c = s[q];
        if (c === '\\' && q + 1 < limit && ASCII_PUNCT.test(s[q + 1])) { q += 2; continue; }
        if (c === '(') depth += 1;
        else if (c === ')') { if (depth === 0) break; depth -= 1; }
        else if (s.charCodeAt(q) <= 32) break;
        q += 1;
      }
      if (q >= limit && q < s.length) return null;
      if (depth !== 0) return null;
      url = unescapeMd(s.slice(p, q));
      p = q;
    }
    while (p < limit && isSpaceCode(s.charCodeAt(p))) p += 1;
    let title = null;
    const open = s[p];
    if (open === '"' || open === "'" || open === '(') {
      const closer = open === '(' ? ')' : open;
      let q = p + 1; const titleLimit = Math.min(s.length, p + 1100);
      while (q < titleLimit && s[q] !== closer) { if (s[q] === '\\') q += 1; q += 1; }
      if (s[q] !== closer) return null;
      title = unescapeMd(s.slice(p + 1, q));
      p = q + 1;
      while (p < limit && isSpaceCode(s.charCodeAt(p))) p += 1;
    }
    if (s[p] !== ')') return null;
    return { url, title, end: p + 1 };
  }

  function imageLabel(alt, href) {
    if (alt) return alt;
    try {
      const segs = new URL(href).pathname.split('/').filter(Boolean);
      if (segs.length) return decodeURIComponent(segs[segs.length - 1]);
    } catch { /* 用預設文字 */ }
    return '圖片';
  }

  function parseInline(src, ctx, depth, noLinks) {
    const n = src.length;
    const tokens = [];
    let buf = '';
    const flush = () => { if (buf) { tokens.push({ t: 'text', v: buf }); buf = ''; } };

    // 反引號片段：一次掃描出所有連續反引號，再用「同長度的下一段」配對（O(n)）
    let runs = null, runNext = null, runAt = null;
    if (src.indexOf('`') !== -1) {
      runs = []; runAt = new Map();
      for (let i = 0; i < n;) {
        if (src[i] === '`') { let j = i; while (src[j] === '`') j += 1; runAt.set(i, runs.length); runs.push({ pos: i, len: j - i }); i = j; } else i += 1;
      }
      runNext = new Array(runs.length);
      const lastByLen = new Map();
      for (let k = runs.length - 1; k >= 0; k -= 1) {
        runNext[k] = lastByLen.has(runs[k].len) ? lastByLen.get(runs[k].len) : -1;
        lastByLen.set(runs[k].len, k);
      }
    }
    // 中括號配對：第一次需要時用堆疊一次算好
    let closeOf = null;
    const ensureBrackets = () => {
      if (closeOf) return;
      closeOf = new Map();
      const stack = [];
      for (let i = 0; i < n; i += 1) {
        const c = src[i];
        if (c === '\\') i += 1;
        else if (c === '`' && runAt && runAt.has(i)) {
          const k = runAt.get(i);
          if (runNext[k] >= 0) i = runs[runNext[k]].pos + runs[k].len - 1; else i += runs[k].len - 1;
        } else if (c === '[') stack.push(i);
        else if (c === ']' && stack.length) closeOf.set(stack.pop(), i);
      }
    };

    const pushLink = (url, kids, extra) => {
      const norm = normalizeUrl(url);
      if (!norm) return false;
      flush();
      tokens.push({ t: 'link', href: norm.href, kind: norm.kind, title: extra.title || null, cls: extra.cls || null, kids });
      return true;
    };

    let i = 0;
    while (i < n) {
      SPECIAL_RE.lastIndex = i;
      const m = SPECIAL_RE.exec(src);
      if (!m) { buf += src.slice(i); break; }
      if (m.index > i) buf += src.slice(i, m.index);
      i = m.index;
      const c = src[i];

      if (c === '\\') {
        const next = src[i + 1];
        if (next === '\n') { flush(); tokens.push({ t: 'br' }); i += 2; while (src[i] === ' ' || src[i] === '\t') i += 1; }
        else if (next !== undefined && ASCII_PUNCT.test(next)) { buf += next; i += 2; }
        else { buf += '\\'; i += 1; }
      } else if (c === '`') {
        const k = runAt ? runAt.get(i) : undefined;
        if (k === undefined) { buf += '`'; i += 1; continue; }
        const len = runs[k].len, mate = runNext[k];
        if (mate < 0) { buf += src.slice(i, i + len); i += len; continue; }
        let code = src.slice(i + len, runs[mate].pos).replace(/\n/g, ' ');
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
        flush(); tokens.push({ t: 'code', v: code });
        i = runs[mate].pos + len;
      } else if (c === '*' || c === '_' || c === '~') {
        let j = i; while (src[j] === c) j += 1;
        const len = j - i;
        if (c === '~' && len !== 2) { buf += src.slice(i, j); i = j; continue; }
        const before = charKind(charBefore(src, i)), after = charKind(charAfter(src, j));
        const left = after !== 0 && (after !== 1 || before !== 2);
        const right = before !== 0 && (before !== 1 || after !== 2);
        const canOpen = c === '_' ? left && (!right || before === 1) : left;
        const canClose = c === '_' ? right && (!left || after === 1) : right;
        if (!canOpen && !canClose) { buf += src.slice(i, j); i = j; continue; }
        flush(); tokens.push({ t: 'delim', ch: c, n: len, orig: len, canOpen, canClose });
        i = j;
      } else if (c === '[' || c === '!') {
        const isImage = c === '!';
        if (isImage && src[i + 1] !== '[') { buf += '!'; i += 1; continue; }
        if (!isImage && (noLinks || depth >= 3)) { buf += '['; i += 1; continue; }
        const open = isImage ? i + 1 : i;
        ensureBrackets();
        const close = closeOf.has(open) ? closeOf.get(open) : -1;
        let result = null;
        if (close > open) {
          const inner = src.slice(open + 1, close);
          let url = null, title = null, end = close + 1;
          if (src[end] === '(') { const d = parseDestination(src, end + 1); if (d) { url = d.url; title = d.title; end = d.end; } }
          if (url === null && depth < 3 && ctx.refs.size) {
            let label = inner, labelEnd = end;
            if (src[end] === '[' && closeOf.has(end)) { const c2 = closeOf.get(end); label = src.slice(end + 1, c2) || inner; labelEnd = c2 + 1; }
            const ref = label.length <= 200 ? ctx.refs.get(normalizeLabel(label)) : null;
            if (ref) { url = ref.url; title = ref.title; end = labelEnd; }
          }
          if (url !== null) result = { inner, url, title, end };
        }
        if (!result) { buf += c; i += 1; continue; }
        if (isImage) {
          const norm = normalizeUrl(result.url);
          const alt = plainText(parseInline(result.inner, ctx, depth + 1, true)).trim();
          if (norm && !noLinks) pushLink(result.url, [{ t: 'text', v: imageLabel(alt, norm.href) }], { title: result.title, cls: 'rc-md-image' });
          else buf += alt;
        } else {
          const kids = parseInline(result.inner, ctx, depth + 1, true);
          if (!pushLink(result.url, kids, { title: result.title })) { flush(); tokens.push(...kids); }
        }
        i = result.end;
      } else if (c === '<') {
        const lim = Math.min(n, i + 2000);
        let j = i + 1;
        while (j < lim && src[j] !== '>' && src[j] !== '<' && !isSpaceCode(src.charCodeAt(j))) j += 1;
        let handled = false;
        if (src[j] === '>' && j > i + 1) {
          const inner = src.slice(i + 1, j);
          let url = null;
          if (ANGLE_SCHEME_RE.test(inner)) url = inner;
          else if (ANGLE_EMAIL_RE.test(inner)) url = 'mailto:' + inner;
          if (url !== null) {
            if (!noLinks && pushLink(url, [{ t: 'text', v: inner }], {})) { /* 已加入 */ } else buf += src.slice(i, j + 1);
            i = j + 1; handled = true;
          }
        }
        if (!handled) { buf += '<'; i += 1; }
      } else if (c === '&') {
        const e = decodeEntity(src, i);
        if (e) { buf += e.text; i += e.length; } else { buf += '&'; i += 1; }
      } else if (c === '\n') {
        let e = buf.length; while (e > 0 && buf[e - 1] === ' ') e -= 1;
        const hard = buf.length - e >= 2;
        buf = buf.slice(0, e);
        if (hard) { flush(); tokens.push({ t: 'br' }); } else buf += '\n';
        i += 1;
        while (src[i] === ' ' || src[i] === '\t') i += 1;
      } else { // h H w W：裸網址（http 或 https 協定開頭，或 www.）
        let consumed = false;
        const prev = i > 0 ? src[i - 1] : '';
        if (!noLinks && !/[A-Za-z0-9_]/.test(prev)) {
          const head = src.slice(i, i + 8).toLowerCase();
          const pre = head.startsWith('https://') ? 8 : head.startsWith('http://') ? 7 : head.startsWith('www.') ? 4 : 0;
          if (pre) {
            URL_END_RE.lastIndex = i + pre;
            const stop = URL_END_RE.exec(src);
            let end = stop ? stop.index : n;
            let opens = 0, closes = 0;
            for (let q = i; q < end; q += 1) { if (src[q] === '(') opens += 1; else if (src[q] === ')') closes += 1; }
            while (end > i + pre) {
              const t = src[end - 1];
              if ('?!.,:;*_~\'"'.includes(t)) end -= 1;
              else if (t === ')' && closes > opens) { closes -= 1; end -= 1; }
              else break;
            }
            if (end > i + pre) {
              const text = src.slice(i, end);
              if (pushLink(pre === 4 ? 'http://' + text : text, [{ t: 'text', v: text }], {})) { i = end; consumed = true; }
              else { buf += text; i = end; consumed = true; }
            }
          }
        }
        if (!consumed) { buf += c; i += 1; }
      }
    }
    flush();
    return resolveEmphasis(tokens);
  }

  // ------------------------------------------------------------------ 區塊解析

  function leading(line) {
    let cols = 0, i = 0;
    for (; i < line.length; i += 1) {
      const c = line.charCodeAt(i);
      if (c === 32) cols += 1;
      else if (c === 9) cols += 4 - (cols % 4);
      else break;
    }
    return { cols, idx: i };
  }
  /** 移除最多 n 欄的行首空白（Tab 以 4 欄計；切到 Tab 中間時以空白補足剩餘欄數）。 */
  function stripCols(line, n) {
    let cols = 0, i = 0;
    while (i < line.length && cols < n) {
      const c = line.charCodeAt(i);
      if (c === 32) { cols += 1; i += 1; }
      else if (c === 9) {
        const w = 4 - (cols % 4);
        if (cols + w > n) return ' '.repeat(cols + w - n) + line.slice(i + 1);
        cols += w; i += 1;
      } else break;
    }
    return line.slice(i);
  }
  const isBlank = (line) => /^[ \t]*$/.test(line);

  function fenceOpen(line) {
    const { cols, idx } = leading(line);
    if (cols > 3) return null;
    const ch = line[idx];
    if (ch !== '`' && ch !== '~') return null;
    let j = idx; while (line[j] === ch) j += 1;
    if (j - idx < 3) return null;
    const info = line.slice(j).trim();
    if (ch === '`' && info.indexOf('`') !== -1) return null;
    return { ch, len: j - idx, indent: cols, info };
  }
  function fenceClose(line, fence) {
    const { cols, idx } = leading(line);
    if (cols > 3) return false;
    let j = idx; while (line[j] === fence.ch) j += 1;
    return j - idx >= fence.len && isBlank(line.slice(j));
  }
  function atxHeading(line) {
    const { cols, idx } = leading(line);
    if (cols > 3) return null;
    let j = idx; while (line[j] === '#') j += 1;
    const level = j - idx;
    if (level < 1 || level > 6) return null;
    if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
    let text = line.slice(j).trim();
    let e = text.length; while (e > 0 && text[e - 1] === '#') e -= 1;
    if (e === 0) text = '';
    else if (e < text.length && (text[e - 1] === ' ' || text[e - 1] === '\t')) text = text.slice(0, e).trimEnd();
    return { level, text };
  }
  function isHr(line) {
    const { cols, idx } = leading(line);
    if (cols > 3) return false;
    const ch = line[idx];
    if (ch !== '-' && ch !== '*' && ch !== '_') return false;
    let count = 0;
    for (let i = idx; i < line.length; i += 1) {
      const c = line[i];
      if (c === ch) count += 1; else if (c !== ' ' && c !== '\t') return false;
    }
    return count >= 3;
  }
  function isQuote(line) { const { cols, idx } = leading(line); return cols <= 3 && line[idx] === '>'; }
  function stripQuote(line) {
    let i = leading(line).idx + 1;
    if (line[i] === ' ') i += 1; else if (line[i] === '\t') i += 1;
    return line.slice(i);
  }
  const setextLevel = (line) => {
    const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    return m ? (m[1][0] === '=' ? 1 : 2) : 0;
  };

  function listMarker(line) {
    const { cols, idx } = leading(line);
    if (cols > 3) return null;
    let j = idx, ordered = false, number = 0;
    const c = line[j];
    if (c === '-' || c === '*' || c === '+') j += 1;
    else if (c >= '0' && c <= '9') {
      while (line[j] >= '0' && line[j] <= '9') j += 1;
      if (j - idx > 9 || (line[j] !== '.' && line[j] !== ')')) return null;
      ordered = true; number = parseInt(line.slice(idx, j), 10); j += 1;
    } else return null;
    const markerLen = j - idx;
    const rest = line.slice(j);
    if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
    if (isBlank(rest)) return { cols, ordered, number, contentIndent: cols + markerLen + 1, first: '', empty: true };
    const sp = leading(rest);
    if (sp.cols >= 5) return { cols, ordered, number, contentIndent: cols + markerLen + 1, first: rest.slice(1), empty: false };
    return { cols, ordered, number, contentIndent: cols + markerLen + sp.cols, first: rest.slice(sp.idx), empty: false };
  }

  /** 這一行是否能打斷段落（以及作為懶惰續行的判斷）。 */
  function interrupts(line) {
    if (fenceOpen(line) || atxHeading(line) || isHr(line) || isQuote(line)) return true;
    const lm = listMarker(line);
    return !!lm && !lm.empty && (!lm.ordered || lm.number === 1);
  }

  function splitRow(line) {
    let s = line.trim();
    if (s[0] === '|') s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; }
      else if (c === '|') { cells.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }
  const DELIM_CELL = /^:?-+:?$/;
  function tableAt(lines, i) {
    const head = lines[i];
    if (head.indexOf('|') === -1 || i + 1 >= lines.length) return null;
    const delimLine = lines[i + 1];
    if (delimLine.indexOf('-') === -1 || delimLine.length > 2000 || head.length > 20000) return null;
    const delim = splitRow(delimLine);
    if (delim.length > MAX_TABLE_COLS || !delim.every((cell) => DELIM_CELL.test(cell))) return null;
    const headCells = splitRow(head);
    if (headCells.length !== delim.length) return null;
    const align = delim.map((cell) => (cell[0] === ':' && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell[0] === ':' ? 'left' : null));
    return { head: headCells, align };
  }

  const REF_DEF = /^ {0,3}\[((?:[^\\\]]|\\.){1,200})\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;
  function refDefinition(line) {
    if (line.length > 3000 || line.indexOf(']:') === -1) return null;
    const m = REF_DEF.exec(line);
    if (!m || m[1][0] === '^') return null;
    let url = m[2];
    if (url[0] === '<') url = url.slice(1, -1);
    return { label: normalizeLabel(m[1]), url: unescapeMd(url), title: m[3] ?? m[4] ?? m[5] ?? null };
  }

  const LANG_RE = /^[\w+#.\-]{1,32}$/;
  function codeBlock(lines, fence) {
    return { type: 'code', lang: LANG_RE.test((fence.info.split(/\s/)[0] || '')) ? fence.info.split(/\s/)[0] : '', text: lines.join('\n') };
  }

  function parseBlocks(lines, depth, ctx) {
    const blocks = [];
    const n = lines.length;
    let i = 0, gap = false;
    const push = (block) => { block.gapBefore = gap; gap = false; blocks.push(block); };

    while (i < n) {
      const line = lines[i];
      if (isBlank(line)) { if (blocks.length) gap = true; i += 1; continue; }

      if (depth > MAX_BLOCK_DEPTH) { // 巢狀過深：不再辨識容器，整段當段落
        const para = [];
        while (i < n && !isBlank(lines[i])) { para.push(lines[i].trim()); i += 1; }
        push({ type: 'paragraph', text: para.join('\n') });
        continue;
      }

      const fence = fenceOpen(line);
      if (fence) {
        const body = []; i += 1;
        while (i < n && !fenceClose(lines[i], fence)) { body.push(stripCols(lines[i], fence.indent)); i += 1; }
        if (i < n) i += 1;
        push(codeBlock(body, fence));
        continue;
      }

      if (leading(line).cols >= 4) { // 縮排程式碼
        const body = [];
        while (i < n && (isBlank(lines[i]) || leading(lines[i]).cols >= 4)) { body.push(stripCols(lines[i], 4)); i += 1; }
        while (body.length && isBlank(body[body.length - 1])) { body.pop(); }
        push({ type: 'code', lang: '', text: body.join('\n') });
        continue;
      }

      const heading = atxHeading(line);
      if (heading) { push({ type: 'heading', level: heading.level, text: heading.text }); i += 1; continue; }
      if (isHr(line)) { push({ type: 'hr' }); i += 1; continue; }

      if (isQuote(line)) {
        const inner = [];
        while (i < n) {
          const l = lines[i];
          if (isQuote(l)) { inner.push(stripQuote(l)); i += 1; continue; }
          const last = inner[inner.length - 1];
          if (!isBlank(l) && last !== undefined && !isBlank(last) && !interrupts(l) && !atxHeading(last) && !isHr(last)) { inner.push(l.trimStart()); i += 1; continue; }
          break;
        }
        push({ type: 'quote', blocks: parseBlocks(inner, depth + 1, ctx) });
        continue;
      }

      const lm = listMarker(line);
      if (lm) {
        const r = parseList(lines, i, depth, ctx);
        push(r.block); i = r.next;
        continue;
      }

      const table = tableAt(lines, i);
      if (table) {
        const rows = [];
        let j = i + 2;
        while (j < n && !isBlank(lines[j]) && !fenceOpen(lines[j]) && !atxHeading(lines[j]) && !isQuote(lines[j])) {
          const cells = splitRow(lines[j]);
          while (cells.length < table.head.length) cells.push('');
          rows.push(cells.slice(0, table.head.length));
          j += 1;
        }
        push({ type: 'table', align: table.align, head: table.head, rows });
        i = j;
        continue;
      }

      const def = refDefinition(line);
      if (def) { if (!ctx.refs.has(def.label)) ctx.refs.set(def.label, def); i += 1; continue; }

      // 段落（可能升級為 Setext 標題）
      const para = [line];
      let j = i + 1, setext = 0;
      while (j < n) {
        const l = lines[j];
        if (isBlank(l)) break;
        const level = setextLevel(l);
        if (level) { setext = level; j += 1; break; }
        if (interrupts(l) || tableAt(lines, j)) break;
        para.push(l); j += 1;
      }
      const text = para.map((l) => l.trimStart()).join('\n').trimEnd();
      push(setext ? { type: 'heading', level: setext, text } : { type: 'paragraph', text });
      i = j;
    }
    return blocks;
  }

  function parseList(lines, start, depth, ctx) {
    const n = lines.length;
    const first = listMarker(lines[start]);
    const ordered = first.ordered;
    const items = [];
    let loose = false, j = start;

    while (j < n) {
      const lm = listMarker(lines[j]);
      if (!lm || lm.ordered !== ordered || isHr(lines[j])) break;
      const markerCols = lm.cols, contentIndent = lm.contentIndent;
      const itemLines = [lm.first];
      let fence = fenceOpen(lm.first);
      const track = (l) => { if (fence) { if (fenceClose(l, fence)) fence = null; } else fence = fenceOpen(l); };
      let k = j + 1;
      while (k < n) {
        const l = lines[k];
        if (isBlank(l)) {
          let m = k + 1; while (m < n && isBlank(lines[m])) m += 1;
          if (m >= n || (lm.empty && itemLines.length === 1) || leading(lines[m]).cols < contentIndent) break;
          for (let b = k; b < m; b += 1) itemLines.push('');
          k = m; continue;
        }
        const ind = leading(l).cols;
        if (ind >= contentIndent) { const s = stripCols(l, contentIndent); itemLines.push(s); track(s); k += 1; continue; }
        if (fence) break;
        const lm2 = listMarker(l);
        if (lm2 && !isHr(l)) {
          if (lm2.ordered !== ordered && ind > markerCols) { // 有序項目下以較少縮排接無序清單：視為巢狀
            itemLines.push(stripCols(l, ind)); k += 1; continue;
          }
          break;
        }
        const last = itemLines[itemLines.length - 1];
        if (!isBlank(last) && !interrupts(l) && !atxHeading(last) && !isHr(last)) { itemLines.push(l.trimStart()); k += 1; continue; }
        break;
      }
      items.push({ blocks: parseBlocks(itemLines, depth + 1, ctx) });
      j = k;
      // 下一個同類型項目？
      let m = j; while (m < n && isBlank(lines[m])) m += 1;
      const next = m < n ? listMarker(lines[m]) : null;
      if (next && next.ordered === ordered && !isHr(lines[m])) { if (m > j) loose = true; j = m; } else break;
    }

    for (const item of items) {
      if (item.blocks.some((b, idx) => idx > 0 && b.gapBefore)) loose = true;
      const head = item.blocks[0];
      if (head && head.type === 'paragraph') {
        const t = /^\[([ xX])\](?:[ \t]+|$)/.exec(head.text);
        if (t) { item.task = t[1] === ' ' ? 'open' : 'done'; head.text = head.text.slice(t[0].length); head.task = item.task; }
      }
    }
    return { block: { type: 'list', ordered, start: ordered ? first.number : 1, loose, items }, next: j };
  }

  // ------------------------------------------------------------------ DOM 建立（只用 createElement / createTextNode / setAttribute）

  function add(parent, child) { if (typeof parent.appendChild === 'function') parent.appendChild(child); else parent.append(child); return child; }
  function make(doc, tag, attrs) {
    const el = doc.createElement(tag);
    if (attrs) for (const key of Object.keys(attrs)) if (attrs[key] !== null && attrs[key] !== undefined) el.setAttribute(key, attrs[key]);
    return el;
  }
  const textNode = (doc, text) => doc.createTextNode(text);

  function emitInline(doc, parent, nodes) {
    for (const node of nodes) {
      switch (node.t) {
        case 'text': add(parent, textNode(doc, node.v)); break;
        case 'code': { const el = add(parent, make(doc, 'code')); if (node.v) add(el, textNode(doc, node.v)); break; }
        case 'br': add(parent, make(doc, 'br')); break;
        case 'em': case 'strong': case 'del': emitInline(doc, add(parent, make(doc, node.t)), node.kids); break;
        case 'link': {
          const a = make(doc, 'a', {
            class: node.cls, 'data-action': node.kind === 'anchor' ? ANCHOR_ACTION : EXTERNAL_ACTION,
            'data-href': node.href, role: 'link', tabindex: '0', title: node.title });
          add(parent, a);
          emitInline(doc, a, node.kids);
          break;
        }
        default: break;
      }
    }
  }
  const inlineInto = (doc, parent, text, ctx) => emitInline(doc, parent, parseInline(text, ctx, 0, false));

  function emitParagraphContent(doc, parent, block, ctx) {
    if (block.task) {
      const box = { type: 'checkbox', disabled: '' };
      if (block.task === 'done') box.checked = '';
      add(parent, make(doc, 'input', box));
      add(parent, textNode(doc, ' '));
    }
    inlineInto(doc, parent, block.text, ctx);
  }

  function emitBlocks(doc, parent, blocks, ctx, tight) {
    for (const block of blocks) {
      switch (block.type) {
        case 'heading': {
          const nodes = parseInline(block.text, ctx, 0, false);
          let slug = slugify(plainText(nodes));
          if (slug) {
            const seen = ctx.slugs.get(slug) || 0;
            ctx.slugs.set(slug, seen + 1);
            if (seen) slug = slug + '-' + seen;
          }
          const h = add(parent, make(doc, 'h' + block.level, { 'data-anchor': slug || null }));
          emitInline(doc, h, nodes);
          break;
        }
        case 'paragraph':
          if (tight) emitParagraphContent(doc, parent, block, ctx);
          else emitParagraphContent(doc, add(parent, make(doc, 'p')), block, ctx);
          break;
        case 'code': {
          const pre = add(parent, make(doc, 'pre'));
          const code = add(pre, make(doc, 'code', block.lang ? { class: 'language-' + block.lang, 'data-lang': block.lang } : null));
          if (block.text) add(code, textNode(doc, block.text));
          break;
        }
        case 'quote': emitBlocks(doc, add(parent, make(doc, 'blockquote')), block.blocks, ctx, false); break;
        case 'hr': add(parent, make(doc, 'hr')); break;
        case 'list': {
          const hasTask = block.items.some((it) => it.task);
          const attrs = { class: hasTask ? 'rc-md-tasks' : null };
          if (block.ordered && block.start !== 1) attrs.start = String(block.start);
          const list = add(parent, make(doc, block.ordered ? 'ol' : 'ul', attrs));
          for (const item of block.items) {
            emitBlocks(doc, add(list, make(doc, 'li', { class: item.task ? 'rc-md-task' : null })), item.blocks, ctx, !block.loose);
          }
          break;
        }
        case 'table': {
          const wrap = add(parent, make(doc, 'div', { class: 'rc-md-table-wrap' }));
          const table = add(wrap, make(doc, 'table'));
          const row = (section, tag, cells) => {
            const tr = add(section, make(doc, 'tr'));
            cells.forEach((cell, idx) => inlineInto(doc, add(tr, make(doc, tag, { 'data-align': block.align[idx] })), cell, ctx));
          };
          row(add(table, make(doc, 'thead')), 'th', block.head);
          if (block.rows.length) { const body = add(table, make(doc, 'tbody')); for (const cells of block.rows) row(body, 'td', cells); }
          break;
        }
        default: break;
      }
    }
  }

  function render(markdown, doc) {
    const container = make(doc, 'div', { class: 'rc-markdown' });
    if (typeof markdown !== 'string' || !markdown) return container;
    let source = markdown.length > MAX_INPUT ? markdown.slice(0, MAX_INPUT) : markdown;
    source = source.replace(/^﻿/, '').replace(/\u0000/g, '�').replace(/\r\n?/g, '\n');
    const ctx = { refs: new Map(), slugs: new Map() };
    const blocks = parseBlocks(source.split('\n'), 0, ctx);
    emitBlocks(doc, container, blocks, ctx, false);
    if (markdown.length > MAX_INPUT) emitBlocks(doc, container, [{ type: 'paragraph', text: '（內容過長，已截斷）' }], ctx, false);
    return container;
  }

  const api = { render, slugify, normalizeUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RcMarkdown = api;
})(typeof window !== 'undefined' ? window : null);
