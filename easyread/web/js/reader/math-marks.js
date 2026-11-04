/* Draw one annotation band per KaTeX line, keeping the saved text anchors intact. */
(function (PR) {
  "use strict";
  const watched = new Set(), pending = new Set();
  let frame = 0;
  // Inline math shares the actual painted box of the same annotation in prose.
  // A wrapped text mark has a separate client rect on each visual line.
  function proseBoxes(math, mark) {
    if (math.closest(".katex-display")) return [];
    const prose = math.closest(".zh, .en");
    if (!prose) return [];
    const key = mark.dataset.note ? "note" : "card";
    const selector = 'mark.hl[data-' + key + '="' + CSS.escape(mark.dataset[key]) + '"]';
    return [...prose.querySelectorAll(selector)]
      .filter(el => !el.closest(".katex"))
      .flatMap(el => [...el.getClientRects()]);
  }

  function draw(math) {
    math.querySelectorAll("mark.math-band").forEach(mark => mark.remove());
    const fragments = [...math.querySelectorAll("mark.hl")];
    fragments.forEach(mark => mark.classList.remove("math-fragment"));
    const lines = [];
    for (const base of math.querySelectorAll(":scope > .base")) {
      const bounds = base.getBoundingClientRect();
      if (!bounds.width || !bounds.height || !base.offsetWidth || !base.offsetHeight) continue;
      const scaleX = bounds.width / base.offsetWidth, scaleY = bounds.height / base.offsetHeight;
      const strut = base.querySelector(":scope > .strut");
      const baseline = strut ? strut.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(strut).verticalAlign) || 0) * scaleY : bounds.bottom;
      let line = lines.find(item => Math.abs(item.baseline - baseline) < 2 * scaleY);
      if (!line) lines.push(line = { baseline, top: Infinity, bottom: -Infinity, groups: new Map() });
      const height = Math.max(bounds.height, parseFloat(getComputedStyle(base).fontSize) * 1.2 * scaleY);
      line.top = Math.min(line.top, bounds.top - (height - bounds.height) / 2);
      line.bottom = Math.max(line.bottom, bounds.bottom + (height - bounds.height) / 2);
      for (const mark of base.querySelectorAll("mark.hl")) {
      const id = mark.dataset.note ? "note:" + mark.dataset.note : "card:" + mark.dataset.card;
      if (!mark.dataset.note && !mark.dataset.card) continue;
      let group = line.groups.get(id);
      if (!group) line.groups.set(id, group = { first: mark, base, bounds, scaleX, scaleY, marks: [], left: Infinity, right: -Infinity });
      for (const rect of mark.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        group.left = Math.min(group.left, rect.left);
        group.right = Math.max(group.right, rect.right);
      }
      group.marks.push(mark);
      }
    }
    const textBoxes = new Map();
    for (const line of lines) for (const [id, group] of line.groups) {
      if (!Number.isFinite(group.left) || group.right <= group.left) continue;
      const { base, bounds, scaleX, scaleY } = group;
      if (!textBoxes.has(id)) textBoxes.set(id, proseBoxes(math, group.first));
      const prose = textBoxes.get(id).find(rect => rect.width && rect.top <= line.baseline && line.baseline < rect.bottom);
      const top = prose ? prose.top : line.top;
      const bottom = prose ? prose.bottom : line.bottom;
      const band = document.createElement("mark");
      band.className = group.first.className + " math-band";
      for (const key of ["note", "card"]) if (group.first.dataset[key]) band.dataset[key] = group.first.dataset[key];
      band.setAttribute("aria-hidden", "true");
      // KaTeX splits expressions at operators into multiple .base elements.
      // Join those sharing a baseline, while keeping wrapped lines separate.
      // Partial selections retain their horizontal span and saved text anchor.
      band.style.left = (group.left - bounds.left) / scaleX + "px";
      band.style.top = (top - bounds.top) / scaleY + "px";
      band.style.width = (group.right - group.left) / scaleX + "px";
      band.style.height = (bottom - top) / scaleY + "px";
      base.appendChild(band);
      group.marks.forEach(mark => mark.classList.add("math-fragment"));
    }
  }
  function schedule(base) {
    if (!base?.isConnected) return;
    pending.add(base);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const item of pending) if (item.isConnected) draw(item);
      pending.clear();
    });
  }
  const observer = new ResizeObserver(entries => entries.forEach(entry => schedule(entry.target.parentElement)));
  PR.renderMathMarks = function (scope) {
    for (const base of watched) if (!base.isConnected || !base.querySelector("mark.hl:not(.math-band)")) {
      observer.unobserve(base);
      watched.delete(base);
    }
    for (const math of scope.querySelectorAll(".katex-html")) {
      if (!math.querySelector("mark.hl:not(.math-band)")) continue;
      for (const base of math.querySelectorAll(":scope > .base")) {
        if (!watched.has(base)) { watched.add(base); observer.observe(base); }
      }
      draw(math);
    }
  };
  if (document.fonts) document.fonts.ready.then(() => watched.forEach(base => schedule(base.parentElement)));
})(window.PR);
