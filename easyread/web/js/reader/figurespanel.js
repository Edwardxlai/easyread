/* 论文图片：复用已整理的图片、图注和图内文字，右侧独立滚动，不跟随正文翻页。 */
(function (PR) {
  "use strict";
  const panel = PR.$("#figurespanel"), list = panel.querySelector(".fp-list");
  let lastHtml = null;

  PR.toggleFiguresPanel = function (force) {
    const open = force != null ? force : PR.side !== "figures";
    PR.openSide(open ? "figures" : null);
    if (open) PR.renderFiguresPanel();
  };

  /* 不给副本加正文的 data-key / 块 id，选区、批注和编辑仍只对应左侧正文。 */
  function textHtml(b, field, label) {
    const key = b.id + "#" + field, original = b[field + "_en"] || "";
    const translated = PR.isEnKey(key) ? "" : PR.textFor(key);
    if (!original && !translated) return "";
    const md = (text) => PR.md(text, { cite: false, xref: false });
    return '<div class="fp-text"><div class="fp-text-label">' + label + '</div><div class="fp-pair' +
      (original && translated ? ' fp-bilingual' : '') + '" data-figure-key="' + PR.esc(key) + '">' +
      (translated ? '<div class="fp-translation">' + md(translated) + '</div>' : '') +
      (original ? '<div class="fp-original" lang="en">' + md(original) + '</div>' : '') + '</div></div>';
  }

  function figureHtml(b) {
    const id = PR.esc(b.id), label = PR.media.label(b);
    const original = PR.media.thumbnail(b);
    const image = PR.hasTranslatedFigure(b) ? '<div class="fp-pair fp-bilingual"><div class="fp-translation">' +
      PR.media.thumbnail(Object.assign({}, b, { src: b.translated_image.src })) + '</div><div class="fp-original">' + original + '</div></div>' : original;
    return '<article class="fp-card media-preview" data-figure-id="' + id + '"><div class="fp-card-head"><strong>' + PR.esc(label) +
      '</strong><span class="grow"></span><button class="btn sm" data-media-go="' + id + '">' + PR.t("定位正文") + '</button>' +
      (b.page ? '<button class="btn sm" data-media-page="' + Number(b.page) + '" data-media-block="' + id + '">' + PR.t("第 {page} 页", { page: b.page }) + '</button>' : '') +
      '</div>' + image + textHtml(b, "caption", PR.t("图注")) + textHtml(b, "image", PR.t("图内文字")) + '</article>';
  }

  PR.renderFiguresPanel = function () {
    if (PR.side !== "figures") return;
    const figures = (PR.state.paper.blocks || []).filter((b) => b && b.type === "figure");
    panel.querySelector(".fp-count").textContent = PR.t("共 {n} 张", { n: figures.length });
    const html = figures.length ? figures.map(figureHtml).join("") : '<p class="fp-empty">' + PR.t("这篇论文还没有整理好的图片。") + '</p>';
    if (html === lastHtml) return;  // 无关的笔记更新不重载图片，也不改变面板的阅读位置。
    const top = list.scrollTop;
    list.innerHTML = html;
    list.scrollTop = top;
    lastHtml = html;
  };
  panel.querySelector("[data-fp-close]").addEventListener("click", () => PR.toggleFiguresPanel(false));
  PR.on("rendered", () => PR.renderFiguresPanel());
  PR.on("block-rendered", () => PR.renderFiguresPanel());
  PR.on("reader", (op) => { if (!op || op.op !== "progress") PR.renderFiguresPanel(); });
})(window.PR);
