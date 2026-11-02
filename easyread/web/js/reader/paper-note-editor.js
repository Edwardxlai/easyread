/* 论文笔记：Tiptap 官方工具栏与双向定位的 Markmap。 */
(function (PR) {
  "use strict";
  const panel = PR.$("#notespanel"), libraries = PR.noteLibraries;
  let rich = null, map = null, observer = null, richSource = "", formula = null, unmountToolbar = null;
  let mode = "rich", split = PR.ls.get("easyread-note-split", 58), firstMap = true;
  let mapBody = null, selectingFromMap = false;
  let mapVisible = PR.ls.get("easyread-note-map-visible", true);
  let expanded = false, layout = PR.ls.get("easyread-note-layout", "side"), focus = "both";
  const wide = window.matchMedia("(min-width: 900px)");
  const horizontal = () => expanded && layout === "side" && wide.matches;
  const workspace = () => panel.querySelector(".pn-workspace");
  const label = text => PR.esc(text);

  function setMode(next) {
    mode = next;
    const el = workspace(), body = PR.$("#paperNote").value;
    if (mode !== "source" && body !== richSource) {
      richSource = body;
      rich.commands.setContent(body, { contentType: "markdown", emitUpdate: false });
    }
    el.querySelector(".pn-rich-pane").hidden = mode !== "rich";
    el.querySelector(".pn-format").hidden = mode !== "rich";
    el.querySelector(".pn-source").hidden = mode !== "source";
    el.querySelector(".pn-formula").hidden = true;
    el.querySelectorAll("[data-note-mode]").forEach(button => {
      button.classList.toggle("on", button.dataset.noteMode === mode);
      button.setAttribute("aria-pressed", String(button.dataset.noteMode === mode));
    });
  }

  function setSplit(value) {
    split = Math.max(25, Math.min(80, value));
    workspace().style.setProperty("--note-split", split + "%");
    workspace().querySelector(".pn-divider").setAttribute("aria-valuenow", String(Math.round(split)));
  }

  function setLayout() {
    const el = workspace();
    if (!el) return;
    panel.classList.toggle("pn-expanded", expanded);
    el.classList.toggle("pn-side", horizontal());
    el.classList.toggle("pn-map-only", expanded && focus === "map");
    el.querySelector(".pn-writing").hidden = expanded && focus === "map";
    const displayBar = panel.querySelector(".pn-display-bar");
    const expandButton = panel.querySelector("[data-note-expand]");
    displayBar.hidden = !expanded;
    panel.querySelector(".pn-view-controls").hidden = !expanded;
    (expanded ? displayBar : el.querySelector(".pn-writing > .pn-bar")).appendChild(expandButton);
    const expandLabel = expanded ? PR.t("退出全屏") : PR.t("全屏工作区");
    expandButton.setAttribute("aria-pressed", String(expanded));
    expandButton.setAttribute("aria-label", expandLabel);
    expandButton.title = expandLabel;
    expandButton.querySelector("span").textContent = expandLabel;
    expandButton.querySelector("span").hidden = !expanded;
    panel.querySelectorAll("[data-note-layout]").forEach(button => {
      button.classList.toggle("on", button.dataset.noteLayout === layout);
      button.setAttribute("aria-pressed", String(button.dataset.noteLayout === layout));
    });
    panel.querySelectorAll("[data-note-focus]").forEach(button => {
      button.classList.toggle("on", button.dataset.noteFocus === focus);
      button.setAttribute("aria-pressed", String(button.dataset.noteFocus === focus));
    });
    const divider = el.querySelector(".pn-divider");
    divider.setAttribute("aria-orientation", horizontal() ? "vertical" : "horizontal");
    const hint = horizontal() ? PR.t("调整笔记与思维导图的宽度") : PR.t("调整笔记与思维导图的高度");
    divider.setAttribute("aria-label", hint); divider.title = hint;
    setMapVisible(mapVisible);
  }
  wide.addEventListener("change", setLayout);

  function setMapVisible(visible) {
    mapVisible = visible;
    visible = expanded ? focus !== "note" : visible;
    const el = workspace(), button = el.querySelector("[data-note-map-toggle]");
    el.classList.toggle("pn-map-hidden", !visible);
    el.querySelector(".pn-divider").hidden = !visible || (expanded && focus === "map");
    el.querySelector(".pn-mindmap").hidden = !visible;
    button.setAttribute("aria-expanded", String(visible));
    button.setAttribute("aria-pressed", String(visible));
    button.classList.toggle("on", visible);
    const action = visible ? PR.t("隐藏思维导图") : PR.t("显示思维导图");
    button.title = action;
    button.setAttribute("aria-label", action);
    if (visible && map) updateMap();
  }

  async function revealSelection() {
    if (workspace().querySelector(".pn-mindmap").hidden || !map || !rich || rich.view.composing || !rich.isFocused || mode !== "rich" || selectingFromMap || PR.$("#paperNote").value !== mapBody) return;
    const current = map, match = libraries.findMapNode(current.state.data, rich.state.selection.from);
    if (!match) return;
    for (const ancestor of match.ancestors) if (ancestor.payload?.fold) await current.toggleNode(ancestor);
    if (current !== map) return;
    await current.setHighlight(match.node);
    if (current === map) await current.ensureVisible(match.node);
  }

  async function updateMap() {
    if (!rich || !map || workspace().querySelector(".pn-mindmap").hidden || rich.view.composing) return;
    const body = PR.$("#paperNote").value, current = map;
    const doc = body === richSource ? rich.getJSON() : rich.markdown.parse(body);
    const meta = PR.state.paper.meta || {};
    const root = libraries.toMindMap(doc, meta.short_zh || meta.title_zh || meta.title_en || PR.t("论文笔记"));
    const empty = !body.trim();
    workspace().querySelector(".pn-map-empty").hidden = !empty;
    await current.setData(root);
    if (current !== map || workspace().querySelector(".pn-mindmap").hidden) return;
    mapBody = body;
    if (firstMap && !empty) { firstMap = false; await current.fit(); }
    if (empty) firstMap = true;
    if (rich.isFocused) revealSelection();
  }
  const updateSoon = PR.debounce(updateMap, 120);

  async function exportMap() {
    updateSoon.cancel();
    await updateMap();
    await document.fonts.ready;
    const svg = map.svg.node(), copy = svg.cloneNode(true), fonts = new Set();
    const properties = "color display font-family font-size font-style font-weight line-height letter-spacing text-align text-decoration white-space vertical-align position top right bottom left width height min-width max-width box-sizing margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left border-top border-right border-bottom border-left border-radius background-color fill fill-opacity stroke stroke-width stroke-opacity stroke-dasharray stroke-linecap stroke-linejoin opacity overflow object-fit object-position".split(" ");
    const originals = [svg, ...svg.querySelectorAll("*")], copies = [copy, ...copy.querySelectorAll("*")];
    originals.forEach((node, i) => {
      const style = getComputedStyle(node), target = copies[i];
      for (const property of properties) target.style.setProperty(property, style.getPropertyValue(property));
      if (node.namespaceURI === "http://www.w3.org/1999/xhtml") {
        target.style.transform = style.transform;
        target.style.transformOrigin = style.transformOrigin;
      }
      style.fontFamily.split(",").forEach(name => fonts.add(name.trim().replace(/["']/g, "")));
    });
    const fontRules = [];
    for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
      if (rule.type !== CSSRule.FONT_FACE_RULE || !fonts.has(rule.style.fontFamily.replace(/["']/g, ""))) continue;
      const source = rule.style.getPropertyValue("src").match(/url\((["']?)(.*?)\1\)/);
      if (!source) continue;
      const response = await fetch(new URL(source[2], sheet.href || document.baseURI));
      const blob = await response.blob();
      const data = await new Promise(resolve => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob);
      });
      fontRules.push('@font-face{font-family:' + rule.style.fontFamily + ';font-style:' + rule.style.fontStyle + ';font-weight:' + rule.style.fontWeight + ';src:url("' + data + '")}');
    }
    copy.querySelectorAll("style, .markmap-highlight").forEach(node => node.remove());
    const ns = "http://www.w3.org/2000/svg", group = copy.querySelector("g");
    group.removeAttribute("transform");
    const bounds = map.g.node().getBBox(), padding = 20;
    const width = Math.ceil(bounds.width + padding * 2), height = Math.ceil(bounds.height + padding * 2);
    const x = bounds.x - padding, y = bounds.y - padding;
    copy.setAttribute("xmlns", ns);
    copy.setAttribute("viewBox", [x, y, width, height].join(" "));
    copy.setAttribute("width", width); copy.setAttribute("height", height);
    copy.style.width = width + "px"; copy.style.height = height + "px";
    if (fontRules.length) {
      const style = document.createElementNS(ns, "style"); style.textContent = fontRules.join("\n"); copy.prepend(style);
    }
    const background = document.createElementNS(ns, "rect");
    for (const [key, value] of Object.entries({ x, y, width, height, fill: getComputedStyle(workspace().querySelector(".pn-mindmap")).backgroundColor })) background.setAttribute(key, value);
    copy.insertBefore(background, group);
    const meta = PR.state.paper.meta || {}, stem = (meta.short_zh || meta.title_zh || meta.title_en || PR.t("论文笔记")).replace(/[\\/:*?"<>|]/g, "");
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml;charset=utf-8" }));
    const link = PR.el("a", { href: url, download: stem + PR.t("-思维导图.svg") });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function selectNote(node) {
    const range = node.payload;
    if (range?.from == null) return;
    selectingFromMap = true;
    if (expanded && focus === "map") { focus = "both"; setLayout(); }
    setMode("rich");
    const source = rich.state.doc.nodeAt(range.from);
    if (source?.isAtom || source?.type.name === "table") rich.chain().focus().setNodeSelection(range.from).scrollIntoView().run();
    else rich.chain().focus().setTextSelection({ from: range.from + 1, to: range.to - 1 }).scrollIntoView().run();
    selectingFromMap = false;
    map.setHighlight(node);
  }

  function openFormula(latex = "", pos = null, display = false) {
    formula = { pos, display };
    const form = workspace().querySelector(".pn-formula");
    form.hidden = false;
    form.querySelector("[data-note-latex]").value = latex;
    const type = form.querySelector("[data-note-display]");
    type.checked = display; type.disabled = pos != null;
    form.querySelector("[data-note-latex]").focus();
  }

  PR.paperNoteEditor = {
    html(body) {
      const modes = [["rich", PR.t("预览")], ["source", "Markdown"]];
      return '<div class="pn-display-bar"><div class="pn-view-controls" hidden><div class="seg" role="group" aria-label="' + label(PR.t("工作区布局")) + '">' + [["side", PR.t("左右")], ["stack", PR.t("上下")]].map(([key, text]) => '<button data-note-layout="' + key + '">' + text + '</button>').join("") + '</div><div class="seg" role="group" aria-label="' + label(PR.t("显示内容")) + '">' + [["both", PR.t("笔记与导图")], ["note", PR.t("仅笔记")], ["map", PR.t("仅导图")]].map(([key, text]) => '<button data-note-focus="' + key + '">' + text + '</button>').join("") + '</div></div><button class="btn sm" data-note-expand aria-pressed="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg><span>' + PR.t("全屏工作区") + '</span></button></div><div class="pn-workspace"><section class="pn-writing" aria-label="' + label(PR.t("论文笔记编辑器")) + '">' +
        '<div class="pn-bar"><div class="seg" role="group" aria-label="' + label(PR.t("笔记显示方式")) + '">' + modes.map(([key, text]) => '<button data-note-mode="' + key + '">' + text + '</button>').join("") + '</div><span class="grow"></span><button class="btn sm" data-note-map-toggle aria-controls="pnMindmap">Markmap</button></div>' +
        '<div class="pn-format"></div>' +
        '<form class="pn-formula" hidden><input class="input" data-note-latex aria-label="' + label(PR.t("LaTeX 公式")) + '" placeholder="E = mc^2"><label><input type="checkbox" data-note-display> ' + PR.t("独立公式") + '</label><button class="btn sm accent" type="submit">' + PR.t("应用") + '</button><button class="btn sm" type="button" data-note-math-cancel>' + PR.t("取消") + '</button></form>' +
        '<div class="pn-content"><div class="pn-rich-pane"><div class="pn-rich"></div></div><div class="pn-source" hidden><textarea id="paperNote" spellcheck="false" aria-label="' + label(PR.t("论文笔记 Markdown")) + '">' + PR.esc(body) + '</textarea></div></div></section>' +
        '<div class="pn-divider" role="separator" tabindex="0" aria-label="' + label(PR.t("调整笔记与思维导图的高度")) + '" aria-orientation="horizontal" aria-valuemin="25" aria-valuemax="80" aria-controls="pnMindmap" title="' + label(PR.t("拖动调整高度，方向键微调，双击恢复")) + '"></div>' +
        '<section id="pnMindmap" class="pn-mindmap" aria-label="' + label(PR.t("思维导图")) + '"><div class="pn-bar"><b>Markmap</b><span class="pn-sync">' + PR.t("随笔记同步") + '</span><span class="grow"></span><button class="btn sm" data-note-map-export title="' + label(PR.t("导出 SVG")) + '">' + PR.t("导出") + '</button><button class="btn sm" data-note-zoom="fit">' + PR.t("适合窗口") + '</button><button class="btn sm" data-note-zoom="out" aria-label="' + label(PR.t("缩小思维导图")) + '">−</button><button class="btn sm" data-note-zoom="in" aria-label="' + label(PR.t("放大思维导图")) + '">+</button></div>' +
        '<div class="pn-map"><svg class="pn-map-svg" role="img" tabindex="0" aria-label="' + label(PR.t("思维导图：拖动平移、滚轮缩放，点击圆点展开或收起")) + '"></svg><p class="pn-map-empty">' + PR.t("写下笔记，思维导图会自动出现在这里。") + '</p></div></section></div>';
    },
    mount(body) {
      richSource = body; firstMap = true; mapBody = null;
      workspace().style.setProperty("--note-zoom", PR.ls.get("easyread-note-zoom", 100) / 100);
      rich = libraries.createEditor({
        element: workspace().querySelector(".pn-rich"), content: body,
        onChange(text) {
          richSource = text;
          const ta = PR.$("#paperNote"); ta.value = text;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        },
        onSelection: revealSelection,
        onMathClick: (node, pos, display) => openFormula(node.attrs.latex, pos, display),
      });
      unmountToolbar = libraries.mountNoteToolbar(workspace().querySelector(".pn-format"), rich, () => openFormula());
      map = libraries.Markmap.create(workspace().querySelector("svg"), { duration: 0, maxWidth: 220, paddingX: 10, spacingVertical: 8 });
      setMode(mode); setSplit(split); setLayout();
      observer = new ResizeObserver(() => { if (!workspace().querySelector(".pn-mindmap").hidden && map && !firstMap) map.fit(); });
      observer.observe(workspace().querySelector(".pn-map"));
    },
    destroy() {
      expanded = false; panel.classList.remove("pn-expanded");
      updateSoon.cancel(); observer?.disconnect(); observer = null;
      if (unmountToolbar) { unmountToolbar(); unmountToolbar = null; }
      if (map) { map.destroy(); map = null; }
      if (rich) { rich.destroy(); rich = null; }
    },
    insertSources(parts) {
      setMode("rich");
      const content = [];
      for (const part of parts) {
        const block = PR.blockById[part.anchor];
        if (!block) continue;
        const title = PR.t("第 {page} 页", { page: block.page || 1 });
        content.push({ type: "blockquote", content: [{ type: "paragraph", content: [
          { type: "text", text: part.quote + " " },
          { type: "text", text: title, marks: [{ type: "link", attrs: { href: "#b-" + part.anchor } }] },
        ] }] });
      }
      if (!content.length) return;
      content.push({ type: "paragraph" });
      rich.chain().focus().insertContentAt(rich.state.selection.from, content).scrollIntoView().run();
      PR.finishPanelNote();
    },
    revealSource(anchor, index = 0) {
      expanded = false; setLayout(); setMode("rich");
      const ranges = [];
      rich.state.doc.descendants((node, pos) => {
        if (!node.isText || !node.marks.some(mark => mark.type.name === "link" && mark.attrs.href === "#b-" + anchor)) return;
        const last = ranges[ranges.length - 1];
        if (last && last.to === pos) last.to += node.nodeSize;
        else ranges.push({ from: pos, to: pos + node.nodeSize });
      });
      if (!ranges.length) return;
      rich.chain().focus().setTextSelection(ranges[index % ranges.length]).scrollIntoView().run();
    },
    getBody: () => rich ? PR.$("#paperNote").value : null,
    update: updateSoon,
  };

  panel.addEventListener("submit", e => {
    if (!e.target.matches(".pn-formula")) return;
    e.preventDefault();
    const latex = e.target.querySelector("[data-note-latex]").value.trim();
    if (!latex) return;
    const display = e.target.querySelector("[data-note-display]").checked, chain = rich.chain().focus();
    if (formula.pos != null) {
      if (display) chain.updateBlockMath({ latex, pos: formula.pos });
      else chain.updateInlineMath({ latex, pos: formula.pos });
    } else if (display) chain.insertBlockMath({ latex });
    else chain.insertInlineMath({ latex });
    chain.run(); e.target.hidden = true;
  });
  panel.addEventListener("click", e => {
    const source = e.target.closest('a[href^="#b-"]');
    if (source) {
      const id = source.getAttribute("href").slice(3);
      if (!PR.blockById[id]) return;
      e.preventDefault(); e.stopPropagation();
      expanded = false; setLayout();
      PR.jumpTo("b-" + id, { instant: true });
      return;
    }
    if (e.target.closest("[data-note-expand]")) { expanded = !expanded; setLayout(); return; }
    const layoutButton = e.target.closest("[data-note-layout]");
    if (layoutButton) { layout = layoutButton.dataset.noteLayout; PR.ls.set("easyread-note-layout", layout); setLayout(); return; }
    const focusButton = e.target.closest("[data-note-focus]");
    if (focusButton) { focus = focusButton.dataset.noteFocus; setLayout(); return; }
    if (e.target.closest("[data-note-map-export]")) { exportMap(); return; }
    if (e.target.closest("[data-note-map-toggle]")) {
      if (expanded) { focus = focus === "note" ? "both" : "note"; setLayout(); return; }
      setMapVisible(!mapVisible);
      PR.ls.set("easyread-note-map-visible", mapVisible);
      return;
    }
    if (e.target.closest(".pn-prose")) { revealSelection(); return; }
    if (e.target.closest("[data-note-math-cancel]")) { workspace().querySelector(".pn-formula").hidden = true; rich.commands.focus(); return; }
    const node = e.target.closest(".markmap-node");
    if (node && !e.target.closest("circle")) { selectNote(map.svg.select(() => node).datum()); return; }
    const modeButton = e.target.closest("[data-note-mode]");
    if (modeButton) { setMode(modeButton.dataset.noteMode); return; }
    const zoomButton = e.target.closest("[data-note-zoom]");
    if (zoomButton && map) {
      if (zoomButton.dataset.noteZoom === "fit") map.fit();
      else map.rescale(zoomButton.dataset.noteZoom === "in" ? 1.25 : 0.8);
    }
  });
  panel.addEventListener("keydown", e => {
    if (e.key === "Escape" && expanded && !e.isComposing && !e.defaultPrevented) {
      e.preventDefault(); e.stopPropagation(); expanded = false; setLayout();
      panel.querySelector("[data-note-expand]").focus(); return;
    }
    if (e.target.matches(".pn-map-svg")) {
      if (["+", "=", "-", "0"].includes(e.key) && map) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === "0") map.fit(); else map.rescale(e.key === "-" ? 0.8 : 1.25);
      }
      return;
    }
    if (!e.target.matches(".pn-divider")) return;
    const next = { [horizontal() ? "ArrowLeft" : "ArrowUp"]: split - 5, [horizontal() ? "ArrowRight" : "ArrowDown"]: split + 5, Home: 25, End: 80 }[e.key];
    if (next == null) return;
    e.preventDefault(); e.stopPropagation(); setSplit(next); PR.ls.set("easyread-note-split", split);
  });
  panel.addEventListener("dblclick", e => { if (e.target.matches(".pn-divider")) { setSplit(58); PR.ls.set("easyread-note-split", split); } });
  panel.addEventListener("pointerdown", e => {
    if (!e.target.matches(".pn-divider") || e.button !== 0) return;
    e.preventDefault();
    const grip = e.target, el = workspace(), rect = el.getBoundingClientRect();
    grip.focus(); grip.setPointerCapture(e.pointerId); el.classList.add("pn-resizing");
    const move = ev => setSplit(horizontal() ? (ev.clientX - rect.left) / rect.width * 100 : (ev.clientY - rect.top) / rect.height * 100);
    const stop = () => {
      grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", stop); grip.removeEventListener("pointercancel", stop);
      el.classList.remove("pn-resizing"); PR.ls.set("easyread-note-split", split);
    };
    grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", stop); grip.addEventListener("pointercancel", stop);
  });
})(window.PR);
