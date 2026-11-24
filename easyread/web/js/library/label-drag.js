/* Copy a sidebar tag to a paper. The source stays in the sidebar throughout the drag. */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const lib = PR.$(".lib");
  const dragType = "application/x-easyread-paper-label";
  let active = null, highlighted = null;

  function clearHighlight() {
    if (!highlighted) return;
    delete highlighted.dataset.labelDrop;
    delete highlighted.dataset.labelDropHint;
    highlighted = null;
  }

  function stopDrag() {
    lib.classList.remove("dragging-paper-label");
    clearHighlight();
    const drag = active;
    active = null;
    return drag;
  }

  function positionChip(chip, x, y) {
    chip.style.left = Math.max(0, Math.min(x, innerWidth - chip.offsetWidth)) + "px";
    chip.style.top = Math.max(0, Math.min(y, innerHeight - chip.offsetHeight)) + "px";
  }

  function returnChip({ chip, label, origin }) {
    const source = PR.$('#side [data-paper-label="' + CSS.escape(label) + '"] .t');
    const destination = source?.getClientRects().length ? source.getBoundingClientRect() : origin;
    if (!chip.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      chip.remove();
      return;
    }
    const start = chip.getBoundingClientRect();
    const dx = destination.left - start.left;
    const dy = destination.top + (destination.height - start.height) / 2 - start.top;
    const motion = chip.animate([
      { transform: "none", opacity: 1 },
      { transform: "translate(" + dx + "px," + dy + "px) scale(.88)", opacity: 0 },
    ], { duration: 400, easing: "cubic-bezier(.3,0,.24,1)", fill: "forwards" });
    motion.finished.catch(() => {}).finally(() => chip.remove());
  }

  function dropTarget(event) {
    if (!active || L.loadStatus !== "ready" || !event.dataTransfer.types.includes(dragType)) return null;
    const node = event.target.closest("#list .row[data-id], #detail .detail-inner");
    const item = node && L.byId(node.dataset.id || L.selected);
    return item && !item.load_error ? { node, item } : null;
  }

  document.addEventListener("dragstart", (event) => {
    stopDrag()?.chip.remove();
    const source = event.target.closest("#side [data-paper-label]");
    if (!source) return;
    if (L.loadStatus !== "ready") { event.preventDefault(); return; }
    const label = source.dataset.paperLabel, origin = source.getBoundingClientRect();
    const chip = PR.el("span", { class: "paper-label-float", "aria-hidden": "true" },
      PR.icon("tag", "sm") + "<span>" + PR.esc(label) + "</span>");
    document.body.appendChild(chip);
    positionChip(chip, origin.left, origin.top);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(dragType, label);
    event.dataTransfer.setDragImage(chip, 12, 12);
    active = { chip, label, origin };
    requestAnimationFrame(() => {
      if (active?.chip !== chip) return;
      chip.hidden = true;  // The browser is carrying its own image of the chip.
      lib.classList.add("dragging-paper-label");
    });
  });

  document.addEventListener("dragover", (event) => {
    const target = dropTarget(event);
    if (highlighted !== target?.node) clearHighlight();
    if (!target) return;
    const existing = target.item.labels?.includes(active.label);
    highlighted = target.node;
    highlighted.dataset.labelDrop = existing ? "existing" : "add";
    highlighted.dataset.labelDropHint = existing ? PR.t("已有此标签") : PR.t("松开以添加标签");
    event.preventDefault();
    event.dataTransfer.dropEffect = existing ? "none" : "copy";
  });
  document.addEventListener("dragleave", (event) => {
    if (highlighted && !highlighted.contains(event.relatedTarget)) clearHighlight();
  });
  document.addEventListener("dragend", () => stopDrag()?.chip.remove());

  document.addEventListener("drop", async (event) => {
    const target = dropTarget(event);
    if (!target) return;
    event.preventDefault();
    const drag = stopDrag();
    const { label, chip } = drag;
    const { item } = target;
    chip.hidden = false;
    positionChip(chip, event.clientX - 12, event.clientY - 12);
    try {
      if (item.labels?.includes(label)) return;
      const title = PR.t("将「{label}」添加到《{paper}》？", { label, paper: PR.titles(item).main });
      if (!await PR.confirm({ title })) return;
      const result = await PR.api("/api/p/" + encodeURIComponent(item.id) + "/labels", { method: "POST", body: { add: [label] } });
      const current = L.byId(item.id);
      if (current) { current.labels = result.labels; L.render(); }
      L.load();  // Reconcile with concurrent edits after displaying the saved chip.
    } catch (error) {
      PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(error.message) }));
    } finally {
      returnChip(drag);
    }
  });
})(window.PR);
