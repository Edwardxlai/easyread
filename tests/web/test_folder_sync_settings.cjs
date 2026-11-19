const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("unreadable mapping state shows its error and disables writes without hiding the library", async () => {
  const state = { tab: "folderSync" };
  const PR = {
    settingsTabs: {}, settingsRender() {}, icon: () => "", t: text => text,
    esc: text => String(text || "").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    api: async () => ({ roots: [], default: null, error: "Cannot read <mapping>; original preserved" }),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/library/settings-folder-sync.js"), "utf8"), { window: { PR } });
  const tab = PR.settingsTabs.folderSync;
  tab.render(state);
  await new Promise(resolve => setImmediate(resolve));
  const html = tab.render(state);
  assert.match(html, /role="alert">Cannot read &lt;mapping>; original preserved/);
  assert.match(html, /id="syncDefaultEnabled" disabled/);
  assert.match(html, /data-sync-action="save-mapping" disabled/);
  assert.equal(state.folderSyncBusy, false);
});
