/* Change only the reflowed paper font; PDF and figure viewers own their zoom. */
(function (PR) {
  "use strict";
  let delta = 0, last = 0;
  document.addEventListener("wheel", (e) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || !e.deltaY) return;
    if (!e.target.closest("#paper") || e.target.closest("textarea, input, [contenteditable], .orig-page, .pending-pages")) return;
    e.preventDefault();
    const now = performance.now();
    if (now - last > 180 || Math.sign(e.deltaY) !== Math.sign(delta)) delta = 0;
    last = now;
    delta += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    if (Math.abs(delta) < 40) return;
    PR.bumpFont(delta < 0 ? 1 : -1);
    delta = 0;
  }, { passive: false });
})(window.PR);
