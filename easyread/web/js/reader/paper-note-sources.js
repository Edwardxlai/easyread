/* 论文笔记中的正文链接，同时作为正文侧的关联笔记入口。 */
(function (PR) {
  "use strict";
  let references = new Map();
  const menu = document.createElement("div"); menu.className = "pn-reference-menu"; menu.setAttribute("popover", "auto"); document.body.appendChild(menu);
  function refresh() {
    const body = PR.paperNoteEditor.getBody() ?? (PR.state.reader.paper_note || {}).body ?? "";
    const rendered = document.createElement("template");
    rendered.innerHTML = PR.mdBlocks(body, { cite: false, xref: false });
    const counts = new Map(); references = new Map();
    for (const link of rendered.content.querySelectorAll('a[href^="#b-"]')) {
      const anchor = link.getAttribute("href").slice(3);
      counts.set(anchor, (counts.get(anchor) || 0) + 1);
      const quote = link.closest('blockquote') || link.parentElement;
      const text = quote.textContent.trim().slice(0, 80);
      references.set(anchor, [...(references.get(anchor) || []), text]);
    }
    PR.$$("#paper .pn-source-links").forEach(el => el.remove());
    for (const [anchor, count] of counts) {
      const block = document.getElementById("b-" + anchor);
      if (!block) continue;
      const row = document.createElement("div"); row.className = "pn-source-links";
      const button = document.createElement("button"); button.className = "btn sm";
      button.dataset.paperNoteSource = anchor;
      button.title = PR.t("关联笔记 {n}", { n: count }); button.setAttribute("aria-label", button.title);
      button.innerHTML = PR.icon("note", "sm");
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
    const anchor = button.dataset.paperNoteSource, entries = references.get(anchor) || [];
    const reveal = index => { PR.openPaperNote(); PR.paperNoteEditor.revealSource(anchor, index); };
    if (entries.length <= 1) { reveal(0); return; }
    menu.replaceChildren();
    entries.forEach((text, index) => {
      const item = document.createElement("button"); item.className = "btn"; item.textContent = text;
      item.onclick = () => { menu.hidePopover(); reveal(index); }; menu.appendChild(item);
    });
    const rect = button.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - 300)) + "px";
    menu.style.top = Math.min(rect.bottom + 4, innerHeight - 220) + "px";
    menu.showPopover();
  });
})(window.PR);
