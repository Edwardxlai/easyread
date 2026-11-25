/* 文献库左侧栏，学 Claude / ChatGPT 的侧栏：
   - 置顶：单篇论文和分类都能置顶，放最上面。
   - 分类：“全部”固定；在读 / 未读 / 已读 / 星标是内置分类，可以隐藏；自己建的分类可以改名、删除，可以建子分类、移到别的分类下、折叠。
     分类的增删改在 categories.js，层级的规则在 cat-tree.js；分类树（展开后列出里面的论文）在 sidebar-tree.js。
     点“＋”新建；右键或“⋯”打开菜单；把论文拖到分类上就放进去（拖到在读 / 未读 / 已读是改状态，拖到星标是加星标）。一篇论文可以在好几个分类里（存在论文的 tags 里）。
   - 最近阅读：默认 5 篇，展开最多 10 篇；显示短标题。置顶了的论文、分类只出现在“置顶”里，不在下面重复。
   - 侧栏右边缘可以拖动调宽度。
   侧栏的设置（自建分类的顺序、隐藏、置顶）存在 prefs.json 的 library 里。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const BUILTIN = [
    ["all", PR.t("全部"), "book", () => true],
    ["reading", PR.t("在读"), "book", (i) => i.status === "reading"],
    ["unread", PR.t("未读"), "book", (i) => (i.status || "unread") === "unread"],
    ["done", PR.t("已读"), "check", (i) => i.status === "done"],
    ["starred", PR.t("星标"), "star", (i) => i.starred],
  ];
  const AUTO = [  // 有内容时才出现，不用管理
    ["questions", PR.t("有待回答的问题"), "question", (i) => i.open_questions > 0],
    ["translating", PR.t("翻译中"), "sparkle", (i) => i.job && ["queued", "running"].includes(i.job.state) && i.job.type !== "prepare"],  // 只准备原页（导入不翻译、Zotero 迁移）不算
  ];
  L.VIEWS = BUILTIN.concat(AUTO);
  const RECENT_SHORT = 5, RECENT_MAX = 10;
  const ui = { adding: false, addUnder: "", renaming: null, recentOpen: false };
  const T = PR.catTree;
  const isPinned = L.isPinned;

  /* ---------- 画面 ---------- */
  const count = (fn) => L.items.filter(fn).length;
  const more = '<span class="more" data-more title="' + PR.t("更多") + '">' + PR.icon("more", "sm") + "</span>";
  /* “分类”这一组的行（内置分类和自建分类树）左边都留箭头槽，图标对齐；置顶、最近阅读不留 */
  function viewRow(v, pinnedRow) {
    const [k, label, icon, fn] = v;
    return '<div class="srow' + (pinnedRow ? "" : " tree") + (L.view === k && !L.tag ? " on" : "") + '" data-view="' + k + '"' + (pinnedRow ? " data-pinrow" : "") + ">" + (pinnedRow ? "" : PR.foldSlot(false)) + PR.icon(icon, "sm") + "<span class=\"t\">" + label +
      '</span><span class="n">' + count(fn) + "</span>" + (k === "all" && !pinnedRow ? "" : more) + "</div>";
  }
  const lvl = (d) => (d ? ' style="--lvl:' + d + '"' : "");
  function catRow(c, pinnedRow, kids, open) {
    const d = pinnedRow ? 0 : T.depth(c);
    const slot = pinnedRow ? "" : PR.foldSlot(kids, open), tree = pinnedRow ? "" : " tree";
    if (ui.renaming === c && !pinnedRow) return '<div class="srow tree editing"' + lvl(d) + ">" + slot + PR.icon("folder", "sm") + '<input class="side-input" data-rename="' + PR.esc(c) + '" value="' + PR.esc(T.leaf(c)) + '" maxlength="' + T.MAX_NAME + '"></div>';
    return '<div class="srow' + tree + (L.tag === c ? " on" : "") + '" data-cat="' + PR.esc(c) + '"' + (pinnedRow ? " data-pinrow" : "") + lvl(d) + ' title="' + PR.esc(T.label(c)) + '">' + slot + PR.icon("folder", "sm") +
      '<span class="t">' + PR.esc(pinnedRow ? T.label(c) : T.leaf(c)) + '</span><span class="n">' + count((i) => L.inCat(i, c)) + "</span>" + more + "</div>";
  }
  const addRow = (d) => '<div class="srow tree editing"' + lvl(d) + ">" + PR.foldSlot(false) + PR.icon("folder", "sm") + '<input class="side-input" data-new placeholder="' + (ui.addUnder ? PR.t("子分类名，回车") : PR.t("分类名，回车")) + '" maxlength="' + T.MAX_PATH + '"></div>';
  /* 自建分类的树（sidebar-tree.js）：隐藏的分类连同子分类都不画；置顶的只出现在“置顶”里 */
  const catTree = (cats) => PR.sideTreeHtml(cats, {
    catRow: (c, kids, open) => catRow(c, false, kids, open), addRow,
    skip: (c) => isPinned("c:" + c) || L.side.hidden.includes("c:" + c),
    addUnder: ui.adding ? ui.addUnder : null,
  });
  /* 侧栏放短标题（PR.titles 里定：翻译时起的短标题，或主标题冒号前那半句） */
  const shortTitle = (i) => PR.titles(i).short;
  function paperRow(i, pinnedRow) {
    const title = PR.titles(i).main;
    return '<a class="srow paper" href="/read/' + i.id + '" data-paper="' + i.id + '"' + (pinnedRow ? " data-pinrow" : "") + ' title="' + PR.esc(title) + (i.last_opened ? PR.t("（{time}打开）", { time: PR.esc(PR.relTime(i.last_opened)) }) : "") + '">' +
      (pinnedRow ? PR.icon("pin", "sm") : "") + '<span class="t">' + PR.esc(shortTitle(i)) + "</span>" + (i.progress > 0.02 ? "<em>" + Math.round(i.progress * 100) + "%</em>" : "") + more + "</a>";
  }

  PR.renderSide = function () {
    const box = PR.$("#side");
    if (box.contains(document.activeElement) && document.activeElement.matches(".side-input")) return;  // 正在输入分类名
    const cats = L.cats();
    const pinned = L.side.pinned.map((key) => {
      const [t, v] = [key.slice(0, 1), key.slice(2)];
      if (t === "p") { const it = L.byId(v); return it ? paperRow(it, true) : ""; }
      if (t === "c") return cats.includes(v) ? catRow(v, true) : "";
      const view = L.VIEWS.find((x) => x[0] === v);
      return view ? viewRow(view, true) : "";
    }).join("");
    let h = pinned ? '<h3>' + PR.t("置顶") + '</h3><div class="sgroup">' + pinned + "</div>" : "";
    h += '<h3>' + PR.t("分类") + '<button class="h-add" data-add title="' + PR.t("新建分类") + '">' + PR.icon("plus", "sm") + "</button></h3><div class=\"sgroup\" data-drop-zone>" +
      BUILTIN.filter(([k]) => k === "all" || (!L.side.hidden.includes(k) && !isPinned("v:" + k))).map((v) => viewRow(v)).join("") +
      AUTO.filter(([k, , , fn]) => count(fn) && !L.side.hidden.includes(k)).map((v) => viewRow(v)).join("") +
      catTree(cats) +
      (ui.adding && !ui.addUnder ? addRow(0) : "") +
      (!ui.adding ? '<button class="srow tree hint-row" data-add>' + PR.foldSlot(false) + PR.icon("plus", "sm") + '<span class="t">' + (cats.length ? PR.t("新建分类") : PR.t("新建分类，把论文拖进来")) + "</span></button>" : "") +
      (!ui.adding && cats.length ? '<button class="srow tree hint-row" data-category-match' + (L.loadStatus === "ready" ? "" : " disabled") + ">" + PR.foldSlot(false) + PR.icon("sparkle", "sm") + '<span class="t">' + PR.t("智能分类") + "</span></button>" : "") + "</div>";
    const recent = L.items.filter((i) => i.last_opened && !isPinned("p:" + i.id)).sort((a, b) => String(b.last_opened).localeCompare(String(a.last_opened)));
    if (recent.length) {
      const shown = recent.slice(0, ui.recentOpen ? RECENT_MAX : RECENT_SHORT);
      h += '<h3>' + PR.t("最近阅读") + '</h3><div class="sgroup">' + shown.map((i) => paperRow(i)).join("") +
        (recent.length > RECENT_SHORT ? '<button class="srow toggle-more" data-recent>' + (ui.recentOpen ? PR.t("收起") : PR.t("展开更多（{n}）", { n: Math.min(recent.length, RECENT_MAX) - RECENT_SHORT })) + "</button>" : "") + "</div>";
    }
    if (L.trashCount) h += '<div class="sgroup side-trash"><button class="srow" data-trash>' + PR.icon("trash", "sm") + '<span class="t">' + PR.t("回收站") + '</span><span class="n">' + L.trashCount + "</span></button></div>";
    box.innerHTML = h;
    const inp = PR.$(".side-input", box);
    if (inp) { inp.focus(); inp.select(); }
  };

  /* ---------- 菜单 ---------- */
  const startAdd = (under, paper) => { ui.adding = paper || true; ui.addUnder = under || ""; L.render(); };
  /* 移到…：放到哪个分类下面（不能是自己或自己的子分类，也不用是现在的父分类），或者移到最外层 */
  const moveTargets = (c) => L.cats().filter((x) => !T.under(x, c) && x !== T.parent(c));
  function moveMenu(c, where) {
    PR.menu(where, (T.parent(c) ? [{ label: PR.t("移到最外层"), icon: "folder", fn: () => L.moveCatTo(c, "") }, "-"] : [])
      .concat(moveTargets(c).map((x) => ({ label: "　".repeat(T.depth(x)) + T.leaf(x), icon: "folder", fn: () => L.moveCatTo(c, x) }))));
  }
  function rowMenu(row, where) {
    if (row.dataset.view) {
      const k = row.dataset.view, key = "v:" + k;
      const items = [{ label: isPinned(key) ? PR.t("取消置顶") : PR.t("置顶"), icon: "pin", fn: () => L.togglePin(key) }];
      if (k !== "all") items.push({ label: PR.t("在侧栏隐藏"), icon: "x", fn: () => { L.setHidden(k, true); PR.toast(PR.t("已隐藏“{name}”，可以在 设置 → 侧边栏 里再打开", { name: row.textContent.trim().replace(/\d+$/, "") })); } });
      return PR.menu(where, items);
    }
    if (row.dataset.cat) {
      const c = row.dataset.cat, key = "c:" + c;
      const sibs = T.children(L.cats(), T.parent(c)), i = sibs.indexOf(c);
      return PR.menu(where, [
        { label: isPinned(key) ? PR.t("取消置顶") : PR.t("置顶"), icon: "pin", fn: () => L.togglePin(key) },
        { label: PR.t("新建子分类"), icon: "plus", fn: () => startAdd(c) },
        { label: PR.t("改名"), icon: "edit", fn: () => { ui.renaming = c; L.render(); } },
        { label: PR.t("移到…"), icon: "folder", disabled: !T.parent(c) && !moveTargets(c).length, fn: () => moveMenu(c, where) },
        { label: PR.t("上移"), disabled: i <= 0, fn: () => L.moveCat(c, -1) },
        { label: PR.t("下移"), disabled: i < 0 || i >= sibs.length - 1, fn: () => L.moveCat(c, 1) },
        { label: PR.t("在侧栏隐藏"), icon: "x", fn: () => { L.setHidden("c:" + c, true); PR.toast(PR.t("已隐藏“{name}”，可以在 设置 → 侧边栏 里再打开", { name: PR.esc(T.label(c)) })); } },
        "-",
        { label: PR.t("批量操作这个分类的论文"), icon: "check", fn: () => { L.tag = c; L.view = "all"; L.startPick(L.filtered().map((paper) => paper.id)); } },
        { label: PR.t("导出这个分类的引用"), icon: "copy", fn: () => PR.openCiteExport(L.items.filter((paper) => L.inCat(paper, c)), T.leaf(c)) },
        { label: PR.t("删除分类"), icon: "trash", fn: () => L.deleteCat(c) },
      ]);
    }
    if (row.dataset.paper) {
      const id = row.dataset.paper, key = "p:" + id;
      return PR.menu(where, [
        { label: PR.t("打开阅读"), icon: "book", fn: () => L.openReader(id) },
        { label: isPinned(key) ? PR.t("取消置顶") : PR.t("置顶"), icon: "pin", fn: () => L.togglePin(key) },
        { label: PR.t("查看详情"), icon: "note", fn: () => L.select(id) },
      ]);
    }
  }
  /* 论文行（列表里、详情里）用的“放进分类”菜单项：子分类缩进 */
  L.catMenuItems = function (id) {
    const it = L.byId(id);
    return L.cats().map((c) => ({ label: "　".repeat(T.depth(c)) + T.leaf(c), icon: "folder", kbd: (it.tags || []).includes(c) ? "✓" : "", fn: () => L.toggleInCat(id, c) }))
      .concat({ label: PR.t("新建分类并放进去…"), icon: "plus", fn: () => startAdd("", id) });
  };

  /* ---------- 事件 ---------- */
  const side = PR.$("#side");
  side.addEventListener("click", (e) => {
    if (e.target.closest(".side-input")) return;
    const m = e.target.closest("[data-more]");
    const row = e.target.closest(".srow");
    if (row && (row.dataset.leaf || row.dataset.allIn)) return;  // 树里的论文行、“还有 N 篇”归 sidebar-tree.js
    if (m && row) { e.preventDefault(); e.stopPropagation(); return rowMenu(row, m); }
    if (e.target.closest("[data-fold]") && row) return L.toggleFold(row.dataset.cat);
    if (e.target.closest("[data-add]")) return startAdd("");
    if (e.target.closest("[data-category-match]")) return L.openCategoryMatch();
    if (e.target.closest("[data-recent]")) { ui.recentOpen = !ui.recentOpen; return L.render(); }
    if (!row) return;
    if (row.dataset.view) { L.view = row.dataset.view; L.tag = null; L.render(); }
    else if (row.dataset.cat) {
      L.tag = L.tag === row.dataset.cat ? null : row.dataset.cat; L.view = "all";
      // 双击（第二下）：筛选回到双击前，切换折叠。第一下已经重画了侧栏，dblclick 落不到原来的行上，所以按 click 的 detail 认
      if (e.detail === 2 && row.querySelector("[data-fold]")) return L.toggleFold(row.dataset.cat);
      L.render();
    }
    // 论文行是链接，直接打开
  });
  side.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".srow[data-view], .srow[data-cat], .srow[data-paper]");
    if (!row) return;
    e.preventDefault();
    rowMenu(row, { x: e.clientX, y: e.clientY });
  });
  function commitInput(inp, cancel) {
    if (inp.dataset.done) return;
    inp.dataset.done = "1";
    inp.blur();  // 输入框还有焦点时侧栏不重画（见 renderSide），先让它失焦，回车后新分类才会马上出现
    const val = inp.value;
    const forPaper = ui.adding === true ? null : ui.adding, under = ui.addUnder;
    if (inp.dataset.new !== undefined) { ui.adding = false; ui.addUnder = ""; if (!cancel) L.addCat(val, forPaper, under); else L.render(); }
    else {  // 改名只改这一级的名字，父分类不变
      const from = inp.dataset.rename, parent = T.parent(from);
      ui.renaming = null;
      if (!cancel && val.trim()) L.renameCat(from, (parent ? parent + T.SEP : "") + val.replace(/\//g, " ")); else L.render();
    }
  }
  side.addEventListener("keydown", (e) => {
    const inp = e.target.closest(".side-input");
    if (!inp) return;
    if (e.key === "Enter") { e.preventDefault(); commitInput(inp); }
    if (e.key === "Escape") { e.preventDefault(); commitInput(inp, true); }
    e.stopPropagation();
  });
  side.addEventListener("focusout", (e) => { const inp = e.target.closest(".side-input"); if (inp && inp.isConnected) setTimeout(() => inp.isConnected && commitInput(inp), 0); });

  /* 侧栏宽度：右边缘拖动，记在本机 */
  const lib = PR.$(".lib");
  const setW = (w) => lib.style.setProperty("--side-w", Math.max(180, Math.min(420, w)) + "px");
  setW(PR.ls.get("easyread-side-w", 248));
  const grip = PR.el("div", { class: "side-grip", title: PR.t("拖动调整侧栏宽度（双击恢复）") });
  lib.appendChild(grip);
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const move = (ev) => setW(ev.clientX);
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.classList.remove("resizing"); PR.ls.set("easyread-side-w", parseInt(lib.style.getPropertyValue("--side-w"), 10)); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  grip.addEventListener("dblclick", () => { setW(248); PR.ls.set("easyread-side-w", 248); });

  /* 把论文从列表拖到侧栏的分类上 */
  let dragId = null;
  document.addEventListener("dragstart", (e) => { const r = e.target.closest && e.target.closest(".row[data-id], .srow[data-leaf]"); if (r) { dragId = r.dataset.id || r.dataset.leaf; e.dataTransfer.setData("text/plain", dragId); e.dataTransfer.effectAllowed = "copy"; side.classList.add("dragging"); } });
  document.addEventListener("dragend", () => { dragId = null; side.classList.remove("dragging"); PR.$$(".srow.drop", side).forEach((x) => x.classList.remove("drop")); });
  /* 能放的地方：自建分类、在读 / 未读 / 已读（改状态）、星标、“新建分类” */
  const STATUS = { reading: PR.t("在读"), unread: PR.t("未读"), done: PR.t("已读") };
  const dropTarget = (e) => dragId && e.target.closest(".srow[data-cat], .srow[data-view='starred'], .srow[data-view='reading'], .srow[data-view='unread'], .srow[data-view='done'], .srow[data-add]");
  side.addEventListener("dragover", (e) => {
    const row = dropTarget(e);
    PR.$$(".srow.drop", side).forEach((x) => x !== row && x.classList.remove("drop"));
    if (!row) return;
    e.preventDefault(); row.classList.add("drop");
  });
  side.addEventListener("drop", (e) => {
    const row = dropTarget(e);
    if (!row) return;
    e.preventDefault();
    if (row.dataset.add !== undefined) { side.classList.remove("dragging"); return startAdd("", L.picking && L.picked.has(dragId) ? Array.from(L.picked) : dragId); }  // 拖到“新建分类”：建一个，把这篇放进去
    side.classList.remove("dragging"); row.classList.remove("drop");
    // 多选时拖的是勾着的一篇，就把勾着的全部一起放过去
    const its = (L.picking && L.picked.has(dragId) ? Array.from(L.picked) : [dragId]).map(L.byId).filter(Boolean);
    const v = row.dataset.view, c = row.dataset.cat, n = its.length;
    if (v === "starred") { L.patchMany(its.filter((i) => !i.starred).map((i) => [i.id, { starred: true }])); PR.toast(n > 1 ? PR.t("{n} 篇已加星标", { n }) : PR.t("已加星标")); }
    else if (STATUS[v]) { L.patchMany(its.filter((i) => i.status !== v).map((i) => [i.id, { status: v }])); PR.toast(n > 1 ? PR.t("{n} 篇已标为{status}", { n, status: STATUS[v] }) : PR.t("已标为{status}", { status: STATUS[v] })); }
    else {
      const add = its.filter((i) => !(i.tags || []).includes(c));
      const name = PR.esc(T.label(c));
      if (add.length) { L.patchMany(add.map((i) => [i.id, { tags: (i.tags || []).concat(c) }])); PR.toast(n > 1 ? PR.t("已把 {n} 篇放进“{name}”", { n, name }) : PR.t("已放进“{name}”", { name })); }
      else PR.toast(PR.t("已经在“{name}”里了", { name }));
    }
  });
})(window.PR);
