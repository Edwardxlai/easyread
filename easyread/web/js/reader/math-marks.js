/* Draw one annotation band per KaTeX line, keeping the saved text anchors intact. */
(function (PR) {
  "use strict";
  const watched = new Set(), pending = new Set();
  let frame = 0;
  function draw(base) {
    base.querySelectorAll("mark.math-band").forEach(mark => mark.remove());
    const fragments = [...base.querySelectorAll("mark.hl")];
    fragments.forEach(mark => mark.classList.remove("math-fragment"));
    const bounds = base.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !base.offsetWidth || !base.offsetHeight) return;
    const scaleX = bounds.width / base.offsetWidth, scaleY = bounds.height / base.offsetHeight;
    const groups = new Map();
    for (const mark of fragments) {
      const id = mark.dataset.note ? "note:" + mark.dataset.note : "card:" + mark.dataset.card;
      if (!mark.dataset.note && !mark.dataset.card) continue;
      let group = groups.get(id);
      if (!group) groups.set(id, group = { first: mark, marks: [], left: Infinity, right: -Infinity });
      for (const rect of mark.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        group.left = Math.min(group.left, rect.left);
        group.right = Math.max(group.right, rect.right);
      }
      group.marks.push(mark);
    }
    for (const group of groups.values()) {
      if (!Number.isFinite(group.left) || group.right <= group.left) continue;
      const band = document.createElement("mark");
      band.className = group.first.className + " math-band";
      for (const key of ["note", "card"]) if (group.first.dataset[key]) band.dataset[key] = group.first.dataset[key];
      band.setAttribute("aria-hidden", "true");
      // .base is an inline-block representing a formula's visual line. Its strut
      // includes superscripts/fractions; nested glyph font sizes no longer set
      // the annotation height. Partial selections retain their horizontal span.
      const height = Math.max(bounds.height / scaleY, parseFloat(getComputedStyle(base).fontSize) * 1.2);
      band.style.left = (group.left - bounds.left) / scaleX + "px";
      band.style.top = (bounds.height / scaleY - height) / 2 + "px";
      band.style.width = (group.right - group.left) / scaleX + "px";
      band.style.height = height + "px";
      base.appendChild(band);
      group.marks.forEach(mark => mark.classList.add("math-fragment"));
    }
  }
  function schedule(base) {
    pending.add(base);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const item of pending) if (item.isConnected) draw(item);
      pending.clear();
    });
  }
  const observer = new ResizeObserver(entries => entries.forEach(entry => schedule(entry.target)));
  PR.renderMathMarks = function (scope) {
    for (const base of watched) if (!base.isConnected || !base.querySelector("mark.hl:not(.math-band)")) {
      observer.unobserve(base);
      watched.delete(base);
    }
    for (const base of scope.querySelectorAll(".katex-html > .base")) {
      if (!base.querySelector("mark.hl:not(.math-band)")) continue;
      if (!watched.has(base)) { watched.add(base); observer.observe(base); }
      draw(base);
    }
  };
  if (document.fonts) document.fonts.ready.then(() => watched.forEach(schedule));
})(window.PR);
