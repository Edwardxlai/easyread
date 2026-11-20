const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const read = file => fs.readFileSync(path.join(__dirname, "../../easyread/web", file), "utf8");
const rules = "js/common/reader-typography.js";

test("both pages load typography before its consumers and CSS matches the first render", () => {
  const PR = {};
  vm.runInNewContext(read(rules), { window: { PR } });
  for (const page of ["reader.html", "library.html"]) {
    const html = read(page);
    const scripts = [...html.matchAll(/<script src="\/web\/([^"]+)"><\/script>/g)].map(m => m[1]);
    for (const consumer of page === "reader.html" ? ["js/reader/panels.js", "js/common/settings-tabs.js"] : ["js/common/settings-tabs.js"]) {
      assert.ok(scripts.includes(rules) && scripts.indexOf(rules) < scripts.indexOf(consumer), page + " / " + consumer);
    }
  }
  const css = read("css/reader.css").match(/:root\s*\{([^}]+)\}/)[1];
  for (const [key, unit] of [["fs", "px"], ["measure", "em"], ["lh", ""]]) {
    assert.equal(css.match(new RegExp("--" + key + ":\\s*([^;]+);"))[1], PR.TYPE_DEFAULTS[key] + unit);
  }
});

test("Aa, settings, shortcuts and mobile export follow the same typography limits", () => {
  const node = { addEventListener() {} };
  const PR = {
    state: {}, store: {}, features: {}, FEATURES: [], settingsTabs: {}, ls: { get: () => ({}), set() {} },
    $: () => node, icon: () => "", logo: () => "", t: s => s, viewSegHtml: () => "", on() {}, toast() {},
    debounce: fn => fn, opt: options => options.map(([value]) => value).join(","),
  };
  const context = vm.createContext({
    window: { PR, addEventListener() {} }, location: { protocol: "file:" }, scrollY: 0,
    document: { body: { classList: { add() {} } }, addEventListener() {} },
    matchMedia: () => ({ addEventListener() {} }),
  });
  const load = file => vm.runInContext(read(file), context, { filename: file });
  load(rules);
  // Narrow the shared ranges so a control with its own hardcoded limits fails.
  PR.typeRanges.fs = { min: 18, max: 22, step: 1 };
  PR.typeRanges.lh = { min: 1.85, max: 1.95, step: 0.05 };
  load("js/reader/panels.js");
  PR.renderSettings();
  assert.match(node.innerHTML, /data-r="fs" min="18" max="22" step="1"/);
  assert.match(node.innerHTML, /data-r="lh" min="1.85" max="1.95" step="0.05"/);
  PR.setPref = (key, value) => { PR.prefs[key] = value; };
  PR.bumpFont(10);
  assert.equal(PR.prefs.fs, 22);
  load("js/common/settings-tabs.js");
  const settings = PR.settingsTabs.reading.render({ ui: { features: {} } });
  assert.match(settings, /data-type="fs">18,19,20,21,22<\/select>/);
  assert.match(settings, /data-type="lh">1.85,1.9,1.95<\/select>/);
  load("js/reader/mobile.js");
  PR.renderSettings();
  assert.match(node.innerHTML, /min="18" max="22" value="22" data-fs-input/);
});

test("font resolution supports custom fonts, scope toggles and sanitization", () => {
  const PR = {};
  const styleProps = new Map();
  const root = {
    style: {
      setProperty: (k, v) => styleProps.set(k, v),
      removeProperty: (k) => styleProps.delete(k),
    },
  };
  vm.runInNewContext(read(rules), { window: { PR }, document: { documentElement: root } });

  assert.equal(PR.resolveFonts({ font: "serif" }).zh, "var(--serif-zh)");
  assert.equal(PR.resolveFonts({ font: "serif" }).en, "var(--serif-en)");
  assert.equal(PR.resolveFonts({ font: "serif" }).code, "var(--mono)");

  const customAll = PR.resolveFonts({ font: "custom", customFont: "Maple Mono NF CN", fontEn: true, fontCode: true });
  assert.equal(customAll.zh, '"Maple Mono NF CN", var(--serif-zh)');
  assert.equal(customAll.en, '"Maple Mono NF CN", var(--serif-en)');
  assert.equal(customAll.code, '"Maple Mono NF CN", var(--mono)');

  const customZhOnly = PR.resolveFonts({ font: "custom", customFont: "Maple Mono NF CN", fontEn: false, fontCode: false });
  assert.equal(customZhOnly.zh, '"Maple Mono NF CN", var(--serif-zh)');
  assert.equal(customZhOnly.en, "var(--serif-en)");
  assert.equal(customZhOnly.code, "var(--mono)");

  const customClean = PR.resolveFonts({ font: "custom", customFont: 'LXGW WenKai"; color: red', fontEn: true, fontCode: false });
  assert.equal(customClean.family, "LXGW WenKai color: red");
  assert.equal(customClean.zh, '"LXGW WenKai color: red", var(--serif-zh)');
  assert.equal(customClean.en, '"LXGW WenKai color: red", var(--serif-en)');
  assert.equal(customClean.code, "var(--mono)");

  assert.equal(PR.resolveFonts({ font: "custom", customFont: "   " }).zh, "var(--serif-zh)");

  PR.applyFontVars({ font: "custom", customFont: "Maple Mono NF CN", fontEn: true, fontCode: true }, root);
  assert.equal(styleProps.get("--reader-zh"), '"Maple Mono NF CN", var(--serif-zh)');
  assert.equal(styleProps.get("--reader-en"), '"Maple Mono NF CN", var(--serif-en)');
  assert.equal(styleProps.get("--reader-code"), '"Maple Mono NF CN", var(--mono)');

  PR.applyFontVars({ font: "serif" }, root);
  assert.equal(styleProps.size, 0);
});

test("Aa and Settings Reading expose custom font picker and scope checkboxes without extra built-in presets", () => {
  const node = { addEventListener() {}, classList: { toggle() {} } };
  const styleProps = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty: (k, v) => styleProps.set(k, v),
      removeProperty: (k) => styleProps.delete(k),
    },
  };
  const PR = {
    state: {}, store: { mode: "server" }, features: {}, FEATURES: [], TARGETS: [["zh", "简体中文"]], settingsTabs: {},
    ls: { get: () => ({}), set() {} }, savePrefs() {},
    $: () => node, $$: () => [], icon: () => "", logo: () => "",
    t: (s, vars) => vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "") : s,
    viewSegHtml: () => "", on() {}, toast() {}, applyTheme() {}, debounce: fn => fn,
    opt: (options, val) => options.map(([value, label]) => '<option value="' + value + '"' +
      (String(value) === String(val) ? " selected" : "") + '>' + label + '</option>').join(""),
  };
  const context = vm.createContext({
    window: { PR, addEventListener() {} }, location: { protocol: "http:" }, scrollY: 0,
    document: { documentElement: root, body: { classList: { add() {}, toggle() {} } }, addEventListener() {} },
    matchMedia: () => ({ addEventListener() {} }),
  });
  const load = file => vm.runInContext(read(file), context, { filename: file });
  load(rules);
  load("js/reader/panels.js");
  PR.prefs.font = "custom";
  PR.prefs.customFont = "Maple Mono NF CN";
  PR.applyPrefs();
  assert.equal(styleProps.get("--reader-zh"), '"Maple Mono NF CN", var(--serif-zh)');
  PR.renderSettings();
  assert.match(node.innerHTML, /<select[^>]*data-p="font"/);
  assert.match(node.innerHTML, /value="custom" selected>自定义（Maple Mono NF CN）/);
  assert.doesNotMatch(node.innerHTML, /value="maple-mono"/);

  load("js/common/settings-tabs.js");
  const state = {
    ui: { features: {} },
    systemFonts: ["Arial", "Maple Mono NF CN"],
    type: { ...PR.TYPE_DEFAULTS, font: "custom", customFont: "Maple Mono NF CN", fontEn: true, fontCode: false },
  };
  const html = PR.settingsTabs.reading.render(state);
  assert.doesNotMatch(html, /value="maple-mono"/);
  assert.match(html, /id="customFontInput"/);
  assert.match(html, /data-type="fontEn" checked/);
  assert.match(html, /data-type="fontCode"[^<]*>/);
  assert.doesNotMatch(html, /data-type="fontCode" checked/);
  assert.match(html, /data-font-pick="Maple Mono NF CN"/);
  assert.doesNotMatch(html, /data-font-pick="Maple Mono NF CN"[^>]*><span style=/);
  assert.match(html, /class="font-status ok"/);
});
