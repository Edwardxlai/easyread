/* 顶栏、阅读设置（字号/版心/行距用滑杆，= - 键也能调）、左侧抽屉（目录/术语/说明）、悬浮卡。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const body = document.body;

  /* ---------- 偏好 ---------- */
  const DEF = Object.assign({ theme: "auto", mode: "zh", lead: "translation", biOrder: "translation" }, PR.TYPE_DEFAULTS);
  /* 1.3.1 测试版存过 readingLanguage（zh / en），换成 lead；传进来的是存下的原样，还没合默认值 */
  PR.migratePrefs = function (p) {
    if (p.lead == null && p.readingLanguage != null) p.lead = p.readingLanguage === "en" ? "original" : "translation";
    if (p.biOrder == null && p.readingLanguage != null) p.biOrder = p.lead;
    delete p.readingLanguage;
    return p;
  };
  PR.prefs = Object.assign({}, DEF, PR.migratePrefs(PR.ls.get("easyread-prefs", {})));
  PR.applyPrefs = function () {
    const p = PR.prefs, root = document.documentElement;
    root.style.setProperty("--fs", p.fs + "px");
    root.style.setProperty("--lh", p.lh);
    root.style.setProperty("--measure", p.measure + "em");
    PR.applyTheme(p.theme);
    body.classList.toggle("font-sans", p.font === "sans");
    body.classList.toggle("mode-bi", p.mode === "bi");
    body.classList.toggle("no-margin", !p.margin);
    if (PR.applyReadingLanguage) PR.applyReadingLanguage();
    PR.ls.set("easyread-prefs", Object.assign(PR.migratePrefs(PR.ls.get("easyread-prefs", {})), p));
    if (PR.store.mode === "server") PR.savePrefs("reader", p);
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => PR.applyPrefs());
  const relayout = PR.debounce(() => { PR.fitWide(); PR.renderMargin(); PR.syncPage && PR.syncPage(true); }, 60);
  PR.setPref = function (k, v, quiet) {
    const anchor = PR.readingBlock && PR.readingBlock();
    const node = anchor && document.getElementById("b-" + anchor);
    const before = node ? node.getBoundingClientRect().top : 0;
    PR.prefs[k] = v;
    PR.applyPrefs();
    if (node) window.scrollBy(0, node.getBoundingClientRect().top - before);  // 调字号时阅读位置不跳
    if (!quiet) PR.renderSettings();
    else syncSettings();
    relayout();
  };
  PR.bumpFont = (d) => { PR.setPref("fs", Math.min(28, Math.max(13, PR.prefs.fs + d)), true); PR.toast(PR.t("字号 {n} px", { n: PR.prefs.fs }), null, 900); };

  function segHtml(key, opts) {
    return '<div class="seg">' + opts.map(([v, label]) => '<button data-p="' + key + '" data-v="' + v + '" class="' + (String(PR.prefs[key]) === String(v) ? "on" : "") + '">' + label + "</button>").join("") + "</div>";
  }
  function slider(key, label, min, max, step, unit) {
    return '<div class="row slider"><span>' + label + '</span><input type="range" data-r="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + PR.prefs[key] + '"><b data-rv="' + key + '">' + PR.prefs[key] + unit + "</b></div>";
  }
  PR.renderSettings = function () {
    PR.$("#settings").innerHTML =
      '<div class="row view-row-narrow">' + PR.viewSegHtml(true) + "</div>" +
      slider("fs", PR.t("字号"), 13, 28, 1, " px") + slider("measure", PR.t("版心"), 26, 50, 1, PR.t(" 字")) + slider("lh", PR.t("行距"), 1.5, 2.4, 0.05, "") +
      '<div class="row"><span>' + PR.t("字体") + "</span>" + segHtml("font", [["serif", PR.t("宋体")], ["sans", PR.t("黑体")]]) + "</div>" +
      '<div class="row"><span>' + PR.t("边注") + "</span>" + segHtml("margin", [[true, PR.t("显示")], [false, PR.t("收起")]]) + "</div>" +
      '<div class="row hintrow"><button class="linkish" data-reset-type>' + PR.t("恢复默认") + '</button><span class="grow"></span>' +
      (PR.store.mode === "server" ? '<button class="linkish" data-open-settings="reading">' + PR.t("更多设置…") + "</button>" : "") + "</div>";
  };
  function syncSettings() {
    PR.$$("#settings [data-r]").forEach((r) => { r.value = PR.prefs[r.dataset.r]; });
    PR.$$("#settings [data-rv]").forEach((b) => { const k = b.dataset.rv; b.textContent = PR.prefs[k] + ({ fs: " px", measure: PR.t(" 字") }[k] || ""); });
  }
  PR.$("#settings").addEventListener("input", (e) => {
    const r = e.target.closest("[data-r]");
    if (r) PR.setPref(r.dataset.r, +r.value, true);
  });
  PR.$("#settings").addEventListener("click", (e) => {
    const os = e.target.closest("[data-open-settings]");
    if (os) { PR.$("#settings").classList.remove("open"); return PR.openSettings(os.dataset.openSettings); }
    if (e.target.closest("[data-reset-type]")) return PR.resetAllType();
    const view = e.target.closest("[data-view]");
    if (view) return PR.setView(view.dataset.view);
    const order = e.target.closest("[data-order]");
    if (order) return PR.setBiOrder(order.dataset.order);
    const b = e.target.closest("[data-p]");
    if (!b) return;
    let v = b.dataset.v;
    if (b.dataset.p === "margin") v = v === "true";
    PR.setPref(b.dataset.p, v);
  });
  /* 排版全部回到默认（主题不动）；opts 传进来就用它（设置里改过的默认值） */
  PR.resetAllType = function (vals) {
    Object.assign(PR.prefs, vals || PR.TYPE_DEFAULTS);
    PR.setPref("fs", PR.prefs.fs);
    if (!vals) PR.toast(PR.t("排版已恢复默认"), null, 1200);
  };
  PR.resetType = () => { ["fs", "measure", "lh"].forEach((k) => (PR.prefs[k] = DEF[k])); PR.setPref("fs", DEF.fs, true); PR.toast(PR.t("已恢复默认字号和版心"), null, 1200); };

  /* ---------- 顶栏 ---------- */
  PR.$("#backBtn").innerHTML = PR.icon("back", "sm") + PR.logo();
  /* 在线演示：左上角回演示主页，顶栏多一个“在线演示”标记 */
  PR.setupDemo = function () {
    if (!S.demo) return;
    const back = PR.$("#backBtn");
    back.href = S.demo.home || "../"; back.title = PR.t("EasyRead 主页"); back.style.display = "";
    const pill = PR.el("a", { class: "demo-pill", href: S.demo.repo, target: "_blank", rel: "noopener", title: PR.t("这是在线演示；在 GitHub 上免费下载，装到自己电脑") }, PR.t("在线演示<span> · 免费下载</span>"));
    PR.$("#bar .save-state").before(pill);
  };
  PR.$('[data-act="drawer"]').innerHTML = PR.icon("menu");
  PR.$('[data-act="pages"]').innerHTML = PR.icon("page", "sm") + "<span>PDF</span>";
  PR.$('[data-act="pages"]').addEventListener("mouseenter", () => PR.preloadPage && PR.preloadPage());  // 鼠标移过去就开始加载
  PR.$('[data-act="notes"]').innerHTML = PR.icon("note", "sm") + "<span>" + PR.t("笔记") + "</span>";
  PR.$('[data-act="chat"]').innerHTML = PR.icon("sparkle", "sm") + "<span>" + PR.t("问 AI") + "</span>";
  /* 设置里关掉的功能：顶栏按钮也藏起来 */
  PR.applyFeatures = function () {
    const set = (sel, on) => { const el = PR.$(sel); if (el) el.style.display = on ? "" : "none"; };
    set('[data-act="pages"]', PR.feature("pages"));
    set('[data-act="chat"]', PR.feature("chat") && PR.chatView());
    if (!PR.feature("pages") && PR.side === "pages") PR.openSide(null);
    if (!PR.feature("chat") && PR.side === "chat") PR.openSide(null);
  };
  PR.on("ui-changed", () => { PR.applyFeatures(); PR.hideBlockbar && PR.hideBlockbar(); PR.renderMargin && PR.renderMargin(); });
  PR.$("#bar").addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]");
    if (v) return PR.setView(v.dataset.view);
    if (e.target.closest("[data-order-menu]")) return PR.toggleOrderMenu();
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "drawer") PR.toggleDrawer();
    if (act === "pages") PR.togglePages();
    if (act === "notes") PR.toggleNotesPanel();
    if (act === "chat") PR.toggleChat();
    if (act === "settings") { PR.renderSettings(); PR.$("#settings").classList.toggle("open"); }
    if (act === "about") PR.toggleDrawer(true, "about");
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#settings, [data-act=settings]")) PR.$("#settings").classList.remove("open");
    if (!e.target.closest("#popover, a.cite, a.xref, mark.hl, .stale-tag, #blockbar")) PR.hidePopover();
  });
  PR.on("status", ({ s, text }) => {
    const el = PR.$(".save-state");
    el.dataset.s = s;
    el.querySelector("span").textContent = text;
    el.title = s === "saved" ? PR.t("修改已写入 reader.json") : text;
  });
  PR.renderJobState = function () {
    const j = S.job || {};
    const el = PR.$("#jobState");
    if (j.type === "figure-images" && ["error", "partial"].includes(j.state)) {
      el.innerHTML = '<span class="err" title="' + PR.esc(j.error || "") + '">' + PR.esc(j.message || "") + '</span>'; return;
    }
    if (j.state === "confirm") { el.textContent = PR.t("等你确认"); return; }
    if (["queued", "running"].includes(j.state)) el.innerHTML = '<span class="spin"></span> ' + PR.esc(j.message || PR.t("翻译中")) + (j.total ? " " + j.done + "/" + j.total : "");
    else if (j.state === "error") el.innerHTML = '<span class="err" title="' + PR.esc(j.error || "") + '">' + (j.read ? PR.t("整理原文出错") : PR.t("翻译出错")) + "</span>";
    else if (j.state === "partial") el.innerHTML = '<span class="err" title="' + PR.esc(j.error || "") + '">' + (j.read ? PR.t("{n} 页没整理成功", { n: Object.keys(j.failed || {}).length }) : PR.t("{n} 页没译成功", { n: Object.keys(j.failed || {}).length })) + "</span>";
    else el.innerHTML = "";
  };

  /* ---------- 抽屉 ---------- */
  let tab = "toc";
  PR.toggleDrawer = function (force, which) {
    if (which) tab = which;
    const open = force != null ? force : !body.classList.contains("drawer-open");
    body.classList.toggle("drawer-open", open);
    if (open) PR.renderDrawer();
  };
  PR.$("#scrim").onclick = () => PR.toggleDrawer(false);
  if (PR.store.mode !== "server") PR.$('[data-tab="recent"]').hidden = true;  // 离线单文件版没有文献库
  PR.$(".drawer-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; PR.renderDrawer(); } });

  PR.renderDrawer = function () {
    PR.$$(".drawer-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    const box = PR.$(".drawer-body");
    box.innerHTML = ({ toc: tocHtml, terms: termsHtml, about: aboutHtml, recent: recentHtml })[tab]();
    box.className = "drawer-body " + tab;
  };
  /* 最近读过的论文：不用回文献库就能换一篇 */
  let recent = null;
  function recentHtml() {
    if (!recent) {
      PR.api("/api/library").then((d) => { recent = d.items.filter((i) => i.last_opened).sort((a, b) => String(b.last_opened).localeCompare(String(a.last_opened))).slice(0, 15); if (tab === "recent") PR.renderDrawer(); })
        .catch(() => { recent = []; });
      return '<p class="hint">' + PR.t("加载中…") + "</p>";
    }
    return '<nav class="toc recent-list">' + recent.map((i) => '<a href="/read/' + i.id + '" class="l1' + (i.id === PR.pid ? " on" : "") + '"><span class="cnt">' + (i.progress > 0.02 ? Math.round(i.progress * 100) + "%" : "") + "</span>" +
      PR.esc(i.title_zh || i.title_en || PR.t("（未命名）")) + "</a>").join("") + '</nav><a class="btn sm line" href="/" style="margin-top:12px">' + PR.t("打开文献库") + "</a>";
  }
  function countByHeading() {
    const counts = {};
    let cur = "head";
    for (const b of S.paper.blocks || []) {
      if (b.type === "heading" || b.type === "references") cur = b.id;
      const n = ((PR.noteGroups || {})[b.id] || []).length;
      if (n) counts[cur] = (counts[cur] || 0) + n;
    }
    return counts;
  }
  function tocHtml() {
    const counts = countByHeading();
    const cur = PR.currentHeading && PR.currentHeading();
    let html = '<nav class="toc">', app = false;
    for (const h of PR.headings) {
      if (h.appendix && !app) { html += '<div class="group">' + PR.t("附录") + "</div>"; app = true; }
      html += '<a href="#b-' + h.id + '" data-go="' + h.id + '" class="' + "l" + h.level + (cur === h.id ? " on" : "") + '">' +
        (counts[h.id] ? '<span class="cnt">' + counts[h.id] + "</span>" : "") + '<span class="n">' + PR.esc(h.num || "") + "</span>" + PR.esc(PR.plain(PR.textFor(h.id) || h.zh)) + "</a>";
    }
    const done = new Set((S.paper.translation || {}).done_pages || []);
    const miss = ((S.paper.meta || {}).pages || []).filter((p) => !done.has(p.n));
    if (miss.length) html += '<div class="group">' + ((S.job || {}).read || (S.paper.translation || {}).en_pages?.length ? PR.t("还没整理的页") : PR.t("未译的页")) + '</div>' + miss.map((p) => '<a href="#orig-' + p.n + '" data-go-orig="' + p.n + '" class="l1"><span class="n"></span>' + PR.t("原文第 {n} 页", { n: p.n }) + "</a>").join("");
    return html + "</nav>";
  }
  function termsHtml() {
    const g = S.paper.glossary || [];
    return '<p class="hint" style="margin:0 0 10px">' + PR.t("译法不合心意？改右边的译法，再点“替换”，会把正文里的旧译法换成新的（记为你的修改，公式不动，随时可在段落右键“恢复译者稿”）。") + "</p>" +
      (g.length ? '<table class="terms-t">' + g.map((t, i) => "<tr><td>" + PR.esc(t.en) + '</td><td><input class="input term-in" data-i="' + i + '" value="' + PR.esc(t.zh) + '"></td><td><button class="btn sm line" data-term="' + i + '">' + PR.t("替换") + "</button></td></tr>").join("") + "</table>" : '<p class="hint">' + PR.t("这篇论文还没有术语表。") + "</p>") +
      '<div class="term-free"><div class="hint" style="margin:14px 0 6px">' + PR.t("任意替换") + '</div><div style="display:flex;gap:6px"><input class="input" id="tFrom" placeholder="' + PR.t("原译法") + '"><input class="input" id="tTo" placeholder="' + PR.t("新译法") + '"><button class="btn sm line" data-term="free">' + PR.t("替换") + "</button></div></div>";
  }
  function aboutHtml() {
    const tr = S.paper.translation || {};
    const m = S.paper.meta || {};
    const pdf = PR.pdfUrl(1);
    const status = S.demo ? PR.t("这是 EasyRead 的在线演示。你在这里做的划线和笔记只存在这个浏览器里，别人看不到。装到自己电脑上，就能导入任意论文、后台翻译、边读边问 AI。")
      : PR.store.mode === "server"
      ? PR.t("你改的译文、笔记、划线写进论文目录的 reader.json（每次保存记日志，每 10 分钟留快照）。翻译方只写 paper.json 和 discussion.json，不会覆盖你的内容。")
      : PR.t("这是离线单文件版：修改只存在当前浏览器里。要把修改带回文献库，点“导出我的修改”得到一个 JSON，再运行 easyread merge。");
    const en = (tr.en_pages || []).length, done = (tr.done_pages || []).length;
    return '<div class="about"><h3>' + (en ? PR.t("英文原文") : PR.t("译文")) + "</h3><p>" + (en ? PR.t("{done} / {n} 页，其中 {en} 页没有翻译。", { done, n: (m.pages || []).length, en }) : PR.t("{done} / {n} 页。", { done, n: (m.pages || []).length })) + PR.esc(tr.note || "") + "</p>" +
      "<h3>" + PR.t("保存") + "</h3><p>" + status + "</p>" + (PR.store.pending ? "<p>" + PR.t("还有 {n} 条修改在等待写入。", { n: PR.store.pending }) + "</p>" : "") +
      '<div class="row">' + (pdf ? '<a class="btn sm line" href="' + pdf + '" target="_blank" rel="noopener">' + PR.t("打开原 PDF") + "</a>" : "") +
      '<button class="btn sm line" data-x="md">' + PR.t("导出笔记…") + "</button>" + (PR.store.mode === "static" && !S.demo ? '<button class="btn sm line" data-x="ops">' + PR.t("导出我的修改") + "</button>" : "") + "</div>" +
      "<h3>" + PR.t("怎么用") + "</h3><p>" + PR.t("点一下段落，上方出现操作条：笔记、提问、问 AI、原文、改译文、原页。右键段落是完整菜单。选中文字可以用四种颜色划线、写笔记、提问；打开问 AI 时，选中的文字可以直接拖进输入框，一次引用多段。双击一段直接改译文。") + "</p>" +
      "<h3>" + PR.t("快捷键") + "</h3>" + (PR.keysOn
        ? '<div class="keyrows">' + PR.KEY_ACTIONS.filter(([id, , , , need]) => PR.keymap[id] && (!need || PR.feature(need))).map(([id, label]) => "<kbd>" + PR.esc(PR.keyOf(id)) + "</kbd><span>" + label + "</span>").join("") +
          "<kbd>1–4</kbd><span>" + PR.t("选中文字后：四色划线") + "</span><kbd>Esc</kbd><span>" + PR.t("关闭面板、取消选中") + "</span></div>"
        : "<p>" + PR.t("快捷键已关闭。") + "</p>") +
      '<button class="btn sm line" data-x="keys">' + PR.t("设置快捷键和功能") + "</button></div>";
  }
  PR.$("#drawer").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) { e.preventDefault(); PR.toggleDrawer(false); PR.jumpTo("b-" + go.dataset.go); return; }
    const og = e.target.closest("[data-go-orig]");
    if (og) { e.preventDefault(); PR.toggleDrawer(false); PR.jumpTo("orig-" + og.dataset.goOrig); return; }
    const t = e.target.closest("[data-term]");
    if (t) {
      let from, to;
      if (t.dataset.term === "free") { from = PR.$("#tFrom").value.trim(); to = PR.$("#tTo").value.trim(); }
      else { const g = S.paper.glossary[+t.dataset.term]; from = g.zh; to = PR.$('.term-in[data-i="' + t.dataset.term + '"]').value.trim(); }
      const n = PR.replaceTerm(from, to, true);
      if (!n) return PR.toast(PR.t("正文里没找到“{s}”", { s: PR.esc(from) }));
      PR.confirm({ title: PR.t("替换 {n} 处？", { n }), body: PR.t("把正文里的“{from}”换成“{to}”。", { from, to }), ok: PR.t("替换"), at: t })
        .then((ok) => { if (ok) { PR.replaceTerm(from, to); PR.toast(PR.t("已替换 {n} 处", { n })); } });
      return;
    }
    const x = e.target.closest("[data-x]");
    if (x) x.dataset.x === "keys" ? PR.openSettings("keys") : x.dataset.x === "md" ? PR.openExport() : PR.download(x.dataset.x);
  });

  PR.download = function (kind) {
    const stem = ((S.paper.meta || {}).short_zh || (S.paper.meta || {}).title_zh || PR.t("论文")).replace(/[\\/:*?"<>|]/g, "");
    const text = kind === "ops" ? JSON.stringify(PR.exportOps(), null, 1) : PR.notesMarkdown();
    const a = PR.el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })), download: stem + (kind === "ops" ? PR.t("-我的修改.json") : PR.t("-笔记.md")) });
    document.body.appendChild(a); a.click(); a.remove();
  };

  /* ---------- 悬浮卡 ---------- */
  let popHideT = null, popSticky = false, popCleanup = null;
  function releasePopover() {
    const cleanup = popCleanup; popCleanup = null;
    if (cleanup) cleanup();
  }
  PR.popover = function (anchor, html, opts) {
    if (!html) return;
    releasePopover();
    popCleanup = opts && opts.onClose;
    clearTimeout(popHideT);
    const pop = PR.$("#popover");
    pop.onclick = null;
    popSticky = !!(opts && opts.sticky);
    pop.classList.toggle("wide", !!(opts && opts.wide));
    pop.innerHTML = html;
    pop.classList.add("open");
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    const x = Math.min(innerWidth - w - 10, Math.max(10, r.left + r.width / 2 - w / 2));
    let y = r.bottom + 8;
    if (y + h > innerHeight - 10) y = r.top - h - 8;
    pop.style.left = x + "px"; pop.style.top = Math.max(58, y) + "px";
  };
  PR.hidePopover = () => {
    releasePopover();
    clearTimeout(popHideT);
    const pop = PR.$("#popover"); pop.classList.remove("open");
    if (pop.querySelector(".media-hover")) pop.replaceChildren();
  };
  PR.hidePopoverSoon = () => { if (popSticky) return; clearTimeout(popHideT); popHideT = setTimeout(PR.hidePopover, 220); };
  PR.$("#popover").addEventListener("mouseenter", () => clearTimeout(popHideT));
  PR.$("#popover").addEventListener("mouseleave", () => PR.hidePopoverSoon());
})(window.PR);
