/* Preserve live DOM and the actual reading position during translation updates. */
(function (PR) {
  "use strict";
  let revision = 0;
  // User navigation takes precedence over the short layout correction.
  ["wheel", "touchstart", "pointerdown", "keydown"].forEach(type => window.addEventListener(type, () => ++revision, {passive:true, capture:true}));

  PR.updatePaperHtml = function (paper, html) {
    const draft = document.createElement("template"); draft.innerHTML = html;
    const existing = new Map([...paper.querySelectorAll('[id]')].map(el => [el.id, el]));
    function reuse(fresh) {
      const source = fresh.outerHTML;
      const old = fresh.id && existing.get(fresh.id);
      if (old && old._paperSource === source) return old;
      // Original pages can move from the tail into a gap between translated pages.
      if (fresh.classList.contains("pending-pages")) {
        for (const child of [...fresh.children]) {
          const saved = reuse(child);
          if (saved !== child) child.replaceWith(saved);
        }
      }
      fresh._paperSource = source;
      return fresh;
    }
    const desired = [...draft.content.children].map(reuse);
    let cursor = paper.firstElementChild;
    for (const el of desired) {
      if (el === cursor) cursor = cursor.nextElementSibling;
      else paper.insertBefore(el, cursor);
    }
    const keep = new Set(desired);
    for (const el of [...paper.children]) if (!keep.has(el)) el.remove();
  };

  PR.rerenderKeepingPlace = function () {
    if (PR.webContentWindow?.()) {
      const id = PR.readingBlock();
      const before = PR.webBlockHost(id);
      const top = before ? PR.webRect(before).top : 0;
      PR.renderPaper();
      const after = PR.webBlockHost(id);
      if (after) window.scrollBy(0, PR.webRect(after).top - top);
      return;
    }
    const line = PR.readingLine ? PR.readingLine() : innerHeight * .3;
    let anchor = null;
    for (const el of PR.$$('#paper > .paper-head, #paper > .blk, #paper .orig-page')) {
      if (el.getBoundingClientRect().top <= line) anchor = el; else break;
    }
    const before = anchor?.getBoundingClientRect();
    const offset = before ? line - before.top : 0;
    const fraction = before?.height ? Math.max(0, Math.min(1, offset / before.height)) : 0;
    const page = anchor?.classList.contains('orig-page') ? +anchor.id.slice(5) : null;
    const savedY = scrollY, ticket = ++revision;
    PR.renderPaper();
    const current = anchor && document.getElementById(anchor.id);
    const replacements = !current && page ? (PR.state.paper.blocks || []).filter(b => b.page === page).map(b => document.getElementById('b-' + b.id)).filter(Boolean) : [];
    const correct = () => {
      if (ticket !== revision) return;
      let y = savedY;
      if (current) y = scrollY + current.getBoundingClientRect().top + offset - line;
      else if (replacements.length) {
        const top = replacements[0].getBoundingClientRect().top;
        const bottom = replacements[replacements.length-1].getBoundingClientRect().bottom;
        y = scrollY + top + (bottom-top)*fraction - line;
      }
      if (Math.abs(y-scrollY) > 1) window.scrollTo({top:Math.max(0,y), behavior:'instant'});
    };
    correct();
    let frames = 0;
    const settle = () => { if (ticket !== revision) return; correct(); if (++frames < 4) requestAnimationFrame(settle); };
    requestAnimationFrame(settle);
  };
})(window.PR);
