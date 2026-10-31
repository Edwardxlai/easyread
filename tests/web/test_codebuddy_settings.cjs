const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

function settings() {
  const dialog = { addEventListener() {} }, input = { value: "" };
  const PR = { t: (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]),
    esc: String, icon: () => "", settingsTabs: {}, $$: () => [],
    $: (selector) => selector === "#settingsDlg" ? dialog : selector === "#cmModel" ? input : null };
  const context = { window: { PR, addEventListener() {} }, document: { addEventListener() {} },
    location: { search: "" }, URLSearchParams };
  for (const name of ["settings.js", "settings-models.js", "settings-translation.js", "settings-chat.js"]) {
    vm.runInNewContext(fs.readFileSync("easyread/web/js/common/" + name, "utf8"), context);
  }
  const state = { cfg: { engine: "claude", claude: {}, codex: {}, openai: {},
    codebuddy: { command: "codebuddy", model: "", extra_args: [], timeout: 1200 },
    zcode: { command: "zcode", model: "", extra_args: [], timeout: 1200 } },
    chat: { models: [], default: "" }, presets: [], pinned: true, transChecked: true };
  PR.settingsRender = () => {};
  PR.saveModelSettings = () => { state.saved = PR.settingsTabs.engine.collect(state); };
  PR.menu = (_, items) => { state.menu = items; };
  const click = (selector, dataset) => PR.settingsTabs.chat.click({ target: {
    closest: (wanted) => wanted === selector ? { dataset } : null,
  } }, state);
  return { PR, state, input, click };
}

test("CodeBuddy cards save and select for translation or chat, with optional models and no effort control", async () => {
  for (const model of ["", "my-codebuddy-model"]) {
    const { PR, state, input, click } = settings();
    await click("[data-cm]", { cm: "add" });
    await click("[data-cmk]", { cmk: "codebuddy" });
    assert.equal(state.form.model, "");
    assert.equal(PR.modelReasoningFields(state, state.form), "");
    const html = PR.settingsTabs.chat.render(state);
    assert.match(html, /data-cmk="codebuddy"/);
    assert.match(html, /https:\/\/www\.codebuddy\.cn\/docs\/cli\/headless/);
    assert.match(html, /WorkBuddy/);
    input.value = model;
    await click("[data-cm]", { cm: "ok" });
    const card = state.chat.models[0];
    assert.equal(card.engine, "codebuddy");
    assert.equal(card.model, model);
    assert.equal(card.source, "CodeBuddy CLI");
    assert.equal(card.name, model || "CodeBuddy CLI");
    assert.equal(card.reasoning_effort, "");
    await click("[data-cm]", { cm: "more", i: "0" });
    state.menu[0].fn();
    assert.equal(state.saved.engine, "codebuddy");
    assert.equal(state.saved.codebuddy.command, "codebuddy");
    assert.equal(state.saved.codebuddy.model, model);
    state.menu[1].fn();
    assert.equal(state.chat.default, card.id);
  }
});

test("ZCode follows its own model and can be selected for translation and chat", async () => {
  const { PR, state, input, click } = settings();
  await click("[data-cm]", { cm: "add" });
  await click("[data-cmk]", { cmk: "zcode" });
  const html = PR.settingsTabs.chat.render(state);
  assert.match(html, /data-cmk="zcode"/);
  assert.match(html, /github.com\/zai-org\/ZCode/);
  assert.doesNotMatch(html, /id="cmModel"/);
  assert.equal(PR.modelReasoningFields(state, state.form), "");
  input.value = "must-not-send-model-flag";
  await click("[data-cm]", { cm: "ok" });
  const card = state.chat.models[0];
  assert.equal(card.engine, "zcode");
  assert.equal(card.model, "");
  assert.equal(card.source, "ZCode CLI");
  await click("[data-cm]", { cm: "more", i: "0" });
  state.menu[0].fn();
  assert.equal(state.saved.engine, "zcode");
  assert.equal(state.saved.zcode.command, "zcode");
  assert.equal(state.saved.zcode.model, "");
  state.menu[1].fn();
  assert.equal(state.chat.default, card.id);
});
