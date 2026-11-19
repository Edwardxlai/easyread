/* 文献库批量操作：勾几篇论文，一次放进分类、移出当前分类、切换在读 / 未读 / 已读、翻译、导出引用、移到回收站。
   进入：点表头“批量操作”，或点缩略图左上角的小方框，或 Ctrl/⌘ + 点论文，或 Ctrl/⌘ + A 全选。
   多选时：点论文 = 勾上 / 取消；Shift + 点 = 连选一段；Esc 或“完成”退出；勾着的论文可以一起拖到侧栏分类上。
   换分类、搜索时已勾的都留着；表头的全选框只管当前列表里看得见的。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  let anchor = null;  // Shift 连选的起点

  const pickedItems = () => L.items.filter((i) => L.picked.has(i.id));
  const busy = (i) => i.job && ["queued", "running"].includes(i.job.state);

  L.startPick = function (ids) {
    L.picking = true;
    (ids || []).forEach((id) => L.picked.add(id));
    L.select(null); L.render();
  };
  L.endPick = function () {
    L.picking = false; L.picked.clear(); anchor = null;
    L.render();
  };
  function toggle(id, shift) {
    const ids = L.filtered().map((i) => i.id);
    const a = ids.indexOf(anchor), b = ids.indexOf(id);
    if (shift && a >= 0 && b >= 0) ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => L.picked.add(x));
    else if (L.picked.has(id)) L.picked.delete(id);
    else L.picked.add(id);
    anchor = id;
  }

  /* ---------- 表头 ---------- */
  const head = PR.$(".list-head"), bar = PR.$("#batchBar"), pickBtn = PR.$("#pickBtn");
  pickBtn.innerHTML = PR.icon("check", "sm") + PR.t("批量操作");
  pickBtn.title = PR.t("勾选几篇论文，一起放进分类、翻译、导出引用（Ctrl/⌘ + 点论文也行）");
  const tool = (act, label, icon, title) => '<button class="btn sm line" data-b="' + act + '"' + (title ? ' title="' + PR.esc(title) + '"' : "") + ">" + (icon ? PR.icon(icon, "sm") : "") + label + "</button>";

  PR.renderBatch = function (list) {
    L.picked.forEach((id) => { if (!L.byId(id)) L.picked.delete(id); });  // 删掉了的不再算
    head.classList.toggle("picking", L.picking);
    PR.$("#list").classList.toggle("picking", L.picking);
    pickBtn.disabled = !list.length;
    if (!L.picking) { bar.innerHTML = ""; return; }
    const n = L.picked.size, shown = list.filter((i) => L.picked.has(i.id)).length, hiddenN = n - shown;
    bar.innerHTML = '<label class="pick-all" title="' + PR.t("全选 / 取消全选当前列表（Ctrl/⌘ + A）") + '"><input type="checkbox" data-b="all"' + (list.length && shown === list.length ? " checked" : "") + ">" +
      "<span>" + (n ? PR.t("已选 {n} 篇", { n }) : PR.t("全选")) + "</span></label>" +
      (hiddenN ? '<span class="pick-hidden" title="' + PR.t("在别的分类或搜索结果里勾的，也会一起处理") + '">' + PR.t("（{n} 篇不在当前列表）", { n: hiddenN }) + "</span>" : "") +
      '<span class="grow"></span><div class="batch-tools"' + (n ? "" : " data-empty") + ">" +
      tool("cat", PR.t("加入分类"), "folder") +
      (canRemoveCurrent() ? tool("uncat", PR.t("移出“{name}”", { name: L.tag ? PR.catTree.leaf(L.tag) : PR.t("星标") }), "x") : "") +
      tool("status", PR.t("切换状态"), "book") +
      tool("translate", PR.t("翻译"), "sparkle") +
      (pickedItems().some(L.modelBusy) ? tool("stop", PR.t("停止翻译"), "stop") : "") +
      tool("cite", PR.t("导出引用"), "copy") +
      tool("trash", "", "trash", PR.t("移到回收站")) + "</div>" +
      '<button class="btn sm accent" data-b="done">' + PR.t("完成") + "</button>";
    PR.$$(".batch-tools button", bar).forEach((b) => (b.disabled = !n));
    const all = PR.$('[data-b="all"]', bar);
    all.indeterminate = shown > 0 && shown < list.length;
  };

  /* ---------- 批量操作 ---------- */
  function setTags(fn) {
    const changes = pickedItems().map((i) => [i, fn(i.tags || [])]).filter(([i, tags]) => tags.join("\n") !== (i.tags || []).join("\n"));
    if (changes.length) L.patchMany(changes.map(([i, tags]) => [i.id, { tags }]));
    return changes.length;
  }
  function addTo(name) {
    const n = setTags((tags) => (tags.includes(name) ? tags : tags.concat(name)));
    const label = PR.esc(PR.catTree.label(name));
    PR.toast(n ? PR.t("已把 {n} 篇放进“{name}”", { n, name: label }) : PR.t("都已经在“{name}”里了", { name: label }));
  }
  function removeFrom(name) {
    const n = setTags((tags) => tags.filter((t) => !PR.catTree.under(t, name)));  // 连同它的子分类
    PR.toast(PR.t("已把 {n} 篇移出“{name}”", { n, name: PR.esc(PR.catTree.label(name)) }));
    if (name === L.tag) L.endPick();  // 勾着的都不在当前列表了，留着勾选只会让人找不着
  }
  async function newCat(then) {
    const name = ((await PR.promptText({ title: PR.t("新建分类"), placeholder: PR.t("分类名"), ok: PR.t("建好放进去"), max: 30 })) || "").trim().slice(0, 30);
    if (!name) return;
    L.addCat(name);
    then(name);
  }

  const setFields = (fields, msg) => () => {
    L.patchMany(pickedItems().filter((i) => Object.keys(fields).some((k) => (k === "status" ? i.status || "unread" : !!i[k]) !== fields[k])).map((i) => [i.id, fields]));
    PR.toast(msg);
  };
  /* 加入分类：星标 + 自建分类，只往里放；已经全在里面的右边打 ✓。
     移出只在打开某个分类（或星标）时出现在表头，“全部”里没有移出。 */
  function catMenu(at) {
    const its = pickedItems(), total = its.length;
    const entry = (label, icon, has, add) => ({ label, icon, kbd: its.every(has) ? "✓" : "", fn: add });
    PR.menu(at, [
      entry(PR.t("星标"), "star", (i) => i.starred, setFields({ starred: true }, PR.t("{n} 篇已加星标", { n: total }))),
      "-",
      ...L.cats().map((c) => entry("　".repeat(PR.catTree.depth(c)) + PR.catTree.leaf(c), "folder", (i) => (i.tags || []).includes(c), () => addTo(c))),
      { label: PR.t("新建分类并放进去…"), icon: "plus", fn: () => newCat(addTo) },
    ]);
  }
  function canRemoveCurrent() { return (L.tag && L.view === "all") || L.view === "starred"; }
  function removeCurrent() {
    if (L.tag && L.view === "all") return removeFrom(L.tag);
    setFields({ starred: false }, PR.t("{n} 篇已取消星标", { n: L.picked.size }))();
    L.endPick();
  }
  /* 切换状态：在读 / 未读 / 已读三选一，全都是这个状态的打 ✓ */
  function statusMenu(at) {
    const its = pickedItems(), total = its.length;
    const status = (s, label, icon) => ({ label, icon, kbd: its.every((i) => (i.status || "unread") === s) ? "✓" : "", fn: setFields({ status: s }, PR.t("{n} 篇已标为{status}", { n: total, status: label })) });
    PR.menu(at, [status("reading", PR.t("在读"), "book"), status("unread", PR.t("未读"), "book"), status("done", PR.t("已读"), "check")]);
  }
  async function translateAll(at) {
    if (L.engine === "none") return PR.toast(PR.t("当前没有开启翻译引擎，去设置里选一个。"));
    const its = pickedItems();
    const todo = its.filter((i) => !busy(i) && (i.en_pages || !(i.pages && i.done_pages >= i.pages)));
    const skip = its.length - todo.length;
    if (!todo.length) return PR.toast(PR.t("选中的论文都已译完或正在翻译"));
    const extra = await PR.translationDialog({title:PR.t("翻译这 {n} 篇？", {n:todo.length}), body:PR.t("会按顺序排队，只译还没译的页，消耗模型额度。") + (skip ? PR.t("另有 {n} 篇已译完或正在翻译，跳过。", {n:skip}) : '')});
    if (extra === null) return;
    let failed = 0;
    for (const i of todo) {
      await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: {en:!!i.en_pages, translation_extra:extra} }).catch(() => failed++);
    }
    PR.toast(failed ? PR.t("{ok} 篇已排队，{n} 篇没排上（可能已有任务）", { ok: todo.length - failed, n: failed }) : PR.t("{n} 篇已排队翻译", { n: todo.length }));
    L.load();
  }

  async function trashAll(at) {
    const its = pickedItems();
    if (!(await PR.confirm({ title: PR.t("把 {n} 篇移到回收站？", { n: its.length }), body: PR.t("随时可以在左侧“回收站”里恢复。"), ok: PR.t("移到回收站"), danger: true, at }))) return;
    const names = [];
    let failed = 0;
    for (const i of its) {
      const r = await PR.api("/api/p/" + i.id + "/delete", { method: "POST", body: {} }).catch(() => null);
      if (r && r.trash) names.push(r.trash.split(/[\\/]/).pop()); else if (!r) failed++;
    }
    L.endPick(); await L.load();
    const undo = async () => {
      for (const name of names) await PR.api("/api/trash", { method: "POST", body: { action: "restore", name } }).catch(() => {});
      await L.load(); PR.toast(PR.t("已恢复 {n} 篇", { n: names.length }));
    };
    PR.toast(PR.t("已把 {n} 篇移到回收站", { n: its.length - failed }) + (failed ? PR.t("，{n} 篇没删成", { n: failed }) : ""), names.length ? { label: PR.t("撤销"), fn: undo } : null);
  }

  function run(act, at) {
    if (act === "cat") catMenu(at);
    else if (act === "uncat") removeCurrent();
    else if (act === "status") statusMenu(at);
    else if (act === "translate") translateAll(at);
    else if (act === "stop") PR.stopJobs(pickedItems(), at);
    else if (act === "cite") PR.openCiteExport(pickedItems(), L.tag ? PR.catTree.leaf(L.tag) : PR.$("#viewTitle").textContent);
    else if (act === "trash") trashAll(at);
  }

  /* ---------- 事件 ---------- */
  pickBtn.onclick = () => L.startPick();
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-b]");
    if (!b || b.disabled) return;
    const act = b.dataset.b;
    if (act === "done") return L.endPick();
    if (act === "all") {
      const ids = L.filtered().map((i) => i.id);
      if (b.checked) ids.forEach((id) => L.picked.add(id)); else ids.forEach((id) => L.picked.delete(id));
      return L.render();
    }
    run(act, b);
  });

  /* 抢在 app.js 之前处理：多选时点论文是勾选，不是打开详情 */
  const list = PR.$("#list");
  list.addEventListener("click", (e) => {
    const r = e.target.closest(".row");
    if (!r) return;
    const box = e.target.closest("[data-pick]"), mod = e.ctrlKey || e.metaKey;
    if (!L.picking && !box && !mod) return;
    e.stopPropagation(); e.preventDefault();
    if (!L.picking) { L.picking = true; L.select(null); }
    toggle(r.dataset.id, e.shiftKey);
    L.render();
  }, true);
  list.addEventListener("dblclick", (e) => { if (L.picking) e.stopPropagation(); }, true);
  list.addEventListener("contextmenu", (e) => {
    const r = e.target.closest(".row");
    if (!L.picking || !r) return;
    e.stopPropagation(); e.preventDefault();
    if (!L.picked.has(r.dataset.id)) { L.picked.add(r.dataset.id); L.render(); }
    const at = { x: e.clientX, y: e.clientY };
    PR.menu(at, [
      { label: PR.t("加入分类…"), icon: "folder", fn: () => catMenu(at) },
      ...(canRemoveCurrent() ? [{ label: PR.t("移出“{name}”", { name: L.tag ? PR.catTree.leaf(L.tag) : PR.t("星标") }), icon: "x", fn: removeCurrent }] : []),
      { label: PR.t("切换状态…"), icon: "book", fn: () => statusMenu(at) },
      { label: PR.t("翻译"), icon: "sparkle", fn: () => translateAll(at) },
      ...(pickedItems().some(L.modelBusy) ? [{ label: PR.t("停止翻译"), icon: "stop", fn: () => PR.stopJobs(pickedItems(), at) }] : []),
      { label: PR.t("导出引用"), icon: "copy", fn: () => run("cite") },
      "-",
      { label: PR.t("移到回收站"), icon: "trash", fn: () => trashAll(at) },
    ]);
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, [contenteditable]") || PR.$(".dialog-backdrop.open, .popover.confirm, #ctxmenu.open")) return;
    if ((e.key || "").toLowerCase() === "a" && (e.ctrlKey || e.metaKey) && L.filtered().length) {
      e.preventDefault(); e.stopPropagation();
      return L.startPick(L.filtered().map((i) => i.id));
    }
    if (!L.picking) return;
    if (e.key === "Escape") { e.stopPropagation(); return L.endPick(); }
    // 多选时上下键、回车、S 不去开详情
    if (["ArrowDown", "ArrowUp", "j", "k", "Enter", "s"].includes(e.key)) e.stopPropagation();
  }, true);
})(window.PR);
