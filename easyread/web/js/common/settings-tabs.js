/* 设置的另外两页：阅读（功能开关、主题）、快捷键（总开关、改键）。 */
(function (PR) {
  "use strict";
  const T = PR.settingsTabs;
  const esc = (s) => (PR.esc ? PR.esc(s) : String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
  const cleanFont = (s) => (PR.sanitizeFontFamily ? PR.sanitizeFontFamily(s) : String(s || "").trim());
  const debounce = PR.debounce || ((fn) => fn);

  function ensureType(s) {
    if (!s.type) {
      const saved = PR.ls.get("easyread-prefs", {}) || {};
      s.type = Object.assign({}, PR.TYPE_DEFAULTS);
      for (const key of [...Object.keys(PR.TYPE_DEFAULTS), "mode", "lead", "biOrder"]) {
        if (key in saved) s.type[key] = saved[key];
      }
    }
    if (s.selectCustomFont) {
      s.type.font = "custom";
      s.selectCustomFont = false;
      s.focusCustomFont = true;
    }
    return s.type;
  }

  function fontTargetName(t) {
    if (t.font === "custom") return cleanFont(t.customFont);
    return "";
  }

  function fontStatusHtml(s, t) {
    if (t.font !== "custom") return '<div class="font-status" hidden></div>';
    const target = fontTargetName(t);
    if (!target) return '<div class="font-status">' + PR.t("输入或从下方选择本机已安装字体，未填时回退到宋体。") + "</div>";
    if (s.fontsLoading) return '<div class="font-status">' + PR.t("正在检查本机字体…") + "</div>";
    if (!Array.isArray(s.systemFonts)) return '<div class="font-status" hidden></div>';
    const installed = new Set(s.systemFonts.map((x) => x.toLowerCase()));
    const parts = target.split(",").map((x) => x.trim()).filter(Boolean);
    const hits = parts.filter((name) => installed.has(name.toLowerCase())).length;
    if (hits === parts.length) return '<div class="font-status ok">' + PR.t("本机已安装：{name}", { name: esc(target) }) + "</div>";
    if (hits > 0) return '<div class="font-status ok">' + PR.t("已匹配部分字体，缺省时按列表顺序回退。") + "</div>";
    return '<div class="font-status warn">' + PR.t("本机未检测到“{name}”，显示时会回退到默认字体。", { name: esc(target) }) + "</div>";
  }

  function fontListContent(s, t) {
    if (s.fontsError) return '<div class="hint" style="padding:8px 10px">' + esc(s.fontsError) + "</div>";
    if (!Array.isArray(s.systemFonts)) return '<div class="hint" style="padding:8px 10px">' + PR.t("正在读取本机字体列表…") + "</div>";
    const q = (s.fontQuery || "").trim().toLowerCase();
    const matched = q ? s.systemFonts.filter((name) => name.toLowerCase().includes(q)) : s.systemFonts;
    if (!matched.length) return '<div class="hint" style="padding:8px 10px">' + PR.t("没有匹配的本机字体。") + "</div>";
    const current = cleanFont(t.customFont).toLowerCase();
    const limit = 250;
    // Keep list rows in the UI font so Chromium does not synchronously rasterize hundreds of font files.
    const rows = matched.slice(0, limit).map((name) => {
      const active = current && name.toLowerCase() === current;
      return '<button type="button" class="font-item' + (active ? " on" : "") + '" data-font-pick="' + esc(name) + '" role="option" aria-selected="' + active + '">' +
        "<span>" + esc(name) + "</span>" +
        (active ? "<small>" + PR.t("已选") + "</small>" : "") + "</button>";
    }).join("");
    const tail = matched.length > limit ? '<div class="hint" style="padding:6px 9px">' + PR.t("仅显示前 {n} 个，请输入关键词筛选。", { n: limit }) + "</div>" : "";
    return rows + tail;
  }

  function fontCountText(s) {
    if (!Array.isArray(s.systemFonts)) return "";
    const q = (s.fontQuery || "").trim().toLowerCase();
    const n = q ? s.systemFonts.filter((name) => name.toLowerCase().includes(q)).length : s.systemFonts.length;
    return PR.t("共 {n} 个", { n });
  }

  function fontPreviewStyle(t) {
    const f = PR.resolveFonts ? PR.resolveFonts(t) : { zh: "var(--serif-zh)", en: "var(--serif-en)", code: "var(--mono)" };
    return "--reader-zh:" + esc(f.zh) + ";--reader-en:" + esc(f.en) + ";--reader-code:" + esc(f.code);
  }

  function syncActiveFontItem(root, target) {
    const current = cleanFont(target).toLowerCase();
    for (const item of root.querySelectorAll(".font-item[data-font-pick]")) {
      const active = !!current && item.dataset.fontPick.toLowerCase() === current;
      if (item.classList.contains("on") === active) continue;
      item.classList.toggle("on", active);
      item.setAttribute("aria-selected", String(active));
      const badge = item.querySelector("small");
      if (active && !badge) item.insertAdjacentHTML("beforeend", "<small>" + PR.t("已选") + "</small>");
      else if (!active && badge) badge.remove();
    }
  }

  function updateFontSelection(s, root) {
    if (!root) return;
    const t = ensureType(s);
    const statusEl = root.querySelector(".font-status");
    if (statusEl) statusEl.outerHTML = fontStatusHtml(s, t);
    const preview = root.querySelector(".font-preview");
    if (preview) preview.setAttribute("style", fontPreviewStyle(t));
    syncActiveFontItem(root, t.customFont);
  }

  function updateFontList(s, root) {
    if (!root) return;
    const t = ensureType(s);
    const listEl = root.querySelector(".font-list");
    if (listEl) listEl.innerHTML = fontListContent(s, t);
    const countEl = root.querySelector(".font-picker-count");
    if (countEl) countEl.textContent = fontCountText(s);
  }

  function updateFontUi(s, root) {
    updateFontSelection(s, root);
    updateFontList(s, root);
  }

  const updateFontSelectionSoon = debounce(updateFontSelection, 120);
  const updateFontListSoon = debounce(updateFontList, 60);

  async function fetchFonts(s, root, fresh) {
    if (location.protocol === "file:" || !PR.api) return;
    if (s.fontsLoading || (s.fontsLoaded && !fresh)) return;
    s.fontsLoading = true;
    s.fontsError = "";
    updateFontUi(s, root);
    try {
      const res = await PR.api("/api/fonts" + (fresh ? "?fresh=1" : ""));
      s.systemFonts = Array.isArray(res.fonts) ? res.fonts : [];
      s.fontsLoaded = true;
    } catch (err) {
      s.fontsError = PR.t("读取本机字体失败：{msg}", { msg: err.message });
    } finally {
      s.fontsLoading = false;
      if (root && root.isConnected) updateFontUi(s, root);
    }
  }

  /* ---------- 阅读 ---------- */
  /* 排版：和阅读页 Aa 面板是同一份设置，这里多一个“恢复默认” */
  function typeHtml(s) {
    const t = Object.assign({ view: ensureType(s).mode === "bi" ? "both" : s.type.lead === "original" ? "original" : "translation" }, s.type);
    const sel = (key, label, list) => '<label class="field"><span>' + label + '</span><select class="input" data-type="' + key + '">' + PR.opt(list, t[key]) + "</select></label>";
    const fontOpts = [["serif", PR.t("宋体")], ["sans", PR.t("黑体")], ["custom", PR.t("自定义字体")]];
    const serverMode = location.protocol !== "file:";
    const enApplies = t.font !== "serif";
    const codeApplies = t.font === "custom";
    const customPanel = t.font === "custom"
      ? '<label class="field" style="margin:0"><span>' + PR.t("自定义字体名称") + '</span><div class="font-custom-head">' +
        '<input class="input" id="customFontInput" data-type="customFont" value="' + esc(t.customFont || "") + '" placeholder="' + esc(PR.t("输入字体名，如 LXGW WenKai、PingFang SC")) + '">' +
        (serverMode ? '<button type="button" class="btn sm line" data-font-refresh>' + PR.t("刷新") + "</button>" : "") + "</div></label>" +
        fontStatusHtml(s, t) +
        (serverMode ? '<div class="font-picker"><div class="font-picker-bar"><input class="input" id="fontSearchInput" type="search" value="' + esc(s.fontQuery || "") + '" placeholder="' + esc(PR.t("搜索本机已安装字体…")) + '">' +
        '<span class="font-picker-count">' + fontCountText(s) + '</span></div><div class="font-list" role="listbox" aria-label="' + esc(PR.t("本机字体")) + '">' + fontListContent(s, t) + "</div></div>" : "")
      : fontStatusHtml(s, t);
    const scopeChecks = '<div class="font-checks">' +
      '<label class="check' + (enApplies ? "" : " dim") + '"><input type="checkbox" data-type="fontEn"' + (t.fontEn !== false ? " checked" : "") + (enApplies ? "" : " disabled") + "><span>" + PR.t("英文原文也使用该字体") + "</span></label>" +
      '<label class="check' + (codeApplies ? "" : " dim") + '"><input type="checkbox" data-type="fontCode"' + (t.fontCode !== false ? " checked" : "") + (codeApplies ? "" : " disabled") + "><span>" + PR.t("代码块也使用该字体") + "</span></label>" +
      "</div>" +
      (!codeApplies ? '<div class="hint">' + PR.t("宋体或黑体下代码保持等宽字体；选择自定义字体时可随上面勾选切换。") + "</div>" : "");
    const preview = '<div class="font-preview" style="' + fontPreviewStyle(t) + '">' +
      '<div class="fp-zh">' + PR.t("译文预览：把英文论文读成舒服的文字，公式与批注保持清晰。") + "</div>" +
      '<div class="fp-en">Original: The loss scales smoothly as N⁻¹ across runs.</div>' +
      '<code class="fp-code">def read_paper(pid): return "ok"</code>' +
      "</div>";
    return '<h4 class="set-h">' + PR.t("排版") + '</h4><div class="settings-sec grid3">' +
      sel("fs", PR.t("字号"), PR.typeValues("fs").map(v => [v, PR.t("{n} px", { n: v })])) + sel("measure", PR.t("版心（每行字数）"), PR.typeValues("measure").map(v => [v, PR.t("{n} 字", { n: v })])) +
      sel("lh", PR.t("行距"), PR.typeValues("lh").map(v => [v, v])) + sel("font", PR.t("字体"), fontOpts) +
      sel("view", PR.t("默认阅读模式"), [["translation", PR.t("译文")], ["original", PR.t("原文")], ["both", PR.t("双语")]]) + sel("margin", PR.t("边注"), [["true", PR.t("显示")], ["false", PR.t("收起")]]) +
      '</div><div class="font-box">' + customPanel + scopeChecks + preview + '</div>' +
      '<div class="keys-foot" style="margin-top:4px"><button class="btn sm" data-type-reset>' + PR.t("恢复默认排版") + "</button></div>";
  }
  T.reading = {
    render(s) {
      return typeHtml(s) + '<h4 class="set-h">' + PR.t("阅读工具") + '</h4><div class="switch-list">' +
        PR.FEATURES.map(([id, name, , desc]) => '<label class="switch-row"><span><b>' + name + "</b><small>" + desc + '</small></span><input type="checkbox" class="switch" data-feat="' + id + '"' + (s.ui.features[id] !== false ? " checked" : "") + "></label>").join("") +
        "</div>" + '<div class="settings-sec grid2"><label class="field"><span>' + PR.t("界面主题") + '</span><select class="input" id="themeSel">' +
        PR.opt([["auto", PR.t("跟随系统")], ["light", PR.t("浅色")], ["dark", PR.t("深色")]], s.theme) + "</select></label>" +
        (location.protocol === "file:" ? "" : '<label class="field"><span>' + PR.t("界面语言") + '</span><select class="input" id="langSel">' +
          PR.opt([["auto", PR.t("跟随系统")], ["zh", PR.t("简体中文")], ["zh-Hant", PR.t("繁体中文")], ["en", PR.t("英文")]], s.lang || PR.langChoice) + "</select></label>") +
        (location.protocol === "file:" ? "" : '<label class="field"><span>' + PR.t("默认译文语言") + '</span><select class="input" id="targetSel">' +
          PR.opt(PR.TARGETS, s.target || PR.target) + "</select></label>") + "</div>";
    },
    onOpen(s, root) {
      fetchFonts(s, root, false);
      if (s.focusCustomFont && root) {
        s.focusCustomFont = false;
        requestAnimationFrame(() => root.querySelector("#customFontInput")?.focus());
      }
    },
    sync(s, root) {
      if (!root || !s.type) return;
      const inp = root.querySelector("#customFontInput");
      if (inp) s.type.customFont = cleanFont(inp.value);
    },
    click(e, s, root) {
      if (e.target.closest("[data-type-reset]")) {
        s.type = Object.assign({}, s.type, PR.TYPE_DEFAULTS);  // 只重置排版，显示方式保留
        s.fontQuery = "";
        return true;
      }
      const pick = e.target.closest("[data-font-pick]");
      if (pick) {
        ensureType(s).customFont = pick.dataset.fontPick;
        const inp = root?.querySelector("#customFontInput");
        if (inp) inp.value = s.type.customFont;
        updateFontSelectionSoon.cancel?.();
        updateFontSelection(s, root);
        return false;
      }
      if (e.target.closest("[data-font-refresh]")) {
        fetchFonts(s, root, true);
        return false;
      }
      return false;
    },
    input(e, s, root) {
      if (e.target.id === "customFontInput") {
        ensureType(s).customFont = e.target.value;
        updateFontSelectionSoon(s, root);
      } else if (e.target.id === "fontSearchInput") {
        s.fontQuery = e.target.value;
        updateFontListSoon(s, root);
      }
      return false;
    },
    change(e, s, root) {
      const t = e.target.dataset.type;
      if (t === "view") { s.type.mode = e.target.value === "both" ? "bi" : "zh"; if (e.target.value !== "both") s.type.lead = e.target.value; }  // 和阅读页顶栏一样：mode + lead
      else if (t === "fontEn" || t === "fontCode") { s.type[t] = e.target.checked; updateFontSelection(s, root); }
      else if (t === "customFont") { s.type.customFont = cleanFont(e.target.value); updateFontSelectionSoon.cancel?.(); updateFontSelection(s, root); }
      else if (t) {
        s.type[t] = t === "margin" ? e.target.value === "true" : ["fs", "measure", "lh"].includes(t) ? +e.target.value : e.target.value;
        if (t === "font") {
          if (s.type.font === "custom") fetchFonts(s, root, false);
          return true;
        }
      }
      if (e.target.dataset.feat) s.ui.features[e.target.dataset.feat] = e.target.checked;
      if (e.target.id === "themeSel") { s.theme = e.target.value; PR.applyTheme(s.theme); }
      if (e.target.id === "langSel") s.lang = e.target.value;
      if (e.target.id === "targetSel") s.target = e.target.value;
      return false;
    },
  };

  /* ---------- 快捷键 ---------- */
  T.keys = {
    render(s) {
      let h = '<label class="switch-row big"><span><b>' + PR.t("启用快捷键") + "</b><small>" + PR.t("关闭后仍可使用 Esc。") + '</small></span><input type="checkbox" class="switch" id="keysOn"' + (s.ui.keys_on ? " checked" : "") + "></label>";
      h += '<div class="keys-list' + (s.ui.keys_on ? "" : " dim") + '">';
      let grp = "";
      for (const [id, label, , group, need] of PR.KEY_ACTIONS) {
        if (group !== grp) { h += '<div class="grp">' + group + "</div>"; grp = group; }
        const off = need && s.ui.features[need] === false;
        const k = s.ui.keys[id];
        h += "<span>" + label + (off ? ' <small class="hint">' + PR.t("（功能已关）") + "</small>" : "") + '</span><button class="kcap' + (s.recording === id ? " rec" : k ? "" : " off") + '" data-krec="' + id + '">' +
          (s.recording === id ? PR.t("请按键") : k ? PR.esc(PR.keyName(k)) : PR.t("未设置")) + '</button><button class="kx" data-koff="' + id + '" title="' + PR.t("不用这个快捷键") + '">' + PR.t("清除") + "</button>";
      }
      return h + '</div><div class="keys-foot"><span class="hint">' + PR.t("选中文字后 1–4 四色划线、N 笔记、Q 提问，跟着总开关。") + '</span><button class="btn sm" data-kreset>' + PR.t("恢复默认键位") + "</button></div>";
    },
    click(e, s) {
      const r = e.target.closest("[data-krec]"), off = e.target.closest("[data-koff]");
      if (r) { s.recording = s.recording === r.dataset.krec ? null : r.dataset.krec; return true; }
      if (off) { s.ui.keys[off.dataset.koff] = ""; s.recording = null; return true; }
      if (e.target.closest("[data-kreset]")) { s.ui.keys = PR.defaultKeys(); s.recording = null; return true; }
      return false;
    },
    change(e, s) { if (e.target.id === "keysOn") { s.ui.keys_on = e.target.checked; return true; } return false; },
    key(e, s) {
      if (e.key === "Escape") { s.recording = null; return true; }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return false;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (/^[1-4]$/.test(k)) { PR.toast(PR.t("1–4 留给选中文字后的划线")); return false; }
      const taken = Object.keys(s.ui.keys).find((id) => s.ui.keys[id] === k && id !== s.recording);
      if (taken) { s.ui.keys[taken] = ""; PR.toast(PR.t("「{name}」原来的键让给了这个操作", { name: PR.KEY_ACTIONS.find((a) => a[0] === taken)[1] })); }
      s.ui.keys[s.recording] = k;
      s.recording = null;
      return true;
    },
  };
})(window.PR);
