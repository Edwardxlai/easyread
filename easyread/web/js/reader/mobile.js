/* 手机版（导出时选“手机版”才打进去）：只读这一篇论文。
   界面只留 Aa 里的原文 / 译文 / 双语和字号；笔记、AI 的解释能看不能改，不带 PDF 原页。 */
(function (PR) {
  "use strict";
  document.body.classList.add("mobile-read");
  Object.assign(PR.features, { chat: false, edit: false, en: false, pages: false, retranslate: false });
  PR.prefs.margin = false;
  PR.ls.set("easyread-hint-seen", true);  // 首次打开的“点段落出操作条”提示，手机版用不上

  PR.setCurrent = () => PR.hideBlockbar && PR.hideBlockbar();  // 点段落不出操作条
  /* 只读：写笔记、改笔记、改译文、点划线改色都关掉；能存下来的只有读到哪儿 */
  const noop = () => {};
  Object.assign(PR, { startNote: noop, openNoteEditor: noop, editZh: noop, noteMarkClick: noop });
  const commit = PR.commit;
  PR.commit = (op) => { if (op.op === "progress") commit(op); };

  /* 笔记卡片只读：只放行“展开全文” */
  document.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest(".card [data-a], .card [data-k], .card [data-color]");
    if (t && t.dataset.a !== "more") { e.stopPropagation(); e.preventDefault(); }
  }, true);

  /* 字号：手机上滑杆难拖，用 − 数字 + */
  const { min, max } = PR.typeRanges.fs;
  const setFs = (v) => { v = Math.round(+v); if (v >= min && v <= max) PR.setPref("fs", v, true); PR.$("#settings [data-fs-input]").value = PR.prefs.fs; };
  PR.renderSettings = function () {
    PR.$("#settings").innerHTML =
      '<div class="row view-row-narrow">' + PR.viewSegHtml(false) + "</div>" +
      '<div class="row fs-row"><span>' + PR.t("字号") + '</span><button class="btn" data-fs="-1" aria-label="' + PR.t("字号变小") + '">−</button>' +
      '<input type="number" inputmode="numeric" min="' + min + '" max="' + max + '" value="' + PR.prefs.fs + '" data-fs-input aria-label="' + PR.t("字号") + '">' +
      '<button class="btn" data-fs="1" aria-label="' + PR.t("字号变大") + '">+</button></div>';
  };
  PR.$("#settings").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fs]");
    if (b) setFs(PR.clampFontSize(PR.prefs.fs + +b.dataset.fs));
  });
  PR.$("#settings").addEventListener("change", (e) => { if (e.target.matches("[data-fs-input]")) setFs(e.target.value); });

  /* 顶栏：往下读时收起，往上划时出来 */
  let lastY = scrollY;
  window.addEventListener("scroll", () => {
    const y = scrollY, bar = PR.$("#bar");
    if (Math.abs(y - lastY) < 8) return;
    const hide = y > lastY && y > 80 && !PR.$("#settings").classList.contains("open");
    bar.classList.toggle("bar-hidden", hide);
    lastY = y;
  }, { passive: true });
})(window.PR);
