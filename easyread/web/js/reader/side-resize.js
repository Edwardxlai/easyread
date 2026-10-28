/* 右侧面板（PDF 原页 / 笔记 / 问 AI）宽度：拖面板左边缘调整，双击恢复默认，记在本机。
   把手单独挂在 body 上，面板内容重绘不会把它冲掉。 */
(function (PR) {
  "use strict";
  const body = document.body;
  const root = document.documentElement;
  const KEY = "easyread-panel-w";
  const MIN = 320, TEXT_MIN = 420;  // 面板至少 320px，正文至少留 420px
  const clamp = (w) => Math.round(Math.max(MIN, Math.min(window.innerWidth - TEXT_MIN, w)));
  const setW = (w) => w ? root.style.setProperty("--side-w", clamp(w) + "px") : root.style.removeProperty("--side-w");
  let saved = PR.ls.get(KEY, 0);
  setW(saved);

  /* 宽度变了：正文重排并停在刚才读的段，原页按新宽度换合适清晰度的图 */
  function relayout() {
    const anchor = PR.readingBlock && PR.readingBlock();
    const node = anchor && document.getElementById("b-" + anchor);
    const before = node ? node.getBoundingClientRect().top : 0;
    PR.fitWide(); PR.renderMargin();
    if (node) window.scrollBy(0, node.getBoundingClientRect().top - before);
    if (PR.side === "pages" && PR.refreshPages) PR.refreshPages();
  }

  const grip = PR.el("div", { class: "panel-grip", title: PR.t("拖动调整面板宽度（双击恢复）") });
  body.appendChild(grip);
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    body.classList.add("resizing");
    const move = (ev) => { saved = window.innerWidth - ev.clientX; setW(saved); };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      body.classList.remove("resizing");
      saved = clamp(saved);
      PR.ls.set(KEY, saved);
      relayout();
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  grip.addEventListener("dblclick", () => { saved = 0; setW(0); PR.ls.set(KEY, 0); relayout(); });
  /* 窗口变窄时别让面板把正文挤没 */
  window.addEventListener("resize", () => { if (saved) setW(saved); });  // 同步改，main.js 里防抖后的重排就用上新宽度
})(window.PR);
