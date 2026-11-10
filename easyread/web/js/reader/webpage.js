/* Web articles keep their DOM/CSS in a scriptless frame and share the reader's
   selection, annotation, editor, notes and AI actions through stable block ids. */
(function (PR) {
  "use strict";
  const S = PR.state;
  const isWeb = () => S.paper?.meta?.source_type === "web";
  let frame, layout, nativeMode = true, pendingPosition, loaded = false, dirty = false, resizing = false, lastView, lastOrder;
  const runs = new Map(), hosts = new Map(), editors = new Map(), codeRoots = new Map();
  const doc = () => loaded ? frame.contentDocument : null;
  const selection = () => doc()?.getSelection();
  const rootsFor = (id, side) => side === "en" && codeRoots.has(id) ? [codeRoots.get(id)] : (PR.blockById[id]?.web_runs || [])
    .map(r => runs.get(r.id)?.[side]).filter(Boolean);

  // Only EasyRead's own nodes are styled; the site's layout and assets stay intact.
  const FRAME_STYLE = `
    [data-easyread-run] { display:contents }
    [data-easyread-side][hidden] { display:none!important }
    [data-easyread-document] mark.hl { color:inherit; border:0; border-radius:2px; padding:.06em 0; cursor:pointer; background:#f8e6a1 }
    [data-easyread-document] mark.hl.c-green { background:#c8e3b5 }
    [data-easyread-document] mark.hl.c-blue { background:#bedcf2 }
    [data-easyread-document] mark.hl.c-pink { background:#f2c8d9 }
    [data-easyread-document] mark.hl.s-ul { background:transparent; box-shadow:inset 0 -2.5px #d4a52b }
    [data-easyread-document] mark.hl.s-ul.c-green { box-shadow:inset 0 -2.5px #73a354 }
    [data-easyread-document] mark.hl.s-ul.c-blue { box-shadow:inset 0 -2.5px #5c9dc5 }
    [data-easyread-document] mark.hl.s-ul.c-pink { box-shadow:inset 0 -2.5px #c985a0 }
    [data-easyread-document] mark.hl.agent { background:transparent; box-shadow:inset 0 -2px #6695a5 }
    [data-easyread-document] [data-easyread-mirror] { text-decoration:underline dotted #9c995c; text-underline-offset:4px; cursor:pointer }
    [data-easyread-block].current { outline:1px dashed #7195a0; outline-offset:5px }
    [data-easyread-block].flash { animation:er-flash 1s ease-out }
    @keyframes er-flash { from { background:#f8e6a1 } to { background:transparent } }
    [data-easyread-pin] { display:inline-block; margin-left:6px; padding:0 5px; border:1px solid #a5b9c0; border-radius:8px; font:11px/1.5 sans-serif; color:#315f70; background:#eef5f5; cursor:pointer }
    [data-easyread-editor] { display:block; margin:14px 0; padding:12px; background:#faf8f3; color:#262622; border:1px solid #c1bbb0; border-radius:8px; font:14px/1.6 sans-serif }
    [data-easyread-editor] textarea { display:block; box-sizing:border-box; width:100%; min-height:160px; padding:10px; color:#262622; background:#fff; border:1px solid #bbb; font:16px/1.7 sans-serif; resize:vertical }
    [data-easyread-editor] .editor-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px }
    [data-easyread-editor] button { cursor:pointer; border:1px solid #bbb; padding:4px 12px; border-radius:5px; background:#fff; color:#262622 }
    [data-easyread-document]::highlight(reader-find) { background:#f8e6a1 }
    [data-easyread-document]::highlight(reader-find-active) { background:#efad5b }
  `;

  PR.webRect = function (el) {
    if (!loaded || el?.ownerDocument !== doc()) return null;
    const r = el.getBoundingClientRect(), f = frame.getBoundingClientRect();
    return new DOMRect(f.left + r.left, f.top + r.top, r.width, r.height);
  };
  PR.webBlockHost = id => nativeMode && loaded && isWeb() ? hosts.get(id) || (id === "head" ? doc().querySelector("h1") || doc().body : null) : null;
  PR.webClearCurrent = () => doc()?.querySelectorAll("[data-easyread-block].current").forEach(el => el.classList.remove("current"));
  PR.webClearSelection = () => selection()?.removeAllRanges();
  PR.webAnnotationRoots = (part, side) => nativeMode && loaded && isWeb() ? rootsFor(part.anchor, side) : null;
  PR.webClearMarks = onlyBlock => {
    if (!loaded) return;
    for (const b of S.paper.blocks || []) {
      if (onlyBlock && b.id !== onlyBlock) continue;
      for (const root of [...rootsFor(b.id, "en"), ...rootsFor(b.id, "zh")]) {
        root.querySelectorAll("mark.hl").forEach(m => m.replaceWith(...m.childNodes));
        root.normalize();
        root.removeAttribute("data-easyread-mirror");
        root.removeAttribute("title");
      }
    }
  };
  PR.webMirrorMarks = onlyBlock => {
    if (!loaded) return;
    for (const n of PR.myNotes()) {
      for (const part of n.parts?.length ? n.parts : [n]) {
        if (onlyBlock && part.anchor !== onlyBlock) continue;
        const side = part.side || "zh", source = rootsFor(part.anchor, side);
        if (!source.some(el => el.querySelector('mark[data-note="' + CSS.escape(n.id) + '"]'))) continue;
        for (const target of rootsFor(part.anchor, side === "en" ? "zh" : "en")) {
          if (target.dataset.easyreadMirror) continue;
          target.dataset.easyreadMirror = n.id;
          target.title = side === "en" ? PR.t("对应原文里的标注") : PR.t("对应译文里的标注");
        }
      }
    }
  };

  PR.webContentWindow = () => nativeMode && loaded ? frame.contentWindow : null;
  PR.webSearchGroups = () => !nativeMode || !loaded ? null : (S.paper.blocks || []).flatMap(b =>
    ["zh", "en"].map(side => ({ roots: rootsFor(b.id, side), block: hosts.get(b.id), domId: "b-" + b.id }))
      .filter(group => group.block && group.roots.length));

  PR.webReadSelection = function () {
    if (!nativeMode) return null;
    const sel = selection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const side = start.closest("[data-easyread-side]")?.dataset.easyreadSide;
    if (!side || start.closest("[data-easyread-editor]")) return null;
    const parts = [];
    for (const b of S.paper.blocks || []) {
      const roots = rootsFor(b.id, side).filter(el => !el.hidden);
      if (!roots.length) continue;
      const part = PR.selectionPart(roots, range, b.id, b.id, side);
      if (part) parts.push(part);
    }
    if (!parts.length || parts.length > 20) return null;
    const r = range.getBoundingClientRect(), f = frame.getBoundingClientRect();
    const rect = new DOMRect(r.left + f.left, r.top + f.top, r.width, r.height);
    return { ...parts[0], ...(parts.length > 1 ? { parts, quote: parts.map(p => p.quote.trim()).join("\n") } : {}), rect };
  };

  function register() {
    const d = doc();
    runs.clear(); hosts.clear(); codeRoots.clear();
    for (const b of S.paper.blocks || []) {
      const elements = [];
      for (const r of b.web_runs || []) {
        const el = d.querySelector('[data-easyread-run="' + r.id + '"]');
        if (!el) continue;
        const zh = d.createElement("span"), en = d.createElement("span");
        zh.dataset.easyreadSide = "zh"; en.dataset.easyreadSide = "en";
        zh.dataset.key = b.id; en.lang = "en";
        el.replaceChildren(zh, en);
        runs.set(r.id, { el, zh, en }); elements.push(el);
      }
      if (!elements.length) continue;
      let host = elements[0].parentElement;
      while (host && !elements.every(el => host.contains(el))) host = host.parentElement;
      // Prefer the semantic paragraph, including headings that contain nested <p>s.
      const semantic = b.type === "heading" ? elements[0].closest("h1,h2,h3,h4,h5,h6")
        : elements[0].closest("p,li,figcaption,td,th,blockquote");
      if (semantic && elements.every(el => semantic.contains(el))) host = semantic;
      if (!host || host === d.body || host === d.documentElement) host = elements[0].parentElement;
      if (host && !host.dataset.easyreadBlock) { host.dataset.easyreadBlock = b.id; hosts.set(b.id, host); }
    }
    // Upgrade older saved snapshots as well: figures/code did not originally carry DOM ids.
    const hidden = el => Array.from((function* () { for (let p = el; p; p = p.parentElement) yield p; })()).some(p =>
      p.hidden || p.getAttribute("aria-hidden") === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(p.getAttribute("style") || ""));
    const images = Array.from(d.querySelectorAll("img")).filter(el => !hidden(el) && !(+el.getAttribute("width") > 0 && +el.getAttribute("width") <= 150));
    const figures = (S.paper.blocks || []).filter(b => b.type === "figure");
    figures.forEach((b, i) => { if (images[i]) { hosts.set(b.id, images[i]); images[i].dataset.easyreadBlock = b.id; } });
    const codeBlocks = (S.paper.blocks || []).filter(b => !b.web_runs && b.en?.startsWith("```"));
    const pres = Array.from(d.querySelectorAll("pre")).filter(el => !hidden(el));
    codeBlocks.forEach((b, i) => {
      if (!pres[i]) return;
      pres[i].dataset.easyreadBlock = b.id; pres[i].dataset.easyreadSide = "en";
      hosts.set(b.id, pres[i]); codeRoots.set(b.id, pres[i]);
    });
    hosts.set("head", d.querySelector("h1") || d.body);
  }

  function updateText() {
    if (!nativeMode || !loaded || PR.editingKey) return;
    const view = PR.readingView(), originalFirst = PR.originalFirst();
    if (selection()?.toString()) {
      if (view !== lastView || originalFirst !== lastOrder) PR.webClearSelection();
      else { dirty = true; return; }
    }
    dirty = false; lastView = view; lastOrder = originalFirst;
    doc().documentElement.lang = view === "original" ? "en" : (S.paper.meta.target || "zh-CN");
    for (const b of S.paper.blocks || []) {
      const source = b.web_runs || [], edited = PR.editOf(b.id);
      const joined = source.map(r => r.zh ?? r.en).join("");
      const override = edited ? edited.zh : b.zh && b.zh !== joined ? b.zh : null;
      const translated = !!(edited || b.zh || source.some(r => r.zh));
      for (const [i, run] of source.entries()) {
        const entry = runs.get(run.id);
        if (!entry) continue;
        const value = override != null ? (i === 0 ? override : "") : (run.zh ?? run.en);
        if (entry.zh.textContent !== value) entry.zh.textContent = value;
        if (entry.en.textContent !== run.en) entry.en.textContent = run.en;
        entry.zh.hidden = !translated || view === "original";
        entry.en.hidden = translated && view === "translation" && !hosts.get(b.id)?.classList.contains("show-en");
        entry.en.style.display = view === "both" ? "block" : "contents";
        if (originalFirst) entry.el.replaceChildren(entry.en, entry.zh);
        else entry.el.replaceChildren(entry.zh, entry.en);
      }
    }
    PR.applyMarks();
    renderPins();
    resize(true);
  }
  function resize(shrink = false) {
    if (!nativeMode || !loaded || resizing) return;
    resizing = true;
    const parentScroll = scrollY;
    if (shrink) frame.style.height = "1px";
    const height = Math.max(500, doc().documentElement.scrollHeight);
    if (frame.style.height !== height + "px") frame.style.height = height + "px";
    // Shrinking the frame for measurement must not clamp the outer page to its top.
    if (shrink) { frame.getBoundingClientRect(); window.scrollTo({ top: parentScroll, behavior: "instant" }); }
    resizing = false;
  }

  function renderPins() {
    if (!loaded) return;
    doc().querySelectorAll("[data-easyread-pin], [data-easyread-stale]").forEach(el => el.remove());
    for (const [anchor, items] of Object.entries(PR.noteGroups || {})) {
      const host = hosts.get(anchor);
      if (!host || !items.length) continue;
      const pin = doc().createElement("button");
      pin.dataset.easyreadPin = anchor; pin.type = "button";
      pin.textContent = String(items.length); pin.title = PR.t("讨论与笔记");
      if (host.tagName === "IMG" || host.tagName === "PRE") host.after(pin); else host.append(pin);
    }
    for (const b of S.paper.blocks || []) {
      const host = hosts.get(b.id);
      if (!host || !PR.isStale(b.id)) continue;
      const badge = doc().createElement("button");
      badge.dataset.easyreadStale = b.id; badge.dataset.key = b.id; badge.type = "button";
      badge.textContent = PR.t("译者稿有更新"); badge.style.cssText = "font:12px sans-serif;color:#9a6b24;cursor:pointer;margin-left:6px";
      host.append(badge);
    }
    resize();
  }

  PR.webEditorMount = key => {
    const host = PR.webBlockHost(key);
    if (!host || !rootsFor(key, "zh").length) return null;
    const mount = doc().createElement("div"); mount.dataset.easyreadEditor = key;
    host.after(mount); editors.set(key, { mount, host, display: host.style.display });
    host.style.display = "none";
    return mount;
  };
  PR.webEditorFinish = key => {
    const edit = editors.get(key);
    if (!edit) return;
    edit.host.style.display = edit.display; edit.mount.remove(); editors.delete(key);
  };

  function bind() {
    const d = doc();
    d.documentElement.dataset.easyreadDocument = "";
    const style = d.createElement("style"); style.textContent = FRAME_STYLE; d.head.append(style);
    const showSelection = PR.debounce(() => {
      if (dirty && !selection()?.toString()) updateText();
      PR.showSelectionBar();
    }, 30);
    d.addEventListener("mouseup", showSelection);
    d.addEventListener("selectionchange", showSelection);
    d.addEventListener("keyup", e => { if (e.shiftKey) showSelection(); });
    d.addEventListener("keydown", e => {
      if (e.target.closest("textarea,input,[contenteditable]")) return;
      const forwarded = new KeyboardEvent("keydown", { key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, bubbles: true, cancelable: true });
      if (!frame.dispatchEvent(forwarded)) e.preventDefault();
    });
    d.addEventListener("click", e => {
      const stale = e.target.closest("[data-easyread-stale]");
      if (stale) { e.preventDefault(); PR.showStale(stale); return; }
      const pin = e.target.closest("[data-easyread-pin], mark[data-card]");
      if (pin) { e.preventDefault(); PR.toggleNotesPanel(true); if (pin.dataset.card) PR.flashCard(pin.dataset.card); return; }
      const mark = e.target.closest("mark[data-note], [data-easyread-mirror]");
      if (mark && !selection()?.toString()) {
        const n = S.reader.notes[mark.dataset.note || mark.dataset.easyreadMirror];
        if (n && !n.deleted) { e.preventDefault(); PR.noteMarkClick(mark, n); return; }
      }
      if (e.target.closest("a,button,textarea,input,[data-easyread-editor]")) {
        const a = e.target.closest("a[href]");
        if (a?.getAttribute("href").startsWith("#")) {
          let id = a.getAttribute("href").slice(1); try { id = decodeURIComponent(id); } catch (_) { /* literal fragment */ }
          const target = d.getElementById(id);
          if (target) { e.preventDefault(); PR.centerOn(target); }
        }
        return;
      }
      if (selection()?.toString()) return;
      const id = e.target.closest("[data-easyread-block]")?.dataset.easyreadBlock;
      if (id) PR.setCurrent(id);
      else { PR.setCurrent(null); PR.hidePopover(); }
    });
    d.addEventListener("contextmenu", e => {
      const id = e.target.closest("[data-easyread-block]")?.dataset.easyreadBlock;
      if (!id || selection()?.toString() || e.target.closest("textarea,input")) return;
      e.preventDefault(); PR.setCurrent(id, { bar: false });
      const f = frame.getBoundingClientRect(); PR.showBlockMenu(id, { x: e.clientX + f.left, y: e.clientY + f.top });
    });
    d.addEventListener("dblclick", e => {
      if (e.target.closest("a,button,textarea,input,[data-easyread-editor],mark")) return;
      const id = e.target.closest("[data-easyread-block]")?.dataset.easyreadBlock;
      const zh = id && PR.$('#b-' + CSS.escape(id) + ' .zh[data-key]');
      if (!zh || !PR.blockById[id]?.web_runs?.length || !PR.feature("edit")) return;
      PR.webClearSelection(); PR.$("#selbar").classList.remove("open"); PR.editZh(zh);
    });
    d.addEventListener("dragstart", e => {
      const selected = PR.webReadSelection();
      if (!selected || !e.dataTransfer) return;
      PR.beginChatDrag?.(selected);
      e.dataTransfer.setData("application/x-easyread-ref", JSON.stringify({ anchor: selected.anchor, quote: selected.quote }));
      e.dataTransfer.setData("text/plain", selected.quote);
    });
    d.addEventListener("dragend", () => PR.endChatDrag?.());
    new ResizeObserver(() => resize()).observe(d.body);
    d.fonts?.ready.then(() => resize(true));
  }

  // Do not overwrite or restore a saved position against the hidden PDF-style projection
  // while the actual web document is still loading.
  const originalRestore = PR.restoreProgress, originalSave = PR.saveProgress, originalCapture = PR.captureProgress;
  PR.restoreProgress = (...args) => isWeb() && nativeMode && !loaded ? false : originalRestore(...args);
  PR.saveProgress = (...args) => { if (!isWeb() || !nativeMode || loaded) return originalSave(...args); };
  PR.captureProgress = (...args) => { if (!isWeb() || !nativeMode || loaded) return originalCapture(...args); };

  const originalOpenNote = PR.openNoteEditor;
  PR.openNoteEditor = function (id) {
    if (!nativeMode || !loaded || !isWeb()) return originalOpenNote(id);
    if (!PR.notesPanelOpen()) PR.toggleNotesPanel(true);
    PR.renderNotesPanel(id);
  };
  const originalToggleEn = PR.toggleEn;
  PR.toggleEn = function (id, force) {
    if (!nativeMode || !loaded || !isWeb()) return originalToggleEn(id, force);
    const host = hosts.get(id); if (host) host.classList.toggle("show-en", force);
    updateText();
  };
  const originalReadingLanguage = PR.applyReadingLanguage;
  PR.applyReadingLanguage = function (...args) { const result = originalReadingLanguage.apply(this, args); if (isWeb()) updateText(); return result; };

  function alignPosition(position) {
    if (!position) return;
    const el = PR.webBlockHost(position.block) || document.getElementById("b-" + position.block);
    if (el) {
      el.style.contentVisibility = "visible";
      const r = PR.webRect(el) || el.getBoundingClientRect();
      if (r.height) { window.scrollTo({ top: Math.max(0, scrollY + r.top + r.height * (position.off || 0) - PR.readingLine()), behavior: "instant" }); return; }
    }
    window.scrollTo({ top: (position.ratio || 0) * Math.max(0, document.documentElement.scrollHeight - innerHeight), behavior: "instant" });
  }
  function syncLayout() {
    document.body.classList.toggle("web-native", nativeMode);
    frame.hidden = !nativeMode;
    layout.querySelectorAll("[data-web-layout]").forEach(button => {
      const active = (button.dataset.webLayout === "native") === nativeMode;
      button.classList.toggle("on", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
  function setLayout(value) {
    const next = value === "native";
    if (next === nativeMode) return;
    if (PR.editingKey) {
      (doc()?.querySelector("[data-easyread-editor] textarea") || PR.$("#paper textarea.editor"))?.focus();
      return;
    }
    PR.finishPanelNote?.();
    if (PR.editingNote) PR.closeNoteEditor();
    const position = PR.progressOp();
    PR.webClearSelection(); window.getSelection()?.removeAllRanges();
    PR.setCurrent(null); PR.hidePopover(); PR.$("#selbar").classList.remove("open");
    nativeMode = next;
    PR.ls.set("easyread-web-layout-" + PR.pid, value);
    const preference = "web_layout_" + PR.pid;
    PR.prefs[preference] = value;
    if (PR.store.mode === "server") PR.savePrefs("reader", { [preference]: value });
    syncLayout();
    PR.applyReadingLanguage(); PR.applyMarks(); PR.renderMargin();
    if (nativeMode && !loaded) pendingPosition = position;
    else { alignPosition(position); requestAnimationFrame(() => alignPosition(position)); }
    PR.saveProgress();
    window.dispatchEvent(new Event("resize"));
  }

  function setup() {
    if (!isWeb()) return;
    if (!frame) {
      document.body.classList.add("web-article");
      nativeMode = (PR.prefs["web_layout_" + PR.pid] || PR.ls.get("easyread-web-layout-" + PR.pid, "native")) !== "reader";
      layout = PR.el("div", { class: "seg", id: "webLayoutToggle", role: "group", "aria-label": PR.t("阅读排版") });
      for (const [value, label] of [["native", PR.t("网页排版")], ["reader", PR.t("EasyRead 风格")]]) {
        const button = PR.el("button", { "data-web-layout": value, text: label });
        button.onclick = () => setLayout(value);
        layout.append(button);
      }
      PR.$("#bar .view-seg").before(layout);
      frame = PR.el("iframe", { id: "webSnapshot", title: S.paper.meta.title_en, sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox", referrerpolicy: "no-referrer" });
      PR.$("#stage").before(frame);
      syncLayout();
      frame.addEventListener("load", () => {
        loaded = true; register(); bind(); updateText();
        if (!nativeMode) return;
        if (pendingPosition) { alignPosition(pendingPosition); pendingPosition = null; }
        else if (location.hash.startsWith("#b-")) PR.jumpTo(location.hash.slice(1), { noBack: true, instant: true });
        else PR.restoreProgress();
      });
      if (S.web_snapshot) frame.srcdoc = S.web_snapshot;
      else frame.src = "/p/" + PR.pid + "/source.html";
      const originalReadingBlock = PR.readingBlock;
      PR.readingBlock = () => {
        if (!nativeMode || !loaded) return originalReadingBlock();
        let found = "head";
        for (const b of S.paper.blocks || []) {
          const host = hosts.get(b.id), r = host && PR.webRect(host);
          if (r?.height && r.top <= PR.readingLine()) found = b.id;
        }
        return found;
      };
      const sideObserver = new MutationObserver(() => { requestAnimationFrame(() => resize(true)); });
      sideObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      let lastWidth = 0;
      new ResizeObserver(entries => {
        const width = entries[0].contentRect.width;
        if (width !== lastWidth) { lastWidth = width; resize(true); }
      }).observe(frame);
    }
    updateText();
  }
  PR.on("margin-rendered", renderPins);
  PR.on("rendered", setup);
  PR.on("reader", op => { if (!op || op.op === "edit") updateText(); });
  PR.on("block-rendered", updateText);
})(window.PR);
