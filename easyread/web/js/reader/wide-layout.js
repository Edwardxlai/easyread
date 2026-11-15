/* Fit equations and tables shortly before they scroll into view. */
(function (PR) {
  "use strict";
  const selector = ".math-body, .tbl-wrap";
  const nearby = new Set();
  let natural = new WeakMap();
  let typeface = "";

  function fit(boxes) {
    boxes = boxes.filter(box => box.isConnected && box.firstElementChild);
    if (!boxes.length) return;
    const style = getComputedStyle(PR.$("#paper"));
    const font = style.fontSize + "|" + style.fontFamily;
    if (font !== typeface) {
      typeface = font;
      natural = new WeakMap();
    }
    const widths = boxes.map(box => box.clientWidth);
    const pending = boxes.filter((box, i) => {
      const cached = natural.get(box.firstElementChild);
      return widths[i] && (!cached || (!cached.overflow && widths[i] < cached.width - 1));
    });
    // Separate writes and reads so one batch needs only one layout.
    pending.forEach(box => { box.firstElementChild.style.fontSize = ""; });
    pending.forEach(box => {
      const width = box.clientWidth;
      const needed = box.firstElementChild.scrollWidth;
      natural.set(box.firstElementChild, {width: Math.max(width, needed), overflow: needed > width + 1});
    });
    const floor = window.innerWidth < 760 ? 0.58 : 0.72;
    boxes.forEach((box, i) => {
      const child = box.firstElementChild;
      const cached = natural.get(child);
      if (!widths[i] || !cached) return;
      let size = "";
      if (cached.overflow && cached.width > widths[i] + 1) {
        const ratio = Math.max(floor, widths[i] / cached.width) * 0.99;
        size = box.classList.contains("tbl-wrap") ? (0.86 * ratio).toFixed(3) + "em" : (ratio * 100).toFixed(1) + "%";
      }
      if (child.style.fontSize !== size) child.style.fontSize = size;
    });
  }

  const observer = window.IntersectionObserver && new IntersectionObserver(entries => {
    const entered = [];
    for (const {target, isIntersecting} of entries) {
      if (isIntersecting) {
        nearby.add(target);
        entered.push(target);
      } else nearby.delete(target);
    }
    fit(entered);
  }, {rootMargin: "600px 0px"});

  PR.fitWide = function (scope, remeasure) {
    if (remeasure) natural = new WeakMap();
    const boxes = observer ? [...nearby] : PR.$$(selector, scope || PR.$("#paper"));
    fit(boxes);
  };

  function observePaper() {
    const boxes = PR.$$(selector, PR.$("#paper"));
    if (!observer) return fit(boxes);
    observer.disconnect();
    nearby.clear();
    boxes.forEach(box => observer.observe(box));
  }
  PR.on("rendered", observePaper);
  PR.on("paper-chunk", fragment => {
    if (observer) fragment.querySelectorAll(selector).forEach(box => observer.observe(box));
  });
  PR.on("block-rendered", observePaper);
  window.addEventListener("beforeprint", () => fit(PR.$$(selector, PR.$("#paper"))));
  window.addEventListener("afterprint", () => PR.fitWide(null, true));
})(window.PR);
