/* 边注：共读讨论（discussion.json）和我的笔记（reader.json）。
   宽屏排在正文右侧、贴着对应段落；窄屏或开着侧面板时收成段尾角标，点开在段落下方。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const KIND_LABEL = { explain: PR.t("AI · 解释"), qa: PR.t("AI · 问答"), insight: PR.t("AI · 补充"), reply: PR.t("AI · 回答你的问题"), check: PR.t("原文核对提示") };
  const expanded = new Set();
  PR.editingNote = null;
  PR.asking = new Set();   // 正在等模型回答的问题

  PR.myNotes = () => Object.values(S.reader.notes || {}).filter((n) => !n.deleted);
  PR.repliesTo = (nid) => (S.discussion.entries || []).filter((e) => e.reply_to === nid);
  const anchorOf = (a) => (a && (a === "head" || PR.blockById[a]) ? a : "head");
  PR.anchorOfEntry = (e) => anchorOf(e.anchor || (((S.reader.notes || {})[e.reply_to] || {}).anchor));

  /* 按锚点分组：组内按时间，agent 的回复紧跟在被回复的笔记后面 */
  function collect() {
    const groups = {};
    const push = (anchor, item) => { item.anchor = anchor; (groups[anchor] = groups[anchor] || []).push(item); };
    const noteById = {};
    const notes = PR.myNotes();
    notes.forEach((n) => (noteById[n.id] = n));
    for (const n of notes) {
      if (n.kind === "highlight" && !(n.body || "").trim() && !PR.noteMedia.has(n) && PR.editingNote !== n.id) continue;
      push(anchorOf(n.anchor), { src: "mine", t: n.created || n.updated || "", data: n });
    }
    for (const e of S.discussion.entries || []) {
      const host = e.reply_to && noteById[e.reply_to];
      push(PR.anchorOfEntry(e), { src: "agent", t: host ? (host.created || "") + "~" + (e.at || "") : e.at || "", data: e });
    }
    for (const list of Object.values(groups)) list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    return groups;
  }

  function cardHtml(item, editingId) {
    const d = item.data;
    if (item.src === "agent") {
      return '<div class="card agent' + (d.kind === "check" ? " check" : "") + '" data-card="' + PR.esc(d.id) + '" data-anchor="' + PR.esc(item.anchor) + '">' +
        '<div class="lbl"><span>' + (KIND_LABEL[d.kind] || "AI") + '</span><span class="meta">' + PR.shortTime(d.updated || d.at) + "</span></div>" +
        (d.quote ? '<div class="quote">' + PR.t("「{q}」", { q: PR.md(d.quote, { cite: false, xref: false }) }) + "</div>" : "") +
        (d.title ? '<div class="ttl">' + PR.md(d.title, { xref: false }) + "</div>" : "") +
        (d.q ? '<div class="q">' + PR.md(d.q) + "</div>" : "") +
        '<div class="body">' + PR.mdBlocks(d.body) + "</div>" +
        (PR.store.mode !== "server" ? "" : '<div class="acts">' + (d.reply_to && (S.reader.notes || {})[d.reply_to] && PR.canChat && PR.canChat() ? '<button data-a="regen">' + PR.t("重新回答") + "</button>" : "") +
        '<button data-a="adel">' + PR.t("删除") + "</button></div>") + "</div>";
    }
    const answered = PR.repliesTo(d.id).length > 0;
    const asking = PR.asking.has(d.id);
    const lbl = d.kind === "question" ? PR.t("我的问题") + " · " + (answered ? PR.t("已回复") : asking ? PR.t("模型思考中") : PR.t("待回答")) : d.kind === "highlight" ? PR.t("我的划线") : PR.t("我的笔记");
    const lost = d.quote && PR.quoteLost && PR.quoteLost(d.id) ? " lost" : "";
    const editing = (editingId !== undefined ? editingId : PR.editingNote) === d.id;
    const askLabel = d.kind === "question" ? (answered ? PR.t("追问 AI") : PR.t("让 AI 回答")) : PR.t("让 AI 点评");
    const ask = d.kind !== "highlight" && d.body && PR.canChat && PR.canChat() && PR.feature("chat")
      ? '<button data-a="ask" class="ask"' + (asking ? " disabled" : "") + ">" + (asking ? '<span class="spin"></span> ' + PR.t("正在回答") : PR.icon("sparkle", "sm") + askLabel) + "</button>" : "";
    const body = editing
      ? '<textarea placeholder="' + (d.kind === "question" ? PR.t("想问什么？可以点“让模型回答”，也可以留给下次和 agent 讨论") : PR.t("写下你的理解、疑问或联想…（支持 $公式$、**粗体**）")) + '">' + PR.esc(d.body || "") + "</textarea>" +
        '<div class="kinds"><button data-k="note" class="' + (d.kind !== "question" ? "on" : "") + '">' + PR.t("笔记") + '</button><button data-k="question" class="' + (d.kind === "question" ? "on" : "") + '">' + PR.t("问题") + "</button>" +
        colorDots(d) + '<span class="hint">' + PR.t("自动保存 · Esc 收起") + '</span></div><div class="acts"><button data-note-media="add">' + PR.t("关联图表") + '</button></div>'
      : '<div class="body">' + PR.mdBlocks(d.body) + "</div>" + (ask ? '<div class="ask-row">' + ask + "</div>" : "") +
        '<div class="acts"><button data-a="edit">' + PR.t("编辑") + '</button><button data-note-media="add">' + PR.t("关联图表") + '</button><button data-a="kind">' + (d.kind === "question" ? PR.t("改成笔记") : PR.t("改成问题")) + '</button><button data-a="del">' + PR.t("删除") + "</button></div>";
    return '<div class="card mine' + (editing ? " editing" : "") + (d.color ? " c-" + d.color : "") + '" data-note="' + PR.esc(d.id) + '" data-anchor="' + PR.esc(item.anchor) + '">' +
      '<div class="lbl"><span>' + lbl + '</span><span class="meta">' + PR.shortTime(d.updated || d.created) + "</span></div>" +
      (d.quote ? '<div class="quote' + lost + '"' + (d.side === "en" ? ' lang="en"' : "") + ">" + (d.side === "en" ? '<span class="side-tag">' + PR.t("原文") + "</span>" : "") +
        PR.t("「{q}」", { q: PR.md(d.quote, { cite: false, xref: false }) }) + "</div>" : "") + body + PR.noteMedia.html(d, editingId !== undefined ? "panel" : "margin") + "</div>";
  }
  PR.cardHtml = cardHtml;
  PR.collectNotes = collect;
  function colorDots(d) {
    if (!d.quote) return "";
    return '<span class="dots">' + ["yellow", "green", "blue", "pink"].map((c) =>
      '<button data-color="' + c + '" class="dot-' + c + ((d.color || "yellow") === c ? " on" : "") + '" title="' + PR.t("换颜色") + '"></button>').join("") + "</span>";
  }

  PR.marginWide = () => window.matchMedia("(min-width: 1240px)").matches &&
    !["side-open", "no-margin", "toc-tight"].some((c) => document.body.classList.contains(c));

  PR.renderMargin = function () {
    const groups = collect();
    PR.noteGroups = groups;
    const margin = PR.$("#margin");
    PR.$$(".note-pin, .inline-notes").forEach((n) => n.remove());
    const wide = PR.marginWide();
    margin.innerHTML = "";
    for (const [anchor, items] of Object.entries(groups)) {
      const host = document.getElementById("b-" + anchor);
      if (!host) continue;
      const html = items.map((it) => cardHtml(it)).join("");
      if (wide) margin.insertAdjacentHTML("beforeend", html);
      else {
        const mine = items.every((i) => i.src === "mine");
        host.appendChild(PR.el("button", { class: "note-pin" + (mine ? " mine" : ""), title: PR.t("讨论与笔记"), "data-t": "pin", text: String(items.length) }));
        host.appendChild(PR.el("div", { class: "inline-notes" }, html));
      }
    }
    PR.$$(".card").forEach(prepCard);
    if (wide) PR.layoutMargin();
    PR.emit("margin-rendered");
  };

  function prepCard(card) {
    const body = card.querySelector(".body");
    const id = card.dataset.card || card.dataset.note;
    if (body && body.scrollHeight > 220) {  // 长的先收起；展开过的也留一个“收起全文”（#31）
      const open = expanded.has(id);
      card.classList.toggle("clamp", !open);
      card.insertAdjacentHTML("beforeend", '<button class="more" data-a="more">' + (open ? PR.t("收起全文") : PR.t("展开全文")) + "</button>");
    }
    const ta = card.querySelector("textarea");
    if (ta) PR.autosize(ta);
  }

  /* 宽屏：卡片贴着锚点，放不下就往下顺延 */
  PR.layoutMargin = function () {
    if (!PR.marginWide()) return;
    const margin = PR.$("#margin");
    const mTop = margin.getBoundingClientRect().top;
    const cards = PR.$$(".card", margin).map((c) => {
      const host = document.getElementById("b-" + c.dataset.anchor);
      let y = host ? host.getBoundingClientRect().top - mTop : 0;
      // 划线所在的那边可能藏着（原文模式藏译文）：取看得见的划线，没有就取另一边的同步标记
      const sel = c.dataset.note ? 'mark[data-note="' + c.dataset.note + '"], [data-mirror="' + c.dataset.note + '"]' : 'mark[data-card="' + c.dataset.card + '"]';
      const mark = PR.$$(sel).find((m) => m.getClientRects().length);
      if (mark) y = Math.max(y, mark.getBoundingClientRect().top - mTop - 4);
      return { c, y };
    });
    cards.sort((a, b) => a.y - b.y);
    let bottom = -Infinity;
    for (const { c, y } of cards) {
      const top = Math.max(y, bottom + 16);
      c.style.top = Math.round(top) + "px";
      bottom = top + c.offsetHeight;
    }
    margin.style.minHeight = Math.max(0, bottom) + "px";
  };

  /* ---------- 笔记的增删改 ---------- */
  const noteById = (id) => (S.reader.notes || {})[id];
  PR.saveNote = function (note) { note.updated = PR.nowIso(); PR.commit({ op: "note", note }); };

  PR.startNote = function (opts) {
    const note = Object.assign({ id: PR.uid("n"), kind: "note", body: "", created: PR.nowIso() }, opts);
    PR.saveNote(note);
    if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel(note.id);
    else PR.openNoteEditor(note.id);
    return note;
  };

  PR.openNoteEditor = function (id) {
    if (PR.notesPanelOpen && PR.notesPanelOpen()) { PR.renderNotesPanel(id); return; }
    if (PR.editingNote && PR.editingNote !== id) PR.closeNoteEditor();
    PR.editingNote = id;
    const n = noteById(id);
    PR.renderMargin();
    PR.applyMarks && PR.applyMarks();
    if (!PR.marginWide() && n) { const host = document.getElementById("b-" + anchorOf(n.anchor)); host && host.classList.add("notes-open"); }
    const ta = PR.$('#margin .card[data-note="' + id + '"] textarea, .inline-notes .card[data-note="' + id + '"] textarea');
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const r = ta.getBoundingClientRect();
      if (r.bottom > innerHeight - 40 || r.top < 70) ta.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  PR.closeNoteEditor = function () {
    const id = PR.editingNote;
    if (!id) return;
    const ta = PR.$('.card[data-note="' + id + '"] textarea');
    const n = noteById(id);
    PR.autosaveNote.cancel();
    PR.editingNote = null;
    if (n) PR.finishNote(n, ta ? ta.value : n.body || "");
    PR.renderMargin();
    PR.applyMarks && PR.applyMarks();
  };
  /* 结束编辑：空笔记有原话就退回成划线，没有就删掉 */
  PR.finishNote = function (n, value) {
    if (n.deleted) return;
    const body = value.trim();
    if (!body && !PR.noteMedia.has(n) && !PR.noteMedia.isChoosing(n.id)) {
      if ((n.quote || "").trim()) {
        if (n.kind !== "highlight" || n.body) PR.saveNote(Object.assign({}, n, { kind: "highlight", body: "" }));
      }
      else PR.commit({ op: "note_del", id: n.id });
    } else if (body !== (n.body || "")) PR.saveNote(Object.assign({}, n, { body, kind: n.kind === "highlight" ? "note" : n.kind }));
  };

  PR.autosaveNote = PR.debounce(() => {
    const id = PR.editingNote;
    const ta = id && PR.$('.card[data-note="' + id + '"] textarea');
    const n = id && noteById(id);
    if (ta && n && ta.value.trim() !== (n.body || "")) {
      const copy = Object.assign({}, n, { body: ta.value.trim() });
      if (copy.kind === "highlight" && copy.body) copy.kind = "note";
      PR.saveNote(copy);
    }
  }, 600);

  /* 笔记卡片上的“让 AI 回答 / 点评 / 追问”：在右侧“问 AI”面板里实时回答，答案同时成为这条笔记的回复 */
  PR.askModel = function (nid) {
    const n = noteById(nid);
    if (!n) return;
    const answered = PR.repliesTo(nid).length > 0;
    if (n.kind === "question" && answered) return PR.chatAsk({ anchor: n.anchor, quote: n.quote, draft: "" });
    const text = n.kind === "question" ? n.body : "这是我读这里时写的笔记，请点评：我理解得对不对、有没有漏掉或想错的地方、还可以往哪想。\n\n我的笔记：" + n.body;  // i18n-ok 发给模型的提示词
    PR.chatAsk({ anchor: n.anchor, quote: n.quote, text, note: nid });
  };
  PR.on("job-finished", (j) => {
    if (j.kind !== "answer") return;
    PR.asking.delete(j.note);
    if (j.state === "error") PR.toast(PR.t("模型回答失败：{msg}", { msg: PR.esc(j.message) }));
    PR.renderMargin(); PR.notesPanelOpen && PR.notesPanelOpen() && PR.renderNotesPanel();
  });

  /* ---------- 卡片上的交互（边注和笔记面板共用） ---------- */
  document.addEventListener("input", (e) => {
    if (e.target.matches("#margin .card textarea, .inline-notes .card textarea")) { PR.autosize(e.target); PR.autosaveNote(); PR.layoutMargin(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("#margin .card textarea, .inline-notes .card textarea") && (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey)))) {
      e.preventDefault(); PR.autosaveNote.flush(); PR.closeNoteEditor();
    }
  });
  document.addEventListener("focusout", (e) => {
    if (!e.target.closest("#margin .card[data-note], .inline-notes .card[data-note]")) return;
    setTimeout(() => {
      const card = e.target.closest(".card");
      if (!card || !card.isConnected) return;   // 卡片被重排替换掉了，新卡片已接手编辑
      if (PR.noteMedia.isChoosing(card.dataset.note)) return;
      if (card.contains(document.activeElement)) return;
      if (PR.editingNote === card.dataset.note) { PR.autosaveNote.flush(); PR.closeNoteEditor(); }
    }, 150);
  });

  PR.cardClick = function (e, inPanel) {
    const card = e.target.closest(".card");
    if (!card) return false;
    const a = e.target.closest("[data-a]"), k = e.target.closest("[data-k]"), col = e.target.closest("[data-color]");
    const nid = card.dataset.note;
    const rerender = () => (inPanel ? PR.renderNotesPanel(nid) : PR.openNoteEditor(nid));
    if (a && a.dataset.a === "more") {
      const id = card.dataset.card || nid, open = !expanded.has(id);
      open ? expanded.add(id) : expanded.delete(id);
      card.classList.toggle("clamp", !open);
      a.textContent = open ? PR.t("收起全文") : PR.t("展开全文");
      PR.layoutMargin();
      if (!open && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "nearest" });  // 收起后卡片顶端跑到屏幕上方了，拉回来
      return true;
    }
    if (card.dataset.card && a && (a.dataset.a === "adel" || a.dataset.a === "regen")) { delAgent(card.dataset.card, a.dataset.a === "regen", a); return true; }
    if (nid && a) {
      const n = noteById(nid);
      if (a.dataset.a === "edit") inPanel ? PR.renderNotesPanel(nid) : PR.openNoteEditor(nid);
      else if (a.dataset.a === "ask") PR.askModel(nid);
      else if (a.dataset.a === "kind") { PR.saveNote(Object.assign({}, n, { kind: n.kind === "question" ? "note" : "question" })); inPanel ? PR.renderNotesPanel() : PR.renderMargin(); }
      else if (a.dataset.a === "del") {
        PR.commit({ op: "note_del", id: nid });
        PR.renderMargin(); PR.applyMarks(); inPanel && PR.renderNotesPanel();
        PR.toast(PR.t("已删除这条笔记"), { label: PR.t("撤销"), fn: () => { PR.saveNote(Object.assign({}, n, { deleted: false })); PR.renderMargin(); PR.applyMarks(); inPanel && PR.renderNotesPanel(); } });
      }
      return true;
    }
    if (nid && (k || col)) {
      const n = noteById(nid);
      const ta = card.querySelector("textarea");
      const patch = k ? { kind: k.dataset.k } : { color: col.dataset.color };
      PR.saveNote(Object.assign({}, n, { body: ta ? ta.value.trim() : n.body }, patch));
      PR.applyMarks();
      rerender();
      return true;
    }
    if (nid && e.target.closest(".body") && !e.target.closest("a")) { rerender(); return true; }
    if (card.dataset.anchor && inPanel) { PR.jumpTo("b-" + card.dataset.anchor); return true; }
    return false;
  };
  document.addEventListener("click", (e) => { if (e.target.closest("#margin, .inline-notes")) PR.cardClick(e, false); });

  /* AI 写的卡片：删除；回答类的还能重新回答（删掉旧的，再问一次） */
  async function delAgent(id, regen, btn) {
    const e = (S.discussion.entries || []).find((x) => x.id === id);
    if (!e) return;
    if (!regen && !(await PR.confirm({ title: PR.t("删除这条 AI 内容？"), body: PR.t("删了不能撤销。"), ok: PR.t("删除"), danger: true, at: btn }))) return;
    try {
      await PR.api("/api/p/" + PR.pid + "/discussion_del", { method: "POST", body: { id } });
    } catch (err) { return PR.toast(PR.t("删除失败：{msg}", { msg: PR.esc(err.message) })); }
    S.discussion.entries = S.discussion.entries.filter((x) => x.id !== id);
    PR.renderMargin(); PR.applyMarks();
    if (PR.notesPanelOpen && PR.notesPanelOpen()) PR.renderNotesPanel();
    if (regen) PR.askModel(e.reply_to);
  }

  /* 卡片和段落互相高亮 */
  function link(card, on) {
    const host = document.getElementById("b-" + card.dataset.anchor);
    host && host.classList.toggle("linked", on);
    card.classList.toggle("linked", on);
    const sel = card.dataset.note ? 'mark[data-note="' + card.dataset.note + '"], [data-mirror="' + card.dataset.note + '"]' : 'mark[data-card="' + card.dataset.card + '"]';
    PR.$$(sel).forEach((m) => m.classList.toggle("active", on));
  }
  document.addEventListener("mouseover", (e) => {
    const card = e.target.closest && e.target.closest("#margin .card, #notespanel .card");
    if (card && !card.classList.contains("linked")) { PR.$$(".card.linked").forEach((c) => link(c, false)); link(card, true); }
    if (!card && e.target.closest && !e.target.closest("#margin, #notespanel")) PR.$$(".card.linked").forEach((c) => link(c, false));
  });

  PR.flashCard = function (id) {
    const card = PR.$('.card[data-card="' + id + '"], .card[data-note="' + id + '"]');
    if (!card) return;
    if (!PR.marginWide()) { const host = card.closest(".blk"); host && host.classList.add("notes-open"); }
    card.classList.remove("new"); void card.offsetWidth; card.classList.add("new");
  };
})(window.PR);
