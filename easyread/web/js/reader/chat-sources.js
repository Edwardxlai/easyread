/* Pick paper IDs locally. A paper in several categories is selected only once. */
(function (PR) {
  "use strict";
  const dialog = PR.$("#chatSources"), get = selector => dialog.querySelector(selector);
  const paperMode = get('[value="paper"]'), manualMode = get('[value="manual"]');
  const picker = get("[data-picker]"), list = get(".source-list"), all = get("[data-all]");
  const search = get("[data-search]"), count = get("[data-count]"), status = get("[role=status]"), apply = get("[data-apply]");
  const title = item => PR.titles(item).main;
  const categoryName = name => name ? PR.catTree.label(name) : PR.t("未分类");
  const scopeName = scope => !scope ? PR.t("当前论文") : scope.papers ? PR.t("已选 {n} 篇", {n:scope.papers.length}) : scope.category || PR.t("全库查找");
  let items, groups, selected, onApply, loading = false, generation = 0;
  const collapsed = new Set();

  function checkGroup(box, ids) {
    const n = ids.filter(id => selected.has(id)).length;
    box.disabled = !ids.length;
    box.checked = n > 0 && n === ids.length;
    box.indeterminate = n > 0 && n < ids.length;
  }

  function syncSelection() {
    for (const box of list.querySelectorAll("[data-paper]")) box.checked = selected.has(box.value);
    const shown = new Set();
    for (const box of list.querySelectorAll("[data-group]")) {
      const ids = groups.get(box.value);
      checkGroup(box, ids);
      for (const id of ids) shown.add(id);
    }
    checkGroup(all, [...shown]);
    count.textContent = PR.t("已选 {n} 篇", {n:selected.size});
    apply.disabled = manualMode.checked && (!items || !selected.size);
  }

  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    groups = new Map();
    const titles = new Map();
    for (const item of items || []) {
      const name = title(item);
      titles.set(item.id, name);
      const match = [name, item.title_zh, item.title_en].some(t => t?.toLocaleLowerCase().includes(query));
      for (const category of new Set(item.tags?.length ? item.tags : [""])) {
        if (!match && !categoryName(category).toLocaleLowerCase().includes(query) && !category.toLocaleLowerCase().includes(query)) continue;
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(item.id);
      }
    }
    const names = [...groups.keys()].sort((a, b) => !a ? 1 : !b ? -1 : a.localeCompare(b));
    list.innerHTML = names.map((category, i) => {
      const name = PR.esc(categoryName(category)), value = PR.esc(category);
      const expanded = !collapsed.has(category);
      const papers = groups.get(category).map(id => '<label><input type="checkbox" data-paper value="' +
        PR.esc(id) + '"><span>' + PR.esc(titles.get(id)) + '</span></label>').join("");
      return '<div class="source-group"><div class="source-heading"><input type="checkbox" data-group value="' + value +
        '" aria-label="' + name + '"><button type="button" data-fold="' + value + '" aria-expanded="' + expanded +
        '" aria-controls="source-papers-' + i + '">' + PR.icon("chevron", "sm") + name + '</button></div>' +
        '<div class="source-papers" id="source-papers-' + i + '"' + (expanded ? '' : ' hidden') + '>' + papers + '</div></div>';
    }).join("") || (items ? '<p class="hint">' + PR.esc(PR.t("没有符合条件的论文")) + '</p>' : "");
    syncSelection();
  }

  async function showMode() {
    picker.hidden = !manualMode.checked;
    status.textContent = "";
    syncSelection();
    if (picker.hidden || items || loading) return;
    const request = generation;
    loading = true; status.textContent = PR.t("加载中…");
    try {
      const response = await PR.api("/api/library");
      if (request !== generation || !dialog.open) return;
      items = response.items;
      selected = new Set(items.filter(i => selected.has(i.id)).map(i => i.id));
      status.textContent = ""; renderList();
    } catch (error) {
      if (request === generation && manualMode.checked) status.textContent = error.message;
    } finally { if (request === generation) loading = false; }
  }

  function open(scope, change) {
    if (dialog.open) return;
    generation++; onApply = change; items = null; loading = false;
    selected = new Set(scope?.papers || []); collapsed.clear();
    manualMode.checked = Array.isArray(scope?.papers); paperMode.checked = !manualMode.checked;
    search.value = ""; renderList(); dialog.showModal(); showMode();
  }

  function setPapers(ids, checked) {
    for (const id of ids) {
      if (checked) selected.add(id); else selected.delete(id);
    }
    syncSelection();
  }
  list.onchange = event => {
    const box = event.target;
    setPapers(box.hasAttribute("data-group") ? groups.get(box.value) : [box.value], box.checked);
  };
  list.onclick = event => {
    const button = event.target.closest("[data-fold]");
    if (!button) return;
    const name = button.dataset.fold, children = document.getElementById(button.getAttribute("aria-controls"));
    const expand = children.hidden;
    if (expand) collapsed.delete(name); else collapsed.add(name);
    button.setAttribute("aria-expanded", String(expand)); children.hidden = !expand;
  };
  all.onchange = () => setPapers([...groups.values()].flat(), all.checked);
  search.oninput = () => { collapsed.clear(); renderList(); };
  manualMode.onchange = paperMode.onchange = showMode;
  get("[data-cancel]").onclick = () => dialog.close();
  apply.onclick = () => {
    if (apply.disabled) return;
    dialog.close(); onApply(manualMode.checked ? {papers:[...selected]} : null);
  };

  const href = s => "/read/" + encodeURIComponent(s.paper) + "#b-" + encodeURIComponent(s.anchor);
  function body(message) {
    if (!message.sources) return PR.mdBlocks(message.content);
    const html = PR.mdBlocks(message.content, {cite:false, xref:false});
    if (!PR.canChat() || !message.sources.length) return html;
    const node = document.createElement("div");
    node.innerHTML = html;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), leaves = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest("a, code, pre, .katex")) leaves.push(walker.currentNode);
    for (const leaf of leaves) {
      if (!/\[\d+\]/.test(leaf.data)) continue;
      leaf.replaceWith(...leaf.data.split(/(\[\d+\])/).map(part => {
        const match = /^\[(\d+)\]$/.exec(part), src = match && message.sources[Number(match[1]) - 1];
        if (!src) return part;
        const a = document.createElement("a"); a.href = href(src); a.target = "_blank"; a.rel = "noopener"; a.textContent = part;
        return a;
      }));
    }
    return node.innerHTML;
  }
  function references(message) {
    const missing = message.missing?.length ? '<p class="hint">' + PR.esc(PR.t("本次未提供正文：{names}", {names:message.missing.join(" · ")})) + "</p>" : "";
    if (!message.sources?.length) return missing;
    const entries = message.sources.map(s => "<li>" + (PR.canChat() ? '<a href="' + PR.esc(href(s)) + '" target="_blank" rel="noopener">' + PR.esc(s.title) + "</a>" : PR.esc(s.title)) + "<br>" + PR.esc(s.text) + "</li>");
    return '<details class="cm-sources"><summary>' + PR.esc(PR.t("参考原文（{n} 段）", {n:entries.length})) + "</summary><ol>" + entries.join("") + "</ol></details>" + missing;
  }
  PR.chatSources = {open, scopeName, body, references};
})(window.PR);
