/* View original figure pixels without changing paper layout or saved notes. */
(function (PR) {
  "use strict";
  const selector = "#paper .figure-media img, .media-preview .media-image img";
  let dialog, image, viewport, label, origin, scale = 1, drag, suppressClick = 0;
  function setScale(next, center) {
    if (!image.naturalWidth) return;
    const old = scale;
    const x = (viewport.scrollLeft + viewport.clientWidth / 2) / old;
    const y = (viewport.scrollTop + viewport.clientHeight / 2) / old;
    scale = Math.max(.05, Math.min(4, next));
    image.style.width = Math.round(image.naturalWidth * scale) + "px";
    image.style.height = Math.round(image.naturalHeight * scale) + "px";
    label.textContent = Math.round(scale * 100) + "%";
    if (center) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    else {
      viewport.scrollLeft = x * scale - viewport.clientWidth / 2;
      viewport.scrollTop = y * scale - viewport.clientHeight / 2;
    }
  }
  function fit() {
    setScale(Math.min(1, (viewport.clientWidth - 24) / image.naturalWidth,
      (viewport.clientHeight - 24) / image.naturalHeight), true);
  }
  function create() {
    dialog = document.createElement("dialog");
    dialog.className = "figure-viewer";
    dialog.setAttribute("aria-label", PR.t("查看图片"));
    dialog.innerHTML = '<div class="figure-viewer-tools"><button class="btn icon" data-zoom="out" aria-label="' + PR.t("缩小图片") + '">−</button><span class="figure-viewer-scale" aria-live="polite"></span><button class="btn icon" data-zoom="in" aria-label="' + PR.t("放大图片") + '">+</button><button class="btn sm" data-zoom="fit">' + PR.t("适合窗口") + '</button><button class="btn sm" data-zoom="actual">100%</button><span class="grow"></span><button class="btn icon" data-zoom="close" aria-label="' + PR.t("关闭") + '">×</button></div><div class="figure-viewer-scroll" tabindex="0"><div class="figure-viewer-canvas"><img alt="" draggable="false"></div></div>';
    document.body.appendChild(dialog);
    image = dialog.querySelector("img");
    viewport = dialog.querySelector(".figure-viewer-scroll");
    label = dialog.querySelector(".figure-viewer-scale");
    image.onload = fit;
    image.onerror = () => { dialog.close(); PR.toast(PR.t("图片未能加载，请查看原页")); };
    dialog.addEventListener("close", () => { drag = null; origin?.focus({ preventScroll: true }); });
    dialog.addEventListener("click", e => {
      const action = e.target.closest("[data-zoom]")?.dataset.zoom;
      if (action === "close") dialog.close();
      else if (action === "fit") fit();
      else if (action === "actual") setScale(1);
      else if (action) setScale(scale * (action === "in" ? 1.25 : .8));
    });
    viewport.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); setScale(scale * (e.deltaY < 0 ? 1.25 : .8));
    }, { passive: false });
    viewport.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add("panning");
      e.preventDefault();
    });
    viewport.addEventListener("pointermove", e => {
      if (!drag) return;
      viewport.scrollLeft = drag.left + drag.x - e.clientX;
      viewport.scrollTop = drag.top + drag.y - e.clientY;
    });
    const stop = () => { drag = null; viewport.classList.remove("panning"); };
    viewport.addEventListener("pointerup", stop);
    viewport.addEventListener("pointercancel", stop);
    viewport.addEventListener("lostpointercapture", stop);
  }
  function open(source) {
    if (!dialog) create();
    origin = source;
    image.alt = source.alt || PR.t("查看图片");
    image.src = source.currentSrc || source.src;
    scale = 1;
    dialog.showModal();
    if (image.complete && image.naturalWidth) fit();
  }
  function prepare() {
    document.querySelectorAll(selector).forEach(img => {
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.setAttribute("aria-label", PR.t("点击放大图片；拖到笔记以关联图表"));
      img.title = PR.t("点击放大图片；拖到笔记以关联图表");
    });
  }
  PR.on("rendered", prepare);
  PR.on("block-rendered", prepare);
  // A missing/corrupt generated asset falls back to the original and text,
  // including in offline exports. Capture is required: image errors do not bubble.
  document.addEventListener("error", e => {
    if (!e.target.matches?.('[data-translated-figure]')) return;
    const block = e.target.closest('.blk');
    if (block) PR.failFigureImage(block.dataset.id, e.target.getAttribute('src'));
  }, true);
  document.addEventListener("dragend", () => { suppressClick = Date.now() + 300; }, true);
  document.addEventListener("click", e => {
    const source = e.target.closest(selector);
    if (!source || Date.now() < suppressClick) return;
    e.preventDefault(); e.stopImmediatePropagation(); open(source);
  }, true);
  document.addEventListener("keydown", e => {
    if (dialog?.open) {
      // Reader shortcuts must not run underneath the modal; Tab stays native.
      e.stopImmediatePropagation();
      if (e.key === "Escape") { e.preventDefault(); dialog.close(); }
      else if (["+", "=", "-", "0"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "0") fit(); else setScale(scale * (e.key === "-" ? .8 : 1.25));
      }
    } else if (["Enter", " "].includes(e.key) && e.target.matches(selector)) {
      e.preventDefault(); e.stopImmediatePropagation(); open(e.target);
    }
  }, true);
})(window.PR);
