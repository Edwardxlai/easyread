/* Two tab groups can share the dock vertically or horizontally. */
(function (PR) {
  "use strict";
  const dock = PR.$("#readerDock"), toggle = PR.$('[data-act="dock"]');
  const names = { pages: "PDF", gallery: PR.t("图表"), notes: PR.t("笔记"), map: PR.t("思维导图"), chat: PR.t("问 AI") };
  const isResource = key => key === "map" || key === "gallery" || key.startsWith("fig:");
  const views = new Map([["pages", PR.$("#pageview")], ["notes", PR.$("#notespanel")], ["chat", PR.$("#chatpanel")]]);
  const MIME = "application/x-easyread-panel", MEDIA = "application/x-easyread-media";
  let current = 0, shown = new Set(), ratio = 50;
  const divider = document.createElement("div");
  divider.className = "dock-divider"; divider.tabIndex = 0;
  divider.setAttribute("role", "separator"); divider.setAttribute("aria-orientation", "horizontal");
  divider.setAttribute("aria-label", PR.t("调整面板高度"));
  const groups = [0, 1].map(index => {
    const el = document.createElement("section");
    el.className = "dock-group"; el.dataset.group = index;
    el.innerHTML = '<div class="dock-head"><div class="dock-tabs"></div><button type="button" class="btn dock-add">' + PR.icon("plus", "sm") + '</button><div class="dock-menu" popover><div class="menu-list"></div></div></div><div class="dock-content"></div>';
    const add = el.querySelector(".dock-add"), menu = el.querySelector(".dock-menu");
    menu.id = "dock-add-menu-" + index;
    add.popoverTargetElement = menu;
    add.setAttribute("aria-controls", menu.id); add.setAttribute("aria-expanded", "false");
    menu.addEventListener("toggle", () => add.setAttribute("aria-expanded", String(menu.matches(":popover-open"))));
    dock.append(el);
    return { el, add, menu, tabs: [], active: null, content: el.lastElementChild };
  });
  dock.insertBefore(divider, groups[1].el);
  PR.side = null;
  PR.dockVisible = key => shown.has(key);
  const owner = key => groups.findIndex(g => g.tabs.includes(key));
  const allowed = key => (key !== "pages" || (PR.feature("pages") && PR.state.paper?.meta?.source_type !== "web")) &&
    (key !== "chat" || (PR.feature("chat") && PR.chatView?.()));
  function title(key) {
    const block = PR.blockById?.[key.slice(4)];
    return key.startsWith("fig:") ? (block ? PR.media.label(block) : PR.t("图表")) : names[key];
  }
  function forget(group, key) {
    const at = group.tabs.indexOf(key);
    if (at < 0) return;
    group.tabs.splice(at, 1);
    if (group.active === key) group.active = group.tabs[Math.min(at, group.tabs.length - 1)] || null;
  }
  function view(key) {
    if (!views.has(key)) {
      const node = document.createElement("section"); node.className = "dock-resource";
      views.set(key, node);
    }
    return views.get(key);
  }
  function draw() {
    const next = new Set(dock.hidden ? [] : groups.map(g => g.active).filter(Boolean));
    if (shown.has("notes") && !next.has("notes")) PR.finishPanelNote?.();
    const previous = shown; shown = next;
    for (const [key, node] of views) node.hidden = !next.has(key);
    groups.forEach(g => {
      g.el.hidden = !g.active;
      if (!g.active) { g.el.querySelector(".dock-tabs").replaceChildren(); return; }
      const node = view(g.active);
      // Keep editors and PDF scrollers mounted when another tab gets focus.
      if (node.parentNode !== g.content) g.content.append(node);
      node.hidden = !next.has(g.active);
      const strip = g.el.querySelector(".dock-tabs");
      strip.replaceChildren(...g.tabs.map(key => {
        const item = document.createElement("div"); item.className = "dock-tab-item";
        const tab = document.createElement("button"); tab.type = "button"; tab.className = "dock-tab";
        tab.draggable = true; tab.dataset.key = key; tab.title = tab.textContent = title(key);
        tab.setAttribute("aria-pressed", String(key === g.active));
        item.classList.toggle("active", key === g.active);
        const close = document.createElement("button"); close.type = "button"; close.className = "dock-tab-close";
        close.dataset.close = key; close.title = PR.t("关闭：{name}", { name: tab.title });
        close.setAttribute("aria-label", close.title); close.innerHTML = PR.icon("x", "sm");
        item.append(tab, close); return item;
      }));
      g.add.title = PR.t("添加标签"); g.add.setAttribute("aria-label", g.add.title);
    });
    divider.hidden = !groups.every(g => g.active);
    dock.classList.toggle("split", !divider.hidden);
    for (const [key, cls] of [["pages","pv-open"],["notes","np-open"],["chat","ch-open"]])
      document.body.classList.toggle(cls, next.has(key));
    PR.side = dock.hidden ? null : groups[current].active;
    toggle.setAttribute("aria-expanded", String(!dock.hidden));
    PR.setSideSpace(!dock.hidden);
    if (next.has("notes") && !previous.has("notes")) PR.renderNotesPanel();
    if (next.has("pages") && !previous.has("pages") && !(PR.$(".pv-scroll .pv-page img")?.getAttribute("src"))) PR.syncPage(true);
    for (const key of next) if (isResource(key)) PR.renderDockResource(key, view(key));
  }
  function place(key, index, before) {
    if (!allowed(key)) return;
    const old = owner(key), dest = groups[index];
    if (old !== index || (before !== undefined && before !== key)) {
      if (old >= 0) forget(groups[old], key);
      const at = before ? dest.tabs.indexOf(before) : -1;
      dest.tabs.splice(at < 0 ? dest.tabs.length : at, 0, key);
    }
    current = index; dest.active = key; dock.hidden = false; draw();
  }
  PR.openSide = key => {
    if (!key) { dock.hidden = true; draw(); return; }
    const index = owner(key);
    place(key, index < 0 ? current : index);
  };
  PR.closeDockTab = key => {
    const i = owner(key);
    if (i < 0) return;
    forget(groups[i], key);
    if (!groups[current].active) current = 1 - current;
    dock.hidden = !groups[current].active; draw();
    if (key.startsWith("fig:")) { views.get(key)?.remove(); views.delete(key); }
  };
  PR.toggleDock = () => {
    if (!dock.hidden) return PR.openSide(null);
    PR.openSide(groups[current].active || (allowed("pages") ? "pages" : "notes"));
  };
  PR.syncDockFeatures = () => {
    for (const key of ["pages", "chat"]) if (!allowed(key) && owner(key) >= 0) PR.closeDockTab(key);
    if (!dock.hidden) draw();
  };
  PR.pinDockFigure = id => { if (PR.media.isMedia(PR.blockById[id])) PR.openSide("fig:" + id); };
  dock.addEventListener("pointerdown", e => {
    const el = e.target.closest(".dock-group");
    if (el) { current = Number(el.dataset.group); PR.side = groups[current].active; }
  });
  function togglePicker(g) {
    if (g.menu.matches(":popover-open")) { g.menu.hidePopover(); return; }
    g.menu.firstElementChild.replaceChildren(...Object.keys(names).filter(allowed).map(key => {
      const b = document.createElement("button"); b.type = "button"; b.dataset.open = key;
      const label = document.createElement("span"); label.textContent = title(key); b.append(label);
      if (owner(key) >= 0) b.insertAdjacentHTML("beforeend", PR.icon("check", "sm"));
      return b;
    }));
    if (g.tabs.length > 1 || !divider.hidden) {
      for (const [axis, label] of [["columns", PR.t("左右分栏")], ["rows", PR.t("上下分栏")]]) {
        const b = document.createElement("button"); b.type = "button";
        b.dataset.split = axis; b.textContent = label;
        g.menu.firstElementChild.append(b);
      }
    }
    g.menu.showPopover({ source: g.add });
    const r = g.add.getBoundingClientRect(), m = g.menu.getBoundingClientRect();
    g.menu.style.left = Math.max(6, Math.min(r.left, innerWidth - m.width - 6)) + "px";
    g.menu.style.top = (r.bottom + m.height + 6 <= innerHeight ? r.bottom + 4 : Math.max(6, r.top - m.height - 4)) + "px";
    g.menu.querySelector("button").focus({ preventScroll: true });
  }
  dock.addEventListener("click", e => {
    const group = e.target.closest(".dock-group"); if (!group) return;
    const index = Number(group.dataset.group), g = groups[index];
    if (e.target.closest(".dock-add")) { e.preventDefault(); return togglePicker(g); }
    const split = e.target.closest("[data-split]");
    if (split && g.menu.contains(split)) {
      g.menu.hidePopover();
      setDirection(split.dataset.split === "columns");
      if (divider.hidden) place(g.active, 1 - index);
      divider.focus(); return;
    }
    const choice = e.target.closest("[data-open]");
    if (choice && g.menu.contains(choice)) {
      const key = choice.dataset.open; g.menu.hidePopover(); current = index;
      if (key === "chat") PR.toggleChat(true); else PR.openSide(key);
      groups[owner(key)]?.el.querySelector('.dock-tab[aria-pressed="true"]')?.focus(); return;
    }
    const close = e.target.closest("[data-close]");
    if (close) {
      PR.closeDockTab(close.dataset.close);
      (dock.hidden ? toggle : groups[current].el.querySelector('.dock-tab[aria-pressed="true"]')).focus(); return;
    }
    const tab = e.target.closest("[data-key]");
    if (tab) { place(tab.dataset.key, index); g.el.querySelector('.dock-tab[aria-pressed="true"]').focus(); }
  });
  dock.addEventListener("dragstart", e => {
    const tab = e.target.closest("[data-key]"); if (!tab) return;
    e.dataTransfer.setData(MIME, tab.dataset.key); e.dataTransfer.effectAllowed = "move";
    dock.classList.add("dragging");
  });
  function dropTarget(e) {
    const el = e.target.closest(".dock-group");
    if (!el) return null;
    const tabDrag = e.dataTransfer.types.includes(MIME), media = e.dataTransfer.types.includes(MEDIA);
    if (!tabDrag && (!media || e.target.closest(".card[data-note], .ProseMirror, textarea"))) return null;
    const index = Number(el.dataset.group), g = groups[index];
    const item = e.target.closest(".dock-tab-item");
    if (e.target.closest(".dock-head")) {
      let before = null;
      if (item) {
        const r = item.getBoundingClientRect();
        const next = e.clientX < r.left + r.width / 2 ? item : item.nextElementSibling;
        before = next?.querySelector("[data-key]").dataset.key || null;
      }
      return { el, index, before };
    }
    const r = el.getBoundingClientRect();
    const canSplit = !groups[1 - index].active && (!tabDrag || g.tabs.length > 1);
    if (!canSplit) return { el, index };
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const lateral = y > .32 && y < .68 && (x < .25 || x > .75);
    const edge = lateral ? (x < .5 ? "left" : "right") : (y < .5 ? "top" : "bottom");
    return { el, index, edge };
  }
  function clearCue() { groups.forEach(g => g.el.removeAttribute("data-drop")); }
  dock.addEventListener("dragover", e => {
    if (![MIME, MEDIA].some(type => e.dataTransfer.types.includes(type))) return;
    clearCue(); const target = dropTarget(e); if (!target) return;
    e.preventDefault(); e.stopPropagation(); target.el.dataset.drop = target.edge || "tab";
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(MIME) ? "move" : "copy";
  }, true);
  function finishDrag() { dock.classList.remove("dragging"); clearCue(); }
  dock.addEventListener("dragleave", e => { if (!dock.contains(e.relatedTarget)) clearCue(); });
  document.addEventListener("dragend", finishDrag);
  dock.addEventListener("drop", e => {
    const target = dropTarget(e); finishDrag(); if (!target) return;
    let key = e.dataTransfer.getData(MIME);
    if (!key) {
      try {
        const ref = JSON.parse(e.dataTransfer.getData(MEDIA));
        if (ref.paper !== PR.paperKey || !PR.media.isMedia(PR.blockById[ref.id])) return;
        key = "fig:" + ref.id;
      } catch { return; }
    } else if (owner(key) < 0) return;
    e.preventDefault(); e.stopPropagation();
    if (target.edge && (owner(key) !== target.index || groups[target.index].tabs.length > 1)) {
      setDirection(target.edge === "left" || target.edge === "right");
      const empty = 1 - target.index;
      if ((target.edge === "top" || target.edge === "left") !== (empty === 0)) {
        [groups[0].tabs, groups[1].tabs] = [groups[1].tabs, groups[0].tabs];
        [groups[0].active, groups[1].active] = [groups[1].active, groups[0].active];
        place(key, target.index);
      } else place(key, empty);
    } else place(key, target.index, target.before);
  }, true);
  function resize(value) {
    ratio = Math.max(20, Math.min(80, value)); dock.style.setProperty("--dock-first", ratio + "%");
    divider.setAttribute("aria-valuenow", String(Math.round(ratio)));
  }
  function setDirection(columns) {
    dock.classList.toggle("columns", columns);
    divider.setAttribute("aria-orientation", columns ? "vertical" : "horizontal");
    divider.setAttribute("aria-label", columns ? PR.t("调整面板宽度") : PR.t("调整面板高度"));
    resize(50);
  }
  resize(ratio);
  divider.addEventListener("pointerdown", e => { divider.setPointerCapture(e.pointerId); e.preventDefault(); });
  divider.addEventListener("pointermove", e => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    const rect = dock.getBoundingClientRect();
    resize(100 * (dock.classList.contains("columns") ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height));
  });
  divider.addEventListener("keydown", e => {
    const keys = dock.classList.contains("columns") ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (!keys.includes(e.key)) return;
    e.preventDefault(); resize(ratio + (e.key === keys[1] ? 5 : -5));
  });
  PR.refreshDockResource = () => {
    for (const key of shown) if (isResource(key)) PR.renderDockResource(key, view(key));
  };
  for (const node of views.values()) node.hidden = true;
})(window.PR);
