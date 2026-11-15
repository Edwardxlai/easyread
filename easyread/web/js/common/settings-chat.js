/* 设置 → 模型：翻译和“问 AI”合在一页。
   上面一排卡片是你能用的模型（Claude Code / Codex / Grok / Antigravity / Cursor / CodeBuddy CLI / 各家 API），每张卡片可以标“翻译”和“问 AI 默认”；
   点卡片弹出菜单：设为翻译、设为问 AI、改 Key 和地址（只有 API 卡片）、删除；拖动卡片排序。添加时下面出现来源卡片和模型选择，API 的表单见 settings-api.js。
   下面是翻译自己的设置（每批几页、同时译几段、导入后自动翻译、试译一句）。
   存的时候：翻译用的那张卡片写进 config 的 engine 和对应配置（后台翻译读这些），整份名单写进 chat.models。
   API 的 Key 每家只存一份，翻译和问 AI 共用。 */
(function (PR) {
  "use strict";
  const T = PR.settingsTabs;
  const kindOf = (m) => (m.engine === "openai" ? "api" : m.engine);
  const isApi = (k) => k === "api";
  const root = () => PR.$("#settingsDlg");
  const preset = (s, id) => s.presets.find((x) => x.id === id);

  /* ---------- 翻译用的是哪张卡片 ---------- */
  function sameAsTranslation(s, m) {
    const c = s.cfg, e = c.engine;
    if (m.engine !== e) return false;
    if (["reasoning_effort", "service_tier"].some((k) => (m[k] || "") !== (c[e][k] || ""))) return false;
    if (PR.isCli(e)) return (m.model || "") === (c[e].model || "");
    const o = c.openai, p = preset(s, m.preset);
    return (m.preset || "") === (o.preset || "") && (m.model || "") === (o.model || "") &&
      (m.base_url || (p ? p.base_url : "")) === (o.base_url || "");
  }
  const transIndex = (s) => s.chat.models.findIndex((m) => sameAsTranslation(s, m));

  /* 翻译现在用的模型不在名单里（以前分两页设的）：给它补一张卡片 */
  function ensureTranslationCard(s) {
    if (s.transChecked || !s.chat) return;
    s.transChecked = true;
    if (s.cfg.engine === "none") { s.cfg.engine = "claude"; s.cfg.auto_translate = false; }  // 旧的“不翻译”= 关掉自动翻译
    if (transIndex(s) >= 0) return;
    const c = s.cfg, e = c.engine, o = c.openai, p = preset(s, o.preset);
    const f = e === "openai" ? { kind: "api", preset: o.preset || "", model: o.model || "", base_url: o.base_url || "", api: o.api || "chat" }
      : { kind: e, model: c[e].model || "" };
    Object.assign(f, { reasoning_effort: c[e].reasoning_effort || "", service_tier: c[e].service_tier || "" });
    s.chat.models.unshift(Object.assign(toModel(s, f, p), { id: "m" + Date.now().toString(36) }));
  }

  /* 把一张卡片设成翻译用：写进 cfg 的 engine 和对应那一节 */
  function useForTranslation(s, m) {
    const c = s.cfg;
    if (m.engine === "openai") {
      const p = preset(s, m.preset), typed = (s.chatKeys || {})[PR.apiKeyId(m.preset, m.base_url)];
      const rec = ((p && p.models) || []).find((x) => x.id === m.model);
      Object.assign(c.openai, { preset: m.preset || "", base_url: m.base_url || (p ? p.base_url : ""), api: m.api || (p && p.api) || "chat",
        model: m.model, api_key: typed || (PR.apiHasKey(s, m.preset, m.base_url) ? "••••" : ""), vision: rec ? !!rec.vision : !!c.openai.vision });
    } else {
      if (m.engine === "codex" && c.codex.model !== (m.model || "")) c.codex.reasoning_effort = "";
      c[m.engine].model = m.model || "";
    }
    c.engine = m.engine;
    c[m.engine].reasoning_effort = m.reasoning_effort || "";
    c[m.engine].service_tier = m.service_tier || "";
  }

  function roleButton(i, action, active, label, hint) {
    return '<button type="button" class="model-role" data-cm="' + action + '" data-i="' + i +
      '" aria-pressed="' + active + '" title="' + PR.esc(hint) + '">' +
      (active ? PR.icon("check", "sm") : "") + PR.esc(label) + '</button>';
  }

  function assignRole(s, m, action) {
    readTranslation(s);
    if (action === "translate") useForTranslation(s, m);
    else s.chat.default = m.id;
    PR.saveModelSettings();
  }

  function cardsHtml(s) {
    const list = s.chat.models, ti = transIndex(s);
    const rows = list.map((m, i) => {
      const follows = !m.model && PR.isCli(m.engine);
      const primary = follows ? (PR.modelDefault(s, m.engine) || m.source || PR.cliName(m.engine))
        : s.models && m.engine === "claude" ? autoName(s, {kind: m.engine, model: m.model}) : m.label || m.name;
      const detail = follows ? [primary !== m.source ? m.source : "", PR.modelDefault(s, m.engine) ? PR.t("跟随默认") : PR.modelDefaultLabelText(s, m.engine)].filter(Boolean).join(" · ") :
        [m.source, m.model && m.model !== primary ? m.model : ""].filter(Boolean).join(" · ");
      const menu = ' data-cm="more" data-i="' + i + '" aria-haspopup="menu"';
      const status = m.ready === false ? '<small class="bad">' + PR.t("不可用") + '</small>' : '';
      return '<div class="mc model-entry" draggable="true" data-i="' + i + '">' +
        '<button type="button" class="model-identity"' + menu + '><b>' + PR.esc(primary) + '</b><small>' + PR.esc(detail) + '</small>' + status + '</button>' +
        '<div class="model-roles">' + roleButton(i, "translate", i === ti, PR.t("默认翻译"), PR.t("设为翻译")) +
        roleButton(i, "chat-default", m.id === s.chat.default, PR.t("问 AI 默认"), PR.t("设为问 AI")) + '</div>' +
        '<button type="button" class="btn icon" aria-label="' + PR.esc(PR.t("管理模型") + ' · ' + primary) + '"' + menu + '>' + PR.icon("more", "sm") + '</button></div>';
    });
    return '<div class="model-heading"><h4 class="set-h">' + PR.t("已配置的模型") + '</h4><button class="btn sm line" data-cm="add">' +
      PR.icon("plus", "sm") + PR.t("添加模型") + '</button></div><div class="mc-cards model-list">' + rows.join("") + '</div>';
  }

  function formHtml(s) {
    const f = s.form, sources = s.sources || [], installed = sources.filter(cli => cli.installed);
    const missing = sources.filter(cli => !cli.installed && cli.install_url);
    const options = installed.map(cli => [cli.id, cli.name]);
    if (f.kind !== "api" && !installed.some(cli => cli.id === f.kind)) {
      options.push([f.kind, PR.cliName(f.kind) + " · " + PR.t("未检测到")]);
    }
    options.push(["api", PR.t("API 接口")]);
    const status = s.scanError ? PR.t("检测失败，请重试") : !s.sources ? PR.t("检测中…") :
      !installed.length ? PR.t("未检测到本机 CLI") : "";
    const guides = missing.length ? '<details class="model-guides"' + (!installed.length ? ' open' : '') + '><summary>' +
      PR.t("安装 CLI") + '</summary><div>' + missing.map(cli => '<a href="' + PR.esc(cli.install_url) +
        '" target="_blank" rel="noopener">' + PR.esc(cli.name) + ' ↗</a>').join("") + '</div></details>' : "";
    const source = '<label class="field"><span>' + PR.t("模型来源") + '</span><select class="input" data-model-source>' +
      PR.opt(options, f.kind) + '</select></label>';
    let modelField = "";
    if (PR.isAgentCli(f.kind)) {
      const provider = PR.agentClis[f.kind];
      modelField = provider.defaultOnly ? '<div class="field"><span>' + PR.t("模型") + '</span>' + PR.modelDefaultLabelText(s, f.kind) + '</div>' :
        '<label class="field"><span>' + PR.t("模型 ID") + '</span><input class="input" id="cmModel" value="' + PR.esc(f.model || "") +
        '" placeholder="' + (f.kind === "opencode" ? "provider/model" : PR.esc(PR.modelDefaultLabelText(s, f.kind))) + '"></label>';
    } else if (!isApi(f.kind)) {
      modelField = '<label class="field"><span>' + PR.t("模型") + '</span>' + PR.cliModelSelect(s, f.kind, f.model, 'id="cmModel"') + '</label>';
    }
    const fields = '<div class="model-fields">' + source + modelField + '</div>' +
      (isApi(f.kind) ? PR.apiForm.html(s, f, {keyProp: "key", vision: false}) : "") + PR.modelReasoningFields(s, f);
    return '<section class="model-editor"><div class="model-heading"><h3>' + (s.editing === "new" ? PR.t("添加模型") : PR.t("编辑模型")) +
      '</h3><button class="linkish" data-rescan>' + PR.t("重新检测") + '</button></div>' +
      (status ? '<p class="hint" role="status">' + status + '</p>' : "") + fields + guides + '</section>';
  }
  function autoName(s, f) {
    if (PR.isAgentCli(f.kind)) return f.model || PR.agentClis[f.kind].name;
    if (f.kind === "claude" || f.kind === "codex") {  // 卡片名就是模型名
      const o = PR.cliModelOptions(s, f.kind, f.model).find(([v]) => v === (f.model || ""));
      return o ? o[1] : f.model || (f.kind === "claude" ? "Claude" : "GPT");
    }
    const p = preset(s, f.preset);
    return f.model ? PR.apiModelName(s, f.preset, f.model) : p ? p.name : "模型";  // i18n-ok 存进模型名单的名字
  }
  function toModel(s, f, p) {
    const api = isApi(f.kind), name = autoName(s, f);
    return { engine: api ? "openai" : f.kind, preset: api ? f.preset : "",
      base_url: api && (!p || f.base_url !== p.base_url) ? f.base_url : "", api: api && (!p || f.api !== (p.api || "chat")) ? f.api : "", model: f.model, name, label: name,
      source: api ? (p ? p.name : (PR.customApis.find(s, f.base_url) || {}).name || PR.t("自定义地址")) :  // i18n-ok 存进模型名单的来源名
      PR.cliName(f.kind),
      reasoning_effort: f.reasoning_effort || "", service_tier: f.kind === "claude" || PR.isAgentCli(f.kind) ? "" : f.service_tier || "",
      detail: f.model, ready: true };
  }
  function readForm(s) {
    const f = s.form;
    if (!f) return;
    const v = (id) => { const el = PR.$("#" + id); return el ? el.value.trim() : null; };
    if (isApi(f.kind)) PR.apiForm.read(root(), f, "key");
    else if (PR.isAgentCli(f.kind) && PR.agentClis[f.kind].defaultOnly) f.model = "";
    else if (v("cmModel") !== null) f.model = v("cmModel");
    for (const key of ["reasoning_effort", "service_tier"]) {
      const el = PR.$('[data-reasoning="' + key + '"]', root());
      if (el) f[key] = el.value;
    }
  }
  function startForm(s, m) {
    const p = m && preset(s, m.preset);
    s.form = m ? { kind: kindOf(m), model: m.model || "", preset: m.preset || "", base_url: m.base_url || (p ? p.base_url : ""), api: m.api || (p && p.api) || "chat", vision: false,
      name: "", key: "" }
      : { kind: "claude", model: "opus", preset: "", base_url: "", api: "", name: "", key: "" };
    if (!m) {
      const cli = (s.sources || []).find(source => source.installed);
      s.form.kind = cli ? cli.id : "api";
      s.form.model = "";
      if (!cli) PR.apiForm.pick(s, s.form, s.cfg.openai.preset || "deepseek", "key");
    }
    s.form.connection_name = m && !m.preset ? (PR.customApis.find(s, m.base_url) || {}).name || "" : "";
    s.fetchMsg = null; s.apiTyping = false;
    s.form.reasoning_effort = m && m.reasoning_effort || "";
    s.form.service_tier = m && m.service_tier || "";
  }

  /* ---------- 翻译自己的设置 ---------- */
  const translationHtml = (s) => PR.translationSettingsHtml(s);

  /* 页面上翻译那几项的值读回 cfg（存的时候 settings.js 从 cfg 取） */
  function readTranslation(s) {
    PR.$$("[data-k]", root()).forEach((el) => {
      const [a, b] = el.dataset.k.split(".");
      const v = el.type === "checkbox" ? el.checked : el.dataset.k === "openai.vision" ? el.value === "images" : el.value;
      if (b) (s.cfg[a] ||= {})[b] = v; else s.cfg[a] = ["batch_pages", "concurrency", "paper_concurrency", "page_cap"].includes(a) ? +v : v;
    });
  }

  function commitForm(s) {
    const list = s.chat.models;
    const f = s.form, api = isApi(f.kind), p = preset(s, f.preset);
    if (api && !p && !f.base_url) { PR.toast(PR.t("填接口地址")); return false; }
    if (api && !f.model) { PR.toast(PR.t("填一个模型名")); return false; }
    const typed = f.key && !f.key.startsWith("••••") ? f.key : "";
    if (api && p && p.key && !PR.apiHasKey(s, f.preset) && !typed) { PR.toast(PR.t("这家要填 API Key")); return false; }
    if (api && typed) (s.chatKeys = s.chatKeys || {})[PR.apiKeyId(f.preset, f.base_url)] = typed;
    if (api && !p && !PR.customApis.save(s, f, "key")) return false;
    const m = toModel(s, f, p);
    if (s.editing === "new") list.push(Object.assign(m, { id: "m" + Date.now().toString(36) }));
    else {
      const old = list.find((x) => x.id === s.editing), wasTr = sameAsTranslation(s, old);
      Object.assign(old, m);
      if (wasTr) useForTranslation(s, old);  // 改的是翻译用的那张：翻译跟着改
    }
    return true;
  }
  function autoSaveForm(s) {
    if (!s.form || s.editing === "new") return;
    if (commitForm(s)) PR.saveModelSettings();
  }

  T.chat = {
    render(s) {
      if (!s.chat) return '<p class="hint">' + PR.t("读不到模型名单。") + "</p>";
      ensureTranslationCard(s);
      if (s.editing) return formHtml(s);
      return cardsHtml(s) +
        '<div class="settings-sec">' + translationHtml(s) + "</div>";
    },
    sync(s) { readForm(s); readTranslation(s); },
    change(e, s) {
      if (e.target.matches("[data-figure-output]")) {
        readTranslation(s);
        s.cfg.translate_figure_text = e.target.value !== "original";
        (s.cfg.figure_images ||= {}).enabled = e.target.value === "image";
        PR.saveModelSettings();
        return true;
      }
      const source = e.target.matches("[data-model-source]") && e.target;
      if (source && s.form) {
        readForm(s);
        const f = s.form, kind = source.value;
        if (kind === f.kind) return false;
        Object.assign(f, { kind, model: "", name: "", key: "", base_url: "", api: "", reasoning_effort: "", service_tier: "" });
        s.fetchMsg = null; s.apiTyping = false;
        if (isApi(kind)) {  // 先给一家：翻译那边用的 API，没有就 DeepSeek
          const o = s.cfg.openai;
          PR.apiForm.pick(s, f, s.cfg.engine === "openai" && o.preset ? o.preset : "deepseek", "key");
        }
        autoSaveForm(s);
        return true;
      }
      if (e.target.matches("[data-custom-connection]") && s.form) {
        PR.customApis.select(s, s.form, e.target.value, "key");
        return true;
      }
      if (e.target.dataset.k) {
        if (e.target.dataset.k === "figure_images.base_url" && e.target.value.trim().replace(/\/$/, '') !== (s.cfg.figure_images?.base_url || '').trim().replace(/\/$/, '')) {
          // A raw key typed earlier in this dialog belongs to the old endpoint.
          // Blank lets the backend restore only the new endpoint's saved key.
          const key = PR.$('[data-k="figure_images.api_key"]', root());
          if (key) key.value = '';
        }
        readTranslation(s); PR.saveModelSettings(); return e.target.dataset.k === "figure_images.provider";
      }
      if (e.target.dataset.reasoning) { readForm(s); autoSaveForm(s); return true; }
      if (s.form && isApi(s.form.kind)) {
        readForm(s);
        if (e.target.dataset.af === "model") s.form.reasoning_effort = s.form.service_tier = "";
        const changed = PR.apiForm.change(e, s, s.form, "key", root());
        autoSaveForm(s); return changed;
      }
      if (e.target.id === "cmModel" && e.target.tagName === "SELECT") { readForm(s); s.form.reasoning_effort = s.form.service_tier = ""; autoSaveForm(s); return true; }
      if (e.target.id === "cmModel") { readForm(s); autoSaveForm(s); return false; }  // 通用 CLI 自己填的模型名
      return false;
    },
    async click(e, s) {
      if (e.target.closest('[data-edit-translation-prompt]')) { PR.editTranslationPrompt(); return false; }
      if (e.target.closest("#testBtn")) {
        readTranslation(s);
        const res = PR.$("#testRes");
        res.className = "test-result"; res.innerHTML = '<span class="spin"></span> ' + PR.t("正在让模型回一句话…");
        try {
          await PR.api("/api/config", { method: "POST", body: T.engine.collect(s) });
          const r = await PR.api("/api/config/test", { method: "POST", body: { engine: s.cfg.engine } });
          res.className = "test-result " + (r.ok ? "ok" : "bad"); res.textContent = (r.ok ? "✓ " : "✗ ") + r.message;
        } catch (err) { res.className = "test-result bad"; res.textContent = err.message; }
        return false;
      }
      if (e.target.closest("[data-rescan]")) {
        e.target.disabled = true;
        const result = await PR.api("/api/engines?fresh=1").catch(() => null);
        s.scanError = !result;
        if (result) Object.assign(s, { sources: result.sources, found: result.found, models: result.models });
        return true;
      }
      if (s.form && isApi(s.form.kind) && e.target.closest("[data-fetch-models], [data-custom-save]")) {
        readForm(s);
        const changed = await PR.apiForm.click(e, s, s.form, "key", root());
        if (e.target.closest("[data-af-preset]")) autoSaveForm(s);
        return changed;
      }
      const b = e.target.closest("[data-cm]");
      if (!b) return false;
      const i = +b.dataset.i, list = s.chat.models, act = b.dataset.cm;
      if (act === "translate" || act === "chat-default") {
        if (b.getAttribute("aria-pressed") === "true") return false;
        assignRole(s, list[i], act);
        return true;
      }
      if (act === "more") {
        const m = list[i], tr = i === transIndex(s);
        readTranslation(s);
        PR.menu(b, [
          { label: PR.t("设为翻译"), icon: "sparkle", disabled: tr, fn: () => { assignRole(s, m, "translate"); PR.settingsRender(); } },
          { label: PR.t("设为问 AI"), icon: "note", disabled: s.chat.default === m.id, fn: () => { assignRole(s, m, "chat-default"); PR.settingsRender(); } },
          "-",
          { label: PR.t("修改"), icon: "edit", fn: () => { readForm(s); s.editing = m.id; startForm(s, m); PR.settingsRender(); } },
          "-",
          { label: PR.t("删除"), icon: "trash", disabled: tr, fn: async () => {
            if (list.length <= 1) return PR.toast(PR.t("至少留一个模型"));
            if (!(await PR.confirm({ title: PR.t("删除“{name}”？", { name: m.label || m.name }), body: PR.t("已有的对话不受影响。"), ok: PR.t("删除"), danger: true }))) return;
            const at = list.indexOf(m); if (at >= 0) list.splice(at, 1);
            if (s.chat.default === m.id) s.chat.default = list[0].id;
            if (s.editing === m.id) { s.editing = null; s.form = null; }
            PR.saveModelSettings(); PR.settingsRender();
          } },
        ]);
        return false;
      }
      if (act === "add") { readForm(s); s.editing = "new"; startForm(s); }
      if (act === "cancel") { s.editing = null; s.form = null; }
      if (act === "ok") {
        readForm(s);
        if (!commitForm(s)) return false;
        PR.saveModelSettings();
        s.editing = null; s.form = null;
      }
      return true;
    },
  };

  /* 拖动卡片排序 */
  let from = -1;
  const cardAt = (e) => e.target.closest && e.target.closest(".mc-cards .mc[data-i]");
  const clear = () => PR.$$(".mc-cards .mc", root()).forEach((c) => c.classList.remove("dragging", "drop-before", "drop-after"));
  root().addEventListener("dragstart", (e) => {
    const c = cardAt(e);
    if (!c) return;
    from = +c.dataset.i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
    c.classList.add("dragging");
  });
  root().addEventListener("dragover", (e) => {
    const c = cardAt(e);
    if (from < 0 || !c) return;
    e.preventDefault();
    const r = c.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    PR.$$(".mc-cards .mc", root()).forEach((x) => x.classList.remove("drop-before", "drop-after"));
    if (+c.dataset.i !== from) c.classList.add(after ? "drop-after" : "drop-before");
  });
  root().addEventListener("drop", (e) => {
    const c = cardAt(e), s = PR.settingsState;
    if (from < 0 || !c || !s.chat) return;
    e.preventDefault();
    const r = c.getBoundingClientRect(), list = s.chat.models;
    let to = +c.dataset.i + (e.clientY > r.top + r.height / 2 ? 1 : 0);
    const [m] = list.splice(from, 1);
    if (to > from) to--;
    list.splice(to, 0, m);
    from = -1;
    T.chat.sync(s);
    PR.saveModelSettings(); PR.settingsRender();
  });
  root().addEventListener("dragend", () => { from = -1; clear(); });
})(window.PR);
