/* 右侧“问 AI”面板：边读边和模型实时对话，回答逐字流出来。
   - 多个对话：顶部点标题展开对话列表，可以新建、切换、改名、删除（存在论文目录的 chat.json）。
   - 模型：输入框左下角切换，名单在“设置 → 模型”里配（默认 Claude Opus 5.5 / Sonnet 5.5 / GPT）。
   - 上下文：默认带上你正在读的段落；可以引用多段——选中文字点“问 AI”、段落操作条的“问 AI”，
     或者把选中的文字直接拖进输入框，每段一个小标签，可以逐个去掉。
   - 你的划线、笔记、问题不会每次都带；问到“标红的”“划线”“我的笔记”时，后台才把对应颜色的标记找出来。
   - 页边笔记里的问题也从这里回答，答案同时写成那条笔记的回复。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const panel = () => PR.$("#chatpanel");
  const st = { loaded: false, threads: [], cur: null, localSeq: 0, models: [], def: "", model: "", answerStyle: "standard", listOpen: false, menuOpen: false, styleOpen: false, usageOpen: false, limits: null, refs: [], auto: null, noAuto: false, streaming: null, draft: "" };
  const STYLES = ["standard", "ste100", "xray"];
  const styleOf = (value) => STYLES.indexOf(value) >= 0 ? value : "standard";   // 只认这三档，其余（旧数据、脏值）一律回到 standard
  const styleOfThread = (t) => styleOf(t && t.answer_style);
  const styleLabel = (s) => s === "ste100" ? PR.t("简明回答") : s === "xray" ? PR.t("精读") : PR.t("标准回答");
  const styleHint = (s) => (s === "ste100" ? PR.t("简明回答：短句、一句只讲一件事、步骤分条列出，数字和前提条件一个不丢。")
    : s === "xray" ? PR.t("精读：解释设计动机、推导公式、核对实验依据；没有报告的内容明确说明。")
    : PR.t("标准回答：直接、具体，能举例就举例。")) + PR.t("会参考已整理正文；过长时提供节选。");
  Object.assign(st, { chatOptions: {}, effortOpen: false, catalog: null });
  const imageDraft = PR.createChatImages(st, panel, render, () => focusInput());
  const imagesHtml = imageDraft.html;

  PR.canChat = () => PR.store.mode === "server";
  /* 在线演示 / 离线版：带着对话记录时可以看，不能问 */
  PR.chatView = () => PR.canChat() || !!(S.chat && (S.chat.threads || []).length);
  PR.chatOpen = () => PR.side === "chat";
  PR.toggleChat = function (force) {
    const open = force != null ? force : PR.side !== "chat";
    PR.openSide(open ? "chat" : null);
    if (open) { autoContext(); load().then(() => { render(); focusInput(); }); render(); }
  };
  const focusInput = () => setTimeout(() => { const t = PR.$("#chatInput"); t && t.focus(); }, 300);

  function autoContext() {
    const id = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock();
    st.auto = PR.blockById[id] ? { anchor: id, quote: "" } : null;
  }
  function addRef(anchor, quote) {
    if (!PR.blockById[anchor]) return false;
    quote = (quote || "").trim();
    if (st.refs.some((r) => r.anchor === anchor && r.quote === quote)) return false;
    st.refs = st.refs.filter((r) => !(r.anchor === anchor && !r.quote && quote)).concat({ anchor, quote });  // 同段先引整段、再选一句：换成那句
    return true;
  }
  /* 这次提问带哪几段：手动引用的；没有就用正在读的那段 */
  const sendRefs = () => (st.refs.length ? st.refs.slice() : st.auto && !st.noAuto ? [st.auto] : []);

  /* 外部入口：段落操作条、选中文字（都是“加一段引用”），笔记卡片（直接问这一条） */
  PR.chatAsk = function (opts) {
    if (PR.side !== "chat") { PR.openSide("chat"); autoContext(); }
    load().then(() => {
      if (opts.text) return send(opts.text, opts.note, [{ anchor: opts.anchor, quote: opts.quote || "" }]);
      const added = addRef(opts.anchor, opts.quote);
      if (opts.draft) st.draft = opts.draft;
      render(); focusInput();
      if (added && st.refs.length > 1) PR.toast(PR.t("已引用 {n} 段", { n: st.refs.length }), null, 1000);
    });
  };

  async function load(force, modelsOnly) {
    if (st.loaded && !force) return;
    if (!PR.canChat()) {
      st.threads = (S.chat && S.chat.threads) || []; st.cur = st.cur || (st.threads[0] || {}).id || null; st.loaded = true;
      st.answerStyle = styleOfThread(thread());
      return;
    }
    try {
      const d = await PR.api("/api/p/" + PR.pid + "/chat");
      // 设置变更只刷新模型，不能覆盖尚未发送的模式或正在流式回答的对话。
      if (!modelsOnly) st.threads = d.threads || [];
      st.models = d.models || []; st.def = d.default; st.limits = d.limits || null;
      if (!st.catalog) st.catalog = ((await PR.api("/api/engines").catch(() => ({}))).models || {});
      if (!st.model || !st.models.some((m) => m.id === st.model)) st.model = st.def;
      if (!modelsOnly) {
        if (st.cur && !st.threads.some((t) => t.id === st.cur)) st.cur = null;
        if (st.cur) { st.answerStyle = styleOfThread(thread()); st.chatOptions = { ...(thread().chat_options || {}) }; }
      }
      st.loaded = true;
    } catch (e) { PR.toast(PR.t("读不到对话记录：{msg}", { msg: PR.esc(e.message) })); }
  }
  PR.on("settings-saved", () => { if (st.loaded) load(true, true).then(render); });

  const thread = () => st.threads.find((t) => t.id === st.cur) || null;
  const modelOf = (id) => st.models.find((m) => m.id === id) || st.models[0] || { label: PR.t("模型") };

  function plainTex(t) {
    return (t || "").replace(/\$\$?([^$]*)\$\$?/g, (m, x) => x.replace(/\\([a-zA-Z]+)\s*/g, (y, name) => ({ mu: "μ", sigma: "σ", epsilon: "ε", alpha: "α", beta: "β", theta: "θ", pi: "π", sum: "Σ", mid: "|", succ: "≻", log: "log ", exp: "exp " })[name] || "").replace(/[{}\\^_]/g, ""));
  }
  function ctxLabel(c) {
    if (!c || !PR.blockById[c.anchor]) return "";
    const b = PR.blockById[c.anchor];
    if (b.type === "math" && !c.quote) return (PR.sectionOf ? PR.sectionOf(c.anchor) + " · " : "") + (b.tag ? PR.t("公式 ({tag})", { tag: b.tag }) : PR.t("一个公式"));
    const text = plainTex(c.quote || PR.textFor(PR.blockKeys(b)[0] || b.id) || b.caption_zh || b.tex || "").replace(/\*\*|`/g, "");  // 先去公式记号再去粗体，不然 $ 已被 PR.plain 去掉、TeX 原样露出来
    const sec = PR.sectionOf ? PR.sectionOf(c.anchor) : "";
    return (sec ? sec + " · " : "") + PR.t("「{q}」", { q: text.slice(0, 18) + (text.length > 18 ? "…" : "") });
  }
  function refChip(r, i, auto) {
    const label = ctxLabel(r);
    const tip = (auto ? PR.t("会带上你正在读的这段：") : PR.t("引用：")) + label + "\n" + PR.t("想一起问几段：把正文里选中的文字拖进来，或点段落上的“问 AI”");
    return '<span class="chip-ctx' + (auto ? " auto" : "") + '" title="' + PR.esc(tip) + '">' + PR.icon(auto ? "book" : "link", "sm") + "<span>" + PR.esc(label) +
      '</span><button data-c="' + (auto ? "noauto" : "unref") + '" data-i="' + i + '" title="' + PR.t("不带这段") + '">×</button></span>';
  }
  function markCounts() {
    const out = {};
    PR.myNotes().forEach((n) => { if (n.quote) out[n.color || "yellow"] = (out[n.color || "yellow"] || 0) + 1; });
    return out;
  }
  const colorName = (c) => (PR.HL_COLORS.find(([k]) => k === c) || [c, c])[1];
  const when = (iso) => (iso ? PR.shortTime(iso) : "");

  /* ---------- 画面 ---------- */
  function headHtml() {
    const t = thread();
    return '<div class="ch-head"><button class="ch-title" data-c="list" title="' + PR.t("全部对话") + '">' + PR.icon("menu", "sm") + "<span>" + PR.md(t ? t.title : PR.t("新对话"), { cite: false, xref: false }) + "</span>" + PR.icon("chevron", "sm") + "</button>" +
      '<span class="grow"></span><button class="btn icon" data-c="new" title="' + PR.t("新对话") + '">' + PR.icon("plus", "sm") + '</button><button class="btn icon" data-c="close" title="' + PR.t("关闭") + '">×</button></div>' +
      (st.listOpen ? listHtml() : "");
  }
  function listHtml() {
    const rows = st.threads.map((t) => '<div class="ch-thread' + (t.id === st.cur ? " on" : "") + '" data-t="' + PR.esc(t.id) + '"><div class="tt">' + PR.md(t.title, { cite: false, xref: false }) + "</div>" +
      '<div class="tm">' + PR.t("{n} 问", { n: Math.round((t.messages || []).length / 2) }) + " · " + PR.esc(when(t.updated)) + "</div>" +
      '<button class="tx" data-c="rename" title="' + (st.streaming ? PR.t("请先停止当前回答") : PR.t("改名")) + '"' + (st.streaming ? ' disabled' : '') + '>' + PR.icon("edit", "sm") + '</button><button class="tx" data-c="del" title="' + (st.streaming ? PR.t("请先停止当前回答") : PR.t("删除")) + '"' + (st.streaming ? ' disabled' : '') + '>' + PR.icon("trash", "sm") + "</button></div>").join("");
    return '<div class="ch-list"><button class="ch-thread newt" data-c="new">' + PR.icon("plus", "sm") + PR.t("新对话") + "</button>" + (rows || '<div class="hint" style="padding:10px 12px">' + PR.t("还没有对话。") + "</div>") + "</div>";
  }
  function msgHtml(m) {
    if (m.role === "user") {
      return '<div class="cm user"><div class="bubble">' + PR.md(m.content, { cite: false, xref: false }) + "</div>" + imagesHtml(m.images || [], false) +
        ((m.refs && m.refs.length ? m.refs : m.anchor ? [m] : []).filter((r) => PR.blockById[r.anchor])
          .map((r) => '<button class="cm-ctx" data-c="go" data-anchor="' + PR.esc(r.anchor) + '">' + PR.icon("link", "sm") + "<span>" + PR.esc(ctxLabel(r)) + "</span></button>").join("")) + "</div>";
    }
    const live = st.streaming && st.streaming.msg === m;
    return '<div class="cm ai' + (m.error ? " err" : "") + '" data-id="' + PR.esc(m.id || "") + '"><div class="who"><span class="av">' + PR.icon("sparkle", "sm") + "</span>" + PR.esc(m.model || "AI") +
      (STYLES.indexOf(m.answer_style) > 0 ? '<span class="cm-style">' + styleLabel(m.answer_style) + "</span>" : "") + (live ? ' <span class="spin"></span>' : "") + "</div>" +
      '<div class="body">' + (m.error ? PR.esc(m.error) : m.content ? PR.mdBlocks(m.content) : '<p class="thinking"><i></i><i></i><i></i></p>') + "</div>" +
      (!live && !m.error && m.id ? '<div class="acts"><button data-c="copy">' + PR.icon("copy", "sm") + PR.t("复制") + "</button>" + (PR.canChat() ? '<button data-c="pin" title="' + PR.t("作为 AI 讨论放到这段旁边") + '">' + PR.icon("note", "sm") + PR.t("放到页边") + "</button>" : "") +
        (PR.canChat() ? '<button data-c="export-md">' + PR.icon("download", "sm") + PR.t("导出 Markdown") + '</button>' : '') +
        (m.usage && m.usage.calls ? '<span class="cm-usage" title="' + PR.t("输入 {input}（缓存命中 {cached}），输出 {output}", { input: PR.fmtTokens(m.usage.input), cached: PR.fmtTokens(m.usage.cached), output: PR.fmtTokens(m.usage.output) }) + '">' + PR.fmtTokens(m.usage.input + m.usage.output) + " token</span>" : "") + "</div>" : "") + "</div>";
  }
  function emptyHtml() {
    const counts = markCounts();
    const colors = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const sug = [PR.t("这段在说什么？用大白话讲一遍"), PR.t("这个公式每一项是什么意思？怎么推出来的？"), PR.t("这里的结论靠得住吗？有什么前提？")];
    if (colors.length) sug.unshift(PR.t("我标{color}的那些地方，彼此有什么联系？", { color: colorName(colors[0]) }), PR.t("把我划过线的内容串成一条主线讲讲"));
    return '<div class="ch-empty">' + PR.logo("hero") + "<b>" + PR.t("边读边问") + "</b><p>" + PR.t("默认带上你正在读的段落；把正文里选中的文字拖到输入框，可以引用多段一起问。") + (colors.length ? PR.t("问到“标{color}的”“划线”时，会自动找出你的 {n} 处标记。", { color: colorName(colors[0]), n: Object.values(counts).reduce((a, b) => a + b, 0) }) : "") + "</p>" +
      '<div class="chips">' + sug.map((q) => '<button data-c="suggest">' + PR.esc(q) + "</button>").join("") + "</div></div>";
  }
  function composerHtml() {
    if (!PR.canChat()) {
      const repo = (S.demo && S.demo.repo) || "https://github.com/Edwardxlai/easyread";
      return '<div class="ch-compose ch-readonly"><b>' + PR.t("这是演示里的对话记录，这里不能提问") + "</b><span>" + PR.t("装到自己电脑上之后，边读边问 Claude、GPT 或免费模型；可以引用多段，问“我标红的那些”也能找到。") + "</span>" +
        '<a class="btn sm accent" href="' + repo + '" target="_blank" rel="noopener">' + PR.t("去 GitHub 安装 ↗") + "</a></div>";
    }
    const m = modelOf(st.model);
    const chips = st.refs.length ? st.refs.map((r, i) => refChip(r, i)).join("") : st.auto && !st.noAuto ? refChip(st.auto, 0, true) : "";
    const menu = st.menuOpen ? '<div class="ch-menu">' + st.models.map((x) => '<button data-c="model" data-m="' + PR.esc(x.id) + '" class="' + (x.id === st.model ? "on" : "") + '"' + (x.ready === false ? ' disabled title="' + PR.esc(x.hint) + '"' : "") + ">" +
      "<b>" + PR.esc(x.label) + (x.id === st.model ? '<span class="ch-model-check">✓</span>' : '') + "</b><small>" + PR.esc(x.ready === false ? x.hint : [x.source, x.id === st.def ? PR.t("默认") : ""].filter(Boolean).join(" · ")) + "</small></button>").join("") +
      PR.chatEffort.section(st, m) + '<hr><button data-c="manage">' + PR.icon("gear", "sm") + PR.t("管理模型…") + "</button></div>" : "";
    // 回答方式（标准 / 简明回答 / 精读）：一个小按钮放在模型旁边，点开再选，不单独占一行
    const styleOn = st.answerStyle !== "standard";
    const style = '<button class="ch-pill' + (styleOn ? " on" : "") + '" data-c="style" data-style="' + st.answerStyle + '"' + (st.streaming ? " disabled" : "") + ' aria-expanded="' + st.styleOpen + '" title="' +
      PR.esc(styleHint(st.answerStyle)) + '">' + styleLabel(st.answerStyle) + "</button>";
    const styleMenu = st.styleOpen ? '<div class="ch-menu">' + STYLES.map((s) => '<button data-c="style-pick" data-s="' + s + '" class="' + (s === st.answerStyle ? "on" : "") + '">' +
      "<b>" + styleLabel(s) + (s === st.answerStyle ? '<span class="ch-model-check">✓</span>' : "") + "</b><small>" + PR.esc(styleHint(s)) + "</small></button>").join("") + "</div>" : "";
    const imageStatus = st.imageError || (st.imageLoading ? PR.t("正在读取图片…") : "");
    return '<div class="ch-compose">' + (chips ? '<div class="ch-chips">' + chips + "</div>" : "") +
      imagesHtml(st.images, true) + (imageStatus ? '<div class="ch-attach-status" role="' + (st.imageError ? 'alert' : 'status') + '">' + PR.esc(imageStatus) + '</div>' : '') +
      '<textarea id="chatInput" rows="1" aria-label="' + PR.t("提问，可粘贴图片") + '" placeholder="' + (st.images.length ? PR.t("补充问题，或直接发送图片…") : PR.t("输入问题，或粘贴截图…")) + '">' + PR.esc(st.draft) + "</textarea>" +
      '<div class="ch-bar"><button class="ch-model" data-c="menu" title="' + PR.t("换模型和思考强度") + '"' + (st.streaming ? ' disabled' : '') + '>' + PR.esc(m.label) + PR.chatEffort.suffix(st, m) + PR.icon("chevron", "sm") + "</button>" + style + styleMenu + menu +
      '<span class="grow"></span>' + PR.usageChip(st.limits, thread() && thread().messages, st.usageOpen) +
      (st.usageOpen ? PR.usagePop(st.limits, thread() && thread().messages) : "") + (st.streaming ? '<button class="ch-send stop" data-c="stop" title="' + PR.t("停止") + '">' + PR.icon("stop", "sm") + "</button>"
        : '<button class="ch-send" data-c="send" title="' + PR.t("发送（Enter）；换行用 Shift+Enter") + '">' + PR.icon("arrowUp", "sm") + "</button>") + "</div></div>";
  }
  function render() {
    const el = panel();
    if (!el) return;
    const ta = PR.$("#chatInput");
    if (ta) st.draft = ta.value;
    const t = thread();
    const msgs = t ? t.messages || [] : [];
    el.innerHTML = headHtml() + '<div class="ch-scroll" id="chatList">' + (msgs.length ? msgs.map(msgHtml).join("") : st.loaded ? emptyHtml() : '<p class="hint" style="padding:20px">' + PR.t("加载中…") + "</p>") + "</div>" + composerHtml();
    const box = PR.$("#chatList");
    box.scrollTop = box.scrollHeight;
    const input = PR.$("#chatInput");
    if (input) PR.autosize(input);
  }
  function renderLive() {
    const node = st.streaming && PR.$("#chatList .cm.ai:last-child .body");
    if (!node) return;
    node.innerHTML = st.streaming.msg.content ? PR.mdBlocks(st.streaming.msg.content) : '<p class="thinking"><i></i><i></i><i></i></p>';
    const box = PR.$("#chatList");
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }
  const renderLiveSoon = PR.throttle(renderLive, 60);

  /* ---------- 发送 ---------- */
  async function send(text, noteId, only) {
    text = (text || "").trim();
    if (st.imageLoading || st.streaming || (!text && !st.images.length)) return;
    const images = only ? [] : st.images.map(image => image.data);
    if (!text && images.length) text = PR.t("请解释这张图片。");
    const refs = only || sendRefs();
    const c = refs[0] || null;
    const answerStyle = st.answerStyle;
    const modelId = st.model;
    const chatOptions = { ...st.chatOptions };
    let t = thread();
    if (!t) { t = { id: null, title: text.slice(0, 22), messages: [], updated: PR.nowIso() }; st.threads.unshift(t); }
    t.answer_style = answerStyle;
    t.model = modelId;
    t.chat_options = chatOptions;
    const user = { role: "user", content: text, anchor: c ? c.anchor : null, quote: c ? c.quote : "", note: noteId || null, refs, answer_style: answerStyle, images };
    const msg = { role: "assistant", content: "", model: modelOf(modelId).label, answer_style: answerStyle };
    t.messages.push(user, msg);
    const ctrl = new AbortController();
    st.streaming = { ctrl, msg };
    if (!only) { st.images = []; st.imageError = ""; }
    st.draft = ""; st.listOpen = false; st.menuOpen = false; st.effortOpen = false;
    if (PR.$("#chatInput")) PR.$("#chatInput").value = "";
    if (noteId) { PR.asking.add(noteId); PR.renderMargin(); }
    render();
    try {
      const res = await fetch("/api/p/" + PR.pid + "/chat", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ thread: t.local ? null : t.id, text, anchor: user.anchor, quote: user.quote, refs, note: noteId || null, model: modelId, answer_style: answerStyle, chat_options: chatOptions, images }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.thread && (!t.id || t.local)) { t.id = ev.thread; delete t.local; st.cur = ev.thread; }
          if (ev.model) msg.model = ev.model;
          if (ev.answer_style) msg.answer_style = t.answer_style = ev.answer_style;
          if (ev.t) { msg.content += ev.t; renderLiveSoon(); }
          if (ev.done) { msg.id = ev.id; if (ev.usage) msg.usage = ev.usage; if (ev.usage && ev.usage.limits) st.limits = { limits: ev.usage.limits, at: Date.now() / 1000 }; }
          if (ev.error) msg.error = ev.error;
        }
      }
    } catch (e) {
      if (e.name === "AbortError") msg.content += "\n\n" + PR.t("（已停止）");
      else msg.error = PR.t("没能回答：{msg}", { msg: e.message });
    }
    st.streaming = null;
    if (msg.error && !only) {
      st.images = images.map(data => ({data})).concat(st.images).slice(0, 4);
      st.draft = PR.$("#chatInput")?.value || text;
      if (PR.$("#chatInput")) PR.$("#chatInput").value = st.draft;
    }
    // 首次提问在服务端分配 ID 前失败，也应能切到新对话或重试。
    if (!t.id) { t.id = "local-" + (++st.localSeq); t.local = true; st.cur = t.id; }
    t.updated = PR.nowIso();
    if (noteId) { PR.asking.delete(noteId); setTimeout(() => PR.poll && PR.poll(), 300); }
    if (!only) { st.refs = []; st.noAuto = false; autoContext(); }  // 问完清掉引用，回到“正在读”
    render();
  }

  /* ---------- 事件 ---------- */
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("#chatpanel")) return;
    const b = e.target.closest("[data-c]");
    if (!b) {
      const menu = (st.menuOpen || st.styleOpen) && !e.target.closest(".ch-menu");
      const pop = st.usageOpen && !e.target.closest(".us-pop");
      if (menu || pop) { st.menuOpen = st.styleOpen = st.usageOpen = false; render(); }
      return;
    }
    const c = b.dataset.c;
    const row = b.closest(".ch-thread[data-t]");
    if (c === "close") return PR.toggleChat(false);
    if (c === "unimage") { st.images.splice(Number(b.dataset.i), 1); st.imageError = ""; render(); return focusInput(); }
    if (c === "list") { st.listOpen = !st.listOpen; st.menuOpen = st.styleOpen = false; return render(); }
    if (c === "new") { if (st.streaming) return; st.chatOptions = {}; st.effortOpen = false; st.cur = null; st.listOpen = false; st.model = st.def; st.answerStyle = "standard"; st.styleOpen = false; st.refs = []; st.noAuto = false; imageDraft.reset(); st.draft = ""; if (PR.$("#chatInput")) PR.$("#chatInput").value = ""; autoContext(); render(); return focusInput(); }
    if (c === "style") { if (st.streaming) return; st.styleOpen = !st.styleOpen; st.menuOpen = st.listOpen = st.usageOpen = false; return render(); }
    if (c === "style-pick") {
      if (st.streaming) return;
      st.answerStyle = styleOf(b.dataset.s);
      st.styleOpen = false;
      const t = thread();
      if (t) t.answer_style = st.answerStyle;
      return render();
    }
    if (c === "effort-level") { if (st.streaming) return; const m = modelOf(st.model); st.chatOptions.reasoning_effort = b.dataset.effort === PR.chatEffort.fallback(st, m) && !m.reasoning_effort ? "" : b.dataset.effort; return render(); }  // 菜单不关；点的就是默认档就不传，跟着 CLI
    if (c === "menu") { st.menuOpen = !st.menuOpen; st.listOpen = st.styleOpen = st.usageOpen = false; return render(); }
    if (c === "usage") { st.usageOpen = !st.usageOpen; st.listOpen = st.menuOpen = st.styleOpen = false; return render(); }
    if (c === "model") { if (st.streaming) return; st.chatOptions = {}; st.model = b.dataset.m; st.menuOpen = false; return render(); }
    if (c === "manage") { st.menuOpen = false; render(); return PR.openSettings("chat"); }
    if (c === "send") return send(PR.$("#chatInput").value);
    if (c === "stop" && st.streaming) return st.streaming.ctrl.abort();
    if (c === "suggest") return send(b.textContent);
    if (c === "unref") { st.refs.splice(+b.dataset.i, 1); return render(); }
    if (c === "noauto") { st.noAuto = true; return render(); }
    if (c === "go") return PR.jumpTo("b-" + b.dataset.anchor);
    if ((c === "rename" || c === "del") && st.streaming) return PR.toast(PR.t("请先停止当前回答，再修改对话"));
    if (c === "rename" && row) {
      const t = st.threads.find((x) => x.id === row.dataset.t);
      if (!t) return;
      const title = await PR.promptText({ title: PR.t("对话改名"), value: t.title, ok: PR.t("改名"), at: row });
      if (title) { t.title = title; if (!t.local) await PR.api("/api/p/" + PR.pid + "/chat/rename", { method: "POST", body: { thread: t.id, title: t.title } }); render(); }
      return;
    }
    if (c === "del" && row) {
      const t = st.threads.find((x) => x.id === row.dataset.t);
      if (!t) return;
      if (!(await PR.confirm({ title: PR.t("删除这个对话？"), body: PR.t("「{title}」。已经放到页边的讨论不受影响。", { title: t.title }), ok: PR.t("删除"), danger: true, at: row }))) return;
      if (!t.local) await PR.api("/api/p/" + PR.pid + "/chat/delete", { method: "POST", body: { thread: t.id } });
      st.threads = st.threads.filter((x) => x !== t);
      if (st.cur === t.id) { imageDraft.reset(); st.cur = null; st.answerStyle = "standard"; }
      return render();
    }
    const card = b.closest(".cm.ai");
    const m = card && thread() && thread().messages.find((x) => x.id === card.dataset.id);
    if (c === "export-md" && m) return PR.exportChatMarkdown(st.cur, m.id, b);
    if (c === "copy" && m) navigator.clipboard.writeText(m.content).then(() => PR.toast(PR.t("已复制")));
    if (c === "pin" && m) {
      try {
        await PR.api("/api/p/" + PR.pid + "/chat/pin", { method: "POST", body: { thread: st.cur, id: m.id } });
        PR.toast(PR.t("已放到页边")); setTimeout(() => PR.poll && PR.poll(), 200);
      } catch (err) { PR.toast(PR.t("没放成：{msg}", { msg: PR.esc(err.message) })); }
    }
  });
  document.addEventListener("click", (e) => {  // 点对话列表里的一行：切过去
    const row = e.target.closest("#chatpanel .ch-thread[data-t]");
    if (!row || e.target.closest("[data-c]") || st.streaming) return;
    if (st.cur !== row.dataset.t) imageDraft.reset();
    st.cur = row.dataset.t; st.listOpen = false;
    const t = thread();
    if (t && t.model && st.models.some((m) => m.id === t.model)) st.model = t.model;
    st.answerStyle = styleOfThread(t);
    st.chatOptions = { ...((t && t.chat_options) || {}) }; st.effortOpen = false;
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (st.effortOpen || st.menuOpen)) { st.effortOpen = st.menuOpen = false; render(); return; }
    if (e.target.id !== "chatInput") return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.target.value); }
    if (e.key === "Escape") e.target.blur();
  });
  document.addEventListener("input", (e) => { if (e.target.id === "chatInput") PR.autosize(e.target); });

  /* 把正文里选中的文字拖进问 AI 面板：变成一段引用，而不是一堆粘进来的字 */
  let dragRef = null;
  document.addEventListener("dragstart", (e) => {
    const sel = window.getSelection();
    const node = sel && sel.rangeCount && sel.getRangeAt(0).startContainer;
    const host = node && (node.nodeType === 1 ? node : node.parentElement).closest("#paper [id^='b-']");
    dragRef = host ? { anchor: host.id.slice(2), quote: sel.toString().trim().slice(0, 1000) } : null;
    if (dragRef && PR.chatOpen()) panel().classList.add("drop-ok");
  });
  document.addEventListener("dragend", () => { dragRef = null; panel().classList.remove("drop-ok", "drop-on"); });
  panel().addEventListener("dragover", (e) => { if (!dragRef) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; panel().classList.add("drop-on"); });
  panel().addEventListener("dragleave", (e) => { if (!panel().contains(e.relatedTarget)) panel().classList.remove("drop-on"); });
  panel().addEventListener("drop", (e) => {
    if (!dragRef) return;
    e.preventDefault();
    panel().classList.remove("drop-ok", "drop-on");
    const { anchor, quote } = dragRef;
    dragRef = null;
    addRef(anchor, quote);
    render(); focusInput();
  });
  /* 读到别处时，上下文跟着换成当前段（手动指定的不动） */
  window.addEventListener("scroll", PR.debounce(() => {
    if (!PR.chatOpen() || st.streaming) return;
    const before = st.auto && st.auto.anchor;
    autoContext();
    if ((st.auto && st.auto.anchor) === before || st.refs.length || st.noAuto) return;
    const el = PR.$(".chip-ctx.auto > span");
    if (el && st.auto) { el.textContent = ctxLabel(st.auto); el.parentElement.title = PR.t("会带上你正在读的这段：") + ctxLabel(st.auto); } else render();
  }, 400), { passive: true });
})(window.PR);
