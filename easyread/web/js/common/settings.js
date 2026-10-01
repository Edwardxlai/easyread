/* 设置对话框（文献库页和阅读页共用）：外壳、分页、保存。
   四页：翻译（本文件）、问 AI / 阅读 / 快捷键（settings-tabs.js）。
   PR.openSettings("chat") 直接打开某一页；不指定就从“翻译”页开始（不记上次停在哪页）。 */
(function (PR) {
  "use strict";
  const dlg = () => PR.$("#settingsDlg");
  const ALL_TABS = [["engine", "翻译"], ["chat", "问 AI"], ["reading", "阅读"], ["library", "侧边栏"], ["keys", "快捷键"]];
  const tabs = () => ALL_TABS.filter(([k]) => PR.settingsTabs[k]);  // “侧边栏”页只在文献库页面有
  PR.settingsTabs = PR.settingsTabs || {};
  const st = (PR.settingsState = { tab: "engine", cfg: null, presets: [], groups: [], found: null, chat: null, ui: null });

  PR.opt = (list, val) => list.map(([v, l]) => '<option value="' + PR.esc(v) + '"' + (String(v) === String(val) ? " selected" : "") + ">" + PR.esc(l) + "</option>").join("");

  PR.openSettings = async function (tab) {
    const [d, chat] = await Promise.all([PR.api("/api/config"), PR.api("/api/chat/models").catch(() => null)]);
    Object.assign(st, { tab: typeof tab === "string" ? tab : "engine", cfg: d.config, presets: d.presets, groups: d.groups || [], chat,
      fetchMsg: null, apiTyping: false, advOpen: false, ui: { features: Object.assign({}, PR.features), keys_on: PR.keysOn, keys: Object.assign({}, PR.keymap) },
      theme: PR.ls.get("easyread-prefs", {}).theme || "auto", recording: null, editing: null, form: null, chatKeys: null, type: null });
    render();
    dlg().classList.add("open");
    // 每次打开都问一次（后端有缓存，很快）：刚装好或更新了 Claude Code / Codex，版本号和模型名单马上跟上
    const r = await PR.api("/api/engines").catch(() => null);
    if (r && (JSON.stringify([r.found, r.models]) !== JSON.stringify([st.found, st.models]))) {
      st.found = r.found; st.models = r.models;
      if (dlg().classList.contains("open")) { sync(); render(); }
    }
  };
  const btn = PR.$("#settingsBtn");
  if (btn) btn.onclick = () => PR.openSettings();

  function sync() { const t = PR.settingsTabs[st.tab]; if (t && t.sync) t.sync(st, dlg()); }
  PR.settingsRender = render;
  function render() {
    const t = PR.settingsTabs[st.tab];
    dlg().querySelector(".dialog").innerHTML =
      '<div class="set-head"><h2>设置</h2><div class="set-tabs">' + tabs().map(([k, l]) => '<button data-set-tab="' + k + '" class="' + (st.tab === k ? "on" : "") + '">' + l + "</button>").join("") + "</div></div>" +
      '<div class="set-body">' + (t ? t.render(st) : "") + "</div>" +
      '<div class="actions set-foot"><button class="linkish" id="showLog">运行日志</button>' +
      (PR.exitEasyRead ? '<button class="linkish" id="exitEasyRead" title="暂停翻译并关闭后台服务">退出 EasyRead</button>' : "") +
      '<span class="grow"></span><button class="btn" id="setCancel">取消</button><button class="btn primary" id="setSave">保存</button></div>' +
      (PR.exitOnClose ? '<p class="hint" style="margin:0 24px 16px">关闭最后一个阅读页面后，约 8 秒自动暂停翻译并退出后台。</p>' : "");
  }

  async function save() {
    sync();
    const r = await PR.api("/api/config", { method: "POST", body: PR.settingsTabs.engine.collect(st) });
    st.cfg = r.config;
    if (st.chat) st.chat = await PR.api("/api/chat/models", { method: "POST", body: { models: st.chat.models, default: st.chat.default, keys: st.chatKeys || {} } });
    PR.applyUi(st.ui, true);
    PR.ls.set("easyread-auto-translate", !!st.cfg.auto_translate);
    const prefs = PR.ls.get("easyread-prefs", {});
    if (prefs.theme !== st.theme) { prefs.theme = st.theme; PR.ls.set("easyread-prefs", prefs); PR.savePrefs("reader", { theme: st.theme }); if (PR.prefs) PR.prefs.theme = st.theme; }
    PR.applyTheme(st.theme);
    if (st.type) {  // 排版：阅读页里立刻生效；文献库页只存起来
      PR.ls.set("easyread-prefs", Object.assign(PR.ls.get("easyread-prefs", {}), st.type));
      if (PR.resetAllType) PR.resetAllType(st.type); else PR.savePrefs("reader", st.type);
    }
    dlg().classList.remove("open");
    PR.toast("设置已保存");
    PR.onSettingsSaved && PR.onSettingsSaved();
    PR.emit("settings-saved", st);
  }

  PR.showText = function (title, text) {
    const d = PR.$("#textDlg");
    d.querySelector(".dialog").innerHTML = "<h2>" + PR.esc(title) + '</h2><pre class="logview">' + PR.esc(text || "（还没有记录）") + '</pre><div class="actions"><button class="btn" data-close>关闭</button></div>';
    d.classList.add("open");
    const pre = d.querySelector("pre"); pre.scrollTop = pre.scrollHeight;
  };
  const td = PR.$("#textDlg");
  if (td) td.addEventListener("click", (e) => { if (e.target.id === "textDlg" || e.target.closest("[data-close]")) td.classList.remove("open"); });

  dlg().addEventListener("click", async (e) => {
    if (e.target === dlg() || e.target.closest("#setCancel")) { st.recording = null; return dlg().classList.remove("open"); }
    const tb = e.target.closest("[data-set-tab]");
    if (tb) { sync(); st.tab = tb.dataset.setTab; st.recording = null; st.editing = null; render(); return; }
    if (e.target.closest("#showLog")) { const r = await PR.api("/api/log"); PR.showText("运行日志", r.text + "\n\n（完整日志：" + r.path + "）"); return; }
    if (e.target.closest("#exitEasyRead")) { try { await PR.exitEasyRead(); } catch (err) { PR.toast("退出失败：" + err.message); } return; }
    if (e.target.closest("#setSave")) { try { await save(); } catch (err) { PR.toast("保存失败：" + PR.esc(err.message)); } return; }
    const t = PR.settingsTabs[st.tab];
    if (t && t.click && (await t.click(e, st, dlg()))) render();
  });
  dlg().addEventListener("change", (e) => {
    const t = PR.settingsTabs[st.tab];
    if (t && t.change && t.change(e, st, dlg())) render();
  });
  document.addEventListener("keydown", (e) => {
    if (!dlg().classList.contains("open")) return;
    const t = PR.settingsTabs[st.tab];
    if (st.recording && t && t.key) { e.preventDefault(); e.stopImmediatePropagation(); if (t.key(e, st)) render(); return; }
    if (e.key === "Escape") dlg().classList.remove("open");
  }, true);

  /* ---------- 翻译 ---------- */
  function badge(name) {
    if (!st.found) return '<span class="badge"><span class="spin"></span>检测中</span>';
    const f = st.found[name] || {};
    return f.found ? '<span class="badge ok">已安装' + (f.version ? " " + PR.esc((f.version.match(/\d+(\.\d+)+/) || [""])[0]) : "") + "</span>" : '<span class="badge">本机没找到</span>';
  }
  function cliFields(name) {
    const c = st.cfg[name];
    const model = PR.cliModelSelect(st, name, c.model, 'data-k="' + name + '.model"', true);  // 选项见 settings-models.js
    const how = name === "claude"
      ? '还没装？<a href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noopener">安装 Claude Code</a>，在终端里运行一次 <code>claude</code> 登录。翻译用的是你订阅里的额度。Opus / Sonnet 自动用 Claude Code 支持的最新版；要用刚出的新模型，先运行 <code>claude update</code>。'
      : (PR.cliModelDesc(st, "codex", c.model) ? PR.esc(PR.cliModelDesc(st, "codex", c.model)) + "<br>" : "") +
        '名单和 Codex 里 <code>/model</code> 看到的一样。还没装或要更新：<code>npm i -g @openai/codex@latest</code>，装好后运行一次 <code>codex</code> 登录。';
    return '<div class="grid2"><label class="field"><span>模型</span>' + model + "</label>" +
      '<label class="field"><span>命令</span><input class="input" data-k="' + name + '.command" value="' + PR.esc(c.command) + '"></label></div><p class="hint">' + how + "</p>";
  }
  function apiFields() {
    return PR.apiForm.html(st, st.cfg.openai, { keyProp: "api_key", vision: true }) +
      '<p class="hint">Key 只存在本机的 config.json 里，只发给你填的这个地址。这里存的 Key，“问 AI”用同一家服务时也能直接用。</p>';
  }

  function collect(state) {
    if (state.tab !== "engine") {  // 不在这一页时，用切页时存下的值
      const c = state.cfg, o = c.openai;
      return { engine: c.engine, batch_pages: c.batch_pages, concurrency: c.concurrency, auto_translate: c.auto_translate,
        claude: { model: c.claude.model, command: c.claude.command }, codex: { model: c.codex.model, command: c.codex.command },
        openai: { preset: o.preset, base_url: o.base_url, api: o.api, model: o.model, api_key: o.api_key, vision: o.vision } };
    }
    const o = state.cfg.openai;
    if (state.cfg.engine === "openai") PR.apiForm.read(dlg(), o, "api_key");
    const patch = { engine: state.cfg.engine, claude: {}, codex: {},
      openai: { preset: o.preset, base_url: o.base_url, api: o.api, model: o.model, api_key: o.api_key, vision: o.vision } };
    PR.$$("[data-k]", dlg()).forEach((el) => {
      const [a, b] = el.dataset.k.split(".");
      const v = el.type === "checkbox" ? el.checked : el.value;
      if (b) patch[a][b] = v; else patch[a] = ["batch_pages", "concurrency"].includes(a) ? +v : v;
    });
    return patch;
  }
  PR.settingsTabs.engine = {
    render(s) {
      if (s.cfg.engine === "none") { s.cfg.engine = "claude"; s.cfg.auto_translate = false; }  // 旧的“不翻译”= 关掉自动翻译
      const e = s.cfg.engine;
      const cur = e;
      const card = (k, title, text, extra) => '<button data-engine="' + k + '" class="' + (cur === k ? "on" : "") + '"><b>' + title + "</b>" + text + (extra || "") + "</button>";
      let h = '<p class="set-lead">导入论文后，用哪个模型在后台把它译成中文。</p><div class="engine-cards">' +
        card("claude", "Claude Code", "本机已登录的 Claude，不用 Key。会看原页图核对公式，译得最好。", badge("claude")) +
        card("codex", "Codex CLI", "本机已登录的 Codex（ChatGPT 账号），不用 Key。", badge("codex")) +
        card("openai", "API 接口", "填 Key 用 DeepSeek、智谱、通义、OpenAI 等；或本机 Ollama、任意自定义地址。", '<span class="badge ok">有免费的</span>') + "</div>";
      if (e === "claude" || e === "codex") h += cliFields(e);
      else if (e === "openai") h += apiFields();
      return h + '<div class="test-line"><button class="btn sm line" id="testBtn">' + PR.icon("sparkle", "sm") + '试译一句</button><span class="test-result" id="testRes"></span></div>' +
        '<div class="settings-sec grid2">' +
        '<label class="field"><span>每次交给模型的页数</span><select class="input" data-k="batch_pages">' + PR.opt([[1, "1 页（最稳）"], [2, "2 页（推荐）"], [3, "3 页"], [4, "4 页"]], s.cfg.batch_pages) + "</select></label>" +
        '<label class="field"><span>同时翻译几批</span><select class="input" data-k="concurrency">' + PR.opt([[1, "1（本机 CLI 推荐）"], [2, "2"], [3, "3（API 推荐）"], [4, "4"], [6, "6（最快）"]], s.cfg.concurrency) + "</select></label></div>" +
        '<label class="check" style="margin-top:0"><input type="checkbox" data-k="auto_translate"' + (s.cfg.auto_translate ? " checked" : "") + ">导入后自动开始翻译</label>" +
        '<p class="hint" style="margin-top:12px">文献库位置：' + PR.esc(s.cfg.library_dir) + "</p>";
    },
    collect,
    change(e, s) {
      return s.cfg.engine === "openai" && PR.apiForm.change(e, s, s.cfg.openai, "api_key", dlg());
    },
    sync(s) {
      const p = collect(s);
      Object.assign(s.cfg, { engine: p.engine, batch_pages: p.batch_pages ?? s.cfg.batch_pages, concurrency: p.concurrency ?? s.cfg.concurrency, auto_translate: p.auto_translate ?? s.cfg.auto_translate,
        claude: Object.assign({}, s.cfg.claude, p.claude), codex: Object.assign({}, s.cfg.codex, p.codex), openai: Object.assign({}, s.cfg.openai, p.openai) });
    },
    async click(e, s) {
      const card = e.target.closest("[data-engine]");
      if (card) {
        this.sync(s);
        const k = card.dataset.engine;
        s.cfg.engine = k;
        if (k === "openai" && !s.cfg.openai.base_url) {  // 第一次选 API：本机 Ollama 在跑就用它，否则 DeepSeek
          const ol = s.found && s.found.ollama && s.found.ollama.running && s.found.ollama.models.length;
          PR.apiForm.pick(s, s.cfg.openai, ol ? "ollama" : "deepseek", "api_key");
        }
        if (s.cfg.engine === "openai" && s.cfg.concurrency < 2) s.cfg.concurrency = 3; if (s.cfg.engine !== "openai" && s.cfg.concurrency > 2) s.cfg.concurrency = 1; return true; }
      if (s.cfg.engine === "openai" && e.target.closest("[data-af-preset], [data-fetch-models]")) { this.sync(s); return PR.apiForm.click(e, s, s.cfg.openai, "api_key", dlg()); }
      if (e.target.closest("#testBtn")) {
        const res = PR.$("#testRes");
        res.className = "test-result"; res.innerHTML = '<span class="spin"></span> 正在让模型回一句话…';
        try {
          await PR.api("/api/config", { method: "POST", body: collect(s) });
          const r = await PR.api("/api/config/test", { method: "POST", body: { engine: s.cfg.engine } });
          res.className = "test-result " + (r.ok ? "ok" : "bad"); res.textContent = (r.ok ? "✓ " : "✗ ") + r.message;
        } catch (err) { res.className = "test-result bad"; res.textContent = err.message; }
      }
      return false;
    },
  };
})(window.PR);
