/* Drag a paper figure or table onto an existing note without inserting a URL. */
(function (PR) {
  "use strict";
  const MIME = "application/x-easyread-media";
  let dragged = null, target = null;
  function clearTarget() {
    target?.classList.remove("media-drop-target");
    target = null;
  }
  function finish() {
    clearTarget(); dragged = null;
    document.body.classList.remove("media-dragging");
  }
  function prepare() {
    document.querySelectorAll("#paper .figure-media img, #paper .blk-table .tbl-wrap").forEach((el) => {
      el.draggable = true;
      el.title = PR.t("拖到笔记以关联图表");
    });
  }
  PR.on("rendered", prepare);
  PR.on("block-rendered", prepare);
  document.addEventListener("dragstart", (e) => {
    const source = e.target.closest(".blk-figure, .blk-table, .media-preview[data-media-block]");
    const b = source && PR.blockById[source.dataset.mediaBlock || source.dataset.id];
    if (!PR.media.isMedia(b) || !e.dataTransfer) return;
    dragged = b;
    e.dataTransfer.setData(MIME, JSON.stringify({ paper: PR.paperKey, id: b.id }));
    e.dataTransfer.effectAllowed = "copy";
    document.body.classList.add("media-dragging");
  }, true);
  document.addEventListener("dragover", (e) => {
    if (!dragged && !Array.from(e.dataTransfer?.types || []).includes(MIME)) return;
    const card = e.target.closest(".card[data-note]");
    if (target !== card) { clearTarget(); target = card; target?.classList.add("media-drop-target"); }
    if (!card) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const list = card.closest(".np-list");
    if (list) {
      const rect = list.getBoundingClientRect();
      if (e.clientY < rect.top + 40) list.scrollTop -= 12;
      else if (e.clientY > rect.bottom - 40) list.scrollTop += 12;
    }
  });
  document.addEventListener("dragleave", (e) => {
    if (target && !target.contains(e.relatedTarget)) clearTarget();
  });
  document.addEventListener("drop", (e) => {
    const card = e.target.closest(".card[data-note]");
    const value = e.dataTransfer?.getData(MIME);
    if (!value) { finish(); return; }
    if (!card && e.target.closest("#readerDock")) { finish(); return; }
    e.preventDefault(); e.stopImmediatePropagation();
    if (!card) { finish(); return; }
    try {
      const ref = JSON.parse(value);
      if (ref.paper === PR.paperKey) PR.noteMedia.attach(card.dataset.note, PR.blockById[ref.id]);
    } catch (_) { /* Ignore unrelated or malformed drag data. */ }
    finish();
  }, true);
  document.addEventListener("dragend", finish);
})(window.PR);
