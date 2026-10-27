/* 划线锚定（参考 Hypothesis 的 TextQuote：原话 + 前后文）和选中文字后的浮动条。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const SKIP = ".katex-mathml, .stale-tag, button, .en-title, .num";

  function textNodes(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n; (n = w.nextNode());) out.push(n);
    return out;
  }
  const fullText = (root) => textNodes(root).map((t) => t.data).join("");
  PR.fullText = fullText;

  function offsetOf(root, container, offset) {
    let pos = 0;
    for (const t of textNodes(root)) {
      if (t === container) return pos + offset;
      const r = document.createRange();
      r.selectNodeContents(t);
      if (r.comparePoint(container, offset) < 0) return pos;
      pos += t.data.length;
    }
    return pos;
  }

  function findQuote(text, q, prefix, suffix) {
    if (!q) return -1;
    let best = -1, bestScore = -1;
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
      let score = 0;
      if (prefix && text.slice(Math.max(0, i - prefix.length), i).endsWith(prefix.slice(-8))) score += 2;
      if (suffix && text.slice(i + q.length, i + q.length + suffix.length).startsWith(suffix.slice(0, 8))) score += 2;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return best;
  }

  function wrap(root, start, end, attrs) {
    let pos = 0;
    for (const t of textNodes(root)) {
      const a = pos, b = pos + t.data.length;
      pos = b;
      if (b <= start || a >= end) continue;
      let node = t;
      const s = Math.max(start, a) - a, e = Math.min(end, b) - a;
      if (e < node.data.length) node.splitText(e);
      if (s > 0) node = node.splitText(s);
      const m = document.createElement("mark");
      for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
      node.parentNode.insertBefore(m, node);
      m.appendChild(node);
    }
  }

  const lost = new Set();
  PR.quoteLost = (id) => lost.has(id);

  function zhFor(item) {
    const host = document.getElementById("b-" + item.anchor);
    if (!host) return null;
    if (item.key) return host.querySelector('.zh[data-key="' + CSS.escape(item.key) + '"]');
    return PR.$$(".zh", host).find((z) => fullText(z).includes(item.quote)) || host.querySelector(".zh");
  }
  /* 标注挂在原文（side: "en"）还是译文上；找不到原话再到另一边找一次：
     只读原文时划在英文上的旧划线没有 side，翻译后英文挪到了 .en 里 */
  function locate(n) {
    const math = document.getElementById("b-" + n.anchor)?.querySelector(".math-body");
    if (math) {
      const i = findQuote(fullText(math), n.quote, n.prefix, n.suffix);
      return i >= 0 ? { el: math, i } : null;
    }
    const zh = zhFor(n);
    const first = PR.noteEl(zh, n.side), second = PR.noteEl(zh, n.side === "en" ? "zh" : "en");
    for (const el of [first, second]) {
      const i = el ? findQuote(fullText(el), n.quote, n.prefix, n.suffix) : -1;
      if (i >= 0) return { el, i };
    }
    return null;
  }

  /* 跨段的划线（#46）：quote 是各段原话连起来的全文，parts 里每段各记一份锚点；单段的没有 parts */
  const spans = (n) => (n.parts && n.parts.length ? n.parts : [n]);
  PR.noteBlocks = (n) => [...new Set(spans(n).map((p) => p.anchor))];
  PR.markNote = (n) => PR.noteBlocks(n).forEach((a) => PR.applyMarks(a));

  PR.applyMarks = function (onlyBlock) {
    const scope = onlyBlock ? document.getElementById("b-" + onlyBlock) : PR.$("#paper");
    if (!scope) return;
    PR.$$("mark.hl", scope).forEach((m) => m.replaceWith(...m.childNodes));
    scope.normalize();
    if (!onlyBlock) lost.clear();
    const items = [];
    for (const n of PR.myNotes()) {
      if (!n.quote) continue;
      const attrs = { class: "hl c-" + (n.color || "yellow") + (n.style === "underline" ? " s-ul" : "") + (n.kind === "question" ? " q" : ""), "data-note": n.id };
      for (const p of spans(n)) items.push({ id: n.id, p, attrs });
    }
    for (const e of S.discussion.entries || []) if (e.quote && e.anchor) items.push({ id: e.id, p: e, attrs: { class: "hl agent", "data-card": e.id } });
    const seen = new Set(), miss = new Set();  // 跨段的划线有一段找不到就算丢了
    for (const { id, p, attrs } of items) {
      if (onlyBlock && p.anchor !== onlyBlock) continue;
      seen.add(id);
      const at = locate(p);
      if (!at) { miss.add(id); continue; }
      wrap(at.el, at.i, at.i + p.quote.length, attrs);
    }
    seen.forEach((id) => (miss.has(id) ? lost.add(id) : lost.delete(id)));
    PR.applyMirrors && PR.applyMirrors(scope);
  };

  /* ---------- 选中文字 -> 浮动条 ---------- */
  const selbar = () => PR.$("#selbar");
  let pendingSel = null;

  const MAX_PARTS = 20;
  /* 选区落在某个元素里的那一截；起点在它前面的从 0 算，终点在它后面的算到末尾 */
  function partOf(el, range) {
    const math = el.classList.contains("math-body"), zh = math ? null : PR.zhOfEl(el), blk = el.closest(".blk");
    if (!blk || (!math && !zh?.dataset.key) || el.querySelector("textarea")) return null;
    const text = fullText(el);
    const s = el.contains(range.startContainer) ? offsetOf(el, range.startContainer, range.startOffset) : 0;
    const e = el.contains(range.endContainer) ? offsetOf(el, range.endContainer, range.endOffset) : text.length;
    const quote = text.slice(s, e);
    if (!quote.trim()) return null;
    const out = { anchor: blk.dataset.id, key: math ? blk.dataset.id : zh.dataset.key, quote, prefix: text.slice(Math.max(0, s - 32), s), suffix: text.slice(e, e + 32) };
    if (math) out.math = true;
    if (PR.isEnEl(el)) out.side = "en";
    return out;
  }

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    // 译文 .zh 和原文 .en 都能划：原文的记 side: "en"（只读原文没译的块，.zh 里排的就是英文）
    const el = startEl && startEl.closest("#paper .zh, #paper .en, #paper .math-body");
    if (!el) return null;
    let parts;
    if (el.contains(range.endContainer)) parts = [partOf(el, range)];
    else {  // 跨段（#46）：起点在译文就取选中的每段译文，在原文就取原文，夹在中间的另一边不算
      const endEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
      const textSide = el.classList.contains("math-body") ? endEl?.closest(".zh, .en") : el;
      const same = (textSide?.classList.contains("en") ? "#paper .en" : "#paper .zh") + ", #paper .math-body";
      parts = PR.$$(same).filter((x) => range.intersectsNode(x)).map((x) => partOf(x, range));
    }
    parts = parts.filter(Boolean);
    if (!parts.length || parts.length > MAX_PARTS) return null;
    const rect = range.getBoundingClientRect();
    if (parts.length === 1) return Object.assign(parts[0], { rect });
    return Object.assign({}, parts[0], { quote: parts.map((p) => p.quote.trim()).join("\n"), parts, rect });
  }
  PR.hasPendingSelection = () => !!pendingSel && selbar().classList.contains("open");

  // Native copy includes KaTeX's positioned glyphs and hidden MathML, which
  // rich-text editors can paste as one character per line (and twice).
  document.addEventListener("copy", (e) => {
    if (!e.clipboardData || e.target.closest?.("input, textarea, [contenteditable]")) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!PR.$$("#paper .katex").some((math) => range.intersectsNode(math))) return;
    const selected = readSelection();
    if (!selected) return;
    e.clipboardData.setData("text/plain", selected.quote);
    e.preventDefault();
  });

  function showSelbar() {
    pendingSel = readSelection();
    const bar = selbar();
    if (!pendingSel) { bar.classList.remove("open"); return; }
    PR.hideBlockbar && PR.hideBlockbar();
    const pen = PR.prefs.pen === "underline" ? "underline" : "marker";
    bar.innerHTML = '<span class="pens"><button data-pen="marker" class="' + (pen === "marker" ? "on" : "") + '" title="' + PR.t("荧光笔：用上次颜色划线") + '">' + PR.icon("marker", "sm") + "</button>" +
      '<button data-pen="underline" class="' + (pen === "underline" ? "on" : "") + '" title="' + PR.t("下划线：用上次颜色划线") + '">' + PR.icon("underline", "sm") + "</button></span>" +
      '<span class="dots pen-' + pen + '">' + PR.HL_COLORS.map(([c, name], i) =>
      '<button data-s="highlight" data-color="' + c + '" class="dot-' + c + '" title="' + (pen === "underline" ? PR.t("{color}色下划线", { color: name }) : PR.t("{color}色荧光笔", { color: name })) + (PR.keysOn ? PR.t("（{k}）", { k: i + 1 }) : "") + '"></button>').join("") + "</span>" +
      '<button data-s="note" title="' + PR.t("写笔记（N）") + '">' + PR.icon("note", "sm") + PR.t("笔记") + "</button>" +
      '<button data-s="question" title="' + PR.t("提问（Q）") + '">' + PR.icon("question", "sm") + PR.t("提问") + "</button>" +
      (PR.store.mode === "server" ? '<button data-s="translate" title="' + PR.t("翻译选中文字，学习词义和用法") + '">' + PR.icon("en", "sm") + PR.t("翻译") + "</button>" : "") +
      (PR.canChat && PR.canChat() && PR.feature("chat") ? '<button data-s="chat" title="' + PR.t("把这句引用到问 AI（可以引用多段）") + '">' + PR.icon("sparkle", "sm") + (PR.chatOpen && PR.chatOpen() ? PR.t("引用到对话") : PR.t("问 AI")) + "</button>" : "") +
      (pendingSel.side || pendingSel.parts || pendingSel.math ? "" : '<button data-s="en" title="' + PR.t("看这段英文") + '">' + PR.icon("en", "sm") + PR.t("原文") + "</button>") +
      '<button data-s="copy" title="' + PR.t("复制") + '">' + PR.icon("copy", "sm") + "</button>";
    bar.classList.add("open");
    const r = pendingSel.rect, w = bar.offsetWidth;
    const x = Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const above = r.top - bar.offsetHeight - 8;
    const y = above < 58 ? r.bottom + 8 : above;
    bar.style.left = x + "px"; bar.style.top = y + "px";
  }
  document.addEventListener("mouseup", (e) => { if (!(e.target.closest && e.target.closest("#selbar, #blockbar"))) setTimeout(showSelbar, 10); });
  document.addEventListener("keyup", (e) => { if (e.shiftKey && e.key.startsWith("Arrow")) showSelbar(); });
  document.addEventListener("selectionchange", PR.debounce(() => { const s = getSelection(); if (!s || s.isCollapsed) selbar().classList.remove("open"); }, 120));

  PR.selectionAction = function (kind, color) {
    if (!pendingSel) return;
    const { anchor, key, quote, prefix, suffix, side, parts, rect } = pendingSel;
    selbar().classList.remove("open");
    getSelection().removeAllRanges();
    pendingSel = null;
    if (kind === "translate") { PR.translateSelection({ anchor, quote, rect }); return; }
    if (kind === "en") { PR.toggleEn(anchor, true); return; }
    if (kind === "copy") { navigator.clipboard.writeText(quote).then(() => PR.toast(PR.t("已复制"))); return; }
    if (kind === "chat") { PR.chatAsk({ anchor, quote }); return; }
    const pen = PR.prefs.pen === "underline" ? "underline" : "marker";
    color = color || (PR.prefs.penColors || {})[pen] || "yellow";
    const note = { anchor, key, quote, prefix, suffix, kind, color };
    if (side) note.side = side;
    if (parts) note.parts = parts;
    if (PR.prefs.pen === "underline") note.style = "underline";
    if (kind === "highlight") {
      PR.prefs.penColors = { ...PR.prefs.penColors, [pen]: color };
      PR.applyPrefs();
      Object.assign(note, { id: PR.uid("n"), body: "", created: PR.nowIso() });
      PR.saveNote(note);
      PR.markNote(note);
      PR.toast(PR.t("已划线　点划线可以写笔记或改颜色"), { label: PR.t("撤销"), fn: () => PR.undoAnnotation(note.id) }, 2600);
    } else PR.startNote(note);
  };
  selbar().addEventListener("mousedown", (e) => e.preventDefault()); // 点按钮时别丢掉选区
  selbar().addEventListener("click", (e) => {
    const p = e.target.closest("[data-pen]");
    if (p) {  // 点笔直接用这支笔上次的颜色划线，色块仍可直接指定颜色。
      PR.prefs.pen = p.dataset.pen;
      return PR.selectionAction("highlight");
    }
    const b = e.target.closest("button[data-s]"); if (b) PR.selectionAction(b.dataset.s, b.dataset.color);
  });

  /* 点划线：写笔记 / 换颜色 / 删掉 */
  document.addEventListener("click", (e) => {
    const m = e.target.closest("mark.hl[data-note]");
    if (!m || getSelection().toString()) return;
    const n = (S.reader.notes || {})[m.dataset.note];
    if (!n) return;
    e.stopPropagation();
    PR.noteMarkClick(m, n);
  }, true);
  /* 点划线（或另一边的同步标记 m）：划线弹出改色菜单，笔记和问题打开编辑 */
  PR.noteMarkClick = function (m, n) {
    if (n.kind !== "highlight") { PR.openNoteEditor(n.id); return; }
    const ul = n.style === "underline";
    PR.popover(m, '<div class="hd">' + PR.t("我的划线") + '</div><div class="hl-edit"><span class="pens"><button data-hl-style="marker" class="' + (ul ? "" : "on") + '" title="' + PR.t("荧光笔") + '">' + PR.icon("marker", "sm") + '</button><button data-hl-style="underline" class="' + (ul ? "on" : "") + '" title="' + PR.t("下划线") + '">' + PR.icon("underline", "sm") + "</button></span>" +
      '<span class="dots pen-' + (ul ? "underline" : "marker") + '">' + PR.HL_COLORS.map(([c, name]) =>
      '<button data-hl-color="' + c + '" title="' + name + '" class="dot-' + c + ((n.color || "yellow") === c ? " on" : "") + '"></button>').join("") + "</span></div>" +
      '<div style="display:flex;gap:6px"><button class="btn sm line" data-hl="note">' + PR.t("写笔记") + '</button><button class="btn sm line" data-hl="question">' + PR.t("提问") + '</button><button class="btn sm danger" data-hl="del">' + PR.t("删除划线") + '</button></div>', { sticky: true });
    PR.$("#popover").onclick = (ev) => {
      const c = ev.target.closest("[data-hl-color]"), b = ev.target.closest("[data-hl]");
      if (c) {
        const pen = n.style === "underline" ? "underline" : "marker";
        PR.prefs.penColors = { ...PR.prefs.penColors, [pen]: c.dataset.hlColor }; PR.applyPrefs();
        PR.saveNote(Object.assign({}, n, { color: c.dataset.hlColor })); PR.markNote(n); PR.hidePopover(); return;
      }
      const sty = ev.target.closest("[data-hl-style]");
      if (sty) { const x = Object.assign({}, n); if (sty.dataset.hlStyle === "underline") x.style = "underline"; else delete x.style; PR.saveNote(x); PR.markNote(n); PR.hidePopover(); return; }
      if (!b) return;
      PR.hidePopover();
      if (b.dataset.hl === "del") { PR.commit({ op: "note_del", id: n.id }); PR.markNote(n); }
      else { PR.saveNote(Object.assign({}, n, { kind: b.dataset.hl })); PR.openNoteEditor(n.id); }
    };
  };
})(window.PR);
