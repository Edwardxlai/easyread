/* 行内与块级标记：$TeX$ / \(TeX\)、**粗体**、*斜体*、`代码`、[n] 引用、[Jimenez et al., 2024](#cite:Jimenez-2024) 作者-年份引用，
   以及 [表 3](#tab:3) 这样指向论文里图表、公式、章节的链接。块级 Markdown 由 markdown-it 解析，保留前置公式/代码/引用保护。 */
(function (PR) {
  "use strict";
  // 先识别代码、完整公式和链接，避免分段、Markdown 和表格的 | 拆坏 TeX。
  // For numeric openers, a dollar introducing another price or following prose is not a close.
  const TOKENS = new RegExp([
    /(?<!\\)(`+)([\s\S]*?)\1/.source,  // i18n-ok: code span pattern
    /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/.source,
    /(?<![\\$])\$(?!\$)((?![0-9])(?:\\\$|[^$])+?|[0-9](?:\\\$|[^$])*?(?<![\s，。；、：（(\u3400-\u9fff])(?=\$(?![0-9])))(?<!\\)\$(?!\$)/.source,
    /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/.source,
    /(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/.source,
    /(?<!\\)\[((?:\\.|[^\[\]\\\n])+)\]\(((?:[^\s()<>]|\([^\s()<>]*\))+)\)/.source,
  ].join("|"), "g");
  const mathCache = new Map();

  function dedentFence(body, text, offset) {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    if (!prefix || !/^(?:[ \t]|>[ \t]*)+$/.test(prefix)) return body;
    const qDepth = (prefix.match(/>/g) || []).length;
    const indentRe = new RegExp("^[ \\t]{1," + prefix.replace(/>/g, " ").length + "}");
    const lines = body.split("\n");
    return lines.map((line, i) => {
      if (i === lines.length - 1 && /^(?:[ \t]|>[ \t]*)*$/.test(line)) return "";
      if (line.startsWith(prefix)) return line.slice(prefix.length);
      if (qDepth) {
        let s = line;
        for (let q = 0; q < qDepth; q++) s = s.replace(/^[ \t]*>[ \t]?/, "");
        return s;
      }
      return line.replace(indentRe, "");
    }).join("\n");
  }

  function tokens(text, blocks) {
    let prefix = "\uE000";
    while (text.includes(prefix)) prefix += "\uE000";
    const values = [];
    const masked = text.replace(TOKENS, (raw, ticks, code, dollarBlock, dollarInline, bracketBlock, parenInline, linkLabel, linkUrl, offset, whole) => {
      if (linkLabel != null) {
        values.push({ raw, text: linkLabel.replace(/\\([\[\]\\])/g, "$1"), link: linkUrl });
        return prefix + (values.length - 1) + "I\uE001";
      }
      const display = ticks ? ticks.length >= 3 && code.includes("\n") : dollarBlock != null || bracketBlock != null;
      let body = ticks ? (display ? code.replace(/^[\w+-]*\r?\n/, "") : code) : dollarBlock ?? dollarInline ?? bracketBlock ?? parenInline;
      if (ticks && display) body = dedentFence(body, whole, offset);
      values.push({ raw, text: body, code: !!ticks, display });
      return prefix + (values.length - 1) + (blocks && display ? "B" : "I") + "\uE001";
    });
    return { prefix, text: masked, values, inline: new RegExp(prefix + "(\\d+)I\\uE001", "g"), blocks: new RegExp(prefix + "(\\d+)B\\uE001", "g") };
  }

  // 论文内部链接由模型按原文写出：[图 3](#fig:3)、第 [2.1](#sec:2.1) 节、[代码清单 3](#lst:3)、[Jimenez 等人（2024）](#cite:Jimenez-2024)。
  // 类型:编号 查 PR.xindex（render.js 按块的编号建），cite:键 查参考文献；查不到、或这里不该有链接（opts.xref/cite === false）就只留文字
  const INTERNAL = /^#(fig|tab|eq|sec|alg|lst):(.+)$/;
  function tokenHtml(t, block, opts) {
    if (t.footnote != null) return footnoteAnchor(t.footnote, opts || {});
    if (t.link && /^#b-[\w-]+$/.test(t.link)) return '<a href="' + PR.esc(t.link) + '">' + PR.esc(t.text) + '</a>';
    if (t.link && t.link.startsWith("#")) {
      opts = opts || {};
      if (t.link.startsWith("#cite:")) {
        const ref = opts.cite !== false && PR.citeTarget(t.link.slice(6));
        return ref ? '<a class="cite" data-ref="' + PR.esc(ref) + '">' + PR.esc(t.text) + "</a>" : PR.esc(t.text);
      }
      const m = t.link.match(INTERNAL);
      return m && opts.xref !== false ? xref(m[1], m[2], PR.esc(t.text)) : PR.esc(t.text);
    }
    if (t.link) {
      if (!/^(https?:\/\/|mailto:)/i.test(t.link) || /[\x00-\x20\x7f]/.test(t.link)) return PR.esc(t.raw);
      try {
        const url = new URL(t.link);
        if (url.protocol !== "mailto:" && !url.hostname) return PR.esc(t.raw);
        return '<a class="external-link" href="' + PR.esc(url.href) + '" target="_blank" rel="noopener noreferrer">' + PR.esc(t.text) + '</a>';
      } catch (e) { return PR.esc(t.raw); }
    }
    if (t.code) return (t.display ? "<pre><code>" : "<code>") + PR.esc(t.text) + (t.display ? "</code></pre>" : "</code>");
    const html = PR.tex(t.display ? t.text.trim() : t.text, t.display);
    return block ? '<div class="eq">' + html + "</div>" : html;
  }

  function restore(s, saved, raw, opts) {
    s = s.replace(saved.inline, (m, i) => raw ? saved.values[i].raw : tokenHtml(saved.values[i], false, opts));
    if (!raw && saved.blocks) s = s.replace(saved.blocks, (m, i) => tokenHtml(saved.values[i], true, opts));
    return s;
  }

  /* [表 3](#tab:3) -> 表 3：拿到阅读页以外（导出的 Markdown）时，指向论文里的链接没有去处，只留文字 */
  PR.unlink = (text) => String(text || "").replace(/(?<!\\)\[((?:\\.|[^\[\]\\\n])+)\]\(#(?!b-)[^)\s]*\)/g, (m, words) => words.replace(/\\([\[\]\\])/g, "$1"));

  PR.tex = function (tex, display) {
    const key = (display ? "D" : "I") + tex;
    if (mathCache.has(key)) return mathCache.get(key);
    let html;
    try {
      html = katex.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: "ignore", trust: false });
    } catch (e) {
      html = '<code title="' + PR.t("公式渲染失败") + '">' + PR.esc(tex) + "</code>";
    }
    mathCache.set(key, html);
    return html;
  };

  // Titles allow math, but preserve literal Markdown punctuation and links.
  PR.titleHtml = function (text) {
    const saved = tokens(String(text == null ? "" : text), false);
    return PR.esc(saved.text).replace(saved.inline, (match, index) => {
      const token = saved.values[index];
      return token.code || token.link ? PR.esc(token.raw) : PR.tex(token.text, false);
    });
  };

  // Web snapshots already have their own HTML formatting. Only replace math;
  // do not interpret Markdown, links or code that happen to occur in their text.
  PR.webMathHtml = function (text) {
    const saved = tokens(String(text == null ? "" : text), false);
    return PR.esc(saved.text).replace(saved.inline, (match, index) => {
      const token = saved.values[index];
      return token.code || token.link ? PR.esc(token.raw) : tokenHtml(token, false);
    });
  };

  const superscriptNumber = /^[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}/;
  function noteNumber(b) {
    if (b.type !== "para") return "";
    const num = footnoteNum(b.num || "");
    if (b.role === "footnote" && /^(\d{1,3}|[*†‡§¶]{1,3})$/.test(num)) return num;
    // Older papers used ids such as fn3-1 (the suffix is a sequence, not the note number).
    if (!/^fn(?:\d|[-_])/.test(b.id) && b.role !== "footnote") return "";
    const text = String(b.en || b.zh || "").trimStart();
    return text.match(superscriptNumber)?.[0].normalize("NFKC") ||
      text.match(/^\$\^\{?(\d{1,3})\}?\$/)?.[1] || text.match(/^(\d{1,3})(?!\d)/)?.[1] || "";
  }
  PR.buildFootnoteIndex = function (blocks) {
    const index = { pages: new Map(), all: new Map() };
    const add = (map, key, id) => map.set(key, map.has(key) ? null : id);
    for (const b of blocks || []) {
      const n = noteNumber(b);
      if (!n) continue;
      add(index.pages, b.page + ":" + n, b.id);
      add(index.all, n, b.id);
    }
    PR.footnoteIndex = index;
  };
  PR.footnoteOptions = function (key) {
    const b = (PR.blockById || {})[String(key).split("#")[0]];
    if (!b) return {};
    return { footnotePage: b.page };
  };

  // Author/year references are linked only when the first author and year
  // identify exactly one bibliography entry. Ambiguous citations stay plain.
  PR.buildCitationIndex = function (refs) {
    const index = new Map();
    for (const ref of refs || []) {
      const text = String(ref.text || ""), first = text.split(",")[0].split(/\s+and\s+/i)[0].split(/(?<=[\p{L}]{2})\.\s/u)[0];
      const author = (first.match(/[\p{L}][\p{L}'’-]*/gu) || []).pop();
      const years = [...text.matchAll(/\b(?:19|20)\d{2}[a-z]?\b/gi)].map(m => m[0].toLowerCase());
      const bases = new Set(years.map(y => y.slice(0, 4)));
      const suffixed = new Set(years.filter(y => y.length === 5));
      // A publication year cannot be inferred safely when the entry mentions
      // different years (for example, an access date or an earlier edition).
      if (!author || bases.size !== 1 || suffixed.size > 1) continue;
      const year = suffixed.size ? [...suffixed][0] : [...bases][0];
      const key = author.toLowerCase() + ":" + year;
      if (index.has(key)) index.set(key, null); else index.set(key, String(ref.id));
    }
    PR.citationIndex = index;
  };
  function citeAnchor(id, label) {
    return '<a class="cite" href="#ref-' + PR.esc(id) + '" data-ref="' + PR.esc(id) + '">' + label + '</a>';
  }
  /* 引用键（Jimenez-2024、Chen-Jiang-2025、JYW+24、13）：模型按论文印出来的标签写，参考文献条目的 id 和正文的 #cite:键 同一个写法。
     比对时不看大小写、标点和重音。样式不同，et al. 前列几位作者也不同，所以对不上时退一步按“第一作者-年份”找，只有一条才算 */
  const citeParts = (key) => String(key || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/-+/).map((p) => p.replace(/[^\p{L}\p{M}\p{N}+]/gu, "")).filter(Boolean);
  const looseKey = (parts) => (parts.length > 1 && /^\d{4}[a-z]?$/.test(parts[parts.length - 1]) ? parts[0] + "-" + parts[parts.length - 1] : "");
  PR.buildCiteIndex = function (references) {
    const exact = new Map(), loose = new Map();
    const add = (map, key, id) => { if (key) map.set(key, map.has(key) ? null : id); };
    for (const r of references || []) {
      const id = String(r.id || "");
      if (!id) continue;
      const parts = citeParts(r.cite_key || id);
      add(exact, parts.join("-"), id);
      add(loose, looseKey(parts), id);
    }
    PR.citeIndex = { exact, loose };
  };
  PR.citeTarget = function (key) {
    const ix = PR.citeIndex, parts = citeParts(key);
    if (!ix || !parts.length) return "";
    const exact = parts.join("-");
    return (ix.exact.has(exact) ? ix.exact.get(exact) : ix.loose.get(looseKey(parts))) || "";
  };
  /* 参考文献表左边那一列：编号式、字母标签式印着 [13]、[JYW+24]；作者-年份式（键以年份结尾）和程序补的 id 不印 */
  PR.refLabel = (id) => (id && (/^\d+[a-z]?$/.test(id) || !/\d{4}[a-z]?$|^r[0-9a-f]{8}x*$/.test(id)) ? "[" + id + "]" : "");

  function citeLinks(s) {
    // Exact reference IDs support numeric and alphanumeric labels, including +.
    const matches = key => PR.refById && Object.hasOwn(PR.refById, key) && (!PR.citeIndex || PR.citeTarget(key) === key);
    s = s.replace(/\[([^\]\n]{1,160})\]/g, (raw, inner) => {
      const parts = inner.split(/(\s*[,，;；–-]\s*)/);
      const ids = parts.filter((_, i) => i % 2 === 0);
      if (!ids.some(matches) ||
          !ids.every(p => /^\d+$/.test(p) || matches(p))) return raw;
      return "[" + parts.map(p => matches(p) ? citeAnchor(p, p) : p).join("") + "]";
    });
    // Parenthetical and narrative citations: Smith et al., 2020 or Smith (2020).
    return s.replace(/(?<![\p{L}\d])([\p{Lu}][\p{L}'’-]+)(?:\s+(?:et al\.|(?:and|&amp;)\s+[\p{Lu}][\p{L}'’-]+))?\s*(?:,\s*|\(\s*)((?:19|20)\d{2}[a-z]?)(\)?)/gu,
      (raw, author, year) => {
        const id = PR.citationIndex && PR.citationIndex.get(author.toLowerCase() + ":" + year.toLowerCase());
        return id ? citeAnchor(id, raw) : raw;
      });
  }

  function xref(kind, key, label) {
    const index = PR.xindex && PR.xindex[kind];
    return index && Object.hasOwn(index, key) && index[key]
      ? '<a class="xref" data-kind="' + kind + '" data-key="' + PR.esc(key) + '">' + label + "</a>" : label;
  }

  // 已译论文里的纯文字仍可跳转；显式 Markdown 链接、代码和公式已经由 tokens 隔开。
  function legacyXrefs(text) {
    text = text.replace(/公式\s*[（(]\d+[）)](?:\s*(?:和|与|及|、|或|,|，)\s*[（(]\d+[）)])*/g,
      (m) => m.replace(/[（(](\d+)[）)]/g, (label, n) => xref("eq", n, label)));
    text = text.replace(/公式\s*(\d+)(?![\d.）)])/g, (m, n) => xref("eq", n, m));
    text = text.replace(/(?<!列)表\s*(\d+)/g, (m, n) => xref("tab", n, m));
    text = text.replace(/图\s*(\d+)/g, (m, n) => xref("fig", n, m));
    text = text.replace(/第\s*(\d+(?:\.\d+)*)\s*节/g, (m, n) => xref("sec", n, m));
    text = text.replace(/附录\s*([A-Z])(?![a-zA-Z])/g, (m, n) => xref("sec", n, m));
    text = text.replace(/\b(Equations?)\s+(\d+)(?:\s+(and)\s+(\d+))?/g, (m, w, a, and, b) =>
      w + " " + xref("eq", a, a) + (b ? " " + and + " " + xref("eq", b, b) : ""));
    text = text.replace(/\bTable\s+(\d+)/g, (m, n) => xref("tab", n, m));
    text = text.replace(/\bFigure\s+(\d+)/g, (m, n) => xref("fig", n, m));
    text = text.replace(/\bSection\s+(\d+(?:\.\d+)*)/g, (m, n) => xref("sec", n, m));
    return text.replace(/\bAppendix\s+([A-Z])\b/g, (m, n) => xref("sec", n, m));
  }

  /* AI 回答里偶尔会带出段落编号 [p4-5]、[eq7]，换成读者看得懂的“式 7”“第 4 页” */
  function blockLabel(s) {
    return s.replace(/\[([a-z]+\d*(?:-[\w-]+)?)\]/g, (m, id) => {
      const b = PR.blockById && PR.blockById[id];
      if (!b) return m;
      return b.type === "math" && b.tag ? PR.t("（式 {tag}）", { tag: b.tag }) : b.page ? PR.t("（第 {page} 页）", { page: b.page }) : m;
    });
  }

  /* 脚注标记 [^13]，符号脚注 [^*]、[^†]（∗ 当 * 算）。要在粗体斜体之前保护：[^*] 里的星号不能被当成斜体的一半 */
  const FOOTNOTE = /(?<!\\)\[\^(\d{1,3}|[*∗†‡§¶]{1,3})\]/g;
  const footnoteNum = (n) => String(n).replace(/∗/g, "*");
  function footnoteAnchor(mark, opts) {
    const n = footnoteNum(mark), ix = PR.footnoteIndex, key = opts.footnotePage + ":" + n;
    const id = ix && (ix.pages.has(key) ? ix.pages.get(key) : ix.all.get(n));
    const label = "<sup>" + n.replace(/\*/g, "&#42;") + "</sup>";
    return id ? '<a class="footnote-ref" href="#b-' + PR.esc(id) + '" data-footnote="b-' + PR.esc(id) + '">' + label + "</a>" : label;
  }

  function maskFootnotes(saved) {
    saved.text = saved.text.replace(FOOTNOTE, (raw, mark) => {
      saved.values.push({ raw, footnote: mark });
      return saved.prefix + (saved.values.length - 1) + "I\uE001";
    });
  }

  function applySuperscriptNotes(saved, opts) {
    // Some older translations have literal superscripts instead of [^n]. Only use a
    // same-page note after prose. Keep standalone powers, units, code and full TeX intact.
    const noteHere = n => PR.footnoteIndex?.pages.get(opts.footnotePage + ":" + n);
    if (opts.footnotePage != null && PR.footnoteIndex) {
      const proseEnd = /(?:[.。！？!?，,；;：:][ \t]*|(?:^|[\s(])[A-Za-z]{3,}|[\u3400-\u9fff]{2,})$/;
      const inProse = (s, i) => proseEnd.test(s.slice(Math.max(0, i - 80), i));
      saved.text = saved.text.replace(saved.inline, (raw, i, at, str) => {
        const token = saved.values[i];
        const n = !token.code && !token.link && !token.display && token.text.match(/^\^(?:\{(\d{1,3})\}|(\d))$/);
        const num = n && (n[1] || n[2]);
        return num && noteHere(num) && inProse(str, at) ? "[^" + num + "]" : raw;
      }).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (raw, at, str) => {
        const num = raw.normalize("NFKC");
        return noteHere(num) && inProse(str, at) ? "[^" + num + "]" : raw;
      });
    }
  }

  function renderPlainSegment(chunk, opts) {
    if (!chunk) return "";
    let s = blockLabel(PR.esc(chunk));
    if (opts.xref !== false) s = legacyXrefs(s);
    if (opts.cite !== false) s = citeLinks(s);
    return s;
  }

  function renderPlainText(text, env) {
    const saved = env && env.saved, opts = (env && env.opts) || {};
    if (!saved) return renderPlainSegment(text, opts);
    return text.split(saved.inline).map((part, i) => (i % 2 ? saved.prefix + part + "I\uE001" : renderPlainSegment(part, opts))).join("");
  }

  function prepareBlockMarkdown(saved) {
    let text = saved.text;
    // 中文顿号编号或实心圆点列表（如 “1、 第一步”“• 要点”）转为标准列表语法
    text = text.replace(/^([ \t]*(?:>[ \t]*)*)(\d+)、[ \t]+/gm, "$1$2. ").replace(/^([ \t]*(?:>[ \t]*)*)•[ \t]+/gm, "$1- ");
    // 行间块标记（$$...$$、\[...\]、围栏代码块）占独立行，便于在列表/引用内正确成块
    const blockRe = new RegExp("(" + saved.prefix + "\\d+B\\uE001)", "g");
    return text.split("\n").map((line) => {
      if (!blockRe.test(line)) return line;
      blockRe.lastIndex = 0;
      if (line.includes("|") && !/^\s*\uE000+\d+B\uE001\s*$/.test(line)) return line;
      const listMatch = line.match(/^([ \t]*(?:>[ \t]*)*)((?:[-+*]|\d{1,9}[.)])[ \t]+)/);
      const contPrefix = listMatch
        ? listMatch[1] + " ".repeat(listMatch[2].length)
        : (line.match(/^([ \t]*(?:>[ \t]*)+|[ \t]+)/) || ["", ""])[1];
      const prefixOnlyRe = /^([ \t]*(?:>[ \t]*)*)$/;
      return line.replace(blockRe, (tok, _g, off) => {
        const before = line.slice(0, off);
        const after = line.slice(off + tok.length);
        const needBefore = before.trim() && !prefixOnlyRe.test(before);
        const needAfter = after.trim();
        return (needBefore ? "\n" + contPrefix : "") + tok + (needAfter ? "\n" + contPrefix : "");
      });
    }).join("\n");
  }

  let mdEngine = null;
  function markdown() {
    if (mdEngine) return mdEngine;
    if (!PR.MarkdownIt) return null;
    const md = new PR.MarkdownIt({ html: false, breaks: true, linkify: false });
    md.validateLink = (url) => /^(https?:\/\/|mailto:|#)/i.test(String(url || "").trim());

    const StateInline = md.inline.State;
    if (!StateInline.prototype._erCjkPatched) {
      const origScan = StateInline.prototype.scanDelims;
      const isCjkOrFull = (c) => (c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFFEF) || (c >= 0x20000 && c <= 0x2FA1F);
      const isCjkPunct = (c) => (c >= 0x2010 && c <= 0x2027) || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF01 && c <= 0xFF0F) || (c >= 0xFF1A && c <= 0xFF20) || (c >= 0xFF3B && c <= 0xFF40) || (c >= 0xFF5B && c <= 0xFF65);
      const isSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D || c === 0x3000;
      const codePointBefore = (src, index) => {
        if (index <= 0) return 0x20;
        const c = src.charCodeAt(index - 1);
        if (c >= 0xDC00 && c <= 0xDFFF && index >= 2) {
          const h = src.charCodeAt(index - 2);
          if (h >= 0xD800 && h <= 0xDBFF) return 0x10000 + ((h - 0xD800) << 10) + (c - 0xDC00);
        }
        return c;
      };
      StateInline.prototype.scanDelims = function (start, canSplitWord) {
        const res = origScan.call(this, start, canSplitWord);
        const marker = this.src.charCodeAt(start);
        if (marker !== 0x2A && marker !== 0x5F) return res;
        let pos = start;
        while (pos < this.posMax && this.src.charCodeAt(pos) === marker) pos++;
        const prev = codePointBefore(this.src, start);
        const next = pos < this.posMax ? this.src.codePointAt(pos) : 0x20;
        const prevCjkP = isCjkPunct(prev), nextCjkP = isCjkPunct(next);
        const prevCjk = isCjkOrFull(prev) && !prevCjkP;
        const nextCjk = isCjkOrFull(next) && !nextCjkP;
        if (prevCjk && !isSpace(next) && nextCjkP) res.can_open = true;
        if (nextCjk && !isSpace(prev) && prevCjkP) res.can_close = true;
        if (nextCjkP && !isSpace(prev)) res.can_open = true;
        if (prevCjkP && !isSpace(next)) res.can_close = true;
        if (marker === 0x2A && prevCjk && nextCjk) { res.can_open = true; res.can_close = true; }
        return res;
      };
      StateInline.prototype._erCjkPatched = true;
    }

    md.block.ruler.before("code", "er_block", function (state, startLine, _endLine, silent) {
      const pos = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      const line = state.src.slice(pos, max).trim();
      if (!/^\uE000+\d+B\uE001$/.test(line)) return false;
      if (silent) return true;
      const token = state.push("er_block", "", 0);
      token.content = line;
      token.map = [startLine, startLine + 1];
      state.line = startLine + 1;
      return true;
    }, { alt: ["paragraph", "reference", "blockquote", "list"] });

    md.renderer.rules.er_block = (toks, idx) => toks[idx].content + "\n";
    md.renderer.rules.heading_open = (toks, idx, options, _env, self) => {
      toks[idx].attrJoin("class", "md-h");
      return self.renderToken(toks, idx, options);
    };
    md.renderer.rules.table_open = () => '<div class="tbl-wrap"><table class="tbl">\n';
    md.renderer.rules.table_close = () => "</table></div>\n";
    md.renderer.rules.text = (toks, idx, _options, env) => renderPlainText(toks[idx].content, env);

    md.core.ruler.after("inline", "er_task_list", (state) => {
      const toks = state.tokens;
      for (let i = 2; i < toks.length; i++) {
        if (toks[i].type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
        const m = toks[i].content.match(/^\[([ xX])\]\s+/);
        if (!m || !toks[i].children || !toks[i].children.length || toks[i].children[0].type !== "text") continue;
        const first = toks[i].children[0];
        if (!/^\[([ xX])\]\s+/.test(first.content)) continue;
        first.content = first.content.replace(/^\[([ xX])\]\s+/, "");
        toks[i - 2].attrJoin("class", "task-list-item");
        const cb = new state.Token("html_inline", "", 0);
        cb.content = '<input type="checkbox" disabled' + (m[1].toLowerCase() === "x" ? " checked" : "") + "> ";
        toks[i].children.unshift(cb);
      }
    });

    mdEngine = md;
    return mdEngine;
  }

  /* 最小兜底：极简测试环境未加载 markdown-it.js 时保持基础渲染 */
  function fallbackInline(text, opts) {
    let s = renderPlainSegment(text.replace(/\\\$/g, "$"), opts);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    return s.replace(/\n/g, "<br>");
  }

  /* 一行/一段文字 -> HTML */
  PR.md = function (text, opts) {
    opts = opts || {};
    text = String(text == null ? "" : text);
    const saved = tokens(text, false);
    applySuperscriptNotes(saved, opts);
    maskFootnotes(saved);
    const md = markdown();
    const html = md ? md.renderInline(saved.text, { saved, opts }) : fallbackInline(saved.text, opts);
    return restore(html, saved, false, opts);
  };

  /* 块级 Markdown（AI 对话、页边讨论、笔记预览） */
  PR.mdBlocks = function (text, opts) {
    opts = opts || {};
    const src = String(text || "").trim();
    if (!src) return "";
    const saved = tokens(src, true);
    maskFootnotes(saved);
    const md = markdown();
    const html = md
      ? md.render(prepareBlockMarkdown(saved), { saved, opts })
      : saved.text.split(saved.blocks).map((part, i) => (i % 2 ? tokenHtml(saved.values[part], true, opts) :
          part.split(/\n\s*\n/).map((p) => (p.trim() ? "<p>" + fallbackInline(p.trim(), opts) + "</p>" : "")).join(""))).join("");
    return restore(html, saved, false, opts);
  };

  /* 去掉标记的纯文字，给目录、列表摘要用 */
  PR.plain = (text) => {
    const saved = tokens(String(text || ""), false);
    return saved.text.replace(saved.inline, (m, i) => saved.values[i].text).replace(/\*\*|`/g, "");
  };
})(window.PR);
