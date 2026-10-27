/* 文献库右侧详情：元数据编辑、分类、状态、翻译任务、引用、删除。 */
(function (PR) {
  "use strict";
  const L = PR.lib;

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); PR.toast(PR.t("已复制{what}", { what })); }
    catch (e) { PR.toast(PR.t("复制失败，请手动选中")); }
  }


  /* 标题可以直接改；哪个在上面看 PR.titles（英文界面看中文译文时英文原标题在上） */
  function titleFields(i) {
    const tr = '<div class="%c" contenteditable="plaintext-only" data-meta="title_zh" lang="' + (i.target || "zh") + '" spellcheck="false">' + PR.esc(i.title_zh || "") + "</div>";
    const en = '<div class="%c" contenteditable="plaintext-only" data-meta="title_en" lang="en" spellcheck="false">' + PR.esc(i.title_en || "") + "</div>";
    return PR.titles(i).main === i.title_zh && i.title_zh ? tr.replace("%c", "title-main") + en.replace("%c", "title-sub") : en.replace("%c", "title-main") + tr.replace("%c", "title-sub");
  }

  function jobHtml(i) {
    const j = i.job || {};
    if (j.state === "confirm") return PR.pageCapHtml(j);
    const running = ["queued", "running"].includes(j.state);
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    let h = '<div class="jobbox">';
    if (running) {
      h += '<div><span class="spin"></span> ' + PR.esc(j.message || PR.t("处理中")) + (j.total ? (j.type === "figure-images" ? PR.t("（{done}/{total} 张）", {done: j.done, total: j.total}) : PR.t("（{done}/{total} 页）", { done: j.done, total: j.total })) : "") + "</div>" +
        (PR.usageShort(j.usage) ? '<div class="hint">' + PR.esc(PR.usageShort(j.usage)) + "</div>" : "") +
        '<div class="bar"><i style="width:' + pct + '%"></i></div><div class="row2"><button class="btn sm line" data-d="cancel">' + PR.t("取消") + "</button>" +
        '<button class="btn sm" data-d="read">' + PR.t("边译边读") + "</button></div>";
    } else {
      const full = i.pages && i.done_pages >= i.pages;
      const en = i.en_pages || 0, read = en > 0 || j.read;  // 只读原文：整理成英文块，没翻译
      h += read ? "<div>" + PR.t("英文原文：{done} / {total} 页", { done: i.done_pages, total: i.pages }) + (full ? PR.t(" · 全文") : "") + (i.done_pages - en ? PR.t(" · 其中 {n} 页已译", { n: i.done_pages - en }) : "") + "</div>"
        : "<div>" + PR.t("译文：{s}", { s: i.pages ? PR.t("{done} / {total} 页", { done: i.done_pages, total: i.pages }) : PR.t("尚未处理") }) + (full ? PR.t(" · 全文") : "") + "</div>";
      const failed = Object.keys(j.failed || {}).map(Number).sort((a, b) => a - b);
      if (j.type === "figure-images" && ["error", "partial"].includes(j.state)) h += '<div class="err">' + PR.esc(j.message || "") + ' ' + PR.esc(j.error || "") + '</div>';
      else if (j.state === "error") h += '<div class="err">' + (j.read ? PR.t("上次整理原文出错：") : PR.t("上次翻译出错：")) + PR.esc(j.error || j.message) + "</div>";
      if (j.read && j.state === "error") h += '<p class="hint">' + PR.t("整理原文需要可用模型。请检查模型设置后重试；重试使用当前翻译模型，已整理的内容会保留。") + '</p><button class="btn sm line" data-d="model-settings">' + PR.t("模型设置") + "</button>";
      h += PR.usageCard(j.usage, j.usage_total);
      if (j.state === "partial" && failed.length) h += '<div class="err">' + (j.read ? PR.t("第 {pages} 页没整理成功：", { pages: PR.esc(pageList(failed)) }) : PR.t("第 {pages} 页没译成功：", { pages: PR.esc(pageList(failed)) })) + PR.esc(j.error || "") + "</div>";
      h += '<div class="row2" style="margin-top:8px">' +
        (j.state === "partial" && failed.length ? '<button class="btn sm accent" data-d="retry-failed">' + PR.t("重试这 {n} 页", { n: failed.length }) + "</button>" : "") +
        (en ? '<button class="btn sm accent" data-d="translate-en">' + PR.t("翻译成{lang}", { lang: PR.targetName(PR.target) }) + "</button>" : "") +
        (!full && !(j.state === "partial" && failed.length) ? '<button class="btn sm ' + (en ? "line" : "accent") + '" data-d="' + (read ? "read-rest" : "translate") + '">' + (read ? (j.state === "error" ? PR.t("重试整理原文") : PR.t("继续整理剩下的页")) : i.done_pages ? PR.t("继续翻译剩下的页") : PR.t("开始翻译")) + "</button>" : "") +
        (!full && j.state === "partial" && failed.length && i.pages - i.done_pages > failed.length ? '<button class="btn sm line" data-d="' + (read ? "read-rest" : "translate") + '">' + (read ? PR.t("继续整理剩下的页") : PR.t("继续翻译剩下的页")) + "</button>" : "") +
        (!full && i.todo ? '<button class="btn sm line" data-d="pick-pages">' + PR.t("选页翻译…") + "</button>" : "") +
        (j.state ? '<button class="btn sm" data-d="log">' + PR.icon("log", "sm") + PR.t("翻译记录") + "</button>" : "") + "</div>" +
        (L.engine === "none" ? '<div class="hint" style="margin-top:6px">' + PR.t("当前没有开启翻译引擎，去设置里选一个。") + "</div>" : "");
    }
    return h + "</div>";
  }

  function pageList(ns) { // [3,4,5,9] → "3–5、9"
    const out = [];
    ns.forEach((n) => { const r = out[out.length - 1]; if (r && n === r[1] + 1) r[1] = n; else out.push([n, n]); });
    return out.map(([a, b]) => (a === b ? a : a + "–" + b)).join(PR.t("、"));
  }

  PR.renderDetail = function () {
    const box = PR.$("#detail");
    const i = L.byId(L.selected);
    if (!i) { box.innerHTML = ""; return; }
    if (i.load_error) {
      box.innerHTML = '<div class="detail-head"><span>' + PR.t("论文详情") +
        '</span><button class="detail-close" data-d="close" title="' + PR.t("收起（Esc）") + '">' + PR.icon("x", "sm") +
        '</button></div><div class="detail-inner"><p class="err">' + PR.esc(i.load_error) +
        '</p><a class="btn line" href="/p/' + i.id + '/source.pdf" target="_blank" rel="noopener">' +
        PR.icon("pdf", "sm") + PR.t("打开原 PDF") + '</a></div>';
      return;
    }
    if (box.contains(document.activeElement) && document.activeElement.matches("[contenteditable], input")) return; // 正在编辑，不打断
    const thumb = i.thumb ? '<div class="thumb" style="background-image:url(' + i.thumb + ')"></div>' : '<div class="thumb blank">' + PR.icon("pdf") + "</div>";
    const readLabel = i.progress > 0.02 ? PR.t("继续阅读 · {pct}%", { pct: Math.round(i.progress * 100) }) : PR.t("开始阅读");
    const status = [["unread", PR.t("未读")], ["reading", PR.t("在读")], ["done", PR.t("已读")]].map(([k, l]) =>
      '<button data-status="' + k + '" class="' + ((i.status || "unread") === k ? "on" : "") + '">' + l + "</button>").join("");
    // 分类：全部分类都列出来，点一下放进 / 拿出
    const cats = L.cats().map((c) => '<button class="catchip' + ((i.tags || []).includes(c) ? " on" : "") + '" data-cattoggle="' + PR.esc(c) + '">' + PR.icon((i.tags || []).includes(c) ? "check" : "folder", "sm") + PR.esc(PR.catTree.label(c)) + "</button>").join("");
    box.innerHTML = '<div class="detail-head"><span>' + PR.t("论文详情") + '</span><button class="detail-close" data-d="close" title="' + PR.t("收起（Esc）") + '">' + PR.icon("x", "sm") + "</button></div>" +
      '<div class="detail-inner">' +
      '<div class="cover">' + thumb + '<div class="actions">' +
      '<a class="btn accent" href="/read/' + i.id + '">' + PR.icon("book", "sm") + readLabel + "</a>" +
      '<a class="btn line" href="/p/' + i.id + '/source.pdf" target="_blank" rel="noopener">' + PR.icon("pdf", "sm") + PR.t("打开原 PDF") + "</a>" +
      '<div class="act-row"><button class="btn line" data-d="cite" title="' + PR.t("复制参考文献格式：GB/T 7714、APA、BibTeX") + '">' + PR.icon("copy", "sm") + PR.t("复制引用") + "</button>" +
      '<button class="btn icon line" data-d="star" title="' + PR.t("星标（S）") + '" style="color:' + (i.starred ? "#c9a24a" : "") + '">' + PR.icon("star", "sm").replace('class="i sm"', 'class="i sm"' + (i.starred ? ' style="fill:currentColor"' : "")) + "</button>" +
      '<button class="btn icon line" data-d="more" title="' + PR.t("更多：导出、打开文件夹、回收站") + '">' + PR.icon("more", "sm") + "</button></div></div></div>" +
      titleFields(i) +
      '<div class="cats">' + cats + '<button class="catchip add" data-d="newcat">' + PR.icon("plus", "sm") + PR.t("新分类") + "</button>" +
      '<input id="catInput" class="catchip" placeholder="' + PR.t("分类名，回车确定") + '" maxlength="30" hidden></div>' +
      '<div class="seg">' + status + "</div>" +
      '<div class="kv"><span>' + PR.t("作者") + '</span><span contenteditable="plaintext-only" data-meta="authors">' + PR.esc(i.authors) + "</span>" +
      '<span>' + PR.t("年份") + '</span><span contenteditable="plaintext-only" data-meta="year">' + PR.esc(i.year) + "</span>" +
      '<span>' + PR.t("出处") + '</span><span contenteditable="plaintext-only" data-meta="venue">' + PR.esc(i.venue || i.arxiv) + "</span>" +
      '<span>' + PR.t("链接") + '</span><span contenteditable="plaintext-only" data-meta="url">' + PR.esc(i.url) + "</span>" +
      '<span>DOI</span><span contenteditable="plaintext-only" data-meta="doi" aria-label="DOI" title="' + PR.t("可粘贴 DOI 编号或 doi.org 链接") + '">' + PR.esc(i.doi) + "</span>" +
      "<span>" + PR.t("添加于") + "</span><span>" + PR.esc(PR.relTime(i.added)) + (i.last_opened ? PR.t("　·　上次打开 {t}", { t: PR.esc(PR.relTime(i.last_opened)) }) : "") + "</span></div>" +
      "<h4>" + PR.t("翻译") + "</h4>" + jobHtml(i) +
      (i.notes + i.highlights + i.open_questions ? '<p class="mine-line">' + [i.notes && PR.t("{n} 条笔记", { n: i.notes }), i.highlights && PR.t("{n} 处划线", { n: i.highlights }), i.open_questions && PR.t("{n} 个问题待回答", { n: i.open_questions })].filter(Boolean).join(" · ") + "</p>" : "") +
      (i.abstract ? "<h4>" + PR.t("摘要") + '</h4><div class="abstract" id="abs">' + PR.esc(i.abstract.replace(/\$([^$]+)\$/g, "$1")) + '</div><button class="linkish" data-d="abs">' + PR.t("展开全文") + "</button>" : "") +
      "</div>";
  };

  async function saveMeta(el) {
    const i = L.byId(L.selected);
    const key = el.dataset.meta;
    const val = key === "doi" ? PR.normalizeDoi(el.textContent) : el.textContent.trim();
    if (key === "doi" && val && !/^10\.\d{4,9}\/[^\s{}]+$/.test(val)) {
      PR.toast(PR.t("DOI 格式不正确，请填写 10. 开头的编号或 doi.org 链接"));
      el.textContent = i.doi || "";
      return;
    }
    if (key === "doi") el.textContent = val;
    if ((i[key] || "") === val) return;
    const override = Object.assign({}, { [key]: val });
    await L.patch(i.id, { meta_override: Object.assign({}, i.meta_override || {}, override) });
  }

  const box = PR.$("#detail");
  box.addEventListener("focusout", (e) => { if (e.target.matches("[data-meta]")) saveMeta(e.target); });
  box.addEventListener("keydown", (e) => {
    if (e.target.matches("[data-meta]") && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    if (e.target.id === "catInput" && e.key === "Enter" && e.target.value.trim()) { L.addCat(e.target.value, L.selected); e.target.value = ""; }
    if (e.target.id === "catInput" && e.key === "Escape") { e.stopPropagation(); e.target.value = ""; e.target.blur(); }
  });
  /* 新分类：平时是个按钮，点了才变成输入框；没输入就离开，变回按钮 */
  box.addEventListener("focusout", (e) => {
    if (e.target.id !== "catInput" || e.target.value.trim()) return;
    e.target.hidden = true;
    const btn = box.querySelector('[data-d="newcat"]');
    if (btn) btn.hidden = false;
  });
  box.addEventListener("click", async (e) => {
    const i = L.byId(L.selected);
    if (!i) return;
    const cap = e.target.closest("[data-page-cap]");
    if (cap) return PR.handlePageCap(cap, i.id, i.job, () => L.load());
    const st = e.target.closest("[data-status]");
    if (st) return L.patch(i.id, { status: st.dataset.status });
    const ct = e.target.closest("[data-cattoggle]");
    if (ct) return L.toggleInCat(i.id, ct.dataset.cattoggle);
    const d = e.target.closest("[data-d]");
    if (!d) return;
    const act = d.dataset.d;
    if (act === "newcat") { d.hidden = true; const inp = PR.$("#catInput"); inp.hidden = false; inp.focus(); return; }
    if (act === "close") L.select(null);
    else if (act === "star") L.patch(i.id, { starred: !i.starred });
    else if (act === "read") L.openReader(i.id);
    else if (act === "model-settings") PR.openSettings("chat");
    else if (act === "abs") { PR.$("#abs").classList.toggle("open"); d.textContent = PR.$("#abs").classList.contains("open") ? PR.t("收起") : PR.t("展开全文"); }
    else if (act === "cite") PR.menu(d, [
      { label: PR.t("GB/T 7714 · 中文论文、学位论文"), icon: "copy", fn: () => copy(PR.cite(i, "gb"), PR.t(" GB/T 7714 引用")) },
      { label: PR.t("APA · 英文论文常用"), icon: "copy", fn: () => copy(PR.cite(i, "apa"), PR.t(" APA 引用")) },
      { label: "BibTeX · LaTeX / Overleaf", icon: "copy", fn: () => copy(PR.cite(i, "bibtex"), " BibTeX") },
      { label: PR.t("Zotero RDF · 保留预印本类型"), icon: "download", fn: () => PR.openCiteExport([i], i.title_en || i.title_zh, "zotero") },
      "-",
      { label: PR.t("标题 + 链接 · 发给别人"), icon: "link", fn: () => copy((i.title_zh ? PR.t("{a}（{b}）", { a: i.title_zh, b: i.title_en }) : i.title_en) + "\n" + (i.url || ""), PR.t("标题和链接")) },
    ]);
    else if (act === "more") PR.rowMenu(i.id, d);
    else if (act === "cancel") { await PR.api("/api/p/" + i.id + "/cancel", { method: "POST", body: {} }); L.load(); }
    else if (act === "retry-failed") { await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: { failed: true } }); PR.toast(PR.t("正在重试")); L.load(); }
    else if (act === "log") { const r = await PR.api("/api/p/" + i.id + "/log"); PR.showText(PR.t("翻译记录"), r.text); }
    else if (act === "pick-pages") PR.pickPages(i, d);
    else if (act === "translate") { if (await PR.startTranslation(i.id)) { PR.toast(PR.t("已开始翻译")); L.load(); } }
    else if (act === "translate-en") { if (await PR.startTranslation(i.id, {en:true})) { PR.toast(PR.t("已开始翻译，笔记和划线都保留")); L.load(); } }
    else if (act === "read-rest") {
      try {
        await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: { read: true, ...((i.job || {}).state === "error" ? { scope: i.job.scope || "all" } : {}) } });
        PR.toast(PR.t("已开始整理原文")); L.load();
      } catch (error) { PR.toast(PR.esc(error.message)); }
    }
  });
  async function retranslateAll(i) {
    if (!(await PR.startTranslation(i.id, {pages:'1-' + i.pages}, {title:PR.t("全部重新翻译？"), body:PR.t("会消耗模型额度。你改过的译文、笔记都保留。"), ok:PR.t("重新翻译")}))) return;
    PR.toast(PR.t("已开始重新翻译")); L.load();
  }

  PR.rowMenu = function (id, where) {
    const i = L.byId(id);
    const setStatus = (s) => () => L.patch(id, { status: s });
    PR.menu(where, [
      { label: PR.t("打开阅读"), icon: "book", kbd: "Enter", fn: () => L.openReader(id) },
      { label: PR.t("打开原 PDF"), icon: "pdf", fn: () => window.open("/p/" + id + "/source.pdf") },
      "-",
      { label: i.starred ? PR.t("取消星标") : PR.t("加星标"), icon: "star", kbd: "S", fn: () => L.patch(id, { starred: !i.starred }) },
      { label: L.side.pinned.includes("p:" + id) ? PR.t("取消置顶") : PR.t("置顶到侧栏"), icon: "pin", fn: () => L.togglePin("p:" + id) },
      "-",
      ...L.catMenuItems(id),
      { label: PR.t("标为未读"), fn: setStatus("unread") }, { label: PR.t("标为在读"), fn: setStatus("reading") }, { label: PR.t("标为已读"), fn: setStatus("done") },
      "-",
      { label: PR.t("复制 BibTeX"), icon: "copy", fn: () => copy(PR.cite(i, "bibtex"), " BibTeX") },
      { label: PR.t("导出离线 HTML（可发给别人）"), icon: "download", fn: () => { PR.toast(PR.t("正在打包…")); location.href = "/api/p/" + id + "/export"; } },
      { label: PR.t("导出手机版（只读，体积小）"), icon: "download", fn: () => { PR.toast(PR.t("正在打包…")); location.href = "/api/p/" + id + "/export?mobile=1"; } },
      { label: PR.t("打开所在文件夹"), icon: "folder", fn: () => PR.api("/api/p/" + id + "/reveal", { method: "POST", body: {} }).catch((e) => PR.toast(PR.esc(e.message))) },
      { label: PR.t("全部重新翻译"), icon: "redo", fn: () => retranslateAll(i) },
      { label: PR.t("翻译记录"), icon: "log", fn: async () => { const r = await PR.api("/api/p/" + id + "/log"); PR.showText(PR.t("翻译记录"), r.text); } },
      { label: PR.t("移到回收站"), icon: "trash", fn: async () => {
        if (!(await PR.confirm({ title: PR.t("移到回收站？"), body: PR.t("《{title}》会放进回收站，随时可以在左侧“回收站”里恢复。", { title: i.title_zh || i.title_en }), ok: PR.t("移到回收站"), danger: true }))) return;
        const r = await PR.api("/api/p/" + id + "/delete", { method: "POST", body: {} }).catch((e) => { PR.toast(PR.t("没删成：") + PR.esc(e.message)); return null; });
        if (!r) return;
        L.select(null); await L.load();
        const name = r && r.trash ? r.trash.split(/[\\/]/).pop() : "";
        PR.toast(PR.t("已移到回收站"), name ? { label: PR.t("撤销"), fn: () => PR.restoreTrash(name) } : null);
      } },
    ]);
  };
})(window.PR);
