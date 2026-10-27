/* 阅读页启动与全局事件：滚动、快捷键、远端更新（agent 追加讨论、后台翻译进度）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const body = document.body;
  PR.on("settings-saved", state => {
    const enabled = state.cfg.figure_images?.enabled === true;
    if (S.figure_images_enabled !== enabled) {
      S.figure_images_enabled = enabled;
      PR.hideBlockbar();
      PR.rerenderKeepingPlace();
    }
  });
  PR.on("figure-images-setting", () => { PR.hideBlockbar(); PR.rerenderKeepingPlace(); });

  /* 当前阅读的块：视口上部 30% 那条线穿过的块 */
  PR.readingLine = () => innerHeight * 0.3;
  PR.readingBlock = function () {
    const line = PR.readingLine();
    let best = null;
    for (const el of PR.$$("#paper > .blk, #paper > .paper-head")) {
      if (el.getBoundingClientRect().top <= line) best = el; else break;
    }
    return best ? best.dataset.id : "head";
  };
  PR.currentHeading = function () {
    const id = PR.readingBlock();
    if (!PR.blockById[id]) return null;
    let cur = null;
    for (const b of S.paper.blocks || []) {
      if (b.type === "heading" || b.type === "references") cur = b.id;
      if (b.id === id) break;
    }
    return cur;
  };

  let lastBlock = null;
  const onScroll = PR.throttle(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    PR.$("#progress i").style.width = (max > 0 ? (scrollY / max) * 100 : 0) + "%";
    const id = PR.readingBlock();
    if (id !== lastBlock) {
      lastBlock = id;
      const h = PR.blockById[PR.currentHeading()];
      PR.$(".bar-section").textContent = h ? (h.num ? h.num + " " : "") + PR.plain(PR.textFor(h.id) || h.zh) : "";
      PR.syncPage(false);
    }
    PR.saveProgress();
  }, 120);

  /* ---------- 快捷键 ---------- */
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("textarea, input, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (PR.hasPendingSelection() && PR.keysOn) {
      // An active IME can report "Process" outside editors. Resolve physical
      // keys only here; keep the selected pen and existing modifier behavior.
      const digit = !e.shiftKey && { Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4" }[e.code];
      const selectionKey = digit || { KeyN: "n", KeyQ: "q" }[e.code] || k;
      const m = { 1: "yellow", 2: "green", 3: "blue", 4: "pink" }[selectionKey];
      if (m) { e.preventDefault(); return PR.selectionAction("highlight", m); }
      if (selectionKey === "n" || selectionKey === "q") { e.preventDefault(); return PR.selectionAction(selectionKey === "n" ? "note" : "question"); }
    }
    if (k === "escape") {
      if (PR.$("#settings").classList.contains("open") || PR.$("#popover").classList.contains("open") || body.classList.contains("drawer-open")) {
        PR.toggleDrawer(false); PR.hidePopover(); PR.$("#settings").classList.remove("open");
      } else if (PR.currentBlock()) PR.setCurrent(null);
      else if (PR.side) PR.openSide(null);
      PR.$("#selbar").classList.remove("open");
      return;
    }
    const act = PR.keyAction(k);  // 键位可在“说明 → 快捷键”里改
    if (act && PR.runAction(act)) e.preventDefault();
  });

  /* ---------- 数据变化 ---------- */
  const busy = () => PR.editingKey || PR.editingNote || PR.noteMedia.isRenaming();
  const refreshNotes = PR.debounce(() => {
    if (busy()) return refreshNotes();
    PR.applyMarks(); PR.renderMargin();
    if (PR.notesPanelOpen()) PR.renderNotesPanel();
    if (body.classList.contains("drawer-open")) PR.renderDrawer();
  }, 80);
  PR.on("reader", (op) => { if (op && op.op === "progress") return; if (!busy()) refreshNotes(); });

  const seen = new Set();
  PR.on("remote", (changed) => {
    if (changed.includes("job")) PR.renderJobState();
    const after = () => {
      if (changed.includes("paper") || changed.includes("reader")) {
        PR.rerenderKeepingPlace();
        const m = S.paper.meta || {};
        PR.$(".bar-title").innerHTML = PR.titleHtml(m.short_zh || m.title_zh || m.title_en || "");
      } else if (changed.includes("job")) {
        const pend = PR.$(".pending-pages .pending, .page-cap");
        if (pend || (S.job || {}).state === "confirm" || (S.job || {}).type === "figure-images" || PR.$(".figure-job")) PR.rerenderKeepingPlace();
      }
      PR.applyMarks(); PR.renderMargin();
      if (PR.notesPanelOpen()) PR.renderNotesPanel();
      if (body.classList.contains("drawer-open")) PR.renderDrawer();
      if (changed.includes("discussion")) announceNew();
    };
    if (busy()) { const t = setInterval(() => { if (!busy()) { clearInterval(t); after(); } }, 800); } else after();
  });

  function announceNew() {
    const fresh = (S.discussion.entries || []).filter((e) => !seen.has(e.id));
    fresh.forEach((e) => seen.add(e.id));
    PR.ls.set("pr-seen-" + PR.paperKey, Array.from(seen));
    if (!fresh.length) return;
    const first = fresh[0];
    fresh.forEach((e) => PR.flashCard(e.id));
    const what = PR.plain(first.title || first.q || first.body || "").slice(0, 28);
    PR.toast(PR.t("新增 {n} 条：{what}", { n: fresh.length, what: PR.esc(what) + (what.length >= 28 ? "…" : "") }), {
      label: PR.t("去看看"), fn: () => { PR.jumpTo("b-" + PR.anchorOfEntry(first)); setTimeout(() => PR.flashCard(first.id), 400); },
    }, 7000);
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    PR.libraryNav.readerBack(PR.pid);  // The return link must work even while a long paper is still loading.
    PR.applyPrefs();
    try { await PR.load(); } catch (e) {
      const back = PR.$("#backBtn").getAttribute("href") || "/";
      PR.$("#paper").innerHTML = '<div class="pending">' + PR.t("读不到论文：{msg}。", { msg: PR.esc(e.message) }) + '<a href="' + PR.esc(back) + '">' + PR.t("回文献库") + "</a></div>";
      return;
    }
    if (PR.store.mode === "server") {  // 以本机 prefs.json 为准
      const p = await PR.loadPrefs();
      if (p.reader) { Object.assign(PR.prefs, PR.migratePrefs(Object.assign({}, p.reader))); PR.applyPrefs(); }
      PR.useServerUi(p);
    }
    if (PR.store.mode === "static") PR.$("#backBtn").style.display = "none";
    PR.applyFeatures();
    const m = S.paper.meta || {};
    document.title = (m.short_zh || m.title_zh || m.title_en || PR.t("论文")) + " · EasyRead";
    PR.$(".bar-title").innerHTML = PR.titleHtml(m.short_zh || m.title_zh || m.title_en || "");
    PR.ls.get("pr-seen-" + PR.paperKey, (S.discussion.entries || []).map((e) => e.id)).forEach((id) => seen.add(id));
    PR.ls.set("pr-seen-" + PR.paperKey, Array.from(seen));
    PR.renderPaper();
    PR.setupDemo();  // 署名要放在论文标题下面，得等正文渲染出来
    PR.applyMarks();
    PR.renderMargin();
    PR.renderJobState();
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", PR.debounce(() => { PR.fitWide(); PR.renderMargin(); }, 150));
    if (document.fonts) document.fonts.ready.then(() => { PR.fitWide(null, true); PR.layoutMargin(); });
    // 正文变宽变窄（最大化、贴边分屏只来一次 resize，那时版面可能还没变完）就重新缩放宽公式
    let paperW = 0;
    new ResizeObserver(PR.debounce(() => {
      const w = PR.$("#paper").clientWidth;
      if (w !== paperW) { paperW = w; PR.fitWide(); }
      PR.layoutMargin();
    }, 80)).observe(PR.$("#paper"));
    PR.startPolling();

    if (location.hash && document.getElementById(location.hash.slice(1))) {
      // 打开带 #段落 的链接：先跳过去，等字体、公式排好后再对一次中，免得排版变动把它挤偏
      const id = location.hash.slice(1);
      setTimeout(() => PR.jumpTo(id, { noBack: true, instant: true }), 200);
      Promise.all([document.fonts ? document.fonts.ready : null, new Promise((r) => setTimeout(r, 900))])
        .then(() => PR.jumpTo(id, { noBack: true, instant: true, noFlash: true }));
    } else if (!PR.restoreProgress()) {
      if (!PR.ls.get("easyread-hint-seen", false)) {
        PR.ls.set("easyread-hint-seen", true);
        const touch = matchMedia("(pointer: coarse)").matches;  // 手机上没有右键和键盘
        const tip = S.demo ? PR.t("在线演示：点段落、选中文字试试划线和笔记；顶栏“问 AI”里有一段真实的 AI 对话。")
          : touch ? PR.t("点一下段落出现操作条；长按选中文字，可以划线、写笔记。")
          : PR.t("点一下段落出现操作条，右键有完整菜单；选中文字可以划线、写笔记。") + (PR.keysOn ? PR.t("<kbd>=</kbd> <kbd>-</kbd> 调字号") : "");
        setTimeout(() => PR.toast(tip, null, 9000), 800);
      }
    }
    PR.watchProgress();  // 位置定了才开始记新的
  }
  boot();
})(window.PR);
