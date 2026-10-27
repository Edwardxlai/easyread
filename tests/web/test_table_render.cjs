const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function render(blocks, options = {}) {
  const paperEl = { innerHTML: "" };
  const bodyClass = new Set();
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    titleOf: (m) => m.title_en || "",
    state: {
      paper: { meta: { title_en: "Table test", pages: [{ n: 1, img: "pages/page-001.webp" }] }, translation: { done_pages: [1] }, blocks },
      reader: { edits: {} },
      discussion: { entries: [] },
      layout: {},
      item: {},
      job: {},
    },
    $: (sel) => sel === "#paper" ? paperEl : null,
    $$: () => [],
    esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    md: (s) => String(s == null ? "" : s),
    plain: (s) => String(s == null ? "" : s),
    textFor: (key) => {
      const [id, field] = String(key).split("#");
      const b = blocks.find(x => x.id === id) || {};
      return field === "caption" ? (b.caption_zh || b.caption_en || "") : (b.zh || b.en || "");
    },
    agentText: (key) => PR.textFor(key),
    editOf: () => null,
    isEnKey: () => false,
    hasZh: (b) => !!(b && (b.zh || b.caption_zh)),
    blockKeys: (b) => b.type === "table" || b.type === "figure" ? [b.id + "#caption"] : [b.id],
    imageUrl: (rel) => rel,
    canAsk: () => false,
    store: { mode: "file" },
    usageShort: () => "",
    emit() {},
    on() {},
    fitWide() {},
    // These tests inspect generated markup; DOM reuse is a separate layer.
    updatePaperHtml: (element, html) => { element.innerHTML = html; },
  };
  if (options.pages) PR.state.paper.meta.pages = options.pages;
  if (options.job) PR.state.job = options.job;
  if (options.mode) PR.store.mode = options.mode;
  if (options.target) PR.state.paper.meta.target = options.target;
  if (options.edited) PR.state.reader.edits = {'f1#image': {zh: 'edited'}};
  PR.state.figure_images_enabled = options.figureImages === true;
  PR.pageCapHtml = () => "";
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/common/markup.js"), "utf8"), { window: { PR }, URL });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/render.js"), "utf8"), {
    window: { PR },
    document: {
      documentElement: { dataset: {} },
      body: { classList: { toggle() {} } },
      getElementById: () => null,
      createElement: () => ({ innerHTML: "", firstChild: null, classList: { contains: () => false, add() {} }, querySelector: () => null }),
    },
    console,
  });
  PR.renderPaper();
  return paperEl.innerHTML;
}

test("translated figures pair original and translation without OCR text; stale results fall back", () => {
  const b = {id: 'f1', type: 'figure', page: 1, src: 'original.webp', image_en: 'Input', image_zh: '入力',
    translated_image: {src: 'translated.webp', source: 'original.webp', target: 'ja', image_en: 'Input', image_zh: '入力'}};
  const html = render([b], {target: 'ja'});
  assert.match(html, /data-translated-figure src="translated.webp"/);
  assert.match(html, /class="zh paired-translation figure-media"/);
  assert.match(html, /class="en figure-media"/);
  assert.doesNotMatch(html, /<details|data-key="f1#image"|入力|Input/);
  assert.match(html, /src="original.webp"/);
  assert.doesNotMatch(html, /class="figure-translation"/);
  for (const [block, options] of [[{...b, src: 'recropped.webp'}, {target: 'ja'}],
    [{...b, image_zh: 'new translation'}, {target: 'ja'}], [b, {target: 'de'}], [b, {target: 'ja', edited: true}]]) {
    const fallback = render([block], options);
    assert.doesNotMatch(fallback, /data-translated-figure/);
    assert.match(fallback, /figure-translation/);
  }
});

test('already translated documents offer image-only controls with progress and retries', () => {
  const block = {id: 'f1', type: 'figure', page: 1, src: 'original.webp'};
  const html = render([block], {mode: 'server', figureImages: true});
  assert.match(html, /data-t="figure-images"/);
  assert.match(html, /data-t="figure-image"/);
  assert.doesNotMatch(render([block]), /data-t="figure-image/);
  const running = render([block], {mode: 'server', figureImages: true, job: {type: 'figure-images', state: 'running', done: 1, total: 2, message: 'GENERATING'}});
  assert.match(running, /data-t="figure-image" disabled/);
  assert.match(running, /data-t="cancel-figure-images"/);
  assert.match(running, /GENERATING/);
  const failed = render([block], {mode: 'server', figureImages: true, job: {type: 'figure-images', state: 'partial', error: '<quota>', image_failed: {f1: 'quota'}}});
  assert.match(failed, /data-t="retry-figure-images"/);
  assert.match(failed, /&lt;quota&gt;/);
});

test('disabled image generation hides entry points while preserving existing image pairs', () => {
  const block = {id: 'f1', type: 'figure', page: 1, src: 'original.webp', image_en: 'Input', image_zh: '输入',
    translated_image: {src: 'translated.webp', source: 'original.webp', target: 'zh', image_en: 'Input', image_zh: '输入'}};
  const disabled = render([block], {mode: 'server', job: {type: 'figure-images', state: 'partial', image_failed: {f1: 'quota'}}});
  assert.doesNotMatch(disabled, /data-t="(?:figure-image|figure-images|retry-figure-images)"/);
  assert.match(disabled, /data-translated-figure src="translated.webp"/);
  assert.match(disabled, /class="en figure-media"/);
  assert.doesNotMatch(disabled, /<details|data-key="f1#image"/);
  const running = render([block], {mode: 'server', job: {type: 'figure-images', state: 'running'}});
  assert.match(running, /data-t="cancel-figure-images"/);
  assert.doesNotMatch(running, /data-t="figure-images"/);
});

test('regenerated images can use user-corrected labels without altering the translator text', () => {
  const b = {id: 'f1', type: 'figure', page: 1, src: 'original.webp', image_zh: 'old',
    translated_image: {src: 'corrected.webp', source: 'original.webp', target: 'zh', image_en: '', image_zh: 'edited'}};
  assert.match(render([b], {edited: true}), /data-translated-figure src="corrected.webp"/);
  assert.doesNotMatch(render([b]), /data-translated-figure/);
});

test("flat table head renders as one header row and does not hide later blocks", () => {
  const html = render([
    { id: "tab1", type: "table", page: 1, head: ["Method", "Score"], rows: [["A", "0.8"]] },
    { id: "p1", type: "para", page: 1, zh: "AFTER_TABLE" },
  ]);
  assert.match(html, /<thead><tr><th[^>]*>Method<\/th><th[^>]*>Score<\/th><\/tr><\/thead>/);
  assert.match(html, /AFTER_TABLE/);
});

test("one malformed block does not blank the rest of the reader", () => {
  const html = render([
    { id: "bad", type: "list", page: 1, items: "not-an-array" },
    { id: "p1", type: "para", page: 1, zh: "AFTER_MALFORMED_BLOCK" },
  ]);
  assert.match(html, /AFTER_MALFORMED_BLOCK/);
  assert.match(html, /bad/);
});

test("failed preparation shows escaped error and a model-free retry instead of a spinner", () => {
  const html = render([], { pages: [], mode: "server", job: { state: "error", error: 'MemoryError <script>bad()</script>' } });
  assert.match(html, /MemoryError &lt;script&gt;/);
  assert.match(html, /data-t="retry-prepare"/);
  assert.doesNotMatch(html, /class="spin"|<script>/);
  // main.js refreshes job-only updates only when this exact wrapper exists.
  assert.match(html, /class="pending-pages"><div class="pending"/);
});

test("only queued or running preparation shows a spinner", () => {
  for (const state of ["queued", "running", "cancelled", "done", ""]) {
    const html = render([], { pages: [], mode: "server", job: { state } });
    assert.equal(html.includes('class="spin"'), ["queued", "running"].includes(state));
    assert.equal(html.includes('data-t="retry-prepare"'), !["queued", "running"].includes(state));
  }
});

test("offline unprepared documents do not offer an unavailable retry API", () => {
  const html = render([], { pages: [], job: { state: "error", error: "MemoryError" } });
  assert.match(html, /MemoryError/);
  assert.doesNotMatch(html, /retry-prepare|class="spin"/);
});

