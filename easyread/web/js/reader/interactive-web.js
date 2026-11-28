(function (PR) {
  'use strict';
  PR.canOpenInteractiveWeb = () => {
    const meta = PR.state.paper?.meta;
    return PR.feature('interactiveWeb') && PR.store.mode === 'server' && meta?.source_type === 'web' && window.easyreadDesktop &&
      window.parent !== window && window.parent.easyreadLiveTabs &&
      /^https:\/\//i.test(meta.live_url || meta.interactive_url || meta.url || '');
  };
  let detected = false, failed = false, watching = false, scheduled = false;
  const shell = () => window.parent.easyreadLiveTabs;
  const key = () => "easyread-live-layout-" + PR.pid;
  PR.inlineWebBounds = () => {
    if (!document.body.classList.contains("web-inline") || document.body.classList.contains("drawer-open") || document.hidden ||
        document.querySelector('.dialog-backdrop.open, dialog[open], #drawer.open, #settings.open, #orderMenu.open, :popover-open, #scrim.open, #popover.open, #selbar.open:not([data-live]), #blockbar.open')) return null;
    const frame = window.frameElement.getBoundingClientRect();
    const top = Math.max(0, PR.$("#bar").getBoundingClientRect().bottom);
    const dock = PR.$("#readerDock");
    const right = dock.hidden ? innerWidth : Math.max(0, dock.getBoundingClientRect().left);
    return { x: frame.x, y: frame.y + top, width: right, height: Math.max(0, innerHeight - top) };
  };
  function watch() {
    if (watching) return;
    watching = true;
    const update = () => {
      if (scheduled || !document.body.classList.contains("web-inline")) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; shell().reposition(PR.pid); });
    };
    const size = new ResizeObserver(update);
    const state = new MutationObserver(update);
    for (const el of document.querySelectorAll("#bar,#readerDock")) size.observe(el);
    for (const el of document.querySelectorAll("#drawer,#scrim,#settings,#orderMenu,.dialog-backdrop,#popover,#selbar,#blockbar,#readerDock")) {
      state.observe(el, {attributes:true, attributeFilter:["class","hidden","open"]});
    }
    state.observe(document.body, {attributes:true, childList:true, attributeFilter:["class"]});
    document.addEventListener("toggle", update, true);
    window.addEventListener("resize", update);
  }
  PR.inlineWebFailed = () => {
    if (failed) return;
    failed = true;
    document.body.classList.remove("web-inline");
    shell().inline(PR.pid, false);
    PR.toast(PR.t("交互网页加载失败"));
    PR.loadWebSnapshot?.();
  };
  PR.syncInlineWeb = () => {
    if (!PR.loadWebSnapshot || !PR.state.paper || !window.easyreadDesktop || window.parent === window || !shell()) return false;
    const meta = PR.state.paper.meta;
    const wanted = !failed && PR.canOpenInteractiveWeb() && document.body.classList.contains("web-native") &&
      (meta.interactive || meta.live_url || meta.interactive_url || detected || PR.ls.get(key(), false));
    const language = PR.readingView() === "both" ? (PR.originalFirst() ? "original-first" : "translation-first") : PR.readingView() !== "original";
    document.body.classList.toggle("web-inline", !!wanted);
    const inline = shell().inline(PR.pid, !!wanted, language);
    if (wanted) watch();
    else if (document.body.classList.contains("web-native")) PR.loadWebSnapshot();
    return inline;
  };
  PR.detectInlineWeb = () => { detected = true; PR.syncInlineWeb(); };
  PR.enableInlineWeb = () => {
    if (!PR.canOpenInteractiveWeb()) return;
    failed = false;
    PR.ls.set(key(), true);
    PR.syncInlineWeb();
  };
  PR.openInteractiveWeb = () => {
    if (PR.canOpenInteractiveWeb()) return shell().open(PR.pid);
  };
})(window.PR);
