/* Existing library and reader pages stay mounted per tab. */
(() => {
  "use strict";
  const tabs = new Map();
  const strip = document.querySelector("#tabs");
  let active = "library";
  const t = text => window.PR?.t(text) || text;
  function syncTheme(tab) {
    const theme = tab.frame.contentDocument?.documentElement.dataset.theme;
    if (active === tab.id && theme) document.documentElement.dataset.theme = theme;
  }
  function notify(text) {
    const el = document.querySelector("#message");
    el.textContent = text; el.hidden = false;
    clearTimeout(notify.timer); notify.timer = setTimeout(() => { el.hidden = true; }, 5000);
  }
  function select(id) {
    if (!tabs.has(id)) return;
    const previous = tabs.get(active);
    if (previous && active !== id) previous.frame.contentWindow.PR?.captureProgress?.();
    active = id;
    for (const [key, tab] of tabs) {
      const selected = key === id;
      tab.node.classList.toggle("active", selected);
      tab.button.setAttribute("aria-selected", String(selected));
      tab.button.tabIndex = selected ? 0 : -1;
      tab.frame.classList.toggle("inactive", !selected);
      tab.frame.setAttribute("aria-hidden", String(!selected));
      tab.frame.inert = !selected;
    }
    const tab = tabs.get(id);
    syncTheme(tab);
    document.title = tab.button.textContent + " · EasyRead";
    tab.node.scrollIntoView({ block: "nearest", inline: "nearest" });
    tab.frame.contentWindow.focus();
  }
  async function save(tab) {
    const pr = tab.frame.contentWindow.PR;
    pr?.finishPanelNote?.();
    pr?.autosaveNote?.flush();
    await pr?.flushPrefs?.();
    return await pr?.flushProgress?.() !== false;
  }
  async function close(id) {
    const tab = tabs.get(id);
    if (!tab || id === "library" || tab.closing) return;
    tab.closing = true;
    try {
      if (!await save(tab)) throw new Error("save failed");
      const ids = [...tabs.keys()], index = ids.indexOf(id);
      if (active === id) select(ids[index - 1] || "library");
      tab.observer?.disconnect(); tab.themeObserver?.disconnect();
      tab.frame.remove(); tab.node.remove(); tabs.delete(id);
    } catch (_) { notify(t("尚未保存成功，请保持标签打开，稍后重试")); }
    finally { tab.closing = false; }
  }
  function keyboard(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "Tab") {
      e.preventDefault(); e.stopImmediatePropagation();
      const ids = [...tabs.keys()], step = e.shiftKey ? -1 : 1;
      select(ids[(ids.indexOf(active) + step + ids.length) % ids.length]);
    } else if (e.key.toLowerCase() === "w") {
      e.preventDefault(); e.stopImmediatePropagation(); void close(active);
    }
  }
  async function open(raw) {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin) return;
    if (url.pathname === "/open") {
      try {
        const response = await fetch(url.href);
        if (!response.ok) throw new Error(t("没有这篇论文"));
        const target = new URL(response.url);
        const block = url.searchParams.get("block");
        if (block) target.hash = block;
        return open(target.href);
      } catch (error) { notify(error.message); return; }
    }
    const match = url.pathname.match(/^\/read\/([a-zA-Z0-9_-]+)$/);
    if (url.origin !== location.origin || !match) return;
    const id = match[1];
    const existing = tabs.has(id);
    if (!existing) create(id, url.href, t("正在打开…"));
    select(id);
    if (!existing) return;
    const frame = tabs.get(id).frame, win = frame.contentWindow;
    if (url.searchParams.has("cite_from") || url.searchParams.has("cite_return")) {
      if (!win.PR?.state?.paper) { frame.src = url.href; return; }
      win.history.replaceState(win.history.state, "", url.href);
      win.PR.citationNav.setup();
      if (url.searchParams.has("cite_return")) win.PR.citationNav.restore();
      else if (url.hash) win.PR.jumpTo(decodeURIComponent(url.hash.slice(1)), { noBack: true, instant: true });
    } else if (url.hash) {
      win.location.hash = url.hash;
      if (win.PR?.jumpTo) requestAnimationFrame(() => win.PR.jumpTo(url.hash.slice(1), { instant: true }));
    }
  }
  function bind(tab) {
    const win = tab.frame.contentWindow, doc = win.document;
    if (win.PR?.lib) win.PR.lib.openReader = id => open("/read/" + encodeURIComponent(id));
    if (win.PR?.citationNav) win.PR.openPaperTab = open;
    doc.addEventListener("click", e => {
      const link = e.target.closest("a[href]");
      if (!link || link.matches("[data-cite-paper], [data-cite-passage]")) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin) return;
      if (url.hash && url.pathname === win.location.pathname && url.search === win.location.search) return;
      if (url.pathname.startsWith("/read/")) {
        e.preventDefault(); e.stopImmediatePropagation(); open(url.href);
      } else if (url.pathname === "/" || url.pathname === "/index.html") {
        e.preventDefault(); e.stopImmediatePropagation(); select("library");
      }
    }, true);
    doc.addEventListener("keydown", keyboard, true);
    const updateTitle = () => {
      const title = tab.id === "library" ? t("文献库") : (doc.title.replace(/\s*[·|–-]\s*EasyRead.*$/i, "") || t("论文"));
      tab.button.textContent = title; tab.button.title = title;
      tab.frame.title = title;
      if (active === tab.id) document.title = title + " · EasyRead";
    };
    tab.observer?.disconnect();
    tab.observer = new MutationObserver(updateTitle);
    tab.observer.observe(doc.querySelector("title") || doc.head, { childList: true, subtree: true, characterData: true });
    tab.themeObserver?.disconnect();
    tab.themeObserver = new MutationObserver(() => syncTheme(tab));
    tab.themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    syncTheme(tab);
    updateTitle();
  }
  function create(id, url, title) {
    const node = document.createElement("div"); node.className = "paper-tab";
    const button = document.createElement("button"); button.className = "tab-title";
    button.setAttribute("role", "tab"); button.id = "tab-" + id;
    button.textContent = title; button.onclick = () => select(id); node.append(button);
    const frame = document.createElement("iframe"); frame.className = "paper-pane inactive";
    frame.id = "pane-" + id; frame.title = title;
    button.setAttribute("aria-controls", frame.id);
    const tab = { id, node, button, frame }; tabs.set(id, tab);
    if (id !== "library") {
      const x = document.createElement("button"); x.className = "tab-close";
      x.textContent = "×"; x.setAttribute("aria-label", t("关闭论文"));
      x.onclick = () => void close(id); node.append(x);
      node.addEventListener("auxclick", e => { if (e.button === 1) { e.preventDefault(); void close(id); } });
    }
    button.addEventListener("keydown", e => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const ids = [...tabs.keys()], pos = ids.indexOf(id);
      const next = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : (pos + (e.key === "ArrowLeft" ? -1 : 1) + ids.length) % ids.length;
      select(ids[next]); tabs.get(ids[next]).button.focus();
    });
    frame.addEventListener("load", () => bind(tab));
    frame.src = url; strip.append(node); document.querySelector("#panes").append(frame);
  }
  document.addEventListener("keydown", keyboard, true);
  document.querySelector("#newTab").onclick = () => select("library");
  window.easyreadTabs = { open, select, close, saveAll: () => Promise.all([...tabs.values()].map(save)), keyboard };
  window.easyreadDesktop?.onBeforeQuit(() => window.easyreadTabs.saveAll());
  create("library", "/", t("文献库")); select("library");
  const initial = new URLSearchParams(location.search).get("open");
  if (initial) void open(initial);
})();
