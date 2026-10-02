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
  const st = { loaded: false, threads: [], cur: null, localSeq: 0, models: [], def: "", model: "", answerStyle: "standard", steBilingual: true, listOpen: false, menuOpen: false, usageOpen: false, limits: null, refs: [], auto: null, noAuto: false, streaming: null, draft: "" };
  const isSte = (style) => style === "ste100" || style === "ste100_bilingual";
  const styleOf = (t) => t && isSte(t.answer_style) ? t.answer_style : "standard";
  function setStyle(style) {
    st.answerStyle = style;
    if (isSte(style)) st.steBilingual = style === "ste100_bilingual";
  }

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
      if (added && st.refs.length > 1) PR.toast("已引用 " + st.refs.length + " 段", null, 1000);
    });
  };

  async function load(force, modelsOnly) {
    if (st.loaded && !force) return;
    if (!PR.canChat()) {
      st.threads = (S.chat && S.chat.threads) || []; st.cur = st.cur || (st.threads[0] || {}).id || null; st.loaded = true;
      setStyle(styleOf(thread()));
      return;
    }
    try {
      const d = await PR.api("/api/p/" + PR.pid + "/chat");
      // 设置变更只刷新模型，不能覆盖尚未发送的模式或正在流式回答的对话。
      if (!modelsOnly) st.threads = d.threads || [];
      st.models = d.models || []; st.def = d.default; st.limits = d.limits || null;
      if (!st.model || !st.models.some((m) => m.id === st.model)) st.model = st.def;
      if (!modelsOnly) {
        if (st.cur && !st.threads.some((t) => t.id === st.cur)) st.cur = null;
        if (st.cur) setStyle(styleOf(thread()));
      }
      st.loaded = true;
    } catch (e) { PR.toast("读不到对话记录：" + PR.esc(e.message)); }
  }
  PR.on("settings-saved", () => { if (st.loaded) load(true, true).then(render); });

  const thread = () => st.threads.find((t) => t.id === st.cur) || null;
  const modelOf = (id) => st.models.find((m) => m.id === id) || st.models[0] || { label: "模型" };

  function plainTex(t) {
    return (t || "").replace(/\$\$?([^$]*)\$\$?/g, (m, x) => x.replace(/\\([a-zA-Z]+)\s*/g, (y, name) => ({ mu: "μ", sigma: "σ", epsilon: "ε", alpha: "α", beta: "β", theta: "θ", pi: "π", sum: "Σ", mid: "|", succ: "≻", log: "log ", exp: "exp " })[name] || "").replace(/[{}\\^_]/g, ""));
  }
  function ctxLabel(c) {
    if (!c || !PR.blockById[c.anchor]) return "";
    const b = PR.blockById[c.anchor];
    if (b.type === "math" && !c.quote) return (PR.sectionOf ? PR.sectionOf(c.anchor) + " · " : "") + (b.tag ? "公式 (" + b.tag + ")" : "一个公式");
    const text = plainTex(c.quote || PR.textFor(PR.blockKeys(b)[0] || b.id) || b.caption_zh || b.tex || "").replace(/\*\*|`/g, "");  // 先去公式记号再去粗体，不然 $ 已被 PR.plain 去掉、TeX 原样露出来
    const sec = PR.sectionOf ? PR.sectionOf(c.anchor) : "";
    return (sec ? sec + " · " : "") + "「" + text.slice(0, 18) + (text.length > 18 ? "…" : "") + "」";
  }
  function refChip(r, i, auto) {
    const label = ctxLabel(r);
    const tip = (auto ? "会带上你正在读的这段：" : "引用：") + label + "\n想一起问几段：把正文里选中的文字拖进来，或点段落上的“问 AI”";
    return '<span class="chip-ctx' + (auto ? " auto" : "") + '" title="' + PR.esc(tip) + '">' + PR.icon(auto ? "book" : "link", "sm") + "<span>" + PR.esc(label) +
      '</span><button data-c="' + (auto ? "noauto" : "unref") + '" data-i="' + i + '" title="不带这段">×</button></span>';
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
    return '<div class="ch-head"><button class="ch-title" data-c="list" title="全部对话">' + PR.icon("menu", "sm") + "<span>" + PR.md(t ? t.title : "新对话", { cite: false, xref: false }) + "</span>" + PR.icon("chevron", "sm") + "</button>" +
      '<span class="grow"></span><button class="btn icon" data-c="new" title="新对话">' + PR.icon("plus", "sm") + '</button><button class="btn icon" data-c="close" title="关闭">×</button></div>' +
      (st.listOpen ? listHtml() : "");
  }
  function listHtml() {
    const rows = st.threads.map((t) => '<div class="ch-thread' + (t.id === st.cur ? " on" : "") + '" data-t="' + PR.esc(t.id) + '"><div class="tt">' + PR.md(t.title, { cite: false, xref: false }) + "</div>" +
      '<div class="tm">' + Math.round((t.messages || []).length / 2) + " 问 · " + PR.esc(when(t.updated)) + "</div>" +
      '<button class="tx" data-c="rename" title="' + (st.streaming ? "请先停止当前回答" : "改名") + '"' + (st.streaming ? " disabled" : "") + '>' + PR.icon("edit", "sm") +
      '</button><button class="tx" data-c="del" title="' + (st.streaming ? "请先停止当前回答" : "删除") + '"' + (st.streaming ? " disabled" : "") + '>' + PR.icon("trash", "sm") + "</button></div>").join("");
    return '<div class="ch-list"><button class="ch-thread newt" data-c="new">' + PR.icon("plus", "sm") + "新对话</button>" + (rows || '<div class="hint" style="padding:10px 12px">还没有对话。</div>') + "</div>";
  }
  function msgHtml(m) {
    if (m.role === "user") {
      return '<div class="cm user"><div class="bubble">' + PR.md(m.content, { cite: false, xref: false }) + "</div>" +
        ((m.refs && m.refs.length ? m.refs : m.anchor ? [m] : []).filter((r) => PR.blockById[r.anchor])
          .map((r) => '<button class="cm-ctx" data-c="go" data-anchor="' + PR.esc(r.anchor) + '">' + PR.icon("link", "sm") + "<span>" + PR.esc(ctxLabel(r)) + "</span></button>").join("")) + "</div>";
    }
    const live = st.streaming && st.streaming.msg === m;
    return '<div class="cm ai' + (m.error ? " err" : "") + '" data-id="' + PR.esc(m.id || "") + '"><div class="who"><span class="av">' + PR.icon("sparkle", "sm") + "</span>" + PR.esc(m.model || "AI") +
      (isSte(m.answer_style) ? '<span class="cm-style">ASD-STE100' + (m.answer_style === "ste100_bilingual" ? " · 中英对照" : "") + '</span>' : "") + (live ? ' <span class="spin"></span>' : "") + "</div>" +
      '<div class="body">' + (m.error ? PR.esc(m.error) : m.content ? PR.mdBlocks(m.content) : '<p class="thinking"><i></i><i></i><i></i></p>') + "</div>" +
      (!live && !m.error && m.id ? '<div class="acts"><button data-c="copy">' + PR.icon("copy", "sm") + "复制</button>" + (PR.canChat() ? '<button data-c="pin" title="作为 AI 讨论放到这段旁边">' + PR.icon("note", "sm") + "放到页边</button>" : "") +
        (m.usage && m.usage.calls ? '<span class="cm-usage" title="输入 ' + PR.fmtTokens(m.usage.input) + "（缓存命中 " + PR.fmtTokens(m.usage.cached) + "），输出 " + PR.fmtTokens(m.usage.output) + '">' + PR.fmtTokens(m.usage.input + m.usage.output) + " token</span>" : "") + "</div>" : "") + "</div>";
  }
  function emptyHtml() {
    const counts = markCounts();
    const colors = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const sug = ["这段在说什么？用大白话讲一遍", "这个公式每一项是什么意思？怎么推出来的？", "这里的结论靠得住吗？有什么前提？"];
    if (isSte(st.answerStyle)) sug.unshift("总结这篇论文的主要问题、方法、结果和局限");
    if (colors.length) sug.unshift("我标" + colorName(colors[0]) + "的那些地方，彼此有什么联系？", "把我划过线的内容串成一条主线讲讲");
    return '<div class="ch-empty">' + PR.logo("hero") + "<b>边读边问</b><p>默认带上你正在读的段落；把正文里选中的文字拖到输入框，可以引用多段一起问。" + (colors.length ? "问到“标" + colorName(colors[0]) + "的”“划线”时，会自动找出你的 " + Object.values(counts).reduce((a, b) => a + b, 0) + " 处标记。" : "") + "</p>" +
      '<div class="chips">' + sug.map((q) => '<button data-c="suggest">' + PR.esc(q) + "</button>").join("") + "</div></div>";
  }
  function composerHtml() {
    if (!PR.canChat()) {
      const repo = (S.demo && S.demo.repo) || "https://github.com/Edwardxlai/easyread";
      return '<div class="ch-compose ch-readonly"><b>这是演示里的对话记录，这里不能提问</b><span>装到自己电脑上之后，边读边问 Claude、GPT 或免费模型；可以引用多段，问“我标红的那些”也能找到。</span>' +
        '<a class="btn sm accent" href="' + repo + '" target="_blank" rel="noopener">去 GitHub 安装 ↗</a></div>';
    }
    const m = modelOf(st.model);
    const chips = st.refs.length ? st.refs.map((r, i) => refChip(r, i)).join("") : st.auto && !st.noAuto ? refChip(st.auto, 0, true) : "";
    const menu = st.menuOpen ? '<div class="ch-menu">' + st.models.map((x) => '<button data-c="model" data-m="' + PR.esc(x.id) + '" class="' + (x.id === st.model ? "on" : "") + '"' + (x.ready === false ? ' disabled title="' + PR.esc(x.hint) + '"' : "") + ">" +
      "<b>" + PR.esc(x.label) + "</b><small>" + PR.esc(x.ready === false ? x.hint : [x.source, x.id === st.def ? "默认" : ""].filter(Boolean).join(" · ")) + "</small></button>").join("") +
      '<hr><button data-c="manage">' + PR.icon("gear", "sm") + "管理模型…</button></div>" : "";
    const style = '<div class="ch-style"><label for="chatAnswerStyle">回答方式</label><select id="chatAnswerStyle"' + (st.streaming ? " disabled" : "") + '>' +
      '<option value="standard"' + (st.answerStyle === "standard" ? " selected" : "") + '>普通问答</option>' +
      '<option value="ste100"' + (isSte(st.answerStyle) ? " selected" : "") + '>ASD-STE100 问答</option></select>' +
      (isSte(st.answerStyle) ? '<label class="ch-bilingual" title="用于下一次回答"><input type="checkbox" id="chatSteBilingual"' + (st.steBilingual ? " checked" : "") + (st.streaming ? " disabled" : "") + '>中英文对照</label>' +
        '<span class="ch-style-hint">' + (st.steBilingual ? "中文在上，英文在下" : "简明中文回答") + '</span>' : "") + '</div>';
    return '<div class="ch-compose">' + style + (chips ? '<div class="ch-chips">' + chips + "</div>" : "") +
      '<textarea id="chatInput" rows="1" placeholder="问点什么…">' + PR.esc(st.draft) + "</textarea>" +
      '<div class="ch-bar"><button class="ch-model" data-c="menu" title="换模型">' + PR.esc(m.label) + PR.icon("chevron", "sm") + "</button>" + menu +
      '<span class="grow"></span>' + PR.usageChip(st.limits, thread() && thread().messages, st.usageOpen) +
      (st.usageOpen ? PR.usagePop(st.limits, thread() && thread().messages) : "") + (st.streaming ? '<button class="ch-send stop" data-c="stop" title="停止">' + PR.icon("stop", "sm") + "</button>"
        : '<button class="ch-send" data-c="send" title="发送（Enter）；换行用 Shift+Enter">' + PR.icon("arrowUp", "sm") + "</button>") + "</div></div>";
  }
  function render() {
    const el = panel();
    if (!el) return;
    const ta = PR.$("#chatInput");
    if (ta) st.draft = ta.value;
    const t = thread();
    const msgs = t ? t.messages || [] : [];
    el.innerHTML = headHtml() + '<div class="ch-scroll" id="chatList">' + (msgs.length ? msgs.map(msgHtml).join("") : st.loaded ? emptyHtml() : '<p class="hint" style="padding:20px">加载中…</p>') + "</div>" + composerHtml();
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
    if (!text || st.streaming) return;
    const refs = only || sendRefs();
    const c = refs[0] || null;
    const answerStyle = st.answerStyle;
    const modelId = st.model;
    let t = thread();
    if (!t) { t = { id: null, title: text.slice(0, 22), messages: [], updated: PR.nowIso() }; st.threads.unshift(t); }
    t.answer_style = answerStyle;
    t.model = modelId;
    const user = { role: "user", content: text, anchor: c ? c.anchor : null, quote: c ? c.quote : "", note: noteId || null, refs, answer_style: answerStyle };
    const msg = { role: "assistant", content: "", model: modelOf(modelId).label, answer_style: answerStyle };
    t.messages.push(user, msg);
    const ctrl = new AbortController();
    st.streaming = { ctrl, msg };
    st.draft = ""; st.listOpen = false; st.menuOpen = false;
    if (PR.$("#chatInput")) PR.$("#chatInput").value = "";
    if (noteId) { PR.asking.add(noteId); PR.renderMargin(); }
    render();
    try {
      const res = await fetch("/api/p/" + PR.pid + "/chat", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ thread: t.local ? null : t.id, text, anchor: user.anchor, quote: user.quote, refs, note: noteId || null, model: modelId, answer_style: answerStyle }),
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
      if (e.name === "AbortError") msg.content += "\n\n（已停止）";
      else msg.error = "没能回答：" + e.message;
    }
    st.streaming = null;
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
    if (!b) { if ((st.menuOpen && !e.target.closest(".ch-menu")) || (st.usageOpen && !e.target.closest(".us-pop"))) { st.menuOpen = st.usageOpen = false; render(); } return; }
    const c = b.dataset.c;
    const row = b.closest(".ch-thread[data-t]");
    if (c === "close") return PR.toggleChat(false);
    if (c === "list") { st.listOpen = !st.listOpen; st.menuOpen = false; return render(); }
    if (c === "new") { if (st.streaming) return; st.cur = null; st.listOpen = false; st.model = st.def; st.answerStyle = "standard"; st.steBilingual = true; st.refs = []; st.noAuto = false; autoContext(); render(); return focusInput(); }
    if (c === "menu") { st.menuOpen = !st.menuOpen; st.listOpen = st.usageOpen = false; return render(); }
    if (c === "usage") { st.usageOpen = !st.usageOpen; st.listOpen = st.menuOpen = false; return render(); }
    if (c === "model") { st.model = b.dataset.m; st.menuOpen = false; return render(); }
    if (c === "manage") { st.menuOpen = false; render(); return PR.openSettings("chat"); }
    if (c === "send") return send(PR.$("#chatInput").value);
    if (c === "stop" && st.streaming) return st.streaming.ctrl.abort();
    if (c === "suggest") return send(b.textContent);
    if (c === "unref") { st.refs.splice(+b.dataset.i, 1); return render(); }
    if (c === "noauto") { st.noAuto = true; return render(); }
    if (c === "go") return PR.jumpTo("b-" + b.dataset.anchor);
    if ((c === "rename" || c === "del") && st.streaming) return PR.toast("请先停止当前回答，再修改对话");
    if (c === "rename" && row) {
      const t = st.threads.find((x) => x.id === row.dataset.t);
      if (!t) return;
      const title = await PR.promptText({ title: "对话改名", value: t.title, ok: "改名", at: row });
      if (title) { t.title = title; if (!t.local) await PR.api("/api/p/" + PR.pid + "/chat/rename", { method: "POST", body: { thread: t.id, title: t.title } }); render(); }
      return;
    }
    if (c === "del" && row) {
      const t = st.threads.find((x) => x.id === row.dataset.t);
      if (!t) return;
      if (!(await PR.confirm({ title: "删除这个对话？", body: "「" + t.title + "」。已经放到页边的讨论不受影响。", ok: "删除", danger: true, at: row }))) return;
      if (!t.local) await PR.api("/api/p/" + PR.pid + "/chat/delete", { method: "POST", body: { thread: t.id } });
      st.threads = st.threads.filter((x) => x !== t);
      if (st.cur === t.id) { st.cur = null; st.answerStyle = "standard"; st.steBilingual = true; }
      return render();
    }
    const card = b.closest(".cm.ai");
    const m = card && thread() && thread().messages.find((x) => x.id === card.dataset.id);
    if (c === "copy" && m) navigator.clipboard.writeText(m.content).then(() => PR.toast("已复制"));
    if (c === "pin" && m) {
      try {
        await PR.api("/api/p/" + PR.pid + "/chat/pin", { method: "POST", body: { thread: st.cur, id: m.id } });
        PR.toast("已放到页边"); setTimeout(() => PR.poll && PR.poll(), 200);
      } catch (err) { PR.toast("没放成：" + PR.esc(err.message)); }
    }
  });
  document.addEventListener("click", (e) => {  // 点对话列表里的一行：切过去
    const row = e.target.closest("#chatpanel .ch-thread[data-t]");
    if (!row || e.target.closest("[data-c]") || st.streaming) return;
    st.cur = row.dataset.t; st.listOpen = false;
    const t = thread();
    if (t && t.model && st.models.some((m) => m.id === t.model)) st.model = t.model;
    setStyle(styleOf(t));
    render();
  });
  document.addEventListener("change", (e) => {
    if (st.streaming) return;
    if (e.target.id === "chatAnswerStyle") {
      st.answerStyle = e.target.value === "ste100" ? (st.steBilingual ? "ste100_bilingual" : "ste100") : "standard";
    } else if (e.target.id === "chatSteBilingual" && isSte(st.answerStyle)) {
      st.steBilingual = e.target.checked;
      st.answerStyle = st.steBilingual ? "ste100_bilingual" : "ste100";
    } else return;
    const t = thread();
    if (t) t.answer_style = st.answerStyle;
    render();
  });
  document.addEventListener("keydown", (e) => {
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
    if (el && st.auto) { el.textContent = ctxLabel(st.auto); el.parentElement.title = "会带上你正在读的这段：" + ctxLabel(st.auto); } else render();
  }, 400), { passive: true });
})(window.PR);
