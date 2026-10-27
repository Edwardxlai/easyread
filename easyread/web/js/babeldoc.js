(function () {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const t = window.PR.t;
  let token = "", active = "", timer, modelReady = false, submitting = false, jobState = "idle";
  const form = $("#babelForm"), paper = $("#paper"), status = $("#status"), results = $("#results");
  localStorage.removeItem("easyread-babeldoc-api");
  const isDual = (name) => name.endsWith(".dual.pdf") || name.endsWith(" - 对照版.pdf"); // i18n-ok: file suffix
  const isMono = (name) => name.endsWith(".mono.pdf") || name.endsWith(" - 纯译文版.pdf"); // i18n-ok: file suffix
  function downloadName(name) {
    if (!name.endsWith(".dual.pdf") && !name.endsWith(".mono.pdf")) return name;
    const title = (paper.selectedOptions[0]?.textContent || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 120);
    return title ? title + " - " + (isDual(name) ? "对照版" : "纯译文版") + ".pdf" : name; // i18n-ok: file names
  }

  async function request(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || t("请求失败：{status}", { status: response.status }));
    return data;
  }
  function message(value, error = false) {
    status.textContent = value;
    status.classList.toggle("error", error);
  }
  function updateStart() {
    const hasUpload = !!$("#upload").files.length;
    $("#start").disabled = !modelReady || submitting || (!hasUpload && (!paper.value || jobState === "running"));
    $("#start").textContent = jobState === "running" && !hasUpload ? t("这篇正在生成中") :
      jobState === "done" && !hasUpload ? t("重新生成两种 PDF") : t("生成两种 PDF");
    $("#delete").hidden = jobState !== "done" || hasUpload;
    $("#delete").disabled = submitting;
    paper.disabled = submitting;
    $("#upload").disabled = submitting;
  }
  function clearResult() {
    results.replaceChildren();
    $("#preview").hidden = true;
    $("#preview").removeAttribute("src");
    $("#previewEmpty").hidden = false;
  }
  async function loadPapers() {
    const data = await request("/api/library");
    token = data.token;
    const selected = paper.value;
    paper.replaceChildren(new Option(t("请选择论文"), ""));
    for (const item of data.items) {
      const option = new Option(item.title_en || item.title_zh || item.id, item.id);
      paper.add(option);
    }
    const ids = data.items.map((item) => item.id);
    let next = 0, running = "", latest = null;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (next < ids.length && !running) {
        const id = ids[next++];
        const job = await request(`/api/p/${encodeURIComponent(id)}/babeldoc`);
        if (job && job.state === "running") running = id;
        else if (job && job.state !== "idle" && (!latest || job.updated > latest.updated)) latest = { id, updated: job.updated };
      }
    }));
    const remembered = sessionStorage.getItem("easyread-babeldoc-paper");
    const chosen = (ids.includes(selected) && selected) || running ||
      (ids.includes(remembered) && remembered) || (latest && latest.id) || "";
    if (ids.includes(chosen)) {
      paper.value = chosen;
      active = chosen;
      sessionStorage.setItem("easyread-babeldoc-paper", chosen);
      poll();
    }
  }
  async function loadModel() {
    const data = await request("/api/config");
    const cfg = data.config || {}, api = cfg.openai || {};
    modelReady = cfg.engine === "openai" && api.api === "chat" && !!api.base_url && !!api.model && !!api.has_key;
    const summary = $("#modelConfig");
    if (cfg.engine !== "openai") summary.textContent = t("当前基础翻译不是 API 模型。BabelDOC 无法使用 Codex 等 CLI 登录。");
    else if (api.api !== "chat") summary.textContent = t("当前接口格式是 Responses；BabelDOC 需要 Chat Completions。");
    else if (!modelReady) summary.textContent = t("API 地址、模型或 API Key 尚未配置完整。");
    else summary.textContent = api.model + " · " + api.base_url + " · " + t("API Key 已保存");
    updateStart();
  }
  async function poll() {
    clearTimeout(timer);
    if (!active) return;
    const id = active;
    try {
      const data = await request(`/api/p/${encodeURIComponent(id)}/babeldoc`);
      if (active !== id) return;
      jobState = data.state;
      updateStart();
      if (data.state === "running") {
        const started = Date.parse(data.updated);
        const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
        message(t("运行中：{message}（已运行 {m} 分 {s} 秒）", { message: t(data.message || t("正在生成两种 PDF…")), m: Math.floor(elapsed / 60), s: elapsed % 60 }));
      } else if (data.state === "done") {
        const hasMono = (data.files || []).some(isMono);
        message(hasMono ? t("已完成：{message}", { message: t(data.message || t("两种 PDF 已生成")) }) :
          t("已完成：这是旧任务，仅有对照版。重新生成后会同时得到译文版和对照版。"));
      } else if (data.state === "error") {
        message(t("翻译失败：{message}", { message: t(data.message || t("未知错误")) }), true);
      } else {
        message(t("尚未开始翻译"));
      }
      if (data.state === "done") {
        results.replaceChildren();
        for (const name of data.files || []) {
          const url = `/api/p/${encodeURIComponent(id)}/babeldoc/${encodeURIComponent(data.job_id)}/${encodeURIComponent(name)}`;
          const label = isDual(name) ? t("下载对照") : t("下载译文");
          const row = document.createElement("div");
          row.className = "result-file";
          const link = document.createElement("a");
          link.href = url;
          link.download = downloadName(name);
          link.className = "btn accent";
          link.textContent = label;
          const preview = document.createElement("a");
          preview.href = url;
          preview.textContent = t("预览");
          preview.addEventListener("click", (event) => {
            event.preventDefault();
            $("#preview").src = url;
            $("#preview").hidden = false;
            $("#previewEmpty").hidden = true;
          });
          row.append(link, preview);
          results.append(row);
          if (isDual(name) && $("#preview").hidden) {
            preview.click();
          }
        }
      }
      if (data.state === "running") timer = setTimeout(poll, 2500);
    } catch (error) { message(error.message, true); }
  }
  paper.addEventListener("change", () => {
    active = paper.value;
    jobState = "idle";
    updateStart();
    if (active) sessionStorage.setItem("easyread-babeldoc-paper", active);
    else sessionStorage.removeItem("easyread-babeldoc-paper");
    clearResult();
    poll();
  });
  $("#upload").addEventListener("change", updateStart);
  $("#delete").addEventListener("click", async () => {
    if (!active || jobState !== "done" || submitting) return;
    if (!window.confirm(t("删除这篇文献的所有排版翻译结果？原 PDF 和阅读笔记不会删除。"))) return;
    const id = active;
    submitting = true;
    updateStart();
    try {
      await request(`/api/p/${encodeURIComponent(id)}/babeldoc/delete`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Token": token }, body: "{}",
      });
      jobState = "idle";
      clearResult();
      message(t("排版翻译结果已删除。可以重新生成两种 PDF。"));
    } catch (error) { message(error.message, true); }
    finally { submitting = false; updateStart(); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    updateStart();
    message(t("正在提交任务…"));
    try {
      if (!modelReady) throw new Error(t("请先在“设置 → 模型”中配置 Chat Completions API"));
      const upload = $("#upload").files[0];
      if (upload) {
        const response = await request(`/api/import?translate=0&babeldoc=1&name=${encodeURIComponent(upload.name)}`, {
          method: "POST", headers: { "X-Token": token }, body: upload,
        });
        await loadPapers();
        paper.value = response.id;
        sessionStorage.setItem("easyread-babeldoc-paper", response.id);
        $("#upload").value = "";
      }
      if (!paper.value) throw new Error(t("请选择文献库论文或导入 PDF"));
      active = paper.value;
      await request(`/api/p/${encodeURIComponent(active)}/babeldoc`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Token": token }, body: "{}",
      });
      jobState = "running";
      clearResult();
      poll();
    } catch (error) { message(error.message, true); }
    finally { submitting = false; updateStart(); }
  });
  loadPapers().catch((error) => message(error.message, true));
  loadModel().catch((error) => message(error.message, true));
})();
