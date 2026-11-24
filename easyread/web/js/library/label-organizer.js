/* Review a resumable library-wide tag run from Settings → Sidebar. */
(function (PR) {
  "use strict";
  const path = "/api/library/labels/organize";
  const esc = PR.esc;

  function sourceUrl(paper) {
    const id = encodeURIComponent(paper.id);
    if (paper.anchor) return "/read/" + id + "#b-" + encodeURIComponent(paper.anchor);
    if (!paper.quote || !paper.page) return "/read/" + id;
    const item = PR.lib.items.find((i) => i.id === paper.id);
    return "/p/" + id + (item?.source_type === "web" ? "/source.html" : "/source.pdf#page=" + encodeURIComponent(paper.page));
  }

  function evidence(papers) {
    if (!papers?.length) return "";
    return '<details><summary>' + esc(PR.t("查看涉及的 {n} 篇文献", { n: papers.length })) + '</summary><ul>' +
      papers.map((p) => '<li><a target="_blank" rel="noopener" href="' + esc(sourceUrl(p)) + '">' + esc(p.title || p.id) + '</a>' +
        (p.page ? ' · ' + esc(PR.t("第 {n} 页", { n: p.page })) : "") +
        (p.quote ? '<blockquote>' + esc(p.quote) + '</blockquote>' : '') + '</li>').join("") + '</ul></details>';
  }

  function proposalRows(proposals, selected) {
    return ["create", "merge"].map((kind) => {
      const group = proposals.filter((p) => p.kind === kind);
      if (!group.length) return "";
      return '<section><h3>' + (kind === "create" ? PR.t("建议新建") : PR.t("建议并入")) + '</h3>' +
        group.map((p) => '<div class="organize-proposal"><label><input type="checkbox" data-choice="' + esc(p.id) + '"' +
          (selected.has(p.id) ? ' checked' : '') + '><strong>' +
          (kind === "create" ? esc(p.name) : esc(PR.t("将「{source}」并入「{target}」", { source: p.source, target: p.target }))) +
          '</strong></label>' + (p.rule ? '<p>' + esc(p.rule) + '</p>' : '') +
          (kind === "merge" ? [[p.source, p.source_rule], [p.target, p.target_rule]].filter(([, rule]) => rule).map(([name, rule]) =>
            '<p><b>' + esc(name) + '</b> · ' + esc(rule) + '</p>').join("") : '') +
          (p.reason ? '<p class="hint">' + esc(p.reason) + '</p>' : '') +
          evidence(p.papers) + '</div>').join("") + '</section>';
    }).join("");
  }

  PR.openLabelOrganizer = async function () {
    if (PR.$("dialog.label-organizer[open]")) return;
    const dialog = PR.el("dialog", { class: "label-organizer", "aria-labelledby": "organizeTitle" },
      '<header><h2 id="organizeTitle">' + PR.t("整理文献标签") + '</h2><button type="button" class="btn sm" data-close>' +
      PR.t("关闭") + '</button></header><div class="organize-body"><p role="status"></p><div data-content></div>' +
      '<p class="err" role="alert" hidden></p></div><footer></footer>');
    document.body.appendChild(dialog);
    dialog.showModal();
    const content = dialog.querySelector("[data-content]"), status = dialog.querySelector("[role=status]");
    const error = dialog.querySelector("[role=alert]"), footer = dialog.querySelector("footer");
    let state, timer, requestVersion = 0, posting = false, selected = new Set(), reviewKey = "", message = "";
    const action = (id, name, primary = false) => '<button type="button" data-action="' + id + '" class="btn ' +
      (primary ? "accent" : "line") + '">' + esc(name) + '</button>';
    const buttons = (disabled) => dialog.querySelectorAll("[data-action], [data-choice], textarea").forEach((b) => { b.disabled = disabled; });
    const persistSelection = () => { try { sessionStorage.setItem(reviewKey, JSON.stringify([...selected])); } catch (_) {} };
    const showError = (e) => { error.textContent = e.message; error.hidden = false; };
    const polling = () => ["running", "applying"].includes(state?.state);
    function schedule() {
      clearTimeout(timer);
      if (dialog.open && polling()) timer = setTimeout(refresh, 1500);
    }
    function render(next) {
      if (!dialog.open) return;
      const previous = state;
      state = next;
      const proposals = state.proposals || [];
      const key = "easyread-tag-review-" + state.id + "-" + state.revision;
      if (key !== reviewKey) {
        reviewKey = key;
        try { selected = new Set(JSON.parse(sessionStorage.getItem(key) || "[]")); } catch (_) { selected = new Set(); }
        selected = new Set(proposals.filter((p) => selected.has(p.id)).map((p) => p.id));
      }
      if ((previous?.state === "running" && state.state !== "running") || state.state === "complete") PR.lib.load();
      const summary = PR.t("已处理 {done} / {total} 篇，已分配 {assigned} 项标签。", state);
      status.textContent = state.state === "idle" ? PR.t("准备整理文献库") : summary;
      let html = "", actions = "";
      if (state.state === "running" || state.state === "applying") {
        const phase = state.state === "applying" ? PR.t("正在保存所选建议…") :
          state.phase === "feedback" ? PR.t("正在根据你的意见调整建议…") :
          state.phase === "synthesis" ? PR.t("正在汇总全库建议…") : PR.t("正在逐篇核对标签规则…");
        html = '<progress aria-label="' + esc(phase) + '" max="' + Math.max(1, Number(state.total) || 0) +
          '" value="' + (Number(state.done) || 0) + '"></progress><p>' + esc(phase) + '</p><p class="hint">' +
          PR.t("可以关闭此窗口。再次打开即可查看进度。") + '</p>';
        if (state.state === "running") actions = action("pause", PR.t("暂停"));
      } else if (state.state === "review") {
        html = '<p>' + (proposals.length ? PR.t("勾选要保存的建议。并入后，原标签名可以继续用于搜索。") :
          PR.t("这一轮没有新建或并入建议。你仍可以提出意见。")) + '</p><p class="hint">' +
          PR.t("全库整理只建议至少有两篇论文提供原文依据的新标签。") + '</p>' + proposalRows(proposals, selected) +
          '<section class="organize-feedback"><h3>' + PR.t("讨论整理建议") + '</h3>' +
          (state.messages || []).map((m) => '<p><b>' + (m.role === "user" ? PR.t("你") : PR.t("AI")) +
            '</b> ' + esc(m.content) + '</p>').join("") +
          '<label for="organizeMessage">' + PR.t("你的意见") + '</label><textarea class="input" rows="2" maxlength="4000" id="organizeMessage" placeholder="' +
          esc(PR.t("例如：把两个任务区分开，按实验所用语言给出建议。")) + '">' + esc(message) + '</textarea>' +
          action("feedback", PR.t("发送意见")) + '</section>';
        actions = action("confirm", PR.t("确认所选并完成整理"), true);
      } else if (state.state === "complete") {
        html = '<p>' + esc(PR.t("已完成整理，已应用 {n} 条建议。", { n: state.applied?.length || 0 })) + '</p>';
        actions = action("start", PR.t("重新整理"));
      } else if (state.state === "paused" || state.state === "error") {
        html = '<p>' + esc(state.error || PR.t("整理已暂停，进度已保留。")) + '</p>';
        actions = action("resume", PR.t("继续整理"), true);
      } else actions = action("start", PR.t("开始整理"), true);
      if (state.warnings?.length) {
        html += '<details><summary>' + esc(PR.t("已跳过 {n} 项", { n: state.warnings.length })) + '</summary><ul>' +
          state.warnings.map((w) => {
            const p = proposals.find((entry) => entry.id === w.id);
            const label = p?.name || p?.source || PR.lib.items.find((item) => item.id === w.id)?.display_title || w.id;
            return '<li>' + esc(label) + ' · ' + esc(w.message) + '</li>';
          }).join("") + '</ul></details>';
      }
      content.innerHTML = html;
      footer.innerHTML = actions;
      schedule();
    }
    async function refresh() {
      const version = ++requestVersion;
      try {
        const next = await PR.api(path);
        if (!dialog.open || version !== requestVersion || posting) return;
        error.hidden = true;
        render(next);
      } catch (e) { if (dialog.open) { showError(e); schedule(); } }
    }
    async function submit(name) {
      if (posting) return;
      const body = { id: state.id, revision: state.revision };
      if (name === "confirm") body.selected = [...selected];
      if (name === "feedback") {
        if (!message.trim()) { dialog.querySelector("textarea").focus(); return; }
        body.message = message.trim();
      }
      clearTimeout(timer);
      requestVersion++;
      posting = true;
      buttons(true);
      error.hidden = true;
      try {
        const next = await PR.api(path + "/" + name, { method: "POST", body });
        if (name === "feedback") message = "";
        render(next);
      } catch (e) {
        if (dialog.open) {
          try { render(await PR.api(path)); } catch (_) { /* Keep selections for a retry. */ }
          showError(e);
        }
      } finally { posting = false; buttons(false); schedule(); }
    }
    dialog.addEventListener("change", (e) => {
      if (!e.target.matches("[data-choice]")) return;
      const id = e.target.dataset.choice;
      if (e.target.checked) selected.add(id); else selected.delete(id);
      persistSelection();
    });
    dialog.addEventListener("input", (e) => { if (e.target.id === "organizeMessage") message = e.target.value; });
    dialog.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return dialog.close();
      const b = e.target.closest("[data-action]");
      if (b?.dataset.action === "reload") return refresh();
      if (b) submit(b.dataset.action);
    });
    dialog.addEventListener("close", () => { clearTimeout(timer); dialog.remove(); }, { once: true });
    status.textContent = PR.t("正在读取整理进度…");
    try {
      const next = await PR.api(path);
      if (!dialog.open) return;
      render(next);
      if (next.state === "idle" && PR.lib.items.length) await submit("start");
    } catch (e) {
      showError(e);
      footer.innerHTML = action("reload", PR.t("重试"));
    }
  };
})(window.PR);
