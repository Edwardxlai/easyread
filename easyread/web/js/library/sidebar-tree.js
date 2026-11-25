/* 侧栏的分类树，像编辑器的资源管理器：展开一个分类，先列子分类，再列直接放在里面的论文（叶子行）。
   - 每行左边一个固定宽度的箭头槽，没有子项的行也留空槽，同级的图标、文字左边对齐；每深一级缩进一格（categories.css）。
   - 论文行：单击在主列表里选中并显示详情，双击打开阅读，右键和“⋯”用主列表同一套菜单（PR.rowMenu），也能拖到别的分类上。
   - 一个分类里论文很多时先显示 LIMIT 篇，最后一行“还有 N 篇”，点了显示全部。
   - 双击分类行切换折叠（单击还是筛选主列表，点箭头只折叠），在 sidebar.js 的单击里认第二下。
   要画哪些行由 cat-tree.js 的 T.rows 定；分类行本身（改名、置顶、徽标）还是 sidebar.js 的 catRow 画。 */
(function (PR) {
  "use strict";
  const L = PR.lib, T = PR.catTree;
  const LIMIT = 50;
  const full = new Set();  // 点过“还有 N 篇”的分类，这次打开页面里一直显示全部

  /* 箭头槽：有子项时放箭头，没有时空着占位 */
  PR.foldSlot = (kids, open) => '<span class="tw' + (kids ? " fold" + (open ? " open" : "") + '" data-fold title="' + PR.t("展开 / 收起") + '">' + PR.icon("chevron", "sm") : '">') + "</span>";
  const lvl = (d) => ' style="--lvl:' + d + '"';
  const more = '<span class="more" data-more title="' + PR.t("更多") + '">' + PR.icon("more", "sm") + "</span>";

  function leafRow(i, d) {
    const t = PR.titles(i);
    return '<div class="srow tree leaf' + (L.selected === i.id ? " sel" : "") + '" data-leaf="' + i.id + '" draggable="true"' + lvl(d) + ' title="' + PR.esc(t.main) + '">' + PR.foldSlot(false) + PR.icon("page", "sm") +
      '<span class="t">' + PR.esc(t.short) + "</span>" + more + "</div>";
  }
  const moreRow = (c, n, d) => '<div class="srow tree show-all" data-all-in="' + PR.esc(c) + '"' + lvl(d) + ">" + PR.foldSlot(false) + '<span class="t">' + PR.t("还有 {n} 篇", { n }) + "</span></div>";

  /* o.catRow(c, kids, open)、o.addRow(depth)：sidebar.js 给；o.skip(c)：隐藏、置顶的分类不画；o.addUnder：正在它下面新建子分类，先展开 */
  PR.sideTreeHtml = function (cats, o) {
    const byTitle = (a, b) => PR.titles(a).short.localeCompare(PR.titles(b).short, PR.lang);
    const items = L.items.filter((i) => (i.tags || []).length).sort(byTitle);
    const rows = T.rows(cats, items, { open: (c) => L.isOpen(c) || o.addUnder === c, skip: o.skip, limit: LIMIT, full: (c) => full.has(c) });
    return rows.map((r) => {
      if (r.type === "paper") return leafRow(r.item, r.depth);
      if (r.type === "more") return moreRow(r.cat, r.n, r.depth);
      return o.catRow(r.c, r.kids, r.open) + (o.addUnder === r.c ? o.addRow(r.depth + 1) : "");
    }).join("");
  };

  /* L.select 不重画侧栏，这里跟着改论文行的选中样子 */
  PR.markSideLeaf = (id) => PR.$$("#side .srow[data-leaf]").forEach((r) => r.classList.toggle("sel", r.dataset.leaf === id));

  const side = PR.$("#side");
  side.addEventListener("click", (e) => {
    const all = e.target.closest("[data-all-in]");
    if (all) { full.add(all.dataset.allIn); return L.render(); }
    const leaf = e.target.closest(".srow[data-leaf]");
    if (!leaf) return;
    const id = leaf.dataset.leaf;
    const more = e.target.closest("[data-more]");
    if (more) PR.rowMenu(id, more);
    else L.select(id);
  });
  side.addEventListener("dblclick", (e) => {
    const leaf = e.target.closest(".srow[data-leaf]");
    if (leaf) L.openReader(leaf.dataset.leaf);
  });
  side.addEventListener("contextmenu", (e) => {
    const leaf = e.target.closest(".srow[data-leaf]");
    if (!leaf) return;
    e.preventDefault();
    PR.rowMenu(leaf.dataset.leaf, { x: e.clientX, y: e.clientY });
  });
})(window.PR);
