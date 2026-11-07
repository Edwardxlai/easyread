const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("reading settings keep the old theme out of the typography save", () => {
  const saved = { theme: "light", fs: 24, mode: "bi", lead: "original", biOrder: "original" };
  const PR = {
    settingsTabs: {}, TYPE_DEFAULTS: { fs: 21, margin: true }, ls: { get: () => saved },
    FEATURES: [], t: key => key, opt: () => "", applyTheme() {},
  };
  const script = path.join(__dirname, "../../easyread/web/js/common/settings-tabs.js");
  vm.runInNewContext(fs.readFileSync(script, "utf8"), { window: { PR }, location: { protocol: "file:" } });
  const state = { theme: saved.theme };
  PR.settingsTabs.reading.render(state);
  PR.settingsTabs.reading.change({ target: { id: "themeSel", value: "auto", dataset: {} } }, state);
  assert.deepEqual({ theme: state.theme, ...state.type }, {
    theme: "auto", fs: 24, margin: true, mode: "bi", lead: "original", biOrder: "original",
  });
});
