/* 论文笔记中的正文链接，同时作为正文侧的关联笔记入口。 */
(function (PR) {
  "use strict";
  const next = new Map();
  function refresh() {
    const body = PR.paperNoteEditor.getBody() ?? (PR.state.reader.paper_note || {}).body ?? "";
    const rendered = document.createElement("template");
    rendered.innerHTML = PR.mdBlocks(body, { cite: false, xref: false });
    const counts = new Map();
    for (const link of rendered.content.querySelectorAll('a[href^="#b-"]')) {
      const anchor = link.getAttribute("href").slice(3);
      counts.set(anchor, (counts.get(anchor) || 0) + 1);
    }
    PR.$$("#paper .pn-source-links").forEach(el => el.remove());
    for (const [anchor, count] of counts) {
      const block = document.getElementById("b-" + anchor);
      if (!block) continue;
      const row = document.createElement("div"); row.className = "pn-source-links";
      const button = document.createElement("button"); button.className = "btn sm";
      button.dataset.paperNoteSource = anchor;
      button.title = PR.t("点击查看关联笔记，再次点击切换下一处");
      button.innerHTML = PR.icon("note", "sm") + PR.esc(PR.t("关联笔记 {n}", { n: count }));
      row.appendChild(button); block.appendChild(row);
    }
  }
  const refreshSoon = PR.debounce(refresh, 120);
  PR.on("rendered", refresh);
  PR.on("block-rendered", refresh);
  PR.on("reader", op => { if (!op || op.op === "paper_note") refreshSoon(); });
  PR.$("#notespanel").addEventListener("input", e => { if (e.target.id === "paperNote") refreshSoon(); });
  PR.$("#paper").addEventListener("click", e => {
    const button = e.target.closest("[data-paper-note-source]");
    if (!button) return;
    e.preventDefault(); e.stopPropagation();
    const anchor = button.dataset.paperNoteSource, index = next.get(anchor) || 0;
    PR.openPaperNote();
    PR.paperNoteEditor.revealSource(anchor, index);
    next.set(anchor, index + 1);
  });
})(window.PR);
