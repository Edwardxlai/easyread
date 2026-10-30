/* Optional Chinese PDF alongside the normal reading workflow. */
(function (PR) {
  "use strict";
  const jobs = new Map(), pending = new Set(), starting = new Set();
  const endpoint = (id) => "/api/p/" + encodeURIComponent(id) + "/babeldoc";
  const optionHtml = () => '<div class="imp-pdf-export"><label class="check">' +
    '<input type="checkbox" id="impPdfExport" aria-describedby="impPdfHint">' +
    '<span>' + PR.t("生成中文 PDF") + '</span></label>' +
    '<p class="hint" id="impPdfHint">' + PR.t("保留原排版，另存为 原文件名-zh.pdf，方便下载或打印") + '</p>' +
    '<div id="impPdfExtra" hidden><p class="hint">' + PR.t("生成 PDF 会额外消耗翻译额度") + '</p>' +
    '<div class="pdf-output-row"><label for="impPdfDirectory">' + PR.t("输出目录") + '</label>' +
    '<input class="input" id="impPdfDirectory" readonly placeholder="' + PR.t("请选择输出目录") + '" value="' +
    PR.esc(PR.ls.get("easyread-pdf-output-dir", "")) + '">' +
    '<button class="btn sm" id="impPdfFolder">' + PR.t("选择文件夹") + '</button></div>' +
    '<button class="linkish pdf-only" id="impPdfOnly">' + PR.t("仅生成翻译后的 PDF") + '</button></div></div>';

  async function chooseDirectory() {
    const input = PR.$("#impPdfDirectory"), button = PR.$("#impPdfFolder");
    if (button.disabled) return false;
    button.disabled = true;
    try {
      const path = await PR.pickFolder({ title: PR.t("选择中文 PDF 的输出目录") });
      if (!path) return false;
      input.value = path;
      input.title = path;
      PR.ls.set("easyread-pdf-output-dir", path);
      return true;
    } catch (error) { PR.toast(PR.esc(error.message)); return false; }
    finally { button.disabled = false; }
  }
  async function prepare(pdfOnly = false) {
    const enabled = pdfOnly || (PR.$("#importDlg").classList.contains("open") && PR.$("#impPdfExport")?.checked);
    return !enabled || !!PR.$("#impPdfDirectory")?.value || await chooseDirectory();
  }

  function paint(id) {
    const box = PR.$("#pdfExportResult"), job = jobs.get(id);
    if (!box || box.dataset.paper !== id) return;
    if (!job || job.state === "idle") { box.innerHTML = ""; return; }
    let html = '<div class="pdf-export-result"><span class="pdf-export-title">' + PR.icon("pdf", "sm") + PR.t("中文 PDF") + '</span>';
    if (job.state === "running" || job.state === "submitting") {
      html += '<p class="hint" role="status"><span class="spin"></span> ' + PR.t("正在生成，可继续阅读") + '</p>';
    } else if (job.state === "done") {
      if (job.save_error) html += '<p class="hint">' + PR.esc(PR.t(job.save_error)) + '</p>';
      else if (job.saved_files?.length) html += '<p class="hint pdf-export-path">' +
        PR.esc(PR.t("已保存到 {path}", { path: job.saved_files.join("\n") })) + '</p>';
      html += '<div class="pdf-export-files">' + (job.files || []).map((name) => {
        const dual = name.endsWith(".dual.pdf") || name.endsWith(" - 对照版.pdf"); // i18n-ok: legacy file suffix
        return '<a class="linkish" href="' + endpoint(id) + '/' + encodeURIComponent(job.job_id) + '/' + encodeURIComponent(name) +
          '" download="' + PR.esc(name) + '">' + PR.icon("download", "sm") +
          PR.t(dual ? "下载对照" : "下载译文") + '<span class="pdf-export-name">' + PR.esc(name) + '</span></a>';
      }).join("") + '</div>';
    } else {
      html += '<p class="hint">' + PR.t("PDF 未生成，论文已正常导入") + '</p><details><summary>' + PR.t("查看原因") +
        '</summary><p class="hint pdf-export-error">' + PR.esc(PR.t(job.message || "请求失败")) + '</p></details>' +
        '<div class="pdf-export-actions"><button class="linkish" data-pdf-retry="' + PR.esc(id) + '">' + PR.t("重试生成") +
        '</button><button class="linkish" data-pdf-settings>' + PR.t("模型设置") + '</button></div>';
    }
    box.innerHTML = html + '</div>';
  }

  async function show(id, refresh = false) {
    paint(id);
    if (pending.has(id) || starting.has(id) || (!refresh && jobs.has(id))) return;
    pending.add(id);
    try {
      const job = await PR.api(endpoint(id));
      if (starting.has(id)) return;
      if (!(job.state === "idle" && jobs.get(id)?.localError)) jobs.set(id, { ...job, modelId: jobs.get(id)?.modelId || "" });
      paint(id);
    } catch (_) { /* Keep the last known state until the next refresh. */ }
    finally { pending.delete(id); }
  }

  async function start(id, model = "", outputDir = "", retry = false) {
    if (starting.has(id)) return;
    starting.add(id);
    jobs.set(id, { state: "submitting", modelId: model, output_dir: outputDir });
    paint(id);
    try {
      const job = await PR.api(endpoint(id), { method: "POST", body: { model, output_dir: outputDir, regenerate: retry } });
      jobs.set(id, { ...job, modelId: model });
    } catch (error) {
      jobs.set(id, { state: "error", message: error.message, localError: true, modelId: model, output_dir: outputDir });
    } finally { starting.delete(id); paint(id); }
  }

  PR.$("#importDlg").addEventListener("change", (event) => {
    if (event.target.id !== "impPdfExport") return;
    PR.$("#impPdfExtra").hidden = !event.target.checked;
    const after = PR.$("#afterSeg .on")?.dataset.after;
    PR.$("#modelRow").classList.toggle("dim", after === "none" && !event.target.checked);
  });
  PR.$("#importDlg").addEventListener("click", (event) => {
    if (event.target.closest("#impPdfFolder")) chooseDirectory();
    if (event.target.closest("#impPdfOnly")) PR.importPdfOnly();
  });
  PR.$("#detail").addEventListener("click", (event) => {
    const retry = event.target.closest("[data-pdf-retry]");
    if (retry) {
      const job = jobs.get(retry.dataset.pdfRetry);
      start(retry.dataset.pdfRetry, job?.modelId || "", job?.output_dir || "", true);
    }
    if (event.target.closest("[data-pdf-settings]")) PR.openSettings();
  });
  setInterval(() => {
    const id = PR.lib.selected;
    if (id && !document.hidden) show(id, true);
  }, 3000);
  PR.pdfExport = { optionHtml, prepare, start, show };
})(window.PR);
