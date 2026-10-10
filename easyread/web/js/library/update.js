/* 新版本提示：打开文献库时问一次服务（服务一天最多问一次 GitHub），有新版本就在顶栏放一个“新版本 x.y.z”，
   第一次看到这个版本时再弹一条提示。点开看这次更新了什么，Windows、macOS 安装版和 Linux AppImage 直接点“更新”。
   顶栏问号里有“检查更新”和“自动检查新版本”开关。 */
(function (PR) {
  "use strict";
  const SEEN = "easyread-seen-update";
  const desktop = /Electron/i.test(navigator.userAgent);
  const bridge = window.easyreadDesktop;
  let nativeUpdate = { supported: false, phase: "idle" };
  let readyNotified = "";
  /* 更新弹窗是否开着（#textDlg 别的弹窗也用，所以还要看里面是不是更新的内容） */
  function dialogOpen() {
    const dlg = PR.$("#textDlg");
    return !!(dlg && dlg.classList.contains("open") && dlg.querySelector("#upFoot"));
  }
  /* 弹窗下半部分。安装版（Windows、macOS、Linux AppImage）：只有“关闭”和“更新”，按钮自己显示进度；下载中关掉弹窗照样下，
     进度显示在顶栏的新版本按钮上。从源码运行的没有应用内更新，给下载链接 */
  function renderNativeUpdate() {
    const status = document.querySelector("#upStatus"), foot = document.querySelector("#upFoot");
    if (!status || !foot) return;
    const u = PR.update, n = nativeUpdate, phase = n.phase;
    const pct = Math.floor(n.percent || 0);
    status.hidden = !n.supported || phase !== "downloading";
    if (!status.firstChild) status.innerHTML = '<div class="up-bar"><i></i></div>';
    status.querySelector("i").style.width = pct + "%";
    if (!n.supported) {
      foot.innerHTML = '<p class="hint up-how">' + howTo() + '</p><button class="btn" data-close>' + PR.t("关闭") + '</button><a class="btn accent" href="' + PR.esc(u.url) + '" target="_blank" rel="noopener">' + PR.t("去下载") + "</a>";
      return;
    }
    const labels = { checking: PR.t("正在检查…"), downloading: PR.t("正在下载 {p}%", { p: pct }), downloaded: PR.t("更新并重启"), installing: PR.t("正在重启…"), error: PR.t("重试"), current: PR.t("已经是最新版") };
    const off = ["checking", "downloading", "installing", "current"].includes(phase);
    const label = labels[phase] || PR.t("更新");
    // 下载进度一秒来好几次：只改按钮上的字。整排重画的话按下和松开落在两个不同的按钮上，“关闭”就点不动
    const key = phase + "|" + (n.error || "");
    if (foot.dataset.key === key) { foot.querySelector("[data-native-update]").textContent = label; return; }
    foot.dataset.key = key;
    foot.innerHTML = (n.error ? '<p class="hint up-err">' + PR.esc(n.error) + "</p>" : "") +
      '<button class="btn" data-close>' + PR.t("关闭") + '</button><button class="btn accent" data-native-update' + (off ? " disabled" : "") + ">" + label + "</button>";
  }
  /* 顶栏新版本按钮跟着下载走：下载中显示百分比，下好了显示“更新并重启” */
  function renderChip() {
    const u = PR.update, phase = nativeUpdate.phase;
    if (!u || !u.newer || !nativeUpdate.supported) return;
    const text = phase === "downloading" ? PR.t("正在下载 {p}%", { p: Math.floor(nativeUpdate.percent || 0) })
      : phase === "downloaded" ? PR.t("更新并重启") : PR.t("新版本 {v}", { v: PR.esc(u.latest) });
    // 只换字，不重画整个按钮：下载时一秒更新好几次，重画会让点击落空
    const label = chip.querySelector(".chip-text");
    if (label) label.innerHTML = text;
    else chip.innerHTML = '<span class="dot"></span><span class="chip-text">' + text + "</span>";
  }
  /* 弹窗关着时下好了：不擅自重启，提示一下，点了再装 */
  function notifyReady() {
    const v = nativeUpdate.version || (PR.update && PR.update.latest) || "";
    if (readyNotified === v || dialogOpen()) return;
    readyNotified = v;
    PR.toast(PR.t("EasyRead {v} 已经下好了", { v: PR.esc(v) }), { label: PR.t("更新并重启"), fn: () => { PR.openUpdate(); runUpdate(); } }, 15000);
  }
  function acceptNativeUpdate(state) {
    const was = nativeUpdate.phase;
    nativeUpdate = state;
    renderNativeUpdate();
    renderChip();
    if (state.phase === "downloaded" && was !== "downloaded") notifyReady();
  }
  /* 点一次“更新”：弹窗开着就下载完直接重启安装（等下载那次调用返回再装，主进程那时才空出来）；
     中途点了“关闭”就只下载，下好了提示再装。后台正在翻译等原因装不了，会带着原因停在“更新并重启” */
  async function runUpdate() {
    try {
      if (nativeUpdate.phase !== "downloaded") acceptNativeUpdate(await bridge.downloadUpdate());
      if (nativeUpdate.phase !== "downloaded") return;
      if (dialogOpen()) acceptNativeUpdate(await bridge.installUpdate());
      else notifyReady();
    } catch (error) { acceptNativeUpdate({ ...nativeUpdate, phase: "error", error: error.message }); }
  }
  document.addEventListener("click", async event => {
    if (!event.target.closest("[data-native-update]")) return;
    runUpdate();
  });
  PR.update = null;

  const chip = PR.el("button", { class: "engine-chip update-chip", id: "updateChip", hidden: "" });
  PR.$("#engineChip").before(chip);
  chip.onclick = () => PR.openUpdate();
  if (bridge && bridge.updateState) {
    bridge.onUpdateState(acceptNativeUpdate);
    bridge.updateState().then(acceptNativeUpdate).catch(() => {});
  }

  /* Release 说明是 Markdown：只认段落、“- ”列表、**粗体**、[链接](地址)、`代码`，够用了 */
  function inline(s) {
    return PR.esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s（(])(https?:\/\/[^\s<）)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }
  function notesHtml(md) {
    let h = "", list = false;
    for (const raw of (md || "").split(/\r?\n/)) {
      const line = raw.trim();
      const li = line.match(/^[-*] (.*)/);
      if (li) { if (!list) { h += "<ul>"; list = true; } h += "<li>" + inline(li[1]) + "</li>"; continue; }
      if (list) { h += "</ul>"; list = false; }
      if (!line) continue;
      const head = line.match(/^#{1,4} (.*)/);
      h += head ? "<h4>" + inline(head[1]) + "</h4>" : "<p>" + inline(line) + "</p>";
    }
    return h + (list ? "</ul>" : "");
  }

  function howTo() {
    return desktop ? PR.t("下载对应系统的安装包，装上就会覆盖旧版本，论文和设置都还在。")
      : PR.t("从源码运行的：下载新版 zip 解压后双击 start.cmd（macOS / Linux 运行 ./start.sh），或者在项目目录里 git pull；用 pip 装的：pip install -U easyread。论文和设置在数据目录里，不受影响。");
  }

  function show(u) {
    PR.update = u;
    const on = !!(u && u.newer);
    chip.hidden = !on;
    const help = PR.$("#helpBtn");
    if (help) help.classList.toggle("has-update", on);  // 问号上也亮个小点
    if (!on) return;
    chip.innerHTML = '<span class="dot"></span><span class="chip-text">' + PR.t("新版本 {v}", { v: PR.esc(u.latest) }) + "</span>";
    renderChip();
    chip.title = PR.t("EasyRead {v} 已发布，点开看更新了什么", { v: u.latest });
    if (PR.ls.get(SEEN, "") !== u.latest) {  // 每个新版本只弹一次
      PR.ls.set(SEEN, u.latest);
      PR.toast(PR.t("EasyRead {v} 发布了", { v: PR.esc(u.latest) }), { label: PR.t("看看更新了什么"), fn: PR.openUpdate }, 9000);
    }
  }

  PR.openUpdate = function () {
    const u = PR.update;
    if (!u || !u.latest) return;
    const dlg = PR.$("#textDlg");
    dlg.querySelector(".dialog").innerHTML =
      '<div class="help-head">' + PR.logo("hero sm") + "<div><h2>EasyRead " + PR.esc(u.latest) + (u.newer ? PR.t(" 可以更新了") : "") + '</h2><div class="hint">' + PR.t("你现在用的是 {v}", { v: PR.esc(u.current) }) +
      (u.published ? PR.t(" · {date} 发布", { date: PR.esc(u.published.slice(0, 10)) }) : "") + "</div></div></div>" +
      '<div class="update-notes">' + (notesHtml(u.notes) || '<p class="hint">' + PR.t("这次没写更新说明。") + "</p>") + "</div>" +
      (u.newer ? '<div class="up-status" id="upStatus" hidden></div><div class="actions up-foot" id="upFoot"></div>'
        : '<div class="actions"><button class="btn" data-close>' + PR.t("关闭") + '</button><a class="btn accent" href="' + PR.esc(u.url) + '" target="_blank" rel="noopener">' + PR.t("在 GitHub 上看") + "</a></div>");
    dlg.classList.add("open");
    renderNativeUpdate();
  };

  /* 问号面板里用：force 为真时马上问 GitHub */
  PR.checkUpdate = async function (force) {
    const u = await PR.api("/api/update" + (force ? "?force=1" : ""));
    show(u);
    return u;
  };
  PR.setAutoUpdate = async function (on) {
    show(await PR.api("/api/update", { method: "POST", body: { enabled: on } }));
  };

  /* 问号面板最上面（help.js）：版本、检查更新、自动检查开关。有新版本时主按钮换成“看看更新了什么” */
  function panelInner(msg) {
    const u = PR.update, newer = !!(u && u.newer);
    const line = msg || (newer ? PR.t("新版本 {v} 可以更新", { v: PR.esc(u.latest) }) : u && u.latest ? PR.t("已经是最新版") : "");
    return '<div class="hu-row"><span class="hu-dot' + (newer ? " new" : "") + '"></span><div class="hu-text"><b>' + PR.t("版本 {v}", { v: PR.esc(PR.lib.version || "") }) +
      '</b><span class="hint" id="helpUpdateMsg">' + line + "</span></div>" +
      (newer ? '<button class="btn sm accent" data-help="open">' + PR.t("看看更新了什么") + "</button>"
        : '<button class="btn sm line" data-help="check">' + PR.t("检查更新") + "</button>") + "</div>" +
      '<label class="check"><input type="checkbox" data-help="auto"' + (!u || u.enabled !== false ? " checked" : "") + ">" + PR.t("自动检查新版本（一天一次）") + "</label>";
  }
  PR.updatePanel = () => '<div class="help-update" id="helpUpdate">' + panelInner() + "</div>";
  document.addEventListener("click", async (e) => {
    const b = e.target.closest('[data-help="check"], [data-help="open"]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.help === "open") return PR.openUpdate();
    const box = PR.$("#helpUpdate");
    b.disabled = true; PR.$("#helpUpdateMsg").textContent = PR.t("正在检查…");
    let msg = "";
    try {
      const u = await PR.checkUpdate(true);
      if (!u.latest || u.failed) msg = PR.t("没连上 GitHub，稍后再试");  // failed 时 latest 是旧缓存，不能说“已经是最新版”
    } catch (err) { msg = PR.t("检查失败：") + PR.esc(err.message); }
    if (box.isConnected) box.innerHTML = panelInner(msg);
  });
  document.addEventListener("change", (e) => {
    if (e.target.dataset.help === "auto") PR.setAutoUpdate(e.target.checked).catch((err) => PR.toast(PR.t("保存失败：") + PR.esc(err.message)));
  });

  setTimeout(() => PR.checkUpdate(false).catch(() => {}), 1500);  // 等文献库先显示出来
})(window.PR);
