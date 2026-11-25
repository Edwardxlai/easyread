/* Review each suggestion when it arrives without disturbing other drafts. */
(function (PR) {
  "use strict";
  const L = PR.lib, queue = PR.$("#categoryQueue"), queueBtn = PR.$("#categoryQueueBtn");
  const notified = new Set();
  const title = i => PR.titles(i).main || i.id;
  const post = (id, action, body) => PR.api("/api/p/" + encodeURIComponent(id) + "/" + action, {method:"POST", body});
  const pending = () => L.items.filter(i => i.category_review?.state === "pending");
  const text = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
  queue.querySelector("[data-close]").onclick = () => queue.close();
  function openQueue() {
    const area = queue.querySelector(".review-list"), status = queue.querySelector("[role=status]");
    const current = new Set(pending().map(i => i.category_review.id));
    for (const card of [...area.children]) {
      if (!current.has(card.dataset.review)) card.remove();
    }
    const rendered = new Set([...area.children].map(card => card.dataset.review));
    queue.querySelector("h2").textContent = PR.t("分类建议（{n}）", {n:current.size});
    if (!queue.open) status.textContent = "";
    for (const i of pending()) {
      const review = i.category_review, card = document.createElement("section");
      if (rendered.has(review.id)) continue;
      card.dataset.review = review.id;
      card.append(text("h3", title(i)));
      const entries = review.options.map(option => {
        const row = document.createElement("div"), box = document.createElement("input"), name = document.createElement("input");
        box.type = "checkbox"; box.checked = true; box.setAttribute("aria-label", option.name);
        name.className = "input"; name.value = option.name; name.maxLength = 120; name.setAttribute("aria-label", PR.t("分类名称"));
        row.className = "category-choice";
        row.append(box, text("small", L.cats().includes(option.name) ? PR.t("已有分类") : PR.t("新建分类")), name);
        card.append(row, text("p", option.reason));
        return {box, name};
      });
      const actions = document.createElement("footer"), skip = text("button", PR.t("跳过")), accept = text("button", PR.t("确认加入"));
      skip.className = "btn"; accept.className = "btn accent"; actions.append(skip, accept); card.append(actions);
      async function resolve(names) {
        card.inert = true;
        try {
          await post(i.id, "review-categories", {id:review.id, categories:names});
          card.remove(); await L.load(); if (!area.children.length) queue.close();
        } catch (e) { status.textContent = e.message; card.inert = false; }
      }
      accept.onclick = () => {
        const names = entries.filter(e => e.box.checked).map(e => e.name.value.trim());
        if (names.length && names.every(Boolean)) resolve(names);
        else status.textContent = PR.t("请勾选并填写分类名称，或跳过");
      };
      skip.onclick = () => resolve([]);
      area.append(card); notified.add(review.id);
    }
    if (area.children.length && !queue.open) queue.showModal();
    if (!area.children.length && queue.open) queue.close();
  }
  queueBtn.onclick = openQueue;
  L.renderAiActions = () => {
    const items = pending();
    queueBtn.hidden = !items.length;
    queueBtn.textContent = PR.t("分类建议（{n}）", {n:items.length});
    if (queue.open) return openQueue();
    if (!items.length || L.loadStatus !== "ready" || document.hidden || L.picking ||
        document.querySelector("dialog[open], .dialog-backdrop.open") || document.activeElement?.matches("input, textarea")) return;
    if (items.some(i => !notified.has(i.category_review.id))) openQueue();
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) L.renderAiActions(); });
  const generating = new Set();
  L.suggestForPaper = async id => {
    if (generating.has(id)) return;
    if (L.byId(id)?.category_review?.state === "pending") return openQueue();
    generating.add(id);
    PR.toast(PR.t("正在生成分类建议…"));
    try {
      const res = await post(id, "suggest-categories", {});
      await L.load();
      if (res.state === "pending" && !queue.open) openQueue();
      if (res.state === "done") PR.toast(PR.t("没有新的分类建议"));
    } catch (e) { PR.toast(PR.esc(e.message)); }
    finally { generating.delete(id); }
  };
})(window.PR);
