/* 文献库右侧详情：元数据编辑、分类、状态、翻译任务、引用、删除。 */
(function (PR) {
  "use strict";
  const L = PR.lib;

  function citeKey(i) {
    const last = (i.authors || "anon").split(",")[0].trim().split(/\s+/).pop().replace(/[^A-Za-z]/g, "").toLowerCase() || "anon";
    const word = (i.title_en || "paper").split(/\s+/).find((w) => w.length > 3) || "paper";
    return last + (i.year || "") + word.replace(/[^A-Za-z]/g, "").toLowerCase();
  }
  PR.cite = function (i, style) {
    const authors = (i.authors || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (style === "bibtex") {
      const arx = (i.arxiv || "").replace(/^arXiv:/i, "").split(/\s/)[0];
      return "@article{" + citeKey(i) + ",\n  title = {" + i.title_en + "},\n  author = {" + authors.join(" and ") + "},\n  year = {" + (i.year || "") + "}" +
        (arx ? ",\n  eprint = {" + arx + "},\n  archivePrefix = {arXiv}" : "") + (i.doi ? ",\n  doi = {" + i.doi + "}" : "") + (i.url ? ",\n  url = {" + i.url + "}" : "") + "\n}";
    }
    if (style === "apa") {
      const apaNames = authors.slice(0, 20).map((a) => { const p = a.split(/\s+/); return p.length > 1 ? p.pop() + ", " + p.map((x) => x[0] + ".").join(" ") : a; });
      const who = apaNames.length > 1 ? apaNames.slice(0, -1).join(", ") + ", & " + apaNames[apaNames.length - 1] : apaNames[0] || "";
      return who + " (" + (i.year || "n.d.") + "). " + i.title_en + ". " + (i.venue || i.arxiv || "") + (i.url ? ". " + i.url : "");
    }
    // GB/T 7714 简式
    const names = authors.slice(0, 3).map((a) => { const p = a.split(/\s+/); return p.length > 1 ? p.pop() + " " + p.map((x) => x[0]).join(" ") : a; });
    return names.join(", ") + (authors.length > 3 ? ", et al" : "") + ". " + i.title_en + "[J/OL]. " + (i.venue || i.arxiv || "") + ", " + (i.year || "") + "." + (i.url ? " " + i.url : "");
  };
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); PR.toast("已复制" + what); }
    catch (e) { PR.toast("复制失败，请手动选中"); }
  }


  function jobHtml(i) {
    const j = i.job || {};
    const running = ["queued", "running"].includes(j.state);
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    let h = '<div class="jobbox">';
    if (running) {
      h += '<div><span class="spin"></span> ' + PR.esc(j.message || "处理中") + (j.total ? "（" + j.done + "/" + j.total + " 页）" : "") + "</div>" +
        '<div class="bar"><i style="width:' + pct + '%"></i></div><div class="row2"><button class="btn sm line" data-d="cancel">取消</button>' +
        '<button class="btn sm" data-d="read">边译边读</button></div>';
    } else {
      const full = i.pages && i.done_pages >= i.pages;
      h += "<div>译文：" + (i.pages ? i.done_pages + " / " + i.pages + " 页" : "尚未处理") + (full ? " · 全文" : "") + "</div>";
      const failed = Object.keys(j.failed || {}).map(Number).sort((a, b) => a - b);
      if (j.state === "error") h += '<div class="err">上次翻译出错：' + PR.esc(j.error || j.message) + "</div>";
      if (j.state === "paused") h += '<div class="hint">已暂停，已译的部分保留。点击下面的按钮继续。</div>';
      if (j.state === "partial" && failed.length) h += '<div class="err">第 ' + PR.esc(pageList(failed)) + " 页没译成功：" + PR.esc(j.error || "") + "</div>";
      h += '<div class="row2" style="margin-top:8px">' +
        (j.state === "partial" && failed.length ? '<button class="btn sm accent" data-d="retry-failed">重试这 ' + failed.length + " 页</button>" : "") +
        (!full && !(j.state === "partial" && failed.length) ? '<button class="btn sm accent" data-d="translate">' + (i.done_pages ? "继续翻译剩下的页" : "开始翻译") + "</button>" : "") +
        (!full && j.state === "partial" && failed.length && i.pages - i.done_pages > failed.length ? '<button class="btn sm line" data-d="translate">继续翻译剩下的页</button>' : "") +
        (j.state ? '<button class="btn sm" data-d="log">' + PR.icon("log", "sm") + "翻译记录</button>" : "") + "</div>" +
        (L.engine === "none" ? '<div class="hint" style="margin-top:6px">当前没有开启翻译引擎，去设置里选一个。</div>' : "");
    }
    return h + "</div>";
  }

  function pageList(ns) { // [3,4,5,9] → "3–5、9"
    const out = [];
    ns.forEach((n) => { const r = out[out.length - 1]; if (r && n === r[1] + 1) r[1] = n; else out.push([n, n]); });
    return out.map(([a, b]) => (a === b ? a : a + "–" + b)).join("、");
  }

  PR.renderDetail = function () {
    const box = PR.$("#detail");
    const i = L.byId(L.selected);
    if (!i) { box.innerHTML = ""; return; }
    if (box.contains(document.activeElement) && document.activeElement.matches("[contenteditable], input")) return; // 正在编辑，不打断
    const thumb = i.thumb ? '<div class="thumb" style="background-image:url(' + i.thumb + ')"></div>' : '<div class="thumb blank">' + PR.icon("pdf") + "</div>";
    const readLabel = i.progress > 0.02 ? "继续阅读 · " + Math.round(i.progress * 100) + "%" : "开始阅读";
    const status = [["unread", "未读"], ["reading", "在读"], ["done", "已读"]].map(([k, l]) =>
      '<button data-status="' + k + '" class="' + ((i.status || "unread") === k ? "on" : "") + '">' + l + "</button>").join("");
    // 分类：全部分类都列出来，点一下放进 / 拿出
    const cats = L.cats().map((c) => '<button class="catchip' + ((i.tags || []).includes(c) ? " on" : "") + '" data-cattoggle="' + PR.esc(c) + '">' + PR.icon((i.tags || []).includes(c) ? "check" : "folder", "sm") + PR.esc(c) + "</button>").join("");
    box.innerHTML = '<div class="detail-head"><span>论文详情</span><button class="detail-close" data-d="close" title="收起（Esc）">' + PR.icon("x", "sm") + "</button></div>" +
      '<div class="detail-inner">' +
      '<div class="cover">' + thumb + '<div class="actions">' +
      '<a class="btn accent" href="/read/' + i.id + '">' + PR.icon("book", "sm") + readLabel + "</a>" +
      '<a class="btn line" href="/p/' + i.id + '/source.pdf" target="_blank" rel="noopener">' + PR.icon("pdf", "sm") + "打开原 PDF</a>" +
      '<div class="act-row"><button class="btn line" data-d="cite" title="复制参考文献格式：GB/T 7714、APA、BibTeX">' + PR.icon("copy", "sm") + "复制引用</button>" +
      '<button class="btn icon line" data-d="star" title="星标（S）" style="color:' + (i.starred ? "#c9a24a" : "") + '">' + PR.icon("star", "sm").replace('class="i sm"', 'class="i sm"' + (i.starred ? ' style="fill:currentColor"' : "")) + "</button>" +
      '<button class="btn icon line" data-d="more" title="更多：导出、打开文件夹、回收站">' + PR.icon("more", "sm") + "</button></div></div></div>" +
      '<div class="title-zh" contenteditable="plaintext-only" data-meta="title_zh" spellcheck="false">' + PR.esc(i.title_zh || "") + "</div>" +
      '<div class="title-en" contenteditable="plaintext-only" data-meta="title_en" lang="en" spellcheck="false">' + PR.esc(i.title_en || "") + "</div>" +
      '<div class="cats">' + cats + '<button class="catchip add" data-d="newcat">' + PR.icon("plus", "sm") + "新分类</button>" +
      '<input id="catInput" class="catchip" placeholder="分类名，回车确定" maxlength="30" hidden></div>' +
      '<div class="seg">' + status + "</div>" +
      '<div class="kv"><span>作者</span><span contenteditable="plaintext-only" data-meta="authors">' + PR.esc(i.authors) + "</span>" +
      '<span>年份</span><span contenteditable="plaintext-only" data-meta="year">' + PR.esc(i.year) + "</span>" +
      '<span>出处</span><span contenteditable="plaintext-only" data-meta="venue">' + PR.esc(i.venue || i.arxiv) + "</span>" +
      '<span>链接</span><span contenteditable="plaintext-only" data-meta="url">' + PR.esc(i.url) + "</span>" +
      "<span>添加</span><span>" + PR.esc(PR.relTime(i.added)) + (i.last_opened ? "　·　上次打开 " + PR.esc(PR.relTime(i.last_opened)) : "") + "</span></div>" +
      "<h4>翻译</h4>" + jobHtml(i) +
      (i.notes + i.highlights + i.open_questions ? '<p class="mine-line">' + [i.notes && i.notes + " 条笔记", i.highlights && i.highlights + " 处划线", i.open_questions && i.open_questions + " 个问题待回答"].filter(Boolean).join(" · ") + "</p>" : "") +
      (i.abstract ? '<h4>摘要</h4><div class="abstract" id="abs">' + PR.esc(i.abstract.replace(/\$([^$]+)\$/g, "$1")) + '</div><button class="linkish" data-d="abs">展开全文</button>' : "") +
      "</div>";
  };

  async function saveMeta(el) {
    const i = L.byId(L.selected);
    const key = el.dataset.meta, val = el.textContent.trim();
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
    else if (act === "abs") { PR.$("#abs").classList.toggle("open"); d.textContent = PR.$("#abs").classList.contains("open") ? "收起" : "展开全文"; }
    else if (act === "cite") PR.menu(d, [
      { label: "GB/T 7714 · 中文论文、学位论文", icon: "copy", fn: () => copy(PR.cite(i, "gb"), " GB/T 7714 引用") },
      { label: "APA · 英文论文常用", icon: "copy", fn: () => copy(PR.cite(i, "apa"), " APA 引用") },
      { label: "BibTeX · LaTeX / Overleaf、Zotero 导入", icon: "copy", fn: () => copy(PR.cite(i, "bibtex"), " BibTeX") },
      "-",
      { label: "标题 + 链接 · 发给别人", icon: "link", fn: () => copy((i.title_zh ? i.title_zh + "（" + i.title_en + "）" : i.title_en) + "\n" + (i.url || ""), "标题和链接") },
    ]);
    else if (act === "more") PR.rowMenu(i.id, d);
    else if (act === "cancel") { await PR.api("/api/p/" + i.id + "/cancel", { method: "POST", body: {} }); L.load(); }
    else if (act === "retry-failed") { await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: { failed: true } }); PR.toast("正在重试"); L.load(); }
    else if (act === "log") { const r = await PR.api("/api/p/" + i.id + "/log"); PR.showText("翻译记录", r.text); }
    else if (act === "translate") { await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: {} }); PR.toast("已开始翻译"); L.load(); }
  });
  async function retranslateAll(i) {
    if (!(await PR.confirm({ title: "全部重新翻译？", body: "会消耗模型额度。你改过的译文、笔记都保留。", ok: "重新翻译" }))) return;
    await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: { pages: "1-" + i.pages } });
    PR.toast("已开始重新翻译"); L.load();
  }

  PR.rowMenu = function (id, where) {
    const i = L.byId(id);
    const setStatus = (s) => () => L.patch(id, { status: s });
    PR.menu(where, [
      { label: "打开阅读", icon: "book", kbd: "Enter", fn: () => L.openReader(id) },
      { label: "打开原 PDF", icon: "pdf", fn: () => window.open("/p/" + id + "/source.pdf") },
      "-",
      { label: i.starred ? "取消星标" : "加星标", icon: "star", kbd: "S", fn: () => L.patch(id, { starred: !i.starred }) },
      { label: L.side.pinned.includes("p:" + id) ? "取消置顶" : "置顶到侧栏", icon: "pin", fn: () => L.togglePin("p:" + id) },
      "-",
      ...L.catMenuItems(id),
      { label: "标为未读", fn: setStatus("unread") }, { label: "标为在读", fn: setStatus("reading") }, { label: "标为已读", fn: setStatus("done") },
      "-",
      { label: "复制 BibTeX", icon: "copy", fn: () => copy(PR.cite(i, "bibtex"), " BibTeX") },
      { label: "导出离线 HTML（可发给别人）", icon: "download", fn: () => { PR.toast("正在打包…"); location.href = "/api/p/" + id + "/export"; } },
      { label: "打开所在文件夹", icon: "folder", fn: () => PR.api("/api/p/" + id + "/reveal", { method: "POST", body: {} }).catch((e) => PR.toast(PR.esc(e.message))) },
      { label: "全部重新翻译", icon: "redo", fn: () => retranslateAll(i) },
      { label: "翻译记录", icon: "log", fn: async () => { const r = await PR.api("/api/p/" + id + "/log"); PR.showText("翻译记录", r.text); } },
      { label: "移到回收站", icon: "trash", fn: async () => {
        if (!(await PR.confirm({ title: "移到回收站？", body: "《" + (i.title_zh || i.title_en) + "》会放进回收站，随时可以在左侧“回收站”里恢复。", ok: "移到回收站", danger: true }))) return;
        const r = await PR.api("/api/p/" + id + "/delete", { method: "POST", body: {} }).catch((e) => { PR.toast("没删成：" + PR.esc(e.message)); return null; });
        if (!r) return;
        L.select(null); await L.load();
        const name = r && r.trash ? r.trash.split(/[\\/]/).pop() : "";
        PR.toast("已移到回收站", name ? { label: "撤销", fn: () => PR.restoreTrash(name) } : null);
      } },
    ]);
  };
})(window.PR);
