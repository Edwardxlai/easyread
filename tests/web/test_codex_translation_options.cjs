const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

test("Codex settings render supported effort levels and save the chosen overrides", () => {
  const PR = { t: (x) => x, esc: String, settingsTabs: {},
    $: () => ({ addEventListener() {} }) };
  const context = { window: { PR, addEventListener() {} }, document: { addEventListener() {} } };
  for (const name of ["settings.js", "settings-models.js"]) {
    vm.runInNewContext(fs.readFileSync("easyread/web/js/common/" + name, "utf8"), context);
  }
  const s = { cfg: { codex: { model: "example", reasoning_effort: "low", service_tier: "fast" }, claude: {}, openai: {} },
    models: { codex: { configured_reasoning: "high", models: [{ id: "example", reasoning_levels: ["low", "high"] }] } } };
  const f = { kind: "codex", ...s.cfg.codex };
  const html = PR.modelReasoningFields(s, f);
  assert.match(html, /value="low" selected/);
  assert.match(html, /value="fast" selected/);
  assert.doesNotMatch(html, /value="max"/);
  const saved = PR.settingsTabs.engine.collect(s).codex;
  assert.equal(saved.reasoning_effort, "low");
  assert.equal(saved.service_tier, "fast");
  s.models.codex.models = [];
  assert.match(PR.modelReasoningFields(s, f), /value="low" selected/);
  assert.match(PR.modelReasoningFields(s, { kind: "claude", model: "opus", reasoning_effort: "max" }), /value="max" selected/);
  assert.doesNotMatch(PR.modelReasoningFields(s, { kind: "claude", model: "haiku" }), /value="low"/);
  assert.match(PR.modelReasoningFields(s, { kind: "api", model: "custom", reasoning_effort: "medium" }), /value="medium" selected/);
});

test("image generation settings render and persist separately from the text model", () => {
  const PR = {t: x => x, esc: String, settingsTabs: {}, $: () => ({addEventListener() {}}), agentClis: {}};
  const context = {window: {PR, addEventListener() {}}, document: {addEventListener() {}}};
  for (const name of ['settings.js', 'settings-translation.js']) {
    vm.runInNewContext(fs.readFileSync('easyread/web/js/common/' + name, 'utf8'), context);
  }
  const cfg = {claude: {}, codex: {}, openai: {}, figure_images: {enabled: true, provider: 'api', base_url: 'https://image.example/v1', model: 'editor', api_key: '••••1234'}};
  const html = PR.translationSettingsHtml({cfg});
  assert.match(html, /data-k="figure_images.enabled" checked/);
  assert.match(html, /data-k="figure_images.model" value="editor"/);
  assert.match(html, /type="password" data-k="figure_images.api_key"/);
  assert.match(html, /生成失败/);
  assert.deepEqual(JSON.parse(JSON.stringify(PR.settingsTabs.engine.collect({cfg}).figure_images)), cfg.figure_images);
  delete cfg.figure_images.provider;
  const subscription = PR.translationSettingsHtml({cfg});
  assert.match(subscription, /value="codex" selected/);
  assert.doesNotMatch(subscription, /type="password" data-k="figure_images.api_key"/);
  assert.match(subscription, /不自动调用付费 API/);
  assert.equal(PR.settingsTabs.engine.collect({cfg}).figure_images.provider, 'codex');
});
