/* 本地阅读页面的生命周期；离线导出和在线演示不连接本机服务。 */
(function (PR) {
  "use strict";
  if (!/^https?:$/.test(location.protocol) || !["127.0.0.1", "localhost"].includes(location.hostname) || document.getElementById("pr-data")) return;
  const page = PR.uid("page");
  let token = "", source = null, hidden = false, connecting = false;

  async function connect() {
    if (source || connecting || hidden) return;
    connecting = true;
    try {
      const response = await fetch("/api/lifecycle", { cache: "no-store" });
      if (!response.ok) return;
      const info = await response.json();
      token = info.token;
      PR.exitOnClose = info.exit_on_close;
      if (hidden) return;
      source = new EventSource("/api/session?token=" + encodeURIComponent(token) + "&page=" + encodeURIComponent(page));
      source.onmessage = () => { document.documentElement.dataset.sessionConnected = "true"; };
      source.onerror = () => { delete document.documentElement.dataset.sessionConnected; };
      source.addEventListener("shutdown", showExited);
    } catch (e) { /* 服务未启动，原有阅读页会提示连接状态 */ }
    finally { connecting = false; }
  }

  window.addEventListener("pagehide", () => {
    hidden = true;
    if (source) { source.close(); source = null; }
    if (token && !PR.exited) fetch("/api/session/close", {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: JSON.stringify({ page }),
    }).catch(() => {});
  });
  window.addEventListener("pageshow", () => { hidden = false; connect(); });
  window.addEventListener("online", connect);

  function showExited() {
    if (PR.exited) return;
    PR.exited = true;
    hidden = true;
    if (source) { source.close(); source = null; }
    PR.emit("exit");
    const pending = PR.store && PR.store.pending;
    document.body.replaceChildren(PR.el("main", { class: "main", style: "max-width:680px;margin:80px auto;padding:32px" },
      "<h1>EasyRead 已退出</h1><p>未完成的翻译已暂停，已保存的译文和笔记会保留。</p>" +
      (pending ? "<p>尚未写入文件的修改暂存在此浏览器，下次打开后会补存。</p>" : "") +
      "<p>可以关闭这个页面。下次重新启动 EasyRead 即可继续阅读。</p>"));
  }

  PR.exitEasyRead = async function () {
    const ok = await PR.confirm({ title: "退出 EasyRead？", body: "暂停正在进行的翻译并关闭后台服务。已保存的译文和笔记会保留；其他阅读页面也会断开连接。", ok: "退出" });
    if (!ok) return;
    if (PR.flush) await PR.flush();
    if (PR.store && PR.store.pending) { PR.toast("还有修改未保存，请保存完成后再退出"); return; }
    const response = await fetch("/api/shutdown", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Token": token }, body: "{}",
    });
    if (!response.ok) { PR.toast("退出失败，请稍后重试"); return; }
    showExited();
  };
  connect();
})(window.PR);
