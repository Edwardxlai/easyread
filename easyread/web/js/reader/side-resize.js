/* 右侧面板（PDF 原页 / 笔记 / 问 AI）宽度：拖面板左边缘调整，双击恢复默认，记在本机。
   把手单独挂在 body 上，面板内容重绘不会把它冲掉。 */
(function (PR) {
  "use strict";
  const body = document.body;
  const root = document.documentElement;
  const KEY = "easyread-panel-w";
  const clamp = (w) => Math.round(Math.min(root.clientWidth, Math.max(320, w)));
  const setW = (w) => w ? root.style.setProperty("--side-w", clamp(w) + "px") : root.style.removeProperty("--side-w");
  let saved = PR.ls.get(KEY, 0);
  setW(saved);

  /* 宽度变了：正文重排并停在刚才读的段，原页按新宽度换合适清晰度的图 */
  function anchorPosition() {
    const anchor = PR.readingBlock && PR.readingBlock();
    const node = anchor && (PR.webBlockHost?.(anchor) || document.getElementById("b-" + anchor));
    const before = node ? (PR.webRect?.(node) || node.getBoundingClientRect()).top : 0;
    return { node, before };
  }
  function relayout({node, before}) {
    PR.fitWide(); PR.renderMargin();
    if (node) window.scrollBy(0, (PR.webRect?.(node) || node.getBoundingClientRect()).top - before);
    if (PR.dockVisible("pages") && PR.refreshPages) PR.refreshPages();
  }

  const grip = PR.el("div", { class: "panel-grip", title: PR.t("拖动调整面板宽度（双击恢复）"),
    role: "separator", tabindex: "0", "aria-label": PR.t("调整侧栏宽度"), "aria-orientation": "vertical" });
  function describeWidth() {
    grip.setAttribute("aria-valuemin", "320"); grip.setAttribute("aria-valuemax", String(root.clientWidth));
    grip.setAttribute("aria-valuenow", String(Math.round(PR.$("#readerDock").getBoundingClientRect().width)));
  }
  body.appendChild(grip);
  grip.addEventListener("focus", describeWidth);
  grip.addEventListener("keydown", e => {
    const width = PR.$("#readerDock").getBoundingClientRect().width;
    const widths = { ArrowLeft: width + 32, ArrowRight: width - 32, Home: 320, End: root.clientWidth };
    if (!(e.key in widths)) return;
    e.preventDefault();
    const position = anchorPosition();
    saved = clamp(widths[e.key]); setW(saved); PR.ls.set(KEY, saved);
    describeWidth(); relayout(position);
  });
  let anchor;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    anchor = anchorPosition();
    grip.setPointerCapture(e.pointerId);
    body.classList.add("resizing");
  });
  grip.addEventListener("pointermove", e => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    saved = clamp(root.clientWidth - (e.clientX < 6 ? 0 : e.clientX));
    setW(saved);
  });
  grip.addEventListener("lostpointercapture", () => {
    body.classList.remove("resizing");
    PR.ls.set(KEY, saved);
    describeWidth();
    relayout(anchor);
  });
  grip.addEventListener("dblclick", () => {
    const position = anchorPosition();
    saved = 0; setW(0); PR.ls.set(KEY, 0); relayout(position);
  });
  window.addEventListener("resize", () => { if (saved) setW(saved); });  // 同步改，main.js 里防抖后的重排就用上新宽度
})(window.PR);
