(function (PR) {
  "use strict";
  const dialog = PR.$("#libraryAsk"), question = PR.$("#libraryQuestion");
  const status = dialog.querySelector(".ask-status"), answer = dialog.querySelector(".ask-answer");
  const sources = dialog.querySelector(".ask-sources"), submit = dialog.querySelector("[type=submit]");
  PR.$("#libraryAskBtn").addEventListener("click", () => { dialog.showModal(); question.focus(); });
  dialog.querySelector("[data-dismiss]").addEventListener("click", () => dialog.close());
  const link = (source, label) => {
    const a = document.createElement("a");
    a.href = "/read/" + encodeURIComponent(source.paper) + "#b-" + encodeURIComponent(source.anchor);
    a.target = "_blank"; a.rel = "noopener"; a.textContent = label;
    return a;
  };
  function show(result) {
    for (const part of result.answer.split(/(\[\d+\])/)) {
      const hit = /^\[(\d+)\]$/.exec(part), source = hit && result.sources[Number(hit[1]) - 1];
      answer.append(source ? link(source, part) : document.createTextNode(part));
    }
    for (const source of result.sources) {
      const item = document.createElement("li"), excerpt = document.createElement("small");
      excerpt.textContent = source.text;
      item.append(link(source, source.title), excerpt); sources.append(item);
    }
    const info = [result.model, PR.t("已送入模型 {n} 段", { n: result.sent })];
    if (result.usage.input || result.usage.output) {
      info.push(PR.t("输入 {i} / 输出 {o} tokens", { i: result.usage.input, o: result.usage.output }));
    } else if (result.sent) info.push(PR.t("模型未报告用量"));
    if (result.unindexed) info.push(PR.t("{n} 篇尚无可检索正文", { n: result.unindexed }));
    if (!result.sources.length) info.push(PR.t("没有找到相关段落"));
    if (result.error) info.push(result.error);
    status.textContent = info.join(" · ");
  }
  dialog.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    const query = question.value.trim();
    if (!query || submit.disabled) return;
    submit.disabled = true; question.readOnly = true;
    answer.replaceChildren(); sources.replaceChildren(); status.textContent = PR.t("正在检索文献并生成回答…");
    try { show(await PR.api("/api/library/ask", { method: "POST", body: { query } })); }
    catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; question.readOnly = false; }
  });
})(window.PR);
