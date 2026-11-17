/* 自建分类的数据操作：新建、改名 / 移动、删除、排序、放进 / 拿出论文，以及侧栏设置（顺序、隐藏、置顶、折叠）。
   折叠：expanded 里的分类是展开的，其余默认收起；collapsed 是旧版记下的“收起”，一起维护，旧版打开也对得上。
   分类可以有层级：名字就是路径“父/子”（见 cat-tree.js）。改名或移动父分类时，子分类和论文上的路径一起改。
   侧栏设置存在 prefs.json 的 library 里，本机再存一份，打开时先用本机的不闪。 */
(function (PR) {
  "use strict";
  const L = PR.lib, T = PR.catTree;

  L.side = Object.assign({ cats: [], hidden: [], pinned: [], collapsed: [], expanded: [] }, PR.ls.get("easyread-lib-side", {}));
  const fixLists = () => ["collapsed", "expanded"].forEach((k) => { if (!Array.isArray(L.side[k])) L.side[k] = []; });
  fixLists();
  L.saveSide = function () {
    PR.ls.set("easyread-lib-side", L.side);
    PR.savePrefs("library", { cats: L.side.cats, hidden: L.side.hidden, pinned: L.side.pinned, collapsed: L.side.collapsed, expanded: L.side.expanded });
  };
  L.useServerSide = (p) => { if (p && p.library) { Object.assign(L.side, p.library); fixLists(); PR.ls.set("easyread-lib-side", L.side); L.render(); } };

  /* 全部自建分类，按树的顺序：设置里记下的顺序 + 论文上已有但没记下的（旧版的标签、导入带来的），祖先自动补上 */
  L.cats = function () {
    const out = L.side.cats.slice();
    L.items.forEach((i) => (i.tags || []).forEach((t) => { if (!out.includes(t)) out.push(t); }));
    return T.ordered(out);
  };
  L.inCat = (i, c) => (i.tags || []).some((t) => T.under(t, c));  // 在 c 或它的子分类里
  L.isPinned = (key) => L.side.pinned.includes(key);
  L.togglePin = (key) => {
    L.side.pinned = L.isPinned(key) ? L.side.pinned.filter((k) => k !== key) : [key].concat(L.side.pinned);
    L.saveSide(); L.render();
  };

  async function patchMany(changes) {  // [[id, {字段}]]：先改界面，再逐个存（批量操作 batch.js 也用）
    changes.forEach(([id, f]) => Object.assign(L.byId(id) || {}, f));
    L.render();
    for (const [id, f] of changes) await PR.api("/api/p/" + id + "/item", { method: "POST", body: f }).catch((e) => PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(e.message) })));
    L.load();
  }
  L.patchMany = patchMany;

  /* parent：建成哪个分类的子分类；name 里自己带“/”也会建成多级 */
  L.addCat = function (name, paperId, parent) {
    name = T.clean((parent ? parent + T.SEP : "") + (name || ""));
    if (!name || name === parent) return L.render();
    if (!L.cats().includes(name)) L.side.cats = L.cats().concat(name);
    if (parent) L.openTo(parent);  // 展开到能看见新分类
    L.saveSide();
    const add = [].concat(paperId || []).map(L.byId).filter((it) => it && !(it.tags || []).includes(name));  // 一篇的 id，或多选拖过来的一组
    if (add.length) return patchMany(add.map((it) => [it.id, { tags: (it.tags || []).concat(name) }]));
    L.render();
  };

  /* 改名和移动是一回事：from 这棵子树整体换成 to（完整路径） */
  L.renameCat = function (from, to) {
    to = T.clean(to);
    if (!to || to === from) return L.render();
    if (T.under(to, from)) { PR.toast(PR.t("不能把分类放进它自己的子分类里")); return L.render(); }
    if (L.cats().includes(to)) { PR.toast(PR.t("已经有叫“{name}”的分类", { name: PR.esc(T.label(to)) })); return L.render(); }
    const mv = (c) => T.move(c, from, to);
    const mvKey = (k) => (k.startsWith("c:") ? "c:" + mv(k.slice(2)) : k);
    L.side.cats = L.cats().map(mv);
    L.side.pinned = L.side.pinned.map(mvKey);
    L.side.hidden = L.side.hidden.map(mvKey);
    L.side.collapsed = L.side.collapsed.map(mv);
    L.side.expanded = L.side.expanded.map(mv);
    if (L.view === "all" && L.tag && T.under(L.tag, from)) L.tag = mv(L.tag);
    L.saveSide();
    patchMany(L.items.filter((i) => L.inCat(i, from)).map((i) => [i.id, { tags: Array.from(new Set(i.tags.map(mv))) }]));
  };
  L.moveCatTo = (c, parent) => L.renameCat(c, (parent ? parent + T.SEP : "") + T.leaf(c));

  L.deleteCat = async function (name, at) {
    const n = L.items.filter((i) => L.inCat(i, name)).length;
    const subs = L.cats().filter((c) => c !== name && T.under(c, name)).length;
    const body = (subs ? PR.t("它下面的 {n} 个子分类也会一起删掉。", { n: subs }) : "") + (n ? PR.t("里面的 {n} 篇论文不会删，只是不再属于这个分类。", { n }) : "");
    if (!(await PR.confirm({ title: PR.t("删除分类“{name}”？", { name: T.label(name) }), body, ok: PR.t("删除"), danger: true, at }))) return;
    const gone = (c) => T.under(c, name);
    const goneKey = (k) => k.startsWith("c:") && gone(k.slice(2));
    L.side.cats = L.cats().filter((c) => !gone(c));
    L.side.pinned = L.side.pinned.filter((k) => !goneKey(k));
    L.side.hidden = L.side.hidden.filter((k) => !goneKey(k));
    L.side.collapsed = L.side.collapsed.filter((c) => !gone(c));
    L.side.expanded = L.side.expanded.filter((c) => !gone(c));
    if (L.view === "all" && L.tag && gone(L.tag)) L.tag = null;
    L.saveSide();
    patchMany(L.items.filter((i) => L.inCat(i, name)).map((i) => [i.id, { tags: i.tags.filter((t) => !gone(t)) }]));
  };
  L.toggleInCat = function (id, name) {
    const it = L.byId(id);
    if (!it) return;
    const has = (it.tags || []).includes(name);
    patchMany([[id, { tags: has ? it.tags.filter((t) => t !== name) : (it.tags || []).concat(name) }]]);
  };
  L.setHidden = function (view, hide) {
    L.side.hidden = hide ? Array.from(new Set(L.side.hidden.concat(view))) : L.side.hidden.filter((v) => v !== view);
    if (hide && L.view === view) L.view = "all";
    L.saveSide(); L.render();
  };
  L.moveCat = function (name, d) {  // 在同级里上移 / 下移，子分类跟着走
    L.side.cats = T.shift(L.cats(), name, d);
    L.saveSide(); L.render();
  };
  L.isOpen = (c) => L.side.expanded.includes(c);
  const setOpen = (c, open) => {
    L.side.expanded = L.side.expanded.filter((x) => x !== c).concat(open ? c : []);
    L.side.collapsed = L.side.collapsed.filter((x) => x !== c).concat(open ? [] : c);
  };
  L.toggleFold = function (c) {
    setOpen(c, !L.isOpen(c));
    L.saveSide(); L.render();
  };
  /* 展开 c 和它的祖先（不存，调用的地方自己存） */
  L.openTo = (c) => T.parts(c).forEach((_, k, p) => setOpen(p.slice(0, k + 1).join(T.SEP), true));
})(window.PR);
