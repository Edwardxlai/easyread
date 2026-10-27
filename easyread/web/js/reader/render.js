/* 把 paper.json 的块排成正文。译文优先取“我的修改”，否则取译者稿。
   只读原文（不翻译）整理出来的块没有 zh，正文直接排英文；之后翻译了就地换成中文。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const failedFigureImages = new Set();
  PR.failFigureImage = function (id, url) {
    const b = PR.blockById[id];
    if (!b?.translated_image?.src || PR.imageUrl(b.translated_image.src) !== url) return;
    failedFigureImages.add(url);
    PR.renderBlock(id);
    PR.applyMarks(id);
  };
  PR.hasTranslatedFigure = function (b) {
    const t = b.translated_image;
    return !!(t?.src && t.source === b.src && t.target === (S.paper.meta?.target || 'zh') &&
      t.image_en === (b.image_en || '') && t.image_zh === (PR.editOf(b.id + '#image')?.zh ?? b.image_zh ?? '') &&
      !failedFigureImages.has(PR.imageUrl(t.src)));
  };

  /* ---------- 译文取值：key 形如 "s1-p1"、"tab1#caption"、"s1-recs#2" ---------- */
  PR.blockById = {};
  function fields(key) {  // [译文, 原文]
    const [id, field] = key.split("#");
    const b = PR.blockById[id];
    if (!b) return ["", ""];
    if (field === "caption") return [b.caption_zh || "", b.caption_en || ""];
    if (field === "image") return [b.image_zh || "", b.image_en || ""];
    if (field != null && /^\d+$/.test(field)) { const it = (Array.isArray(b.items) ? b.items : [])[+field] || {}; return [it.zh || "", it.en || ""]; }
    return [b.zh || "", b.en || ""];
  }
  PR.agentText = function (key) { const [zh, en] = fields(key); return zh || en; };
  /* 这处还没有译文、正文排的是英文原文（只读原文） */
  PR.isEnKey = function (key) { const [zh, en] = fields(key); return !zh && !!en && !PR.editOf(key); };
  PR.hasZh = (b) => !!(b.zh || b.caption_zh || b.image_zh || PR.hasTranslatedFigure(b) || (Array.isArray(b.items) && b.items.some((i) => i && i.zh)));
  PR.editOf = function (key) { const e = (S.reader.edits || {})[key]; return e && e.zh != null ? e : null; };
  PR.textFor = function (key) { const e = PR.editOf(key); return e ? e.zh : PR.agentText(key); };
  PR.isStale = function (key) { const e = PR.editOf(key); return !!(e && e.base && e.base !== PR.hashText(PR.agentText(key))); };
  PR.blockKeys = function (b) {
    if (b.type === "list") return (Array.isArray(b.items) ? b.items : []).map((_, i) => b.id + "#" + i);
    if (b.type === "table") return [b.id + "#caption"];
    if (b.type === "figure") return [b.id + "#caption"].concat(b.image_zh || b.image_en ? [b.id + "#image"] : []);
    if (b.type === "math" || b.type === "references" || b.type === "note") return [];
    return [b.id];
  };

  function buildIndex() {
    PR.buildFootnoteIndex(S.paper.blocks);
    PR.blockById = {};
    PR.xindex = { eq: {}, tab: {}, fig: {}, sec: {} };
    PR.headings = [];
    PR.refById = {};
    PR.order = {};
    (S.paper.references || []).forEach((r) => (PR.refById[String(r.id)] = r));
    (S.paper.blocks || []).forEach((b, i) => {
      if (!b || typeof b !== "object") return;
      PR.blockById[b.id] = b;
      PR.order[b.id] = i;
      if (b.type === "math" && b.tag) PR.xindex.eq[b.tag] = b.id;
      if (b.type === "table" && b.num) PR.xindex.tab[b.num] = b.id;
      if (b.type === "figure" && b.num) PR.xindex.fig[b.num] = b.id;
      if (b.type === "heading" || b.type === "references") { if (b.num) PR.xindex.sec[b.num] = b.id; PR.headings.push(b); }
    });
  }

  function staleTag(key) { return PR.isStale(key) ? '<button class="stale-tag" data-t="stale" title="' + PR.t("你改过这段之后，译者稿又更新了") + '">' + PR.t("译者稿有更新") + "</button>" : ""; }
  // 段落和列表项有句子对齐时一句一个 span（sentences.js），没有就整段
  const sentMd = (key, side, text) => (PR.sentMd ? PR.sentMd(key, side, text) : PR.md(text, PR.footnoteOptions(key)));
  function zhDiv(key) {
    const en = PR.isEnKey(key) ? ' lang="en"' : "";
    return '<div class="zh' + (en ? " en-main" : "") + '"' + en + ' data-key="' + PR.esc(key) + '">' + sentMd(key, "zh", PR.textFor(key)) + staleTag(key) + "</div>";
  }
  const enIfZh = (key, text) => (PR.isEnKey(key) ? "" : enDiv(text, key));  // 正文已经是英文了，就不再附一份原文
  function enDiv(text, key) { return text ? '<div class="en" lang="en">' + (key ? sentMd(key, "en", text) : PR.md(text)) + "</div>" : ""; }

  function captionHtml(b) {
    const key = b.id + "#caption";
    const text = PR.textFor(key);
    const m = text.match(/^([^：:]{1,12})[：:]/);
    const opts = PR.footnoteOptions(b.id);
    const body = m ? '<span class="label">' + PR.esc(m[1]) + "</span>" + PR.md(text.slice(m[1].length), opts) : PR.md(text, opts);
    const en = PR.isEnKey(key) ? ' lang="en"' : "";
    return '<div class="caption"><div class="zh' + (en ? " en-main" : "") + '"' + en + ' data-key="' + key + '">' + body + staleTag(key) + "</div>" + enIfZh(key, b.caption_en) + "</div>";
  }
  function tableRows(value) {
    if (!Array.isArray(value) || !value.length) return [];
    if (value.every((row) => !Array.isArray(row))) return [value];
    return value.map((row) => Array.isArray(row) ? row : [row]);
  }
  function cell(c) { return PR.md(String(c), { xref: false, cite: false }).replace(/<br>(\([^<]*\))/g, '<br><span class="sub">$1</span>'); }
  function linkify(t) { return PR.esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,;)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>'); }

  /* 图块的归一化裁剪框 [x0,y0,x1,y1]；不合格式就返回 null（渲染时按默认处理）。 */
  function figureBox(value) {
    if (!Array.isArray(value) || value.length !== 4) return null;
    const v = value.map(Number);
    if (v.some((x) => !isFinite(x))) return null;
    return v.every((x, i) => x >= -0.01 && x <= 1.01 && (i < 2 ? true : x > v[i - 2])) ? v : null;
  }

  const R = {
    heading(b) {
      const tag = (b.level || 1) === 1 ? "h2" : "h3";
      const en = PR.isEnKey(b.id);
      return "<" + tag + ' class="zh' + (en ? ' en-main" lang="en"' : '"') + ' data-key="' + b.id + '">' + (b.num ? '<span class="num">' + PR.esc(b.num) + "</span>" : "") +
        "<span>" + PR.md(PR.textFor(b.id), PR.footnoteOptions(b.id)) + "</span>" + staleTag(b.id) +
        (b.en && !en ? '<span class="en-title" lang="en">' + PR.md(b.en, { cite: false, xref: false }) + "</span>" : "") + "</" + tag + ">";
    },
    para: (b) => (b.role === "footnote" ? '<span class="footnote-label"><sup>' + PR.esc(b.num || "") + "</sup></span>" : "") + zhDiv(b.id) + enIfZh(b.id, b.en),
    list(b) {
      const tag = b.ordered ? "ol" : "ul";
      const items = Array.isArray(b.items) ? b.items : [];
      return "<" + tag + ">" + items.map((it, i) => "<li>" + zhDiv(b.id + "#" + i) + enIfZh(b.id + "#" + i, it && it.en) + "</li>").join("") + "</" + tag + ">";
    },
    math: (b) => '<div class="math-row"><div class="math-body">' + PR.tex(b.tex, true) + "</div>" + (b.tag ? '<div class="math-tag">(' + PR.esc(b.tag) + ")</div>" : "") + "</div>",
    table(b) {
      const al = (b.align || "").split("");
      const style = (i) => (al[i] ? ' style="text-align:' + ({ l: "left", r: "right", c: "center" }[al[i]] || "left") + '"' : "");
      const head = tableRows(b.head).map((r) => "<tr>" + r.map((c, i) => "<th" + style(i) + ">" + cell(c) + "</th>").join("") + "</tr>").join("");
      const rows = tableRows(b.rows).map((r) => "<tr>" + r.map((c, i) => "<td" + style(i) + ">" + cell(c) + "</td>").join("") + "</tr>").join("");
      const table = '<div class="tbl-wrap"><table class="tbl"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>";
      return b.caption_pos === "above" ? captionHtml(b) + table : table + captionHtml(b);
    },
    figure(b) {
      // 图按原 PDF 的物理尺寸（1pt = 4/3 CSS px）显示，和原页一致；版心放不下时 max-width:100% 兜底。
      // 优先用 abox（截图实际用的框，按 PDF 图形边界校正过）；模型给的 box 常偏紧，只在没有 abox 时退用。两个都没有维持浏览器默认。
      let style = "";
      const page = b.page && (S.paper.meta || {}).pages ? (S.paper.meta.pages.find((p) => p.n === b.page) || {}) : {};
      const box = figureBox(b.abox) || figureBox(b.box);
      if (box && page.w) {
        const w = Math.round((box[2] - box[0]) * page.w * 4 / 3);
        if (w >= 24) style = ' style="width:' + Math.min(w, Math.round(page.w * 4 / 3)) + 'px"';
      }
      const img = b.src ? '<img src="' + PR.imageUrl(b.src) + '" alt="" loading="lazy"' + style + '>'
        : '<button class="fig-missing" data-t="page">' + PR.t("图见原文第 {n} 页（点击查看）", { n: b.page }) + "</button>";
      const key = b.id + "#image";
      const imageText = b.image_zh || b.image_en ? '<div class="figure-translation"><div class="figure-translation-label">' + PR.t("图内文字") + '</div>' + zhDiv(key) + enIfZh(key, b.image_en) + '</div>' : "";
      const translated = b.translated_image;
      const current = PR.hasTranslatedFigure(b);
      const failed = translated?.src && failedFigureImages.has(PR.imageUrl(translated.src));
      const original = '<div class="figure-media">' + img + '</div>' + imageText;
      const generate = PR.store.mode === 'server' && S.figure_images_enabled && b.src ? '<p class="figure-image-actions"><button class="btn sm line" data-t="figure-image"' + (jobRunning() ? ' disabled' : '') + '>' +
        (translated?.src ? PR.t("重新生成译图") : PR.t("生成译图")) + '</button></p>' : '';
      // 图片和正文共用 .zh / .en 配对，沿用阅读模式、双语顺序和单块展开。
      // 有可用译图时不渲染图内文字；加载失败后才恢复文字兜底。
      return (current ? '<div class="figure-generated"><div class="zh paired-translation figure-media"><img data-translated-figure src="' + PR.esc(PR.imageUrl(translated.src)) +
        '" alt="' + PR.t("译图") + '" loading="lazy"' + style + '></div><div class="en figure-media">' + img + '</div></div>'
        : (failed ? '<div class="figure-translation-label">' + PR.t("译图未能加载，已显示原图和文字译文") + '</div>' : '') + original) + generate + captionHtml(b);
    },
    note: (b) => '<div class="inline-note"><div class="lbl">' + PR.t("阅读批注（非原文）") + "</div>" + PR.mdBlocks(b.zh) + "</div>",
    references(b) {
      const refs = (S.paper.references || []).map((r) => '<li id="ref-' + PR.esc(r.id) + '"><span class="n">[' + PR.esc(r.id) + "]</span><span>" + linkify(r.text) + "</span></li>").join("");
      if (!b.zh && b.en) return '<h2 class="zh en-main" lang="en" data-key="' + b.id + '"><span>' + PR.esc(b.en) + '</span></h2><div class="refs"><ol>' + refs + "</ol></div>";
      return '<h2 class="zh" data-key="' + b.id + '"><span>' + PR.esc(b.zh || PR.t("参考文献")) + '</span><span class="en-title" lang="en">' + PR.esc(b.en || "References") + "</span></h2>" +
        '<div class="refs"><p class="note">' + PR.t("条目保留原文，便于检索。") + "</p><ol>" + refs + "</ol></div>";
    },
  };

  function blockClass(b) {
    let c = "blk blk-" + b.type;
    if (b.type === "heading") c += " h" + (b.level || 1) + (b.appendix ? " appendix" : "");
    if (b.type === "references") c += " blk-heading h1";
    if (b.cont) c += " cont";
    if (b.role === "abstract") c += " abstract";
    if (b.role === "footnote") c += " footnote";
    return c;
  }
  const edited = (b) => PR.blockKeys(b).some((k) => PR.editOf(k));

  function sectionHtml(b, extraClass, pageMark) {
    return '<section class="' + blockClass(b) + (extraClass || "") + '" id="b-' + PR.esc(b.id) + '" data-id="' + PR.esc(b.id) + '">' +
      (pageMark ? '<button class="pgmark" data-t="page" title="' + PR.t("看原文第 {n} 页", { n: b.page }) + '">p.' + b.page + "</button>" : "") +
      R[b.type](b) + (edited(b) ? '<span class="edited-dot" title="' + PR.t("这里有你改过的译文") + '"></span>' : "") + "</section>";
  }

  function blockErrorHtml(b, error) {
    const id = PR.esc(b && b.id ? b.id : "unknown");
    console.error("EasyRead block render failed", b && b.id, error);
    return '<section class="blk blk-error" id="b-' + id + '" data-id="' + id + '">' +
      '<div class="inline-note"><div class="lbl">' + PR.t("这一块没能显示") + '</div><p>' + PR.t("块 {id} 的数据格式有问题，其他内容仍可阅读。", { id }) + '</p></div></section>';
  }

  /* 在线演示的署名和许可（CC BY 要求写明出处），网址做成链接 */
  function creditHtml() {
    const c = S.demo && S.demo.credit;
    if (!c) return "";
    const link = (u) => '<a href="' + u + '" target="_blank" rel="noopener">' + u.replace(/^https?:\/\//, "") + "</a>";
    return '<p class="demo-credit">' + PR.esc(c).replace(/https?:\/\/[^\s（）()，。,]+/g, link) + "</p>";
  }

  function headHtml() {
    const m = S.paper.meta || {};
    const tr = S.paper.translation || {};
    const kicker = [m.arxiv, m.venue, m.date].filter(Boolean).map(PR.esc).join("　·　");
    const by = [m.authors, m.affiliation].filter(Boolean).map(PR.esc).join("　·　");
    const pages = (m.pages || []).length, done = (tr.done_pages || []).length, en = (tr.en_pages || []).length;
    const toZh = en && PR.canAsk() && !jobRunning() && (S.job || {}).state !== "confirm" ? '<button class="btn sm line" data-t="translate-en">' + PR.t("翻译成{lang}", { lang: PR.targetName((S.paper.meta || {}).target || PR.target) }) + "</button>" : "";
    const scope = (en ? "<b>" + PR.t("英文原文") + "</b>　" + (done - en ? PR.t("其中 {n} 页已译，", { n: done - en }) : "") + PR.t("{n} 页没有翻译", { n: en }) + toZh
      : "<b>" + PR.t("译文") + "</b>　" + (pages ? (done >= pages ? PR.t("全文 {n} 页", { n: pages }) : PR.t("已译 {done} / {n} 页", { done, n: pages })) : PR.t("尚未处理"))) +
      (tr.note ? "　" + PR.esc(tr.note) : "") +
      '<br><span class="reading-language-description">' + (en ? PR.t("没译的地方正文是英文原文") : PR.t("正文是译文")) + '</span>' + PR.t('；<span class="legend-agent"></span>青色细线是 AI 的解释和回答，<span class="legend-mine"></span>赭色细线是我的笔记，都不属于原文。');
    return '<header class="paper-head" id="b-head" data-id="head">' + (kicker ? '<div class="kicker">' + kicker + "</div>" : "") +
      "<h1>" + PR.titleHtml(m.title_zh || m.title_en || PR.t("（正在识别标题）")) + "</h1>" +
      (m.title_zh && m.title_en && m.title_zh !== m.title_en ? '<p class="title-en" lang="' + (m.target === "en" ? "" : "en") + '">' + PR.titleHtml(m.title_en) + "</p>" : "") +
      (by ? '<p class="byline">' + by + "</p>" : "") + '<p class="scope">' + scope + "</p>" + figureJobsHtml() + creditHtml() + "</header>";
  }

  function figureJobsHtml() {
    if (PR.store.mode !== 'server' || !(S.paper.blocks || []).some(b => b.type === 'figure' && b.src)) return '';
    const job = S.job || {}, running = jobRunning();
    if (!S.figure_images_enabled && !(job.type === 'figure-images' && running)) return '';
    const button = S.figure_images_enabled ? '<button class="btn sm line" data-t="figure-images"' + (running ? ' disabled' : '') + '>' + PR.t("为本文生成译图") + '</button>' : '';
    const hint = S.figure_images_enabled ? '<span class="hint">' + PR.t("只补齐缺失或已过期的译图，不重译正文") + '</span>' : '';
    if (job.type !== 'figure-images') return '<div class="figure-job">' + button + ' ' + hint + '</div>';
    return '<div class="figure-job" role="status">' + button + ' ' + hint + '<p>' + PR.esc(job.message || '') +
      (running ? ' ' + PR.t("（{done}/{total} 张）", {done: job.done || 0, total: job.total || 0}) +
        ' <button class="btn sm line" data-t="cancel-figure-images">' + PR.t("取消") + '</button>' : '') + '</p>' +
      (job.error ? '<p class="err">' + PR.esc(job.error) + '</p>' : '') +
      (S.figure_images_enabled && !running && Object.keys(job.image_failed || {}).length ? '<button class="btn sm line" data-t="retry-figure-images">' + PR.t("重试失败的译图") + '</button>' : '') + '</div>';
  }

  /* 还没译的页：放原页图，边译边读 */
  const origFig = (p) => '<figure class="orig-page" id="orig-' + p.n + '"><figcaption>' + PR.t("原文第 {n} 页", { n: p.n }) + '</figcaption><img loading="lazy" style="aspect-ratio:' + (Number(p.w) > 0 ? Number(p.w) : 612) + '/' + (Number(p.h) > 0 ? Number(p.h) : 792) + '" src="' + PR.imageUrl(p.img) + '" alt="' + PR.t("原文第 {n} 页", { n: p.n }) + '"></figure>';
  const failedOf = () => ((S.job || {}).state === "partial" && S.job.failed) || {};
  const jobRunning = () => ["queued", "running"].includes((S.job || {}).state);
  const reading = () => !!((S.job || {}).read || ((S.paper.translation || {}).en_pages || []).length);  // 这篇是只读原文

  /* 中间漏掉的页（多半是译失败了）：就地放原页，给重试 */
  function gapHtml(pages) {
    const failed = failedOf();
    const bad = pages.filter((p) => failed[p.n]);
    const running = ["queued", "running"].includes((S.job || {}).state);
    const label = pages.length > 1 ? PR.t("第 {a}–{b} 页", { a: pages[0].n, b: pages[pages.length - 1].n }) : PR.t("第 {n} 页", { n: pages[0].n });
    const head = bad.length ? (reading() ? PR.t("{label}没整理成功：", { label }) : PR.t("{label}没译成功：", { label })) + PR.esc(failed[bad[0].n]) + (PR.canAsk() && !running ? '<button class="btn sm line" data-t="retry-failed">' + PR.t("重试") + "</button>" : "")
      : running ? (reading() ? PR.t("{label}还在排队整理，先放原页。", { label }) : PR.t("{label}还在排队翻译，先放原页。", { label }))
      : reading() ? PR.t("{label}还没整理，先放原页。", { label }) : PR.t("{label}还没有译文，先放原页。", { label });
    return '<div class="pending-pages gap"><div class="pending' + (bad.length ? " bad" : "") + '">' + head + "</div>" + pages.map(origFig).join("") + "</div>";
  }

  function pendingHtml(lastPage) {
    const m = S.paper.meta || {};
    const done = new Set((S.paper.translation || {}).done_pages || []);
    const miss = (m.pages || []).filter((p) => !done.has(p.n) && p.n > lastPage);
    if (!(m.pages || []).length) {
      const job = S.job || {};
      const running = ["queued", "running"].includes(job.state);
      const message = running ? '<span class="spin"></span> ' + PR.esc(job.message || PR.t("正在渲染原页、抽取文字…"))
        : PR.t("原页尚未准备完成") + (job.state === "error" ? '<div class="err">' + PR.esc(job.error || job.message || PR.t("出错了")) + '</div>' : "") +
          (PR.store.mode === "server" ? '<p class="hint">' + PR.t("请确认 PDF 在本机可读取、文献库目录可写，并关闭占用大量内存的程序后重试。重试仅准备原页，不调用翻译模型。") +
            '</p><button class="btn sm accent" data-t="retry-prepare">' + PR.t("重试") + '</button>' : "");
      // The remote job listener watches this wrapper, including before page 1 exists.
      return '<div class="pending-pages"><div class="pending">' + message + '</div></div>';
    }
    if (!miss.length) return "";
    const job = S.job || {};
    const running = ["queued", "running"].includes(job.state);
    const nFailed = miss.filter((p) => failedOf()[p.n]).length;
    const head = job.state === "confirm" ? PR.t("等待确认期间，仍可阅读原页。") : running ? '<span class="spin"></span> ' + PR.esc(job.message || PR.t("翻译中")) + (job.total ? PR.t("（{done}/{total} 页）", { done: job.done, total: job.total }) : "") + '<span class="hint">' + PR.t("译好的页会自动出现在这里") + (PR.usageShort(job.usage) ? " · " + PR.esc(PR.usageShort(job.usage)) : "") + "</span>"
      : reading() ? PR.t("下面 {n} 页还没整理，先放原页。", { n: miss.length }) + (nFailed ? PR.t("其中 {n} 页上次没整理成功。", { n: nFailed }) : "") +
        (PR.canAsk() && job.state !== "error" ? '<button class="btn sm line" data-t="read-rest">' + PR.t("整理剩下的页") + "</button>" : "")
      : PR.t("下面 {n} 页还没有译文，先放原页。", { n: miss.length }) + (nFailed ? PR.t("其中 {n} 页上次没译成功。", { n: nFailed }) : "") +
        (PR.canAsk() ? '<button class="btn sm line" data-t="translate-rest">' + PR.t("翻译剩下的页") + "</button>" : "");
    const recovery = job.read && job.state === "error" && PR.store.mode === "server"
      ? '<div class="err">' + PR.esc(job.error || job.message || "") + '</div><p class="hint">' + PR.t("整理原文需要可用模型。请检查模型设置后重试；重试使用当前翻译模型，已整理的内容会保留。") +
        '</p><button class="btn sm line" data-t="model-settings">' + PR.t("模型设置") + '</button> <button class="btn sm accent" data-t="read-rest">' + PR.t("重试整理原文") + "</button>"
      : "";
    return '<div class="pending-pages"><div class="pending">' + head + recovery + "</div>" + miss.map(origFig).join("") + "</div>";
  }

  PR.renderPaper = function () {
    buildIndex();
    let html = headHtml() + (PR.store.mode === "server" ? PR.pageCapHtml(S.job) : ""), appendixSeen = false, lastPage = 0;
    const done = new Set((S.paper.translation || {}).done_pages || []);
    const allPages = (S.paper.meta || {}).pages || [];
    for (const raw of S.paper.blocks || []) {
      const b = raw && typeof raw === "object" ? raw : null;
      if (!b || !R[b.type]) continue;
      if (b.page && b.page > lastPage + 1) {
        const gap = allPages.filter((p) => p.n > lastPage && p.n < b.page && !done.has(p.n));
        if (gap.length) html += gapHtml(gap);
      }
      let extra = "";
      if (b.appendix && !appendixSeen) { extra = " appendix-start"; appendixSeen = true; }
      const mark = b.page && b.page > lastPage;
      if (b.page) lastPage = Math.max(lastPage, b.page);
      try {
        html += sectionHtml(b, extra, mark);
      } catch (error) {
        html += blockErrorHtml(b, error);
      }
    }
    PR.updatePaperHtml(PR.$("#paper"), html + pendingHtml(lastPage));
    // 一段译文都没有（只读原文）：顶栏的“译文 / 对照”没意义，藏起来
    document.body.classList.toggle("en-only", (S.paper.blocks || []).length > 0 && !(S.paper.blocks || []).some((b) => b && PR.hasZh(b)));
    // 译文语言决定正文字体（base.css 按 data-target 换字体）；1.3 以前译的论文没记语言，都是中文
    const target = (S.paper.meta || {}).target || ((S.paper.blocks || []).some((b) => b && PR.hasZh(b)) ? "zh" : PR.target);
    document.documentElement.dataset.target = target;
    const paperEl = document.getElementById("paper");
    if (paperEl) paperEl.lang = target === "zh" ? "zh-CN" : target;  // 让浏览器选对简繁、日文、韩文字形，西文能断词
    PR.emit("rendered");
  };

  /* 只重排一个块（编辑保存后用），不动别的块 */
  PR.renderBlock = function (id) {
    const b = PR.blockById[id];
    const node = document.getElementById("b-" + id);
    if (!b || !node || !R[b.type]) return;
    const fresh = document.createElement("div");
    try {
      fresh.innerHTML = sectionHtml(b, node.classList.contains("appendix-start") ? " appendix-start" : "", !!node.querySelector(":scope > .pgmark"));
    } catch (error) {
      fresh.innerHTML = blockErrorHtml(b, error);
    }
    const nn = fresh.firstChild;
    ["show-en", "notes-open", "current"].forEach((c) => node.classList.contains(c) && nn.classList.add(c));
    node.replaceWith(nn);
    PR.emit("block-rendered", id);
  };

  /* 版心放不下的长公式、宽表格：先缩小字号，再不行才横向滚动。
     公式原本多宽只和字号、字体有关，量一次记下来；开关侧栏、改窗口大小只是版心变了，不用再把几百个公式复原重量一遍
     （复原再量要整页重排，长论文一两百毫秒，点“原页”“笔记”会明显顿一下）。 */
  // 记的是 { w, over }：over 为真时 w 是放不下时量到的真实宽度；为假时只知道“宽 w 的版心放得下”，版心变窄得重量
  const natural = new WeakMap();
  let typeface = "";
  PR.fitWide = function (scope, remeasure) {  // remeasure：字体刚加载完这类，量过的也不作数
    const paper = PR.$("#paper");
    const cs = getComputedStyle(paper);
    const tf = cs.fontSize + "|" + cs.fontFamily;
    const fresh = remeasure || tf !== typeface;
    typeface = tf;
    const boxes = PR.$$(".math-body, .tbl-wrap", fresh ? paper : scope || paper).filter((box) => box.firstElementChild);
    const avail = boxes.map((box) => box.clientWidth);
    const todo = boxes.filter((box, i) => {
      const n = !fresh && natural.get(box.firstElementChild);
      return !n || !n.w || (!n.over && avail[i] < n.w - 1);  // w 为 0：上次量时藏着（比如对照模式的英文）
    });
    // 要重量的：先全部复原、再一起量、最后一起改，边改边量会让浏览器每个公式都重排一次整页
    todo.forEach((box) => { box.firstElementChild.style.fontSize = ""; });
    todo.forEach((box) => {
      const need = box.firstElementChild.scrollWidth, w = box.clientWidth;
      natural.set(box.firstElementChild, need > w + 1 ? { w: need, over: true } : { w, over: false });
    });
    const floor = window.innerWidth < 760 ? 0.58 : 0.72;
    boxes.forEach((box, i) => {
      const n = natural.get(box.firstElementChild);
      let size = "";
      if (n.over && n.w > avail[i] + 1) {
        const r = Math.max(floor, avail[i] / n.w) * 0.99;
        size = box.classList.contains("tbl-wrap") ? (0.86 * r).toFixed(3) + "em" : (r * 100).toFixed(1) + "%";
      }
      if (box.firstElementChild.style.fontSize !== size) box.firstElementChild.style.fontSize = size;
    });
  };
  PR.on("rendered", () => PR.fitWide());
  PR.on("block-rendered", (id) => PR.fitWide(document.getElementById("b-" + id)));

})(window.PR);
