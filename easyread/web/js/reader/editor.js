/* 改译文：双击一段或按 E，原地变成编辑框。草稿随手存在浏览器里，误关页面也能找回。 */
(function (PR) {
  "use strict";
  PR.editingKey = null;
  const draftKey = (key) => "pr-draft-" + PR.paperKey + "-" + key;

  PR.editZh = function (zh) {
    if (PR.editingKey) return;
    PR.hideBlockbar && PR.hideBlockbar();
    const key = zh.dataset.key;
    const blockId = zh.closest(".blk").dataset.id;
    const current = PR.textFor(key);
    const draft = PR.ls.get(draftKey(key), null);
    const edited = !!PR.editOf(key);
    PR.editingKey = key;
    const wrapEl = PR.el("div", { class: "editor-wrap" });
    const ta = PR.el("textarea", { class: "editor", spellcheck: "false", "aria-label": PR.t("编辑译文") });
    ta.value = draft != null && draft !== current ? draft : current;
    const bar = PR.el("div", { class: "editor-bar" },
      "<span>" + (draft != null && draft !== current ? PR.t("已恢复上次没保存的草稿 · ") : "") + PR.t("Ctrl+Enter 保存 · Esc 取消 · 支持 $公式$、**粗体**") + "</span>" +
      '<span class="grow"></span>' + (edited ? '<button data-e="revert">' + PR.t("恢复译者稿") + "</button>" : "") +
      '<button data-e="cancel">' + PR.t("取消") + '</button><button data-e="save" class="primary">' + PR.t("保存") + "</button>");
    wrapEl.append(ta, bar);
    const webMount = PR.webEditorMount?.(key);
    (webMount || zh).replaceChildren(wrapEl);
    PR.autosize(ta);
    ta.focus();
    const saveDraft = PR.debounce(() => PR.ls.set(draftKey(key), ta.value), 400);
    ta.addEventListener("input", () => { PR.autosize(ta); saveDraft(); PR.layoutMargin(); });

    const finish = (action) => {
      saveDraft.cancel();
      PR.editingKey = null;
      PR.ls.del(draftKey(key));
      const agent = PR.agentText(key);
      if (action === "save") {
        const text = ta.value.replace(/\s+$/, "");
        if (text === agent) { if (edited) PR.commit({ op: "edit", block: key, zh: null }); }
        else if (text !== current || PR.isStale(key)) PR.commit({ op: "edit", block: key, zh: text, base: PR.hashText(agent) });
      } else if (action === "revert") PR.commit({ op: "edit", block: key, zh: null });
      PR.webEditorFinish?.(key);
      PR.renderBlock(blockId);
      PR.applyMarks(blockId);
      PR.renderMargin();
    };
    bar.addEventListener("click", (e) => { const b = e.target.closest("[data-e]"); if (b) finish(b.dataset.e); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish("cancel"); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish("save"); }
    });
  };

  document.addEventListener("dblclick", (e) => {
    const zh = e.target.closest("#paper .zh[data-key]");
    if (!zh || e.target.closest("a, button, textarea") || zh.closest(".blk-references")) return;
    getSelection().removeAllRanges();
    PR.$("#selbar").classList.remove("open");
    PR.editZh(zh);
  });

  /* 我改过、译者稿后来又变了 */
  PR.showStale = function (zh) {
    const key = zh.dataset.key;
    const agent = PR.agentText(key);
    PR.popover(zh, '<div class="hd">' + PR.t("译者稿（更新后）") + '</div><div class="cap">' + PR.md(agent) + "</div>" +
      '<div class="hd" style="margin-top:10px">' + PR.t("你的版本") + '</div><div class="cap">' + PR.md(PR.textFor(key)) + "</div>" +
      '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm line" data-st="agent">' + PR.t("换成译者稿") + '</button><button class="btn sm line" data-st="mine">' + PR.t("保留我的") + "</button></div>", { sticky: true, wide: true });
    PR.$("#popover").onclick = (ev) => {
      const b = ev.target.closest("[data-st]");
      if (!b) return;
      PR.hidePopover();
      if (b.dataset.st === "agent") PR.commit({ op: "edit", block: key, zh: null });
      else PR.commit({ op: "edit", block: key, zh: PR.textFor(key), base: PR.hashText(agent) });
      const id = key.split("#")[0];
      PR.renderBlock(id); PR.applyMarks(id);
    };
  };

  /* 术语一键替换：在我的版本里把旧译法换成新译法（写成我的修改，不动译者稿） */
  PR.replaceTerm = function (from, to, dryRun) {
    if (!from || from === to) return 0;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const guard = to.startsWith(from) ? "(?!" + to.slice(from.length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")" : "";
    const re = new RegExp(esc + guard, "g");
    let n = 0;
    for (const b of PR.state.paper.blocks || []) {
      for (const key of PR.blockKeys(b)) {
        const cur = PR.textFor(key);
        const parts = cur.split(/(\$[^$]*\$)/);  // 公式里不替换
        let hits = 0;
        const next = parts.map((p, i) => (i % 2 ? p : p.replace(re, () => { hits++; return to; }))).join("");
        if (!hits) continue;
        n += hits;
        if (!dryRun) PR.commit({ op: "edit", block: key, zh: next, base: PR.hashText(PR.agentText(key)) });
      }
    }
    if (!dryRun && n) PR.rerenderKeepingPlace();
    return n;
  };
})(window.PR);
