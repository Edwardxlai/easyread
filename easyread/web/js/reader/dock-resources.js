/* Figures use their existing paper reference. The map reads the same note as the editor. */
(function (PR) {
  "use strict";
  let map, lastBody;
  function drawMap(node) {
    const text = PR.paperNoteEditor.getBody() ?? PR.state.reader.paper_note?.body ?? "";
    if (map && lastBody === text) return;
    lastBody = text;
    if (!map) {
      node.innerHTML = '<p class="hint"></p><svg class="dock-map" aria-label="' + PR.t("思维导图") + '"></svg>';
      node.firstElementChild.textContent = PR.t("在论文笔记里写下标题和内容，思维导图会自动出现在这里。");
      map = PR.noteLibraries.Markmap.create(node.querySelector("svg"), { duration: 0, maxWidth: 220 });
      new ResizeObserver(() => { if (node.clientHeight && lastBody?.trim()) map.fit(); }).observe(node);
    }
    node.querySelector("p").hidden = !!text.trim();
    node.querySelector("svg").style.display = text.trim() ? "" : "none";
    if (!text.trim()) return;
    let doc = PR.paperNoteEditor.documentForMap(text);
    if (!doc) {
      const editor = PR.noteLibraries.createEditor({ element: document.createElement("div"), content: text,
        onChange() {}, onSelection() {}, onMathClick() {} });
      doc = editor.getJSON(); editor.destroy();
    }
    const meta = PR.state.paper.meta;
    const tree = PR.noteLibraries.toMindMap(doc, meta.short_zh || meta.title_zh || meta.title_en || PR.t("论文笔记"));
    map.setData(tree).then(() => { if (lastBody === text && node.clientHeight) map.fit(); });
  }
  const lastFigure = new WeakMap();
  function drawFigure(block, node, lazy = false) {
    if (!block) { lastFigure.delete(node); node.textContent = PR.t("图表已变化或移除"); return; }
    const mode = PR.readingView(), translated = mode !== "original" && PR.hasTranslatedFigure(block) ? PR.imageUrl(block.translated_image.src) : "";
    const markup = PR.media.html(PR.media.reference(block));
    const zh = PR.textFor(block.id + "#caption") || block.caption_zh, en = block.caption_en;
    const labels = mode === "both" ? (PR.originalFirst() ? [en, zh] : [zh, en]) : [mode === "original" ? en || zh : zh || en];
    const captionText = [...new Set(labels.filter(Boolean))].join("\n");
    const signature = JSON.stringify([markup, mode, translated, PR.originalFirst(), captionText]);
    if (lastFigure.get(node) === signature) return;
    const shell = document.createElement("div");
    shell.innerHTML = markup;
    const original = shell.querySelector("img");
    if (original && lazy) original.loading = "lazy";
    if (original && translated) {
      const image = original.cloneNode(); image.src = translated; image.alt = PR.t("译图");
      if (mode === "translation") original.replaceWith(image);
      else if (PR.originalFirst()) original.after(image); else original.before(image);
    }
    const caption = shell.querySelector(".media-caption");
    if (caption) caption.textContent = captionText;
    lastFigure.set(node, signature); node.replaceChildren(...shell.childNodes);
  }
  function drawGallery(node) {
    const blocks = PR.media.blocks();
    if (!blocks.length) {
      const hint = document.createElement("p"); hint.className = "hint"; hint.textContent = PR.t("没有找到图表");
      node.replaceChildren(hint); return;
    }
    const existing = new Map(Array.from(node.children, child => [child.dataset.id, child]));
    blocks.forEach((block, i) => {
      let entry = existing.get(block.id);
      if (!entry) {
        entry = document.createElement("article"); entry.className = "dock-gallery-entry"; entry.dataset.id = block.id;
        entry.append(document.createElement("h3"), document.createElement("div"));
      }
      existing.delete(block.id);
      if (entry !== node.children[i]) node.insertBefore(entry, node.children[i] || null);
      entry.firstElementChild.textContent = PR.media.label(block);
      drawFigure(block, entry.lastElementChild, true);
    });
    existing.forEach(entry => entry.remove());
  }
  PR.renderDockResource = (key, node) => key === "map" ? drawMap(node)
    : key === "gallery" ? drawGallery(node) : drawFigure(PR.blockById[key.slice(4)], node);
  const refresh = PR.debounce(() => PR.refreshDockResource(), 100);
  PR.on("reader", refresh); PR.on("remote", refresh); PR.on("rendered", refresh);
  document.addEventListener("input", e => { if (e.target.id === "paperNote") refresh(); });
})(window.PR);
