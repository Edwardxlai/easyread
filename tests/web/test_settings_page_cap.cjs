const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("page limit options include a translated page unit and keep numeric values", () => {
  const PR = {
    settingsTabs: {}, esc: String, icon: () => "", $: () => ({ addEventListener() {} }),
    t: (key, args = {}) => key === "{n} 页" ? args.n + " pages" : key,
    opt: (items, selected) => items.map(([value, label]) => '<option value="' + value + '"' +
      (value === selected ? " selected" : "") + '>' + label + '</option>').join(""),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/common/settings-chat.js"), "utf8"), { window: { PR } });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/common/settings-translation.js"), "utf8"), { window: { PR } });
  const state = { pinned: true, transChecked: true, cfg: { engine: "claude", claude: {}, page_cap: 60, translation_instructions: "Keep KV cache" }, chat: { models: [] } };
  const html = PR.settingsTabs.chat.render(state);
  const options = html.match(/data-k="page_cap">([\s\S]*?)<\/select>/)[1];
  for (const limit of [30, 60, 100, 200]) {
    assert.match(options, new RegExp('value="' + limit + '"(?: selected)?>' + limit + ' pages<'));
  }
  assert.match(options, /value="60" selected/);
  assert.match(options, /value="0">/);
  assert.match(html, /data-edit-translation-prompt/);
  assert.doesNotMatch(html, /data-k="translation_instructions"/);
});

test("enabling translated images reveals the API fields and autosaves the choice", () => {
  let saved = 0;
  const checkbox = {dataset: {k: 'figure_images.enabled'}, type: 'checkbox', checked: true, matches: () => false};
  const PR = {settingsTabs: {}, $: () => ({addEventListener() {}}), $$: () => [checkbox], saveModelSettings: () => saved++};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/common/settings-chat.js'), 'utf8'), {window: {PR}});
  const state = {cfg: {figure_images: {enabled: false}}};
  assert.equal(PR.settingsTabs.chat.change({target: checkbox}, state), true);
  assert.equal(state.cfg.figure_images.enabled, true);
  assert.equal(saved, 1);
  checkbox.checked = false;
  assert.equal(PR.settingsTabs.chat.change({target: checkbox}, state), true);
  assert.equal(state.cfg.figure_images.enabled, false);
});

test("changing image endpoints does not carry a key typed for the old service", () => {
  const url = {dataset: {k: 'figure_images.base_url'}, type: 'text', value: 'https://new.example/v1', matches: () => false};
  const key = {dataset: {k: 'figure_images.api_key'}, type: 'password', value: 'old-secret'};
  const PR = {settingsTabs: {}, $: s => s.includes('api_key') ? key : {addEventListener() {}},
    $$: () => [url, key], saveModelSettings() {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/common/settings-chat.js'), 'utf8'), {window: {PR}});
  const state = {cfg: {figure_images: {base_url: 'https://old.example/v1', api_key: 'old-secret'}}};
  PR.settingsTabs.chat.change({target: url}, state);
  assert.equal(state.cfg.figure_images.base_url, url.value);
  assert.equal(state.cfg.figure_images.api_key, '');
});
