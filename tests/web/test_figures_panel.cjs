const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function reader(blocks = [], edits = {}) {
  const events = new Map(), nodes = new Map();
  const list = { scrollTop: 0, writes: 0, value: "", set innerHTML(html) { this.value = html; this.writes++; this.scrollTop = 0; }, get innerHTML() { return this.value; } };
  const close = { addEventListener(type, fn) { this[type] = fn; } }, count = {};
  const panel = { querySelector: s => ({ ".fp-list": list, ".fp-count": count, "[data-fp-close]": close })[s] };
  nodes.set("#figurespanel", panel);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const PR = {
    state: { paper: { blocks, meta: {} }, reader: { edits } }, store: { mode: "server" },
    $: s => nodes.get(s), on: (type, fn) => events.set(type, fn),
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (_, k) => v[k]) : s,
    esc, md: esc, plain: s => s, imageUrl: s => "/p/test/" + s,
    openSide(name) { this.side = name; },
  };
  const context = { window: { PR }, document: { addEventListener() {} } };
  for (const file of ["render", "media-preview", "figurespanel"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/" + file + ".js"), "utf8"), context);
  }
  blocks.filter(Boolean).forEach(b => { PR.blockById[b.id] = b; });
  PR.toggleFiguresPanel(true);
  return { PR, list, close, count, events };
}

const figure = { id: "fig1", type: "figure", num: "1", page: 3, src: "figures/one.webp", caption_en: "Figure 1", caption_zh: "图一", image_en: "Accuracy", image_zh: "准确率" };

test("figures are listed in paper order with captions, labels and navigation", () => {
  const r = reader([null, { id: "p1", type: "para", en: "body" }, figure, { ...figure, id: "fig2", num: "2" }]);
  assert.equal(r.count.textContent, "共 2 张");
  assert.ok(r.list.innerHTML.indexOf('data-figure-id="fig1"') < r.list.innerHTML.indexOf('data-figure-id="fig2"'));
  for (const text of ["Figure 1", "图一", "Accuracy", "准确率", 'src="/p/test/figures/one.webp"', 'data-media-go="fig1"', 'data-media-page="3"']) assert.ok(r.list.innerHTML.includes(text));
  assert.doesNotMatch(r.list.innerHTML, /data-key=|id="b-/);
});

test("reader edits and new translated blocks refresh without resetting independent scroll", () => {
  const r = reader([figure], { "fig1#caption": { zh: "我的图注" }, "fig1#image": { zh: "我的图内文字" } });
  assert.match(r.list.innerHTML, /我的图注/);
  assert.match(r.list.innerHTML, /我的图内文字/);
  r.list.scrollTop = 420;
  r.PR.state.reader.edits["fig1#caption"].zh = "更新后的图注";
  r.events.get("reader")({ op: "edit" });
  assert.equal(r.list.scrollTop, 420);
  assert.match(r.list.innerHTML, /更新后的图注/);
  const writes = r.list.writes;
  r.events.get("reader")({ op: "progress" });
  r.events.get("reader")({ op: "note" });
  assert.equal(r.list.writes, writes);
  r.PR.state.paper.blocks.push({ ...figure, id: "fig2" });
  r.PR.blockById.fig2 = r.PR.state.paper.blocks[1];
  r.events.get("rendered")();
  assert.equal(r.count.textContent, "共 2 张");
  assert.equal(r.list.scrollTop, 420);
});

test("original-only and legacy figures remain readable without translations or image files", () => {
  const r = reader([{ id: "fig1", type: "figure", page: 2, caption_en: "Original caption", image_en: "Source label" }]);
  assert.match(r.list.innerHTML, /Original caption/);
  assert.match(r.list.innerHTML, /Source label/);
  assert.doesNotMatch(r.list.innerHTML, /fp-bilingual/);
  assert.match(r.list.innerHTML, /尚无图像/);
  assert.match(r.list.innerHTML, /data-media-page="2"/);
});

test("generated images retain the original image and extracted labels", () => {
  const b = { ...figure, translated_image: { src: "figures/translated.webp", source: figure.src, target: "zh", image_en: figure.image_en, image_zh: figure.image_zh } };
  const r = reader([b]);
  assert.match(r.list.innerHTML, /src="\/p\/test\/figures\/translated.webp"/);
  assert.match(r.list.innerHTML, /src="\/p\/test\/figures\/one.webp"/);
  assert.match(r.list.innerHTML, /准确率/);
});

test("empty papers and close/reopen preserve panel behavior", () => {
  const r = reader();
  assert.match(r.list.innerHTML, /这篇论文还没有整理好的图片/);
  assert.equal(r.count.textContent, "共 0 张");
  r.close.click();
  assert.equal(r.PR.side, null);
  r.list.scrollTop = 80;
  r.PR.toggleFiguresPanel();
  assert.equal(r.PR.side, "figures");
  assert.equal(r.list.scrollTop, 80);
});

test("figure metadata and text cannot inject HTML into the panel", () => {
  const r = reader([{ ...figure, id: 'bad" onclick="alert(1)', image_zh: '<script>alert(1)</script>' }]);
  assert.doesNotMatch(r.list.innerHTML, /<script>|data-figure-id="bad"/);
  assert.match(r.list.innerHTML, /&lt;script&gt;/);
});
