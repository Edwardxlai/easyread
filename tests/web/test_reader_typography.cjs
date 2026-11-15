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
