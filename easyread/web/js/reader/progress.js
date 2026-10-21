/* 阅读位置：记住读到哪儿，下次打开回到那儿。
   - 记视口上部那条线穿过的块 + 线在块里的位置；块不在了退回用全文比例。
   - 滚动中每两秒记一次，离开页面、退出软件前再补记一次。
   - 打开就直接回到那儿（落位期间先不显示正文，见 anchor）。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const EVERY = 2000;  // 滚动中最多两秒记一次
  const REVEAL = 1200;  // 字体没排好时最多藏这么久
  const SETTLE = [900, 2200, 4000];  // 字体、图片、图注陆续排进来，各对一次

  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const element = (block) => block && (/^orig-\d+$/.test(block) ? document.getElementById(block) : document.getElementById("b-" + block));

  /* 现在读到哪儿，写成一条 progress 操作 */
  PR.progressOp = function () {
    let block = PR.readingBlock();
    let el = element(block);
    // 未整理的 PDF 原页没有正文块，也需要记住页码和页内位置。
    for (const page of PR.$$("#paper .orig-page")) {
      const top = page.getBoundingClientRect().top;
      if (top > PR.readingLine()) break;
      if (!el || top >= el.getBoundingClientRect().top) { block = page.id; el = page; }
    }
    const box = el ? el.getBoundingClientRect() : null;
    const off = box && box.height > 0 ? (PR.readingLine() - box.top) / box.height : 0;
    const max = maxScroll();
    return {
      op: "progress", block,
      off: Math.round(Math.min(1, Math.max(0, off)) * 100) / 100,
      ratio: max > 0 ? Math.round((scrollY / max) * 100) / 100 : 0,
    };
  };

  function save() {
    if (!watching || landing) return;  // 位置没对准之前不记
    const op = PR.progressOp(), was = S.reader.progress || {};
    if (op.block === was.block && Math.abs((was.ratio || 0) - op.ratio) <= 0.02 && Math.abs((was.off || 0) - op.off) <= 0.05) return;
    PR.commit(op);
  }

  let watching = false, landing = false;
  /* 位置定了才开始记（main.js 启动流程末尾调它） */
  PR.watchProgress = () => { watching = true; };

  PR.saveProgress = PR.throttle(save, EVERY);
  PR.captureProgress = save;
  /* 离开页面、退出软件前补记一次并立刻发出去 */
  PR.flushProgress = function (opts) {
    save();
    return PR.flushPending ? PR.flushPending(opts) : Promise.resolve();
  };
  window.addEventListener("pagehide", () => PR.flushProgress({ leaving: true }));

  /* 记下的位置换算成 scrollTop：以块为准，没有 off 就按块顶对线 */
  function target(p) {
    // 旧版把读到原页的进度记成 head；越过标题的记录按全文比例恢复。
    const el = p.block === "head" && p.ratio > 0 && (p.off == null || p.off >= 1) ? null : element(p.block);
    if (el) {
      const box = el.getBoundingClientRect();
      if (box.height > 0) return Math.max(0, Math.round(scrollY + box.top + box.height * (p.off ?? 0) - PR.readingLine()));
    }
    return p.ratio != null ? Math.round(maxScroll() * p.ratio) : null;
  }

  /* 上次读到哪儿；back：已经回来了，还是只问一句要不要去 */
  function lastRead(p, back) {
    const page = /^orig-(\d+)$/.exec(p.block);
    if (page) return back ? PR.t("已回到上次读到第 {page} 页", { page: +page[1] }) : PR.t("上次读到第 {page} 页", { page: +page[1] });
    let h = null;
    for (const x of S.paper.blocks || []) { if (x.type === "heading") h = x; if (x.id === p.block) break; }
    const b = PR.blockById[p.block];
    if (h) {
      const sec = (h.num ? h.num + " " : "") + PR.plain(PR.textFor(h.id));
      return back ? PR.t("已回到上次读到「{sec}」", { sec }) : PR.t("上次读到「{sec}」", { sec });
    }
    if (b) return back ? PR.t("已回到上次读到第 {page} 页", { page: b.page }) : PR.t("上次读到第 {page} 页", { page: b.page });
    return PR.t("已回到上次读到的地方");
  }

  PR.restoreProgress = function () {
    const p = S.reader.progress || {};
    if (scrollY > 50) return false;  // 浏览器恢复过滚动位置，或者用户已经动了
    const at = target(p);
    if (at == null) return false;
    /* 单文件版没有服务，位置只在本机浏览器里：照旧问一句 */
    if (PR.store.mode !== "server") {
      if (!PR.blockById[p.block]) return false;
      PR.toast(lastRead(p, false), { label: PR.t("接着读"), fn: () => window.scrollTo({ top: at, behavior: "smooth" }) }, 8000);
      return true;
    }
    if (at <= 0) return false;  // 上次就停在最上面，不用回，也不用说
    anchor(p, at);
    PR.toast(lastRead(p, true), { label: PR.t("回到顶部"), fn: () => window.scrollTo({ top: 0, behavior: "smooth" }) }, 8000);
    return true;
  };

  /* 落位，并在版面排好前跟住它；没对准之前先不显示正文（露出来又被挤走） */
  function anchor(p, at) {
    const paper = PR.$("#paper");
    const userInput = ["wheel", "touchstart", "keydown", "mousedown"];
    let stopped = false, shown = false;
    landing = true;
    const show = () => {
      if (shown) return;
      shown = true;
      landing = false;  // 对准了，从这里才开始记
      if (paper) paper.classList.remove("landing");
    };
    const stop = () => { stopped = true; show(); };  // 用户自己动了：别跟了，也别藏着
    const land = () => {
      if (stopped) return;
      const to = target(p);
      if (to != null && to > 0 && Math.abs(to - scrollY) > 2) window.scrollTo({ top: to, behavior: "auto" });
    };
    if (paper) paper.classList.add("landing");
    window.scrollTo({ top: at, behavior: "auto" });
    userInput.forEach((n) => window.addEventListener(n, stop, { passive: true }));
    Promise.race([document.fonts ? document.fonts.ready : null, new Promise((r) => setTimeout(r, REVEAL))])
      .then(() => { land(); show(); });
    SETTLE.forEach((ms, i) => setTimeout(() => {
      land();
      if (i === SETTLE.length - 1) userInput.forEach((n) => window.removeEventListener(n, stop));
    }, ms));
  }
})(window.PR);
