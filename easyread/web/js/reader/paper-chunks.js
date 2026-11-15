/* Build the opening and resume point first. Each placeholder stays in document
   order, so filling a chapter never replaces the paragraph being read. */
(function (PR) {
  "use strict";
  const batch = 12;
  let active = null;

  PR.cancelPaperChunks = () => {
    if (!active) return;
    active.observer.disconnect();
    clearTimeout(active.timer);
    active = null;
  };

  PR.openPaperChunks = function (blocks, render) {
    const paper = PR.$("#paper");
    const progress = PR.state.reader.progress || {};
    let anchor = progress.block;
    if (location.hash) {
      try { anchor = decodeURIComponent(location.hash.slice(1)).replace(/^b-/, ""); }
      catch (_) { return null; }
    }
    const index = blocks.findIndex(b => b?.id === anchor);
    // Preserve the existing full-document fallback for legacy ratio-only
    // progress, PDF page links, and citation returns with their own position.
    if ((index < 0 && (location.hash || progress.ratio > 0)) ||
        new URLSearchParams(location.search).has("cite_return") || history.state?.citationVisit) return null;

    const eager = new Set([0]);
    for (let i = Math.max(0, index - 6); i < Math.min(blocks.length, index + 12); i++) eager.add(Math.floor(i / batch));
    // Existing highlights and note anchors must be present at initial setup.
    const marked = new Set((PR.state.discussion.entries || []).map(e => e.anchor));
    for (const note of PR.myNotes()) for (const id of PR.noteBlocks(note)) marked.add(id);
    blocks.forEach((b, i) => { if (marked.has(b?.id)) eager.add(Math.floor(i / batch)); });
    const waiting = new Map();
    const observer = new IntersectionObserver(entries => {
      if (active !== job) return;
      const visible = entries.filter(e => e.isIntersecting).map(e => Number(e.target.dataset.paperChunk));
      if (visible.length) fill(visible);
    }, {rootMargin:"800px 0px"});
    const job = {observer, timer:0};
    active = job;

    function fill(groupIds) {
      // Chromium may anchor on an estimated spacer. Preserve the real text
      // at the reading line when an earlier spacer changes height.
      const line = innerHeight * 0.3;
      const paperRect = paper.getBoundingClientRect();
      const anchor = document.elementFromPoint(paperRect.left + paperRect.width / 2, line)?.closest("#paper > .blk");
      const top = anchor?.getBoundingClientRect().top;
      for (const id of groupIds) {
        const marker = waiting.get(id);
        if (!marker) continue;
        waiting.delete(id);
        observer.unobserve(marker);
        const template = document.createElement("template");
        template.innerHTML = render(id * batch, (id + 1) * batch);
        for (const el of template.content.children) el._paperSource = el.outerHTML;
        PR.prepareReadingBlocks(template.content);
        PR.emit("paper-chunk", template.content);
        marker.replaceWith(template.content);
      }
      if (anchor && anchor.isConnected) {
        const delta = anchor.getBoundingClientRect().top - top;
        if (Math.abs(delta) > 1) window.scrollBy({top:delta, behavior:"instant"});
      }
      if (!waiting.size) {
        PR.cancelPaperChunks();
        PR.emit("rendered");
        PR.layoutMargin();
      }
    }
    function next() {
      if (active !== job) return;
      fill([waiting.keys().next().value]);
      if (active === job) job.timer = setTimeout(next, 36);
    }
    job.finish = () => fill([...waiting.keys()]);
    let html = "";
    for (let start = 0; start < blocks.length; start += batch) {
      const id = start / batch;
      html += eager.has(id) ? render(start, start + batch) :
        '<div aria-hidden="true" data-paper-chunk="' + id + '" style="height:' + Math.min(batch, blocks.length - start) * 120 + 'px"></div>';
    }
    return {html, start() {
      for (const marker of paper.querySelectorAll("[data-paper-chunk]")) {
        waiting.set(Number(marker.dataset.paperChunk), marker);
        observer.observe(marker);
      }
      // Leave the first paint to the readable blocks before filling the rest.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (active === job) job.timer = setTimeout(next, 36); }));
    }};
  };
  PR.finishPaperChunks = () => active?.finish();
  window.addEventListener("beforeprint", PR.finishPaperChunks);
  window.addEventListener("keydown", e => {
    if (e.key === "End" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a")) PR.finishPaperChunks();
  }, true);
})(window.PR);
