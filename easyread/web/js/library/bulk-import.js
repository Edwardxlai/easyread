/* 成批导入：从 Zotero 迁移、导入整个文件夹。选来源 → 看一眼有多少 → 开始 → 看进度 → 结果。
   后端在后台一条条导入（easyread/bulk/），这里每秒问一次进度；关掉对话框照样进行，再打开接着看进度。
   入口：导入对话框里的“从 Zotero 迁移整个文献库”“导入整个文件夹”。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const dlg = PR.$("#bulkDlg"), box = dlg.querySelector(".dialog");
  const s = { source: "zotero", step: "pick", candidates: [], path: "", scan: null, status: null, tags: true, fetch: false, link: false, busy: false };
  let pollT = null;

  const esc = PR.esc;
  const zotero = () => s.source === "zotero";
  const close = () => { dlg.classList.remove("open"); clearTimeout(pollT); };
  function dismiss() {
    if (!zotero() && s.step === "scan") {
      if (s.busy) return;
      close();
      PR.$("#importBtn")?.focus?.();
      return;
    }
    close();
  }
  const list = (rows) => '<ul class="zt-list">' + rows.map((r) => "<li><b>" + esc(r.title) + "</b>" + (r.why ? "<small>" + esc(r.why) + "</small>" : "") + "</li>").join("") + "</ul>";
  const more = (label, rows) => (rows && rows.length ? '<details class="zt-more"><summary>' + label + "</summary>" + list(rows) + "</details>" : "");
  const stat = (n, label) => '<div class="zt-stat"><b>' + n + "</b><span>" + label + "</span></div>";
  const title = () => "<h2>" + (zotero() ? PR.t("从 Zotero 迁移") : PR.t("导入整个文件夹")) + "</h2>";

  function pickHtml() {
    return '<p class="zt-lead">' + PR.t("把 Zotero 里的论文 PDF、分类、标签和元数据（标题、作者、年份、期刊、DOI、摘要）搬进 EasyRead。只读 Zotero 的数据，不会改动它。") + "</p>" +
      (s.candidates.length ? '<div class="zt-paths">' + s.candidates.map((c) => '<label class="zt-path"><input type="radio" name="ztPath" value="' + esc(c.path) + '"' + (c.path === s.path ? " checked" : "") + "><span>" + esc(c.path) + "</span></label>").join("") + "</div>"
        : '<p class="hint">' + PR.t("没找到 Zotero 的数据文件夹。在 Zotero 的 设置 → 高级 → 文件和文件夹 里能看到“数据存储位置”，选那个文件夹。") + "</p>") +
      '<button class="linkish" data-z="other">' + PR.t("选别的文件夹…") + "</button>" +
      '<div class="actions"><button class="btn" data-z="close">' + PR.t("取消") + '</button><button class="btn accent" data-z="scan"' + (s.path && !s.busy ? "" : " disabled") + ">" + (s.busy ? '<span class="spin"></span> ' + PR.t("正在读取") : PR.t("下一步")) + "</button></div>";
  }
  function folderConfirm(c) {
    const locked = s.busy ? " disabled" : "";
    const checked = value => value ? " checked" : "";
    const action = c.watch ? (s.watch ? PR.t("保存") : PR.t("停止自动导入"))
      : !c.with_pdf && s.watch ? PR.t("启用自动导入") : PR.t("导入");
    const canSubmit = c.with_pdf || s.watch || c.watch;
    const name = c.path.split(/[\\/]/).pop() || c.path;
    return '<div class="folder-confirm"><p class="folder-source" dir="auto" title="' + esc(c.path) + '">' + esc(name) + '</p><p class="folder-count">' +
      PR.t("{pdf} 个 PDF · {cats} 个分类", { pdf: c.with_pdf, cats: c.collections }) + '</p>' +
      '<label class="switch-row"><b>' + PR.t("自动导入新 PDF") + '</b><input class="switch" type="checkbox" data-zo="watch"' +
      checked(s.watch) + locked + '></label>' +
      '<details class="folder-options"' + (s.optionsOpen ? " open" : "") + '><summary>' + PR.t("更多选项") + '</summary><p class="zt-src">' + esc(c.path) + '</p>' +
      '<label class="zt-opt"><input type="checkbox" data-zo="link"' + checked(s.link) + locked + '>' + PR.t("链接本地 PDF，不复制原文件") + '</label>' +
      (c.watch ? '<label class="zt-opt"><input type="checkbox" data-zo="keepFilename"' + checked(s.keepFilename) + locked + '>' +
        PR.t("用原文件名作为文献库标题") + '</label>' : '') + '</details>' +
      '<div class="actions"><button class="btn" data-z="close"' + locked + '>' + PR.t("取消") +
      '</button><button class="btn accent" data-z="start"' + (locked || (!canSubmit ? " disabled" : "")) + '>' + action + '</button></div></div>';
  }

  function scanHtml() {
    const c = s.scan;
    if (!zotero()) return folderConfirm(c);
    let h = '<p class="zt-src">' + esc(c.path) + "</p>";
    h += (c.from_backup ? '<p class="zt-warn">' + PR.t("Zotero 正在用它的数据库，这次读的是 Zotero 的自动备份，最近几天的改动可能不在里面。想要最新的，先关掉 Zotero 再点“上一步”重新读。") + "</p>" : "") +
        '<div class="zt-stats">' + stat(c.with_pdf, PR.t("篇有 PDF，会导入")) + stat(c.collections, PR.t("个分类")) + stat(c.tags, PR.t("个标签")) + "</div>" +
        (c.no_pdf ? '<p class="hint">' + PR.t("另有 {n} 条没有 PDF（只有题录，或者文件找不到），默认跳过。", { n: c.no_pdf }) + "</p>" + more(PR.t("看看是哪些"), c.missing) : "") +
        '<label class="zt-opt"><input type="checkbox" data-zo="tags"' + (s.tags ? " checked" : "") + ">" + PR.t("Zotero 的标签也建成分类（放在“Zotero 标签”下面）") + "</label>" +
        (c.fetchable ? '<label class="zt-opt"><input type="checkbox" data-zo="fetch"' + (s.fetch ? " checked" : "") + (s.link ? " disabled" : "") + ">" + PR.t("没有 PDF 的 {n} 条有 DOI 或 arXiv 编号，联网下载 PDF（慢一些，有的下不到）", { n: c.fetchable }) + "</label>" : "") +
        '<p class="hint">' + PR.t("导入后不会自动翻译，只准备原页；想读哪篇再翻译哪篇。迁移可以重复做，已经导入的只补分类，不会重复。") + "</p>";
    h += '<label class="zt-opt"><input type="checkbox" data-zo="link"' + (s.link ? " checked" : "") + ">" + PR.t("链接本地 PDF，不复制原文件") + "</label>" +
      '<p class="hint">' + PR.t("链接仅在能访问原路径的电脑上使用。请保留原 PDF；已有论文保留原来的存储方式、笔记和进度。") + "</p>";
    const can = c.with_pdf || (!s.link && s.fetch && c.fetchable);
    return h + '<div class="actions"><button class="btn" data-z="back">' + PR.t("上一步") + '</button><button class="btn accent" data-z="start"' +
      (s.busy || !can ? " disabled" : "") + ">" + PR.t("开始迁移") + "</button></div>";
  }
  function runHtml() {
    const st = s.status || {};
    const running = st.state === "running";
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    return (running ? '<div class="zt-bar"><i style="width:' + pct + '%"></i></div><p class="zt-now">' + PR.t("{done}/{total}：{title}", { done: st.done, total: st.total, title: esc(st.message || "") }) + "</p>"
      : '<p class="zt-done">' + esc(st.state === "error" ? PR.t("迁移出错：{msg}", { msg: st.message }) : st.state === "stopped" ? PR.t("已停止，已经导入的保留。") : zotero() ? PR.t("迁移完成。") : PR.t("导入完成。")) + "</p>") +
      '<div class="zt-stats">' + stat(st.imported || 0, PR.t("篇新导入")) + stat(st.existing || 0, PR.t("篇原来就在库里，补了分类")) +
      (zotero() ? stat((st.skipped || []).length, PR.t("条没有 PDF，跳过")) : "") + stat((st.failed || []).length, PR.t("条没导进来")) + "</div>" +
      more(PR.t("没导进来的"), st.failed) + more(PR.t("跳过的"), st.skipped) +
      (running ? '<p class="hint">' + PR.t("可以关掉这个窗口，迁移在后台继续。") + "</p>" : "") +
      '<div class="actions">' + (running ? '<button class="btn" data-z="stop">' + PR.t("停止") + '</button><button class="btn accent" data-z="close">' + PR.t("后台继续") + "</button>"
        : '<button class="btn accent" data-z="finish">' + PR.t("完成") + "</button>") + "</div>";
  }
  function render() {
    box.innerHTML = title() + (s.step === "pick" ? pickHtml() : s.step === "scan" ? scanHtml() : runHtml());
  }

  async function poll() {
    clearTimeout(pollT);
    try { s.status = await PR.api("/api/migrate/status"); } catch (e) { return; }
    if (s.status.source) s.source = s.status.source;
    if (dlg.classList.contains("open")) render();
    if (s.status.state === "running") { pollT = setTimeout(poll, 1000); if (s.status.done % 5 === 0) L.load(); }
    else afterRun();
  }
  /* 做完：分类顺序在后端写进了 prefs，重新拿一次；列表也刷新 */
  async function afterRun() {
    try { L.useServerSide(await PR.loadPrefs()); } catch (e) { /* 拿不到就用论文上的分类 */ }
    L.load();
  }
  /* 已经有一批在跑：不管从哪个入口打开，都先看它的进度 */
  async function resume() {
    try { s.status = await PR.api("/api/migrate/status"); } catch (e) { s.status = null; }
    if (!s.status || s.status.state !== "running") return false;
    s.step = "run"; dlg.classList.add("open"); poll();
    return true;
  }

  PR.openZotero = async function () {
    if (await resume()) return;
    Object.assign(s, { source: "zotero", step: "pick", scan: null, busy: false, path: "", link: false });
    dlg.classList.add("open");
    render();
    try { s.candidates = (await PR.api("/api/zotero/detect")).candidates || []; } catch (e) { s.candidates = []; }
    if (s.candidates.length) s.path = s.candidates[0].path;
    render();
  };
  PR.openFolderImport = async function (keepFilename = false) {
    if (await resume()) return;
    const p = await PR.pickFolder({ title: PR.t("选择要导入的文件夹") });
    if (!p) return;
    Object.assign(s, { source: "folder", step: "pick", path: p, scan: null, watch: false, optionsOpen: false, busy: false, fetch: false, link: false, keepFilename });
    scan();
  };

  async function scan() {
    s.busy = true; render();
    try {
      s.scan = await PR.api("/api/migrate/scan", { method: "POST", body: { source: s.source, path: s.path } });
      if (!zotero()) {
        s.watch = !!s.scan.watch;
        if (s.watch) { s.link = s.scan.watch.link; s.keepFilename = s.scan.watch.keep_filename; }
      }
      s.step = "scan"; dlg.classList.add("open");
    } catch (e) { PR.toast(PR.t("读不了：{msg}", { msg: esc(e.message) }), null, 8000); }
    s.busy = false; render();
    if (!zotero() && s.step === "scan") box.querySelector?.('[data-z="close"]')?.focus();
  }
  async function start() {
    s.busy = true; render();
    try {
      if (!zotero() && (s.watch || s.scan.watch)) {
        await PR.api("/api/migrate/watch", { method: "POST", body: {
          path: s.scan.path, enabled: s.watch, link: s.link, keep_filename: !!s.keepFilename,
        } });
        close(); s.busy = false; s.step = "pick";
        PR.toast(s.watch ? PR.t("EasyRead 运行时会自动导入这个文件夹里的 PDF") : PR.t("已停止自动导入"));
        L.load();
        return;
      }
      s.status = await PR.api("/api/migrate/start", { method: "POST", body: { source: s.source, path: s.path, tags: s.tags, fetch: s.fetch, link: s.link, keep_filename: !zotero() && s.keepFilename } });
      s.step = "run"; poll();
    } catch (e) { PR.toast(PR.t("没能开始：{msg}", { msg: esc(e.message) }), null, 8000); }
    s.busy = false; render();
  }

  dlg.addEventListener("click", async (e) => {
    if (e.target === dlg) return dismiss();
    const b = e.target.closest("[data-z]");
    if (!b || b.disabled) return;
    const act = b.dataset.z;
    if (act === "close") dismiss();
    if (act === "finish") { close(); s.step = "pick"; }
    if (act === "back") { s.step = "pick"; render(); }
    if (act === "scan") scan();
    if (act === "start") start();
    if (act === "stop") { await PR.api("/api/migrate/stop", { method: "POST", body: {} }).catch(() => {}); poll(); }
    if (act === "other") {
      const p = await PR.pickFolder({ title: PR.t("选择 Zotero 的数据文件夹"), body: PR.t("Zotero 的 设置 → 高级 → 文件和文件夹 里写着“数据存储位置”，就是放 zotero.sqlite 的那个文件夹。") });
      if (p) { if (!s.candidates.some((c) => c.path === p)) s.candidates.push({ path: p }); s.path = p; render(); }
    }
  });
  dlg.addEventListener("change", (e) => {
    if (e.target.name === "ztPath") { s.path = e.target.value; render(); }
    const option = e.target.dataset.zo;
    if (option) {
      s[option] = e.target.checked;
      if (s.link) s.fetch = false;
      if (!zotero()) s.optionsOpen = !!box.querySelector?.(".folder-options")?.open;
      render();
      if (!zotero()) box.querySelector?.('[data-zo="' + option + '"]')?.focus();
    }
  });
  (dlg.ownerDocument || dlg).addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !dlg.classList.contains("open") || dlg.ownerDocument?.querySelector("dialog:modal")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    dismiss();
  }, true);
})(window.PR);
