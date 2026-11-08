const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { page } = require("../helpers/library_page.cjs");

function css(file) {
  assert.ok(file === "tabs.css" || file === "base.css", "Unexpected CSS fixture");
  const limit = 64 * 1024;
  const fd = fs.openSync(path.join(__dirname, "../../easyread/web/css/", file), "r");
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= limit, "CSS fixture must be a regular file of at most 64 KiB");
    // Read one extra byte to detect growth after the size check without an unbounded read.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    assert.ok(length <= limit, "CSS fixture exceeds 64 KiB");
    return buffer.toString("utf8", 0, length);
  } finally {
    fs.closeSync(fd);
  }
}

test("tab panes let the library and reader see the OS color scheme", () => {
  assert.match(css("tabs.css"), /\.paper-pane \{[^}]*color-scheme: light dark;/);
  assert.doesNotMatch(css("base.css"), /color-scheme: light dark/);
});

test("library re-applies the saved theme when the OS color scheme changes", () => {
  const p = page().library([]);
  const applied = [];
  p.PR.applyTheme = theme => applied.push(theme);
  for (const [prefs, dark] of [[{ theme: "auto" }, true], [{ theme: "light" }, true], [{ theme: "dark" }, false], [{}, true]]) {
    p.PR.ls.get = (key, fallback) => key === "easyread-prefs" ? prefs : fallback;
    p.preferColorScheme(dark);
  }
  assert.deepEqual(applied, ["auto", "light", "dark", undefined]);
});
