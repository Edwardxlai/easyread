/* One on-demand renderer for figure/table hovers and note references. */
(function (PR) {
  "use strict";
  const isMedia = (b) => b && (b.type === "figure" || b.type === "table");
  const blocks = () => (PR.state.paper.blocks || []).filter(isMedia);
  const caption = (b) => PR.plain(PR.textFor(b.id + "#caption") || b.caption_en || b.caption_zh || "");
  const label = (b) => (b.type === "table" ? PR.t("表 {n}", { n: b.num || "" }) : PR.t("图 {n}", { n: b.num || "" })).trim();
  // Store identity only, never pixels or a duplicate table in reader.json.
  const reference = (b) => ({ id: b.id, type: b.type, num: String(b.num || ""), page: b.page, caption: caption(b).slice(0, 160) });
  function resolve(ref) {
    if (!ref) return null;
    const same = (b) => isMedia(b) && b.type === ref.type && String(b.num || "") === String(ref.num || "");
    const exact = PR.blockById[ref.id];
    if (same(exact)) return exact;
    // A retranslation can change IDs. Only accept an unambiguous match on the same page.
    const matches = ref.num ? blocks().filter((b) => same(b) && b.page === ref.page) : [];
    return matches.length === 1 ? matches[0] : null;
  }
  function tableHtml(b, compact = false) {
    const {head, rows, notes} = PR.tableParts(b);
    const cells = (rs, tag) => rs.map((r) => "<tr>" + r.map((c) => "<" + tag + ">" + PR.md(String(c ?? ""), { cite: false, xref: false }) + "</" + tag + ">").join("") + "</tr>").join("");
    return '<div class="media-table-scroll"' + (compact ? '' : ' tabindex="0"') + '><table><thead>' + cells(head, "th") + '</thead><tbody>' + cells(compact ? rows.slice(0, 4) : rows, "td") + "</tbody></table></div>" + (compact ? "" : PR.tableNotesHtml(notes, b));
  }
  function thumbnail(b) {
    if (!b) return '<span class="media-empty">' + PR.t("图表已变化或移除") + '</span>';
    if (b.type === "table") return tableHtml(b, true);
    if (!b.src) return '<span class="media-empty">' + PR.t("尚无图像，可查看 PDF 原页") + '</span>';
    return '<span class="media-image"><img src="' + PR.esc(PR.imageUrl(b.src)) + '" alt="' + PR.esc(label(b)) + '" loading="lazy" decoding="async"><span class="media-image-error" hidden>' + PR.t("图片未能加载，请查看原页") + '</span></span>';
  }
  function html(ref) {
    const b = resolve(ref);
    if (!b) return '<p class="media-empty">' + PR.t("这张图表已变化或移除，请重新关联") + '</p>' + (ref.page ? '<button class="btn sm" data-media-page="' + Number(ref.page) + '">' + PR.t("查看原页") + '</button>' : "");
    let content;
    if (b.type === "table") content = tableHtml(b);
    else if (b.src) content = '<div class="media-image"><img src="' + PR.esc(PR.imageUrl(b.src)) + '" alt="' + PR.esc(label(b)) + '" decoding="async"><span class="media-image-error" hidden>' + PR.t("图片未能加载，请查看原页") + '</span></div>';
    else content = '<p class="media-empty">' + PR.t("尚无图像，可查看 PDF 原页") + '</p>';
    return '<div class="media-preview" data-media-block="' + PR.esc(b.id) + '">' + content + '<div class="media-caption">' + PR.esc(caption(b)) + '</div><div class="media-footer"><span>' + PR.t("第 {page} 页", { page: b.page || "?" }) + '</span><button class="btn sm" data-media-go="' + PR.esc(b.id) + '">' + PR.t("定位正文") + '</button>' + (b.page ? '<button class="btn sm" data-media-page="' + Number(b.page) + '" data-media-block="' + PR.esc(b.id) + '">PDF</button>' : "") + '</div></div>';
  }
  function hover(anchor, b) {
    PR.popover(anchor, '<div class="media-hover"><div class="media-title">' + PR.esc(label(b)) + '</div>' + html(reference(b)) + '</div>', { wide: true });
  }
  document.addEventListener("click", (e) => {
    const go = e.target.closest("[data-media-go]"), page = e.target.closest("[data-media-page]");
    if (!go && !page) return;
    e.preventDefault(); e.stopPropagation(); PR.hidePopover();
    if (go) PR.jumpTo("b-" + go.dataset.mediaGo);
    else PR.openPage(Number(page.dataset.mediaPage), page.dataset.mediaBlock);
  }, true);
  document.addEventListener("error", (e) => {
    if (!e.target.matches || !e.target.matches(".media-image img")) return;
    e.target.hidden = true;
    e.target.nextElementSibling.hidden = false;
  }, true);
  PR.media = { isMedia, blocks, label, caption, reference, resolve, html, hover, thumbnail };
})(window.PR);
