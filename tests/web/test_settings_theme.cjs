const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("reading settings keep the old theme out of the typography save", () => {
  const saved = { theme: "light", fs: 24, mode: "bi", lead: "original", biOrder: "original" };
  const PR = {
    settingsTabs: {}, ls: { get: () => saved },
    FEATURES: [], t: key => key, opt: () => "", applyTheme() {},
  };
  const context = { window: { PR }, location: { protocol: "file:" } };
  for (const name of ["reader-typography.js", "settings-tabs.js"]) {
    const script = path.join(__dirname, "../../easyread/web/js/common", name);
    vm.runInNewContext(fs.readFileSync(script, "utf8"), context);
  }
  const state = { theme: saved.theme };
  PR.settingsTabs.reading.render(state);
  PR.settingsTabs.reading.change({ target: { id: "themeSel", value: "auto", dataset: {} } }, state);
  assert.deepEqual({ theme: state.theme, ...state.type }, {
    ...PR.TYPE_DEFAULTS, theme: "auto", fs: 24, mode: "bi", lead: "original", biOrder: "original",
  });
});
