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

  PR.applyMarks = function (onlyBlock) {
    const scope = onlyBlock ? document.getElementById("b-" + onlyBlock) : PR.$("#paper");
    if (!scope) return;
    PR.$$("mark.hl", scope).forEach((m) => m.replaceWith(...m.childNodes));
    scope.normalize();
    if (!onlyBlock) lost.clear();
    const items = [];
    for (const n of PR.myNotes()) if (n.quote) items.push({ n, attrs: { class: "hl c-" + (n.color || "yellow") + (n.style === "underline" ? " s-ul" : "") + (n.kind === "question" ? " q" : ""), "data-note": n.id } });
    for (const e of S.discussion.entries || []) if (e.quote && e.anchor) items.push({ n: e, attrs: { class: "hl agent", "data-card": e.id } });
    for (const { n, attrs } of items) {
      if (onlyBlock && n.anchor !== onlyBlock) continue;
      const zh = zhFor(n);
      const i = zh ? findQuote(fullText(zh), n.quote, n.prefix, n.suffix) : -1;
      if (i < 0) { lost.add(n.id); continue; }
      lost.delete(n.id);
      wrap(zh, i, i + n.quote.length, attrs);
    }
  };

  /* ---------- 选中文字 -> 浮动条 ---------- */
  const selbar = () => PR.$("#selbar");
  let pendingSel = null;

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const zh = startEl && startEl.closest("#paper .zh");
    if (!zh || !zh.contains(range.endContainer) || zh.querySelector("textarea")) return null;
    const text = fullText(zh);
    const s = offsetOf(zh, range.startContainer, range.startOffset);
    const e = offsetOf(zh, range.endContainer, range.endOffset);
    const quote = text.slice(s, e);
    if (!quote.trim()) return null;
    return { anchor: zh.closest(".blk").dataset.id, key: zh.dataset.key, quote, prefix: text.slice(Math.max(0, s - 32), s), suffix: text.slice(e, e + 32), rect: range.getBoundingClientRect(), s, e, total: text.length };
  }
  PR.hasPendingSelection = () => !!pendingSel && selbar().classList.contains("open");

  function showSelbar() {
    pendingSel = readSelection();
    const bar = selbar();
    if (!pendingSel) {
      bar.classList.remove("open");
      PR.clearSelectionHighlight && PR.clearSelectionHighlight();
      return;
    }
    PR.highlightSelection && PR.highlightSelection(pendingSel);
    PR.hideBlockbar && PR.hideBlockbar();
    const pen = PR.prefs.pen === "underline" ? "underline" : "marker";
    bar.innerHTML = '<span class="pens"><button data-pen="marker" class="' + (pen === "marker" ? "on" : "") + '" title="荧光笔：涂底色">' + PR.icon("marker", "sm") + "</button>" +
      '<button data-pen="underline" class="' + (pen === "underline" ? "on" : "") + '" title="下划线">' + PR.icon("underline", "sm") + "</button></span>" +
      '<span class="dots pen-' + pen + '">' + PR.HL_COLORS.map(([c, name], i) =>
      '<button data-s="highlight" data-color="' + c + '" class="dot-' + c + '" title="' + name + (pen === "underline" ? "色下划线" : "色荧光笔") + (PR.keysOn ? "（" + (i + 1) + "）" : "") + '"></button>').join("") + "</span>" +
      '<button data-s="note" title="写笔记（N）">' + PR.icon("note", "sm") + "笔记</button>" +
      '<button data-s="question" title="提问（Q）">' + PR.icon("question", "sm") + "提问</button>" +
      (PR.canChat && PR.canChat() && PR.feature("chat") ? '<button data-s="chat" title="把这句引用到问 AI（可以引用多段）">' + PR.icon("sparkle", "sm") + (PR.chatOpen && PR.chatOpen() ? "引用到对话" : "问 AI") + "</button>" : "") +
      '<button data-s="en" title="看这段英文">' + PR.icon("en", "sm") + "原文</button>" +
      '<button data-s="copy" title="复制">' + PR.icon("copy", "sm") + "</button>";
    bar.classList.add("open");
    const r = pendingSel.rect, w = bar.offsetWidth;
    const x = Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const y = r.top - 48 < 58 ? r.bottom + 8 : r.top - 48;
    bar.style.left = x + "px"; bar.style.top = y + "px";
  }
  document.addEventListener("mouseup", (e) => { if (!(e.target.closest && e.target.closest("#selbar, #blockbar"))) setTimeout(showSelbar, 10); });
  document.addEventListener("keyup", (e) => { if (e.shiftKey && e.key.startsWith("Arrow")) showSelbar(); });
  document.addEventListener("selectionchange", PR.debounce(() => { const s = getSelection(); if (!s || s.isCollapsed) { selbar().classList.remove("open"); PR.clearSelectionHighlight && PR.clearSelectionHighlight(); } }, 120));

  PR.selectionAction = function (kind, color) {
    if (!pendingSel) return;
    const { anchor, key, quote, prefix, suffix } = pendingSel;
    selbar().classList.remove("open");
    getSelection().removeAllRanges();
    pendingSel = null;
    PR.clearSelectionHighlight && PR.clearSelectionHighlight();
    if (kind === "en") { PR.toggleEn(anchor, true); return; }
    if (kind === "copy") { navigator.clipboard.writeText(quote).then(() => PR.toast("已复制")); return; }
    if (kind === "chat") { PR.chatAsk({ anchor, quote }); return; }
    const note = { anchor, key, quote, prefix, suffix, kind, color: color || "yellow" };
    if (PR.prefs.pen === "underline") note.style = "underline";
    if (kind === "highlight") {
      Object.assign(note, { id: PR.uid("n"), body: "", created: PR.nowIso() });
      PR.saveNote(note);
      PR.applyMarks(anchor);
      PR.toast("已划线　点划线可以写笔记或改颜色", { label: "撤销", fn: () => { PR.commit({ op: "note_del", id: note.id }); PR.applyMarks(anchor); } }, 2600);
    } else PR.startNote(note);
  };
  selbar().addEventListener("mousedown", (e) => e.preventDefault()); // 点按钮时别丢掉选区
  selbar().addEventListener("click", (e) => {
    const p = e.target.closest("[data-pen]");
    if (p) {  // 换笔：荧光笔 / 下划线，记住上次用的
      PR.prefs.pen = p.dataset.pen; PR.applyPrefs();
      PR.$$("[data-pen]", selbar()).forEach((x) => x.classList.toggle("on", x === p));
      PR.$(".dots", selbar()).className = "dots pen-" + p.dataset.pen;
      return;
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
    if (n.kind !== "highlight") { PR.openNoteEditor(n.id); return; }
    const ul = n.style === "underline";
    PR.popover(m, '<div class="hd">我的划线</div><div class="hl-edit"><span class="pens"><button data-hl-style="marker" class="' + (ul ? "" : "on") + '" title="荧光笔">' + PR.icon("marker", "sm") + '</button><button data-hl-style="underline" class="' + (ul ? "on" : "") + '" title="下划线">' + PR.icon("underline", "sm") + "</button></span>" +
      '<span class="dots pen-' + (ul ? "underline" : "marker") + '">' + PR.HL_COLORS.map(([c, name]) =>
      '<button data-hl-color="' + c + '" title="' + name + '" class="dot-' + c + ((n.color || "yellow") === c ? " on" : "") + '"></button>').join("") + "</span></div>" +
      '<div style="display:flex;gap:6px"><button class="btn sm line" data-hl="note">写笔记</button><button class="btn sm line" data-hl="question">提问</button><button class="btn sm danger" data-hl="del">删除划线</button></div>', { sticky: true });
    PR.$("#popover").onclick = (ev) => {
      const c = ev.target.closest("[data-hl-color]"), b = ev.target.closest("[data-hl]");
      if (c) { PR.saveNote(Object.assign({}, n, { color: c.dataset.hlColor })); PR.applyMarks(n.anchor); PR.hidePopover(); return; }
      const sty = ev.target.closest("[data-hl-style]");
      if (sty) { const x = Object.assign({}, n); if (sty.dataset.hlStyle === "underline") x.style = "underline"; else delete x.style; PR.saveNote(x); PR.applyMarks(n.anchor); PR.hidePopover(); return; }
      if (!b) return;
      PR.hidePopover();
      if (b.dataset.hl === "del") { PR.commit({ op: "note_del", id: n.id }); PR.applyMarks(n.anchor); }
      else { PR.saveNote(Object.assign({}, n, { kind: b.dataset.hl })); PR.openNoteEditor(n.id); }
    };
  }, true);
})(window.PR);
