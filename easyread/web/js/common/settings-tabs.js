/* 设置的另外两页：阅读（功能开关、主题）、快捷键（总开关、改键）。 */
(function (PR) {
  "use strict";
  const T = PR.settingsTabs;

  /* ---------- 阅读 ---------- */
  /* 排版：和阅读页 Aa 面板是同一份设置，这里多一个“恢复默认” */
  function typeHtml(s) {
    if (!s.type) {
      const saved = PR.ls.get("easyread-prefs", {}) || {};
      s.type = Object.assign({}, PR.TYPE_DEFAULTS);
      for (const key of [...Object.keys(PR.TYPE_DEFAULTS), "mode", "lead", "biOrder"]) {
        if (key in saved) s.type[key] = saved[key];
      }
    }
    const t = Object.assign({ view: s.type.mode === "bi" ? "both" : s.type.lead === "original" ? "original" : "translation" }, s.type), range = (a, b, step) => { const out = []; for (let v = a; v <= b + 1e-9; v += step) out.push([+v.toFixed(2), +v.toFixed(2)]); return out; };
    const sel = (key, label, list) => '<label class="field"><span>' + label + '</span><select class="input" data-type="' + key + '">' + PR.opt(list, t[key]) + "</select></label>";
    return '<h4 class="set-h">' + PR.t("排版") + '</h4><div class="settings-sec grid3">' +
      sel("fs", PR.t("字号"), range(13, 28, 1).map(([v]) => [v, PR.t("{n} px", { n: v })])) + sel("measure", PR.t("版心（每行字数）"), range(26, 50, 1).map(([v]) => [v, PR.t("{n} 字", { n: v })])) +
      sel("lh", PR.t("行距"), range(1.5, 2.4, 0.05)) + sel("font", PR.t("字体"), [["serif", PR.t("宋体")], ["sans", PR.t("黑体")]]) +
      sel("view", PR.t("打开时显示"), [["translation", PR.t("译文")], ["original", PR.t("原文")], ["both", PR.t("双语")]]) + sel("margin", PR.t("边注"), [["true", PR.t("显示")], ["false", PR.t("收起")]]) +
      '</div><div class="keys-foot" style="margin-top:4px"><span class="hint">' + PR.t("阅读时也能在右上角 Aa 里随手调。") + '</span><button class="btn sm" data-type-reset>' + PR.t("恢复默认排版") + "</button></div>";
  }
  T.reading = {
    render(s) {
      return typeHtml(s) + '<h4 class="set-h">' + PR.t("功能") + '</h4><p class="set-lead">' + PR.t("阅读页上显示哪些功能。关掉的功能，按钮和快捷键都会一起消失。") + '</p><div class="switch-list">' +
        PR.FEATURES.map(([id, name, , desc]) => '<label class="switch-row"><span><b>' + name + "</b><small>" + desc + '</small></span><input type="checkbox" class="switch" data-feat="' + id + '"' + (s.ui.features[id] !== false ? " checked" : "") + "></label>").join("") +
        "</div>" + '<div class="settings-sec grid2"><label class="field"><span>' + PR.t("界面主题") + '</span><select class="input" id="themeSel">' +
        PR.opt([["auto", PR.t("跟随系统")], ["light", PR.t("浅色")], ["dark", PR.t("深色")]], s.theme) + "</select></label>" +
        (location.protocol === "file:" ? "" : '<label class="field"><span>' + PR.t("界面语言") + '</span><select class="input" id="langSel">' +
          PR.opt([["auto", PR.t("跟随系统")], ["zh", PR.t("简体中文")], ["zh-Hant", PR.t("繁体中文")], ["en", PR.t("英文")]], s.lang || PR.langChoice) + "</select></label>") +
        (location.protocol === "file:" ? "" : '<label class="field"><span>' + PR.t("论文译成") + '</span><select class="input" id="targetSel">' +
          PR.opt(PR.TARGETS, s.target || PR.target) + "</select></label>") + "</div>" +
        (location.protocol === "file:" ? "" : '<p class="set-lead">' + PR.t("新翻译的论文用这个语言；已经译过的论文保持原来的语言。不需要译文的话，导入时选“读英文原文”。") + "</p>");
    },
    click(e, s) {
      if (!e.target.closest("[data-type-reset]")) return false;
      s.type = Object.assign({}, s.type, PR.TYPE_DEFAULTS);  // 只重置排版，显示方式保留
      return true;
    },
    change(e, s) {
      const t = e.target.dataset.type;
      if (t === "view") { s.type.mode = e.target.value === "both" ? "bi" : "zh"; if (e.target.value !== "both") s.type.lead = e.target.value; }  // 和阅读页顶栏一样：mode + lead
      else if (t) s.type[t] = t === "margin" ? e.target.value === "true" : ["fs", "measure", "lh"].includes(t) ? +e.target.value : e.target.value;
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
      let h = '<label class="switch-row big"><span><b>' + PR.t("启用快捷键") + "</b><small>" + PR.t("关掉后只剩 Esc。单个字母的快捷键打字时不会触发，但点着页面时按到会触发。") + '</small></span><input type="checkbox" class="switch" id="keysOn"' + (s.ui.keys_on ? " checked" : "") + "></label>";
      h += '<div class="keys-list' + (s.ui.keys_on ? "" : " dim") + '">';
      let grp = "";
      for (const [id, label, , group, need] of PR.KEY_ACTIONS) {
        if (group !== grp) { h += '<div class="grp">' + group + "</div>"; grp = group; }
        const off = need && s.ui.features[need] === false;
        const k = s.ui.keys[id];
        h += "<span>" + label + (off ? ' <small class="hint">' + PR.t("（功能已关）") + "</small>" : "") + '</span><button class="kcap' + (s.recording === id ? " rec" : k ? "" : " off") + '" data-krec="' + id + '">' +
          (s.recording === id ? PR.t("按一个键…") : k ? PR.esc(PR.keyName(k)) : PR.t("未设置")) + '</button><button class="kx" data-koff="' + id + '" title="' + PR.t("不用这个快捷键") + '">' + PR.t("清除") + "</button>";
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
