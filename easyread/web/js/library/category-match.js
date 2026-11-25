/* Review one filing rule against selected papers. Only the confirmation writes memberships. */
(function (PR) {
  "use strict";
  const L = PR.lib, dialog = PR.$("#categoryMatch");
  const el = selector => dialog.querySelector(selector);
  const setup = el("[data-setup]"), rule = el("textarea"), scope = el("[data-scope]");
  const target = el("#categoryTarget");
  const results = el("[data-results]"), status = el("[role=status]");
  const run = el("[data-run]"), apply = el("[data-apply]"), all = el("[data-all]");
  const checked = area => [...area.querySelectorAll("input:checked")];
  const post = (id, action, body) => PR.api("/api/p/" + encodeURIComponent(id) + "/" + action, {method: "POST", body});
  let session;

  function choice(id, title, selected) {
    const label = document.createElement("label"), box = document.createElement("input");
    box.type = "checkbox"; box.value = id; box.checked = selected;
    label.append(box, document.createTextNode(title));
    return label;
  }

  function updateScope() {
    const n = checked(scope).length;
    all.checked = n > 0 && n === scope.children.length;
    all.indeterminate = n > 0 && n < scope.children.length;
    run.disabled = !n || !rule.value.trim();
    run.textContent = PR.t("分析 {n} 篇论文", {n});
  }
  all.onchange = () => {
    for (const box of scope.querySelectorAll("input")) box.checked = all.checked;
    updateScope();
  };
  scope.onchange = rule.oninput = updateScope;
  results.onchange = () => { apply.disabled = !checked(results).length || session?.busy; };
  target.onchange = () => {
    const category = target.value;
    session.category = category;
    scope.replaceChildren();
    for (const item of L.items) {
      if (category && item.ai_indexed !== false && !L.inCat(item, category)) {
        scope.append(choice(item.id, PR.titles(item).main || item.id, true));
      }
    }
    status.textContent = !category || scope.children.length ? "" : PR.t("没有待分析的论文");
    updateScope();
  };
  L.openCategoryMatch = () => {
    const cats = L.cats();
    if (!cats.length || L.loadStatus !== "ready") return;
    session = {category: "", papers: [], next: 0, skipped: 0, busy: false, saving: false};
    target.replaceChildren(new Option(PR.t("选择目标分类"), ""));
    for (const cat of cats) target.add(new Option(PR.catTree.label(cat), cat));
    target.value = L.tag || (cats.length === 1 ? cats[0] : "");
    results.replaceChildren();
    rule.value = ""; setup.disabled = false; el("details").open = false;
    run.hidden = false; apply.hidden = true; apply.disabled = true;
    target.onchange(); dialog.showModal(); (target.value ? rule : target).focus();
  };
  el("[data-close]").onclick = () => dialog.close();
  dialog.addEventListener("cancel", event => { if (session?.saving) event.preventDefault(); });
  dialog.addEventListener("close", () => { session = null; });

  function addCandidate(id, title, result) {
    const card = document.createElement("section"), quote = document.createElement("blockquote");
    const source = document.createElement("a");
    source.textContent = PR.t("查看原文");
    source.href = result.anchor ? "/read/" + encodeURIComponent(id) + "#b-" + encodeURIComponent(result.anchor)
      : "/p/" + encodeURIComponent(id) + "/source.pdf#page=" + result.page;
    source.target = "_blank"; source.rel = "noopener";
    quote.textContent = result.quote;
    card.append(choice(id, title, false), quote, source);
    results.append(card);
  }

  run.onclick = async () => {
    const current = session;
    if (!current || current.busy) return;
    if (!current.papers.length) {
      current.papers = checked(scope).map(box => ({id: box.value, title: box.parentElement.textContent}));
      if (!current.papers.length || !rule.value.trim()) return;
      current.rule = rule.value.trim(); setup.disabled = true; el("details").open = false;
    }
    current.busy = true; run.hidden = true; apply.disabled = true;
    try {
      while (current.next < current.papers.length) {
        const paper = current.papers[current.next];
        status.textContent = PR.t("正在分析 {i}/{n}：{title}", {
          i: current.next + 1, n: current.papers.length, title: paper.title});
        const result = await post(paper.id, "match-category", {rule: current.rule});
        if (session !== current || !dialog.open) return;
        if (result.status === "match") addCandidate(paper.id, paper.title, result);
        if (["excluded", "no_source"].includes(result.status)) current.skipped++;
        current.next++;
      }
      status.textContent = PR.t("找到 {n} 篇候选，跳过 {skipped} 篇。", {
        n: results.children.length, skipped: current.skipped});
    } catch (error) {
      if (session !== current) return;
      status.textContent = PR.t("分析「{title}」失败：{msg}", {
        title: current.papers[current.next].title, msg: error.message});
      run.hidden = false; run.disabled = false; run.textContent = PR.t("从这篇重试");
    } finally {
      if (session === current) {
        current.busy = false; apply.hidden = !results.children.length; results.onchange();
      }
    }
  };

  apply.onclick = async () => {
    if (!session || session.busy || !checked(results).length) return;
    const current = session;
    current.busy = current.saving = true;
    results.inert = true; run.disabled = apply.disabled = el("[data-close]").disabled = true;
    try {
      if (!L.cats().includes(current.category)) throw new Error(PR.t("目标分类已更改，请重新打开"));
      const selected = checked(results);
      for (const box of selected) {
        await post(box.value, "item", {add_category: current.category});
        box.closest("section").remove();
      }
      PR.toast(PR.t("已加入分类，共 {n} 篇", {n: selected.length}));
      dialog.close();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      current.busy = current.saving = false;
      results.inert = false; run.disabled = el("[data-close]").disabled = false;
      results.onchange(); await L.load();
    }
  };
})(window.PR);
