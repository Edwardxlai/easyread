/* 右侧面板：原文页（随阅读位置翻页、框出当前段）。和笔记面板共用右侧，一次开一个。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const body = document.body;
  let pvPage = 1, pvBlock = null;
  const pages = () => (S.paper.meta || {}).pages || [];

  /* 右侧面板开关：pages | notes | null */
  /* 面板先滑出来（只动面板，不卡），滑完再让正文让位、重排一次。
     长论文有几万个节点，正文宽度一变就要整页重排（两三百毫秒），放在点击的当下会让人觉得按钮反应慢。 */
  PR.side = null;
  let sideT = null;
  PR.openSide = function (name) {
    PR.side = name;
    body.classList.toggle("pv-open", name === "pages");
    body.classList.toggle("np-open", name === "notes");
    body.classList.toggle("ch-open", name === "chat");
    PR.$('[data-act="chat"]').classList.toggle("on", name === "chat");
    PR.$('[data-act="pages"]').classList.toggle("on", name === "pages");
    PR.$('[data-act="notes"]').classList.toggle("on", name === "notes");
    clearTimeout(sideT);
    if (name) { const t = PR.$("#toast"); if (t) t.classList.remove("open"); }  // 提示条别挡住面板底部的输入框
    if (body.classList.contains("side-open") === !!name) return;  // 面板之间切换：正文宽度不变
    sideT = setTimeout(() => requestAnimationFrame(() => {
      const anchor = PR.readingBlock && PR.readingBlock();
      const node = anchor && document.getElementById("b-" + anchor);
      const before = node ? node.getBoundingClientRect().top : 0;
      body.classList.toggle("side-open", !!PR.side);
      PR.fitWide(); PR.renderMargin();
      if (node) window.scrollBy(0, node.getBoundingClientRect().top - before);  // 重排后还停在刚才读的地方
    }), 300);
  };

  PR.togglePages = function (force) {
    const open = force != null ? force : PR.side !== "pages";
    PR.openSide(open ? "pages" : null);
    if (open) { PR.syncPage(true); if (activeSel) PR.highlightSelection(activeSel); }
    else { pair(null); PR.clearSelectionHighlight && PR.clearSelectionHighlight(); }
  };
  PR.openPage = function (page, blockId) {
    pvBlock = blockId || null;
    if (PR.side !== "pages") PR.openSide("pages");
    showPage(page, blockId);
  };

  /* 原图是 2.4 倍渲染（约 1500 像素宽、几百 KB），面板用不了那么大：要一张和面板一样宽的，服务端生成一次后缓存 */
  function srcOf(n) {
    const p = pages()[n - 1];
    if (!p) return "";
    const base = PR.imageUrl(p.img);
    if (PR.store.mode !== "server") return base;
    const need = (PR.$(".pv-scroll").clientWidth || 480) * (body.classList.contains("pv-zoom") ? 1.65 : 1) * (devicePixelRatio || 1);
    return need <= 1000 ? base + "?w=1000" : need <= 1600 ? base + "?w=1600" : base;  // 1000 宽的服务端已提前生成好
  }
  const preloaded = new Set();
  function preload(n) {
    const s = srcOf(n);
    if (s && !preloaded.has(s)) { preloaded.add(s); const im = new Image(); im.decoding = "async"; im.src = s; }
  }
  PR.preloadPage = () => { const b = PR.blockById[PR.readingBlock()]; if (b && b.page) preload(b.page); };

  let activeSel = null;

  function applySelHighlight(sel, loc) {
    const selHl = PR.$(".pv-hl-sel");
    if (!selHl || !loc || !loc.box) return;
    const [x0, y0, x1, y1] = loc.box;
    const H = y1 - y0;
    const total = sel.total || Math.max(1, sel.quote ? sel.quote.length : 1);
    const r0 = Math.max(0, Math.min(1, (sel.s != null ? sel.s : 0) / total));
    const r1 = Math.max(r0, Math.min(1, (sel.e != null ? sel.e : total) / total));

    const lines = Math.max(1, Math.round(H / 0.018));
    const lineH = Math.min(0.04, Math.max(0.014, H / lines));
    let subTop = y0 + r0 * H;
    let subBottom = y0 + r1 * H;
    if (subBottom - subTop < lineH * 0.9) {
      const pad = (lineH * 0.9 - (subBottom - subTop)) / 2;
      subTop = Math.max(y0, subTop - pad);
      subBottom = Math.min(y1, subBottom + pad);
      if (subBottom - subTop < lineH * 0.9) {
        if (subTop <= y0 + 0.001) subBottom = Math.min(y1, subTop + lineH * 0.9);
        else subTop = Math.max(y0, subBottom - lineH * 0.9);
      }
    }
    subTop = Math.max(y0 - 0.002, subTop);
    subBottom = Math.min(y1 + 0.002, Math.max(subTop + lineH * 0.8, subBottom));

    Object.assign(selHl.style, {
      left: (x0 * 100 - 0.8) + "%",
      top: (subTop * 100 - 0.3) + "%",
      width: ((x1 - x0) * 100 + 1.6) + "%",
      height: ((subBottom - subTop) * 100 + 0.6) + "%"
    });
    selHl.classList.add("on");

    const scroller = PR.$(".pv-scroll");
    const img = PR.$(".pv-page img");
    const doSelScroll = () => {
      const h = PR.$(".pv-page").offsetHeight;
      if (!h || !scroller) return;
      const midY = ((subTop + subBottom) / 2) * h + 18;
      const curTop = scroller.scrollTop;
      const curBottom = curTop + scroller.clientHeight;
      if (midY < curTop + 40 || midY > curBottom - 40) {
        scroller.scrollTo({ top: Math.max(0, midY - scroller.clientHeight / 2), behavior: "smooth" });
      }
    };
    img && img.complete ? doSelScroll() : img && img.addEventListener("load", doSelScroll, { once: true });
  }

  PR.clearSelectionHighlight = function () {
    activeSel = null;
    const selHl = PR.$(".pv-hl-sel");
    if (selHl) selHl.classList.remove("on");
  };

  PR.highlightSelection = function (sel) {
    if (!sel || !sel.anchor) {
      PR.clearSelectionHighlight();
      return;
    }
    const loc = S.layout && S.layout[sel.anchor];
    if (!loc || !loc.box) {
      PR.clearSelectionHighlight();
      return;
    }
    activeSel = sel;
    if (PR.side === "pages") {
      if (loc.page !== pvPage || sel.anchor !== pvBlock) {
        showPage(loc.page, sel.anchor);
      } else {
        applySelHighlight(sel, loc);
      }
    }
  };

  function showPage(page, blockId) {
    const list = pages();
    if (!list.length) return;
    pvPage = Math.min(list.length, Math.max(1, page));
    const img = PR.$(".pv-page img");
    img.decoding = "async";
    const src = srcOf(pvPage);
    if (img.getAttribute("src") !== src) { img.setAttribute("src", src); PR.$(".pv-page").classList.add("loading"); img.onload = () => PR.$(".pv-page").classList.remove("loading"); }
    preload(pvPage + 1); preload(pvPage - 1);
    PR.$(".pv-label").textContent = "第 " + pvPage + " / " + list.length + " 页";
    const pdf = PR.$('[data-pv="pdf"]');
    const url = PR.pdfUrl(pvPage);
    pdf.style.display = url ? "" : "none";
    if (url) pdf.href = url;
    const hl = PR.$(".pv-hl");
    const loc = blockId && S.layout[blockId];
    pair(loc && loc.page === pvPage ? blockId : null);
    if (loc && loc.page === pvPage) {
      const [x0, y0, x1, y1] = loc.box;
      Object.assign(hl.style, { left: (x0 * 100 - 0.8) + "%", top: (y0 * 100 - 0.4) + "%", width: ((x1 - x0) * 100 + 1.6) + "%", height: ((y1 - y0) * 100 + 0.8) + "%" });
      hl.classList.add("on");
      const scroller = PR.$(".pv-scroll");
      const doScroll = () => { const h = PR.$(".pv-page").offsetHeight;  // 原页里框出的那段也放在面板中间
        scroller.scrollTo({ top: Math.max(0, ((y0 + y1) / 2) * h + 18 - scroller.clientHeight / 2), behavior: "smooth" }); };
      img.complete ? doScroll() : img.addEventListener("load", doScroll, { once: true });
    } else hl.classList.remove("on");
    if (activeSel && activeSel.anchor === blockId && loc && loc.page === pvPage) {
      applySelHighlight(activeSel, loc);
    } else {
      const selHl = PR.$(".pv-hl-sel");
      if (selHl) selHl.classList.remove("on");
    }
  }

  /* 译文里和原页框对应的那段也标出来（同一个颜色），一眼看出左右是哪两段 */
  let paired = null, holdUntil = 0;
  function pair(id) {
    if (paired === id) return;
    const old = paired && document.getElementById("b-" + paired);
    if (old) old.classList.remove("pv-pair");
    paired = id;
    const node = id && document.getElementById("b-" + id);
    if (node) node.classList.add("pv-pair");
  }
  PR.on("block-rendered", (id) => { if (id === paired) { paired = null; pair(id); } });  // 段落重画后补回标记
  PR.on("rendered", () => { const id = paired; paired = null; pair(id); });

  /* 点原页上的某一段 → 正文跳到那段译文（排版特殊、看不出语序时，从原文找回去） */
  function blockAt(x, y) {
    let best = null, area = Infinity;
    for (const id in S.layout) {
      const l = S.layout[id];
      if (l.page !== pvPage || !PR.blockById[id]) continue;
      const [x0, y0, x1, y1] = l.box;
      const a = (x1 - x0) * (y1 - y0);
      if (x >= x0 - 0.01 && x <= x1 + 0.01 && y >= y0 - 0.006 && y <= y1 + 0.006 && a < area) { best = id; area = a; }
    }
    return best;
  }
  PR.$(".pv-page").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const id = blockAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (!id) return;
    pvBlock = id;
    holdUntil = Date.now() + 1500;  // 跳过去的滚动会触发“跟随阅读位置”，别让它把刚点的段换掉
    showPage(pvPage, id);
    PR.jumpTo("b-" + id);
  });
  PR.$(".pv-page").addEventListener("mousemove", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.classList.toggle("pickable", !!blockAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
  });

  PR.syncPage = function (force) {
    if (PR.side !== "pages") return;
    if (!force && (!PR.$(".pv-follow input").checked || Date.now() < holdUntil)) return;
    const id = force ? ((PR.currentBlock && PR.currentBlock()) || PR.readingBlock()) : PR.readingBlock();
    if (id === "head") {
      showPage(1, null);
      return;
    }
    const b = PR.blockById[id];
    if (!b) return;
    if (!force && id === pvBlock) return;
    pvBlock = id;
    const loc = S.layout[id];
    showPage(loc ? loc.page : b.page, id);
  };

  PR.$("#pageview").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pv]");
    if (!b) return;
    const act = b.dataset.pv;
    if (act === "close") { PR.togglePages(false); pair(null); }
    if (act === "prev") showPage(pvPage - 1, pvBlock);
    if (act === "next") showPage(pvPage + 1, pvBlock);
    if (act === "zoom") { body.classList.toggle("pv-zoom"); b.textContent = body.classList.contains("pv-zoom") ? "适宽" : "放大"; showPage(pvPage, pvBlock); }
  });
  PR.pageStep = (d) => showPage(pvPage + d, pvBlock);
})(window.PR);
