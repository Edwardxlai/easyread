/* 设置 → 侧边栏：管理文献库左侧栏里的分类。
   内置分类和自建分类用同一种行：开关决定在侧栏显示还是隐藏，图钉按钮置顶；自建分类还能改名、删除。
   “全部”始终显示。改动立刻生效（和在侧栏右键操作一样），不用等“保存”。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const BUILTIN = [["reading", PR.t("在读")], ["unread", PR.t("未读")], ["done", PR.t("已读")], ["starred", PR.t("星标")],
    ["questions", PR.t("有待回答的问题"), PR.t("有问题没回答时才出现")], ["translating", PR.t("翻译中"), PR.t("有论文在翻译时才出现")]];
  const savingLabels = new Map();
  const labelChecked = (id) => savingLabels.get(id) ?? (L.labelFeatures[id] === true);
  const labelDisabled = (id) => savingLabels.has(id) || L.loadStatus !== "ready";

  L.syncLabelSwitches = function () {
    for (const input of PR.$$("#settingsDlg [data-label-feature]")) {
      const id = input.dataset.labelFeature;
      input.checked = labelChecked(id);
      input.disabled = labelDisabled(id);
    }
  };

  async function saveLabelFeature(input) {
    const id = input.dataset.labelFeature, enabled = input.checked;
    savingLabels.set(id, enabled);
    input.disabled = true;
    try {
      const saved = await PR.api("/api/prefs", { method: "POST", body: { library: { [id]: enabled } } });
      L.labelFeatures[id] = saved.library[id] === true;
      PR.renderDetail();
      await L.load();
    } catch (error) {
      PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(error.message) }));
    } finally {
      savingLabels.delete(id);
      L.syncLabelSwitches();
    }
  }

  function row(o) {  // o: {name, label, depth, sub, pinKey, hideKey, custom, fixed}；自建分类的 name 是完整路径，改名时可以改成别的路径来移动
    const pinned = o.pinKey && L.side.pinned.includes(o.pinKey);
    if (o.renaming) return '<div class="sb-row"><input class="input" id="libRenameInput" value="' + PR.esc(o.name) + '" maxlength="' + PR.catTree.MAX_PATH + '"><button class="btn sm accent" data-lib="rename-ok" data-c="' + PR.esc(o.name) + '">' + PR.t("好") + '</button><button class="btn sm" data-lib="cancel">' + PR.t("取消") + "</button></div>";
    return '<div class="sb-row"><span class="sb-name"' + (o.depth ? ' style="padding-left:' + o.depth * 16 + 'px"' : "") + ">" + PR.icon(o.custom ? "folder" : "book", "sm") + "<b>" + PR.esc(o.label || o.name) + "</b>" + (o.sub ? "<small>" + PR.esc(o.sub) + "</small>" : "") + "</span>" +
      (o.custom ? '<button class="btn sm" data-lib="rename" data-c="' + PR.esc(o.name) + '">' + PR.t("改名") + '</button><button class="btn sm danger" data-lib="del" data-c="' + PR.esc(o.name) + '">' + PR.t("删除") + "</button>" : "") +
      (o.pinKey ? '<button class="sb-pin' + (pinned ? " on" : "") + '" data-lib="pin" data-key="' + PR.esc(o.pinKey) + '" title="' + (pinned ? PR.t("取消置顶") : PR.t("置顶到侧栏最上面")) + '">' + PR.icon("pin", "sm") + "</button>" : '<span class="sb-pin-space"></span>') +
      '<input type="checkbox" class="switch" title="' + PR.t("在侧栏显示") + '"' + (o.fixed ? " checked disabled" : ' data-libshow="' + PR.esc(o.hideKey) + '"' + (L.side.hidden.includes(o.hideKey) ? "" : " checked")) + "></div>";
  }

  PR.settingsTabs.library = {
    render(s) {
      const count = (fn) => L.items.filter(fn).length;
      const cats = L.cats();
      return '<p class="set-lead">' + PR.t("选择 AI 标签工具和侧栏中显示的分类，改动会立即保存。把论文拖进自建分类即可归档，同一篇论文可以放进多个分类。") + "</p>" +
        '<h4 class="set-h">' + PR.t("论文标签") + '</h4><div class="switch-list">' +
        PR.PAPER_LABEL_TOOLS.map(({ id, name, description }) => '<label class="switch-row"><span><b>' + name + '</b><small>' + description +
          '</small></span><input type="checkbox" class="switch" data-label-feature="' + id + '"' + (labelChecked(id) ? ' checked' : '') +
          (labelDisabled(id) ? ' disabled' : '') + '></label>').join("") + '</div>' +
        '<div class="organize-entry"><button type="button" class="btn line" data-organize-labels>' + PR.icon("tag", "sm") +
          PR.t("一键整理文献标签") + '</button><small>' + PR.t("使用默认问答模型扫描全库。明确匹配的标签直接分配，新建和并入的建议由你统一确认。") + '</small></div>' +
        '<h4 class="set-h">' + PR.t("内置分类") + '</h4><div class="sb-list">' +
        row({ name: PR.t("全部"), sub: PR.t("始终显示"), fixed: true }) +
        BUILTIN.map(([k, name, note]) => row({ name, sub: note || PR.t("{n} 篇", { n: count((L.VIEWS.find((v) => v[0] === k) || [])[3] || (() => false)) }), pinKey: "v:" + k, hideKey: k })).join("") + "</div>" +
        '<h4 class="set-h">' + PR.t("我的分类") + '</h4><div class="sb-list">' +
        (cats.map((c) => row({ name: c, label: PR.catTree.leaf(c), depth: PR.catTree.depth(c), sub: PR.t("{n} 篇", { n: count((x) => L.inCat(x, c)) }), pinKey: "c:" + c, hideKey: "c:" + c, custom: true, renaming: s.libRename === c })).join("") || '<p class="hint">' + PR.t("还没有自建分类。") + "</p>") +
        '</div><div class="cm-form-acts" style="margin-top:10px"><input class="input" id="libNewInput" placeholder="' + PR.t("新分类的名字，“父/子”建子分类") + '" maxlength="' + PR.catTree.MAX_PATH + '" style="max-width:280px"><button class="btn sm line" data-lib="add">' + PR.icon("plus", "sm") + PR.t("新建分类") + "</button></div>";
    },
    async click(e, s) {
      if (e.target.closest("[data-organize-labels]")) { PR.openLabelOrganizer(); return false; }
      const b = e.target.closest("[data-lib]");
      if (!b) return false;
      const c = b.dataset.c, act = b.dataset.lib;
      if (act === "add") L.addCat(PR.$("#libNewInput").value);
      if (act === "pin") L.togglePin(b.dataset.key);
      if (act === "rename") s.libRename = c;
      if (act === "cancel") s.libRename = null;
      if (act === "rename-ok") { L.renameCat(c, PR.$("#libRenameInput").value); s.libRename = null; }
      if (act === "del") await L.deleteCat(c, b);
      return true;
    },
    change(e) {
      if (e.target.dataset.labelFeature) saveLabelFeature(e.target);
      if (e.target.dataset.libshow) L.setHidden(e.target.dataset.libshow, !e.target.checked);
      return false;
    },
  };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target.id === "libNewInput") { e.preventDefault(); PR.$('[data-lib="add"]').click(); }
    if (e.target.id === "libRenameInput") { e.preventDefault(); PR.$('[data-lib="rename-ok"]').click(); }
  }, true);
})(window.PR);
