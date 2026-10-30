/* 导入：对话框（选文件 / 链接）+ 把 PDF 拖进窗口任何地方 + 在页面上直接粘贴链接。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const dlg = PR.$("#importDlg");
  const SCOPES = [["all", PR.t("全文")], ["body", PR.t("正文（到参考文献为止）")], ["range", PR.t("指定页")]];
  // 导入后做什么：翻译成中文 / 只读英文原文（模型把版面排好，不翻译）/ 只放原页图
  const AFTER = [["translate", PR.t("翻译成"), PR.t("后台逐页翻译，随时对照原文；译成哪种语言在右边选")],
    ["read", PR.t("读英文原文"), PR.t("不翻译：模型只把公式、表格、段落排好，正文就是英文，比翻译省用量；想看译文了随时点“翻译成{lang}”", { lang: PR.targetName(PR.target) })],
    ["none", PR.t("先不处理"), PR.t("不用模型，阅读页先放原页图片")]];
  const BULK = 5;  // 一次超过这么多篇，先问要不要翻译

  const pref = () => {
    const saved = PR.ls.get("easyread-import", null);
    // 英文界面第一次导入默认读原文：母语是英文的人多半不需要译文，要翻译时再选
    const p = Object.assign({ auto: true, scope: "all", from: 1, to: 10 }, saved || (PR.lang === "en" ? { after: "read" } : {}));
    if (p.scope === "first") Object.assign(p, { scope: "range", from: 1, to: p.first || 10 });  // 旧的“前几页”
    if (!p.after) p.after = p.auto ? "translate" : "none";  // 旧的“导入后翻译”勾选框
    return p;
  };
  const savePref = (p) => PR.ls.set("easyread-import", Object.assign(pref(), p));

  PR.openImport = function (ref) {
    const p = pref();
    const off = L.engine === "none";
    const after = off ? "none" : p.after;
    dlg.querySelector(".dialog").innerHTML =
      "<h2>" + PR.t("导入论文") + "</h2>" +
      '<div class="dropzone" id="pick">' + PR.icon("upload") + '<div class="big">' + PR.t("选择 PDF，或拖到这里") + '</div><div class="hint">' + PR.t("可以一次选多个；同一个文件不会重复导入") + "</div></div>" +
      '<div class="or">' + PR.t("或者") + "</div>" +
      '<label class="field"><span>' + PR.t("链接、arXiv 编号、DOI 或论文标题") + '</span><div class="inline"><input class="input" id="arxivRef" placeholder="' + PR.t("2411.00640 · 10.18653/v1/N19-1423 · 论文网页链接 · 论文标题") + '">' +
      '<button class="btn accent" id="arxivGo">' + PR.t("导入") + "</button></div></label>" +
      '<div class="imp-bulk"><button class="linkish" id="folderGo">' + PR.icon("folder", "sm") + PR.t("导入整个文件夹") + "</button>" +
      '<button class="linkish" id="zoteroGo">' + PR.icon("upload", "sm") + PR.t("从 Zotero 迁移整个文献库") + "</button></div>" +
      '<div class="imp-opts"><span class="imp-lbl">' + PR.t("导入后") + '</span><div class="seg" id="afterSeg">' + AFTER.map(([k, l, tip]) => '<button data-after="' + k + '" title="' + PR.esc(tip) + '" class="' + (after === k ? "on" : "") + '"' + (off && k !== "none" ? " disabled" : "") + ">" + l + "</button>").join("") + "</div>" +
        '<select class="input imp-target" id="impTarget" title="' + PR.t("译成哪种语言") + '"' + (after === "translate" ? "" : " hidden") + ">" + PR.opt(PR.TARGETS, PR.target) + "</select></div>" +
      '<p class="hint" id="enTargetHint"' + (after === "translate" && PR.target === "en" ? "" : " hidden") + '>' + PR.t("原文本来就是英文的话，选“读英文原文”就行，不用翻译，更省用量。") + "</p>" +
      '<p class="hint" id="originalModelHint"' + (after === "read" ? "" : " hidden") + '>' + PR.t("读英文原文仍需可用模型整理段落、公式和表格，会消耗模型额度；只看 PDF 可选“先不处理”。") + "</p>" +
      '<div class="imp-opts' + (after === "none" ? " dim" : "") + '" id="scopeRow"><span class="imp-lbl">' + PR.t("范围") + '</span><div class="seg" id="scopeSeg">' + SCOPES.map(([k, l]) => '<button data-scope="' + k + '" class="' + (p.scope === k ? "on" : "") + '">' + l + "</button>").join("") + "</div>" +
      '<span class="first-n"' + (p.scope === "range" ? "" : " hidden") + '>' + PR.t("第 {from} 到 {to} 页", { from: '<input class="input" id="pgFrom" type="number" min="1" value="' + p.from + '">', to: '<input class="input" id="pgTo" type="number" min="1" value="' + p.to + '">' }) + "</span></div>" +
      '<div class="imp-opts' + (after === "none" ? " dim" : "") + '" id="modelRow"><span class="imp-lbl">' + PR.t("模型") + '</span><select class="input" id="impModel">' +
      '<option value="">' + PR.esc(L.engineLabel || PR.t("未设置")) + "</option></select>" +
      '<button class="linkish" id="impEngine" title="' + PR.t("增删模型在设置 → 模型") + '">' + PR.t("管理模型") + "</button></div>" +
      '<div id="impExtra"' + (after === 'translate' ? '' : ' hidden') + '>' + PR.translationExtraHtml() + '</div>' +
      PR.pdfExport.optionHtml() +
      '<div class="actions"><button class="btn" id="impClose">' + PR.t("关闭") + "</button></div>";
    dlg.classList.add("open");
    setTimeout(() => { const i = PR.$("#arxivRef"); if (ref) i.value = ref; i.focus(); }, 50);
    fillModels(p.model);
  };

  /* 模型：默认是设置里的翻译引擎，也可以直接选“问 AI”名单里配好的模型 */
  async function fillModels(want) {
    let r;
    try { r = await PR.api("/api/chat/models"); } catch (e) { return; }
    const sel = PR.$("#impModel");
    if (!sel) return;
    // 标着“翻译”的那张卡片就是空值（用设置里的翻译配置，包括“能看图”）；对不上时才留第一项翻译引擎
    if (r.translate) sel.innerHTML = "";
    sel.insertAdjacentHTML("beforeend", (r.models || []).map((m) =>
      '<option value="' + (m.id === r.translate ? "" : PR.esc(m.id)) + '"' + (m.ready ? "" : " disabled") + ">" + PR.esc(m.label + " · " + m.source) + "</option>").join(""));
    const ok = (r.models || []).some((m) => m.id === want && m.id !== r.translate && m.ready);
    sel.value = ok ? want : "";
  }
  const close = () => dlg.classList.remove("open");
  function opts(pdfOnly = false) {
    const p = pref();
    const after = pdfOnly || L.engine === "none" ? "none" : p.after;
    const from = Math.max(1, +p.from || 1), to = Math.max(1, +p.to || from);
    const scope = p.scope === "range" ? "range:" + Math.min(from, to) + "-" + Math.max(from, to) : p.scope;
    const sel = PR.$("#impModel"), tgt = PR.$("#impTarget");  // 拖进来导入时对话框没开，用设置里的译文语言
    const pdfExport = pdfOnly || (dlg.classList.contains('open') && !!PR.$('#impPdfExport')?.checked);
    return { translate: after !== "none", read: after === "read", scope, model: after === "none" && !pdfExport ? "" : sel ? sel.value : "",
      target: after === "translate" ? (tgt ? tgt.value : PR.target) : "",
      pdf_export: pdfExport,
      pdf_output_dir: pdfExport ? PR.$('#impPdfDirectory').value : '',
      translation_extra: after === "translate" && dlg.classList.contains('open') ? (dlg.querySelector('[data-translation-extra]')?.value.trim() || '') : '' };
  }

  dlg.addEventListener("click", (e) => {
    if (e.target === dlg || e.target.closest("#impClose")) close();
    if (e.target.closest("#pick")) { delete PR.$("#fileInput").dataset.pdfOnly; PR.$("#fileInput").click(); }
    if (e.target.closest("#arxivGo")) importRef(PR.$("#arxivRef").value);
    if (e.target.closest("#impEngine")) { close(); PR.openSettings(); }
    if (e.target.closest("#zoteroGo")) { close(); PR.openZotero(); }
    if (e.target.closest("#folderGo")) { close(); PR.openFolderImport(); }
    const a = e.target.closest("[data-after]");
    if (a && !a.disabled) {
      savePref({ after: a.dataset.after });
      PR.$('#impExtra').hidden = a.dataset.after !== 'translate';
      PR.$$("[data-after]", dlg).forEach((b) => b.classList.toggle("on", b === a));
      PR.$("#scopeRow").classList.toggle("dim", a.dataset.after === "none");
      PR.$("#modelRow").classList.toggle("dim", a.dataset.after === "none" && !PR.$('#impPdfExport').checked);
      PR.$("#impTarget").hidden = a.dataset.after !== "translate";
      PR.$("#originalModelHint").hidden = a.dataset.after !== "read";
      enHint();
    }
    const s = e.target.closest("[data-scope]");
    if (s) {
      savePref({ scope: s.dataset.scope });
      PR.$$("[data-scope]", dlg).forEach((b) => b.classList.toggle("on", b === s));
      PR.$(".first-n", dlg).hidden = s.dataset.scope !== "range";
    }
  });
  // 译成英语（#48）：原文本来就是英文时不用翻译，提示改选“读英文原文”
  const enHint = () => { const t = PR.$("#impTarget"); PR.$("#enTargetHint").hidden = t.hidden || t.value !== "en"; };
  dlg.addEventListener("change", (e) => { if (e.target.id === "impModel") savePref({ model: e.target.value }); if (e.target.id === "impTarget") enHint(); });
  dlg.addEventListener("input", (e) => {  // 边输边存：输完直接点“导入”也用新的页码
    if (e.target.id === "pgFrom") savePref({ from: +e.target.value || 1 });
    if (e.target.id === "pgTo") savePref({ to: +e.target.value || 1 });
  });
  dlg.addEventListener("keydown", (e) => { if (e.target.id === "arxivRef" && e.key === "Enter") importRef(e.target.value); if (e.key === "Escape") close(); });
  PR.$("#importBtn").onclick = () => PR.openImport();
  PR.$("#fileInput").addEventListener("change", (e) => {
    const pdfOnly = e.target.dataset.pdfOnly === "1";
    delete e.target.dataset.pdfOnly;
    importFiles(Array.from(e.target.files), pdfOnly);
    e.target.value = "";
  });
  PR.$("#fileInput").addEventListener("cancel", (e) => { delete e.target.dataset.pdfOnly; });
  PR.importPdfOnly = async function () {
    const ref = PR.$("#arxivRef").value.trim();
    if (ref) {
      const button = PR.$("#impPdfOnly");
      if (button.disabled) return;
      button.disabled = true;
      try { await importRef(ref, true); }
      finally { button.disabled = false; }
    } else {
      // Open synchronously from the click so browsers preserve user activation.
      const input = PR.$("#fileInput");
      input.dataset.pdfOnly = "1";
      input.click();
    }
  };

  async function importFiles(files, pdfOnly = false) {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!pdfs.length) return PR.toast(PR.t("只支持 PDF 文件"));
    if (!(await PR.pdfExport.prepare(pdfOnly))) return;
    let o = opts(pdfOnly);
    const wasOpen = dlg.classList.contains('open');
    close();
    // 一次拖进来很多篇：默认先只导入，免得按上次的设置把额度一下子用光
    if (pdfs.length > BULK && (o.translate || o.pdf_export)) {
      const pick = await PR.confirm({
        title: PR.t("一次导入 {n} 篇，先不翻译？", { n: pdfs.length }),
        body: (o.read ? PR.t("按上次的设置，导入后会用模型整理全部 {n} 篇的原文，比较费额度。", { n: pdfs.length }) : PR.t("按上次的设置，导入后会翻译全部 {n} 篇，比较费额度。", { n: pdfs.length })) +
          PR.t("先只导入的话，之后在想读的论文上点翻译，或勾选几篇一起翻译。"),
        ok: PR.t("只导入"), alt: o.read ? PR.t("照样整理全部") : PR.t("照样翻译全部"), center: true });
      if (!pick) return;
      if (pick === true) o = Object.assign(o, { translate: false, read: false, model: "", target: "", pdf_export: false });
    }
    if (!wasOpen && o.translate && !o.read) {
      const extra = await PR.translationDialog();
      if (extra === null) return;
      o.translation_extra = extra;
    }
    let last = null;
    for (const [k, f] of pdfs.entries()) {
      PR.toast(PR.t("正在导入 {i}/{n}：{name}", { i: k + 1, n: pdfs.length, name: PR.esc(f.name) }), null, 60000);
      try {
        const r = await PR.api("/api/import?translate=" + (o.translate ? 1 : 0) + "&read=" + (o.read ? 1 : 0) + "&model=" + encodeURIComponent(o.model) + "&target=" + encodeURIComponent(o.target) + "&scope=" + encodeURIComponent(o.scope) + "&translation_extra=" + encodeURIComponent(o.translation_extra) + "&name=" + encodeURIComponent(f.name), { method: "POST", body: f });
        last = r.id;
        if (o.pdf_export) await PR.pdfExport.start(r.id, o.model, o.pdf_output_dir);
        if (!r.new) PR.toast(r.queued ? PR.t("《{name}》已重新加入准备队列", { name: PR.esc(f.name) }) : PR.t("《{name}》已经在库里了", { name: PR.esc(f.name) }));
      } catch (e) { PR.toast(PR.t("导入失败：{msg}", { msg: PR.esc(e.message) })); }
    }
    await L.load();
    if (last) { L.select(last); PR.toast((o.read ? PR.t("已导入 {n} 篇，后台开始整理原文", { n: pdfs.length }) : o.translate ? PR.t("已导入 {n} 篇，后台开始翻译", { n: pdfs.length }) : PR.t("已导入 {n} 篇", { n: pdfs.length })), { label: PR.t("打开"), fn: () => L.openReader(last) }, 6000); }
  }

  async function importRef(ref, pdfOnly = false) {
    ref = (ref || "").trim();
    if (!ref) return;
    if (!(await PR.pdfExport.prepare(pdfOnly))) return;
    const btn = PR.$("#arxivGo");
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + PR.t("查找中"); }
    else PR.toast('<span class="spin"></span> ' + PR.t("正在查找并下载 {ref}", { ref: PR.esc(ref) }), null, 60000);
    const o = opts(pdfOnly);
    try {
      const r = await PR.api("/api/import-url", { method: "POST", body: { ref, ...o } });
      if (o.pdf_export) await PR.pdfExport.start(r.id, o.model, o.pdf_output_dir);
      close();
      await L.load();
      L.select(r.id);
      PR.toast(r.new ? (o.read ? PR.t("已导入，后台开始整理原文") : o.translate ? PR.t("已导入，后台开始翻译") : PR.t("已导入")) : r.queued ? PR.t("已重新加入准备队列") : PR.t("这篇已经在库里了"), { label: PR.t("打开"), fn: () => L.openReader(r.id) }, 6000);
    } catch (e) {
      PR.toast(PR.t("导入失败：{msg}", { msg: PR.esc(e.message) }), null, 8000);
      if (btn) { btn.disabled = false; btn.textContent = PR.t("导入"); }
    }
  }
  PR.importRef = importRef;

  /* 在文献库页面直接 Ctrl+V 一个链接或 arXiv 编号 */
  document.addEventListener("paste", (e) => {
    if (e.target.closest("input, textarea, [contenteditable]") || PR.$(".dialog-backdrop.open")) return;
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) { e.preventDefault(); return importFiles(files); }
    const t = (e.clipboardData.getData("text") || "").trim();
    if (/^(https?:\/\/\S+|(arxiv:)?\d{4}\.\d{4,5}(v\d+)?|(doi:\s*)?10\.\d{4,9}\/\S+)$/i.test(t)) { e.preventDefault(); PR.openImport(t); }
  });

  /* 拖进窗口任何地方都能导入 */
  let depth = 0;
  const overlay = PR.$("#dropOverlay");
  const hasFiles = (e) => Array.from(e.dataTransfer && e.dataTransfer.types || []).includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth++; overlay.classList.add("on"); });
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove("on"); });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; overlay.classList.remove("on");
    importFiles(Array.from(e.dataTransfer.files));
  });
})(window.PR);
