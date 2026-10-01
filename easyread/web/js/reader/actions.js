/* 段落操作：点一下段落出现操作条（在段落右上方），右键出完整菜单，键盘 J/K 移动当前段。
   还有：重译一段、展开原文、引用和交叉引用的悬停预览、跳转。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  let current = null;
  const bar = () => PR.$("#blockbar");

  PR.currentBlock = () => current;
  PR.toggleEn = function (id, force) {
    const host = document.getElementById("b-" + id);
    if (!host) return;
    host.classList.toggle("show-en", force);
    PR.layoutMargin();
    placeBar();
  };

  function actionsFor(id) {
    const b = PR.blockById[id];
    if (!b) return [];
    const keys = PR.blockKeys(b);
    const hasEn = b.en || b.caption_en || (b.items || []).some((i) => i.en);
    const list = [
      { k: "note", label: "笔记", icon: "note", fn: () => PR.startNote({ anchor: id }) },
      { k: "question", label: "提问", icon: "question", fn: () => PR.startNote({ anchor: id, kind: "question" }) },
    ];
    if (PR.canChat() && PR.feature("chat")) list.push({ k: "chat", label: PR.chatOpen && PR.chatOpen() ? "引用到对话" : "问 AI", icon: "sparkle", fn: () => PR.chatAsk({ anchor: id }) });
    if (hasEn && PR.feature("en")) list.push({ k: "en", label: "原文", icon: "en", fn: () => PR.toggleEn(id) });
    if (keys.length && PR.feature("edit")) list.push({ k: "edit", label: "改译文", icon: "edit", fn: () => { const zh = PR.$("#b-" + CSS.escape(id) + " .zh[data-key]"); zh && PR.editZh(zh); } });
    if (b.page && PR.feature("pages")) list.push({ k: "page", label: "原页 p." + b.page, icon: "page", fn: () => PR.openPage(b.page, id) });
    // 重译花 token、容易误点：默认关，开了也只放在“⋯”菜单里
    if (keys.length && PR.canAsk() && PR.feature("retranslate")) list.push({ k: "redo", label: "让模型重译这段…", icon: "redo", menuOnly: true, fn: () => retranslate(id) });
    list.forEach((a) => { a.kbd = PR.keyOf ? PR.keyOf(a.k) : ""; });
    return list;
  }

  PR.setCurrent = function (id, opts) {
    PR.$$("#paper .blk.current").forEach((x) => x.classList.remove("current"));
    current = id && PR.blockById[id] ? id : null;
    if (!current) { PR.hideBlockbar(); return; }
    const el = document.getElementById("b-" + current);
    el.classList.add("current");
    if (opts && opts.scroll) PR.centerOn(el);  // J/K：放到屏幕中间
    if (!opts || opts.bar !== false) showBar();
    if (PR.syncPage && PR.$ && PR.$(".pv-follow input") && PR.$(".pv-follow input").checked) {
      PR.syncPage(true);
    }
  };

  function showBar() {
    const acts = actionsFor(current).filter((a) => !a.menuOnly);
    bar().innerHTML = acts.map((a, i) => '<button data-i="' + i + '" title="' + a.label + (a.kbd ? "（" + a.kbd + "）" : "") + '">' + PR.icon(a.icon, "sm") + "<span>" + PR.esc(a.label) + "</span></button>").join("") +
      '<button data-i="more" title="更多（右键段落也可以）">⋯</button>';
    bar().onclick = (e) => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      if (b.dataset.i === "more") return blockMenu(current, b);
      PR.hideBlockbar();
      acts[+b.dataset.i].fn();
    };
    bar().classList.add("open");
    placeBar();
  }
  function placeBar() {
    if (!current || !bar().classList.contains("open")) return;
    const el = document.getElementById("b-" + current);
    if (!el) return PR.hideBlockbar();
    const r = el.getBoundingClientRect(), w = bar().offsetWidth;
    const top = r.top - bar().offsetHeight - 6;
    if (r.bottom < 60 || r.top > innerHeight) { bar().classList.remove("open"); return; }
    bar().style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w + 8)) + "px";
    bar().style.top = Math.max(58, top) + "px";
  }
  PR.hideBlockbar = () => bar().classList.remove("open");
  window.addEventListener("scroll", PR.throttle(placeBar, 30), { passive: true });
  window.addEventListener("resize", placeBar);

  function blockMenu(id, where) {
    const b = PR.blockById[id];
    const items = actionsFor(id).map((a) => ({ label: a.label, icon: a.icon, kbd: a.kbd, fn: a.fn }));
    items.push("-",
      { label: "复制译文", icon: "copy", kbd: PR.keyOf("copy"), fn: () => copyBlock(id, "zh") },
      { label: "复制英文原文", icon: "copy", fn: () => copyBlock(id, "en") },
      // 贴进 Obsidian / Notion 是一条 Markdown 链接，点开（EasyRead 开着时）直接回到这一段
      { label: "复制段落链接（贴进笔记软件）", icon: "link", fn: () => {
        const sec = PR.sectionOf ? PR.sectionOf(id) : "";  // 用“论文 · 章节 · 页码”当链接文字，正文里可能有公式，不好截
        const title = [(S.paper.meta || {}).short_zh || (S.paper.meta || {}).title_zh || "论文", sec, b && b.page ? "p." + b.page : ""].filter(Boolean).join(" · ");
        navigator.clipboard.writeText("[" + title.replace(/[[\]]/g, "") + "](" + location.origin + location.pathname + "#b-" + id + ")").then(() => PR.toast("已复制 Markdown 链接，贴进笔记里点开就回到这一段"));
      } });
    if (b && PR.blockKeys(b).some((k) => PR.editOf(k))) items.push("-", { label: "恢复译者稿", icon: "redo", fn: () => { PR.blockKeys(b).forEach((k) => PR.editOf(k) && PR.commit({ op: "edit", block: k, zh: null })); PR.renderBlock(id); PR.applyMarks(id); } });
    PR.menu(where, items);
  }
  function copyBlock(id, lang) {
    const b = PR.blockById[id];
    const t = lang === "en" ? (b.en || b.caption_en || (b.items || []).map((i) => i.en).join("\n")) : PR.blockKeys(b).map(PR.textFor).join("\n");
    navigator.clipboard.writeText(PR.plain(t || (b.tex ? "$$" + b.tex + "$$" : ""))).then(() => PR.toast("已复制"));
  }

  /* 点击段落 = 设为当前段并出操作条；再点一次收起 */
  document.addEventListener("click", (e) => {
    if (e.target.closest("#blockbar, #selbar, #popover, .menu")) return;
    const blk = e.target.closest("#paper .blk");
    if (!blk || e.target.closest("a, button, textarea, mark, .editor-wrap, input") || getSelection().toString()) {
      if (!blk && !e.target.closest("#margin, #notespanel, #pageview, .topbar")) PR.setCurrent(null);
      return;
    }
    if (current === blk.dataset.id && bar().classList.contains("open")) PR.hideBlockbar();
    else PR.setCurrent(blk.dataset.id);
  });
  document.addEventListener("contextmenu", (e) => {
    const blk = e.target.closest("#paper .blk");
    if (!blk || getSelection().toString() || e.target.closest("textarea")) return;
    e.preventDefault();
    PR.setCurrent(blk.dataset.id, { bar: false });
    blockMenu(blk.dataset.id, { x: e.clientX, y: e.clientY });
  });

  /* 段落里的按钮：页码、角标、过期提示 */
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-t]");
    if (!t || !t.closest("#paper")) return;
    const host = t.closest(".blk");
    const id = host && host.dataset.id;
    const b = PR.blockById[id];
    if (t.dataset.t === "page" && b) PR.openPage(b.page, id);
    if (t.dataset.t === "pin") host.classList.toggle("notes-open");
    if (t.dataset.t === "stale") PR.showStale(t.closest(".zh"));
    if (t.dataset.t === "retry-failed") PR.api("/api/p/" + PR.pid + "/translate", { method: "POST", body: { failed: true } }).then(() => { PR.toast("正在重试，译好后自动替换"); PR.poll(); });
    if (t.dataset.t === "translate-rest") PR.api("/api/p/" + PR.pid + "/translate", { method: "POST", body: {} }).then(() => { PR.toast("已开始翻译，译好的页会自动出现"); PR.poll(); });
  });

  /* ---------- 重译 ---------- */
  function retranslate(id) {
    const el = document.getElementById("b-" + id);
    PR.popover(el.querySelector(".zh") || el, '<div class="hd">让模型重译这段</div>' +
      '<textarea class="input" id="rtHint" rows="3" placeholder="哪里译得不好？比如“standard error 应译标准误差”“太生硬”（可留空）"></textarea>' +
      '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px"><button class="btn sm" data-rt="cancel">取消</button><button class="btn sm accent" data-rt="go">重译</button></div>', { sticky: true, wide: true });
    setTimeout(() => PR.$("#rtHint").focus(), 30);
    PR.$("#popover").onclick = async (ev) => {
      const b = ev.target.closest("[data-rt]");
      if (!b) return;
      const hint = PR.$("#rtHint").value.trim();
      PR.hidePopover();
      if (b.dataset.rt !== "go") return;
      el.classList.add("busy");
      try {
        for (const key of PR.blockKeys(PR.blockById[id])) await PR.ask("retranslate", { key, hint });
        PR.toast("正在重译，好了会自动替换（你改过的段落会提示对比）");
      } catch (err) { el.classList.remove("busy"); PR.toast("没能提交：" + PR.esc(err.message)); }
    };
  }
  PR.on("job-finished", (j) => {
    if (j.kind !== "retranslate") return;
    const id = (j.key || "").split("#")[0];
    const el = document.getElementById("b-" + id);
    el && el.classList.remove("busy");
    if (j.state === "error") PR.toast("重译失败：" + PR.esc(j.message));
    else { PR.toast("这段已重译"); setTimeout(() => { const n = document.getElementById("b-" + id); n && n.classList.add("flash"); }, 300); }
  });

  /* ---------- 引用、交叉引用悬停 ---------- */
  let hoverT = null;
  document.addEventListener("mouseover", (e) => {
    const a = e.target.closest && e.target.closest("a.cite, a.xref");
    if (!a) return;
    clearTimeout(hoverT);
    hoverT = setTimeout(() => PR.popover(a, refCard(a)), 180);
  });
  document.addEventListener("mouseout", (e) => { if (e.target.closest && e.target.closest("a.cite, a.xref")) { clearTimeout(hoverT); PR.hidePopoverSoon(); } });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.cite, a.xref");
    if (!a) return;
    e.preventDefault();
    PR.hidePopover();
    PR.jumpTo(a.classList.contains("cite") ? "ref-" + a.dataset.ref : "b-" + PR.xindex[a.dataset.kind][a.dataset.key]);
  });
  function refCard(a) {
    if (a.classList.contains("cite")) {
      const r = PR.refById[a.dataset.ref];
      return r ? '<div class="ref"><span class="n">[' + PR.esc(r.id) + "]</span>" + PR.esc(r.text) + "</div>" : "";
    }
    const b = PR.blockById[PR.xindex[a.dataset.kind][a.dataset.key]];
    if (!b) return "";
    if (b.type === "math") return '<div class="hd">公式 (' + PR.esc(b.tag) + ") · 第 " + b.page + ' 页</div><div class="eq">' + PR.tex(b.tex, true) + "</div>";
    if (b.type === "table" || b.type === "figure") return '<div class="hd">第 ' + b.page + ' 页</div><div class="cap">' + PR.md(PR.textFor(b.id + "#caption"), { xref: false }) + "</div>";
    return '<div class="hd">跳到</div><div class="cap">' + PR.esc((b.num ? b.num + "　" : "") + PR.plain(PR.textFor(b.id))) + "</div>";
  }

  /* 所有跳转都用这个：目标放在屏幕正中（比一屏还高的才顶到上面），不被顶栏挡住 */
  PR.centerOn = function (el, instant) {
    const r = el.getBoundingClientRect(), bar = (PR.$("#bar") || {}).offsetHeight || 0;
    const room = innerHeight - bar;
    const top = r.height > room * 0.85 ? r.top - bar - 16 : r.top - bar - (room - r.height) / 2;
    window.scrollTo({ top: scrollY + top, behavior: instant ? "auto" : "smooth" });
  };

  /* opts：noBack 不记返回点；instant 不要动画；noFlash 不闪 */
  PR.jumpTo = function (domId, opts) {
    const el = document.getElementById(domId);
    if (!el) return;
    opts = opts || {};
    if (!opts.noBack && PR.rememberSpot) PR.rememberSpot(el);  // 跳得远就记下原处，好回去
    PR.centerOn(el, opts.instant);
    if (!opts.noFlash) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
    history.replaceState(history.state, "", "#" + domId);
  };

  /* 当前段的键盘操作 */
  PR.blockAction = function (name) {
    const ids = PR.$$("#paper > .blk").map((x) => x.dataset.id);
    if (name === "next" || name === "prev") {
      const d = name === "next" ? 1 : -1;
      let i = ids.indexOf(current);
      if (i < 0) i = ids.indexOf(PR.readingBlock()) - (d > 0 ? 1 : 0);
      const next = ids[Math.max(0, Math.min(ids.length - 1, i + d))];
      PR.setCurrent(next, { scroll: true });
      return true;
    }
    const id = current || PR.readingBlock();
    const act = actionsFor(id).find((a) => a.k === name);
    if (act) { PR.setCurrent(id, { bar: false }); act.fn(); return true; }
    if (name === "copy" && PR.blockById[id]) { copyBlock(id, "zh"); return true; }
    return false;
  };
})(window.PR);
