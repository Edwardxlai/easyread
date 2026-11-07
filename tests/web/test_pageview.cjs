const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function reader(mode = "server") {
  const nodes = new Map();
  const events = new Map();
  const documentEvents = new Map();
  const scrolls = [];
  function node(selector) {
    if ([".pv-page", ".pv-page img", ".pv-hl"].includes(selector) && nodes.get(".pv-scroll")?.children.length) {
      const label = nodes.get(".pv-label")?.textContent || "1";
      const n = Number(label.match(/\d+/)[0]) - 1;
      const page = nodes.get(".pv-scroll").children[n];
      return selector === ".pv-page" ? page : page.children[selector === ".pv-hl" ? 1 : 0];
    }
    if (!nodes.has(selector)) nodes.set(selector, {
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, contains: () => false,
      dataset: {}, scrollTop: 0, listeners: {}, children: [], style: {}, checked: true, complete: true, clientWidth: 480, clientHeight: 480, offsetHeight: 1000,
      addEventListener(name, fn) { this.listeners[name] = fn; },
      replaceChildren(...children) { this.children = children; },
      scrollTo(value) { this.scroll = value; },
      getBoundingClientRect() { const top = this.dataset.n ? 18 + (Number(this.dataset.n) - 1) * 1018 - node(".pv-scroll").scrollTop : 0;
        return { left: 0, top, bottom: top + 1000, width: 1000, height: 1000 }; },
      getAttribute(name) { return this[name] || null; }, setAttribute(name, value) { this[name] = value; },
    });
    return nodes.get(selector);
  }
  let reading = "head", selected = null;
  const PR = {
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s),
    state: { paper: { meta: { pages: [{ img: "pages/one.webp" }, { img: "pages/two.webp" }] } }, layout: {} },
    $: node, on(name, fn) { events.set(name, fn); }, store: { mode }, imageUrl: img => "/p/paper/" + img,
    pdfUrl: page => "/p/paper/source.pdf#page=" + page,
    readingBlock: () => reading, currentBlock: () => selected,
    blockById: { first: { page: 1 }, second: { page: 2 } },
    jumpTo(id) { this.jumped = id; },
    fitWide() {}, renderMargin() {},
  };
  const sandbox = {
    window: { PR, scrollY: 0, innerHeight: 800, scrollTo: value => scrolls.push(value) }, document: { body: node("body"), addEventListener: (name, fn) => documentEvents.set(name, fn), getElementById: id => nodes.get(id) || null, createElement: () => node("created-" + nodes.size) },
    devicePixelRatio: 1, Image: class {}, setTimeout: () => 1, clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/page-zoom.js"), "utf8"), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/pageview.js"), "utf8"), sandbox);
  return { PR, node, events, documentEvents, scrolls, read: id => { reading = id; }, select: id => { selected = id; } };
}

test("opening original pages at the paper title loads the first image", () => {
  const r = reader();
  r.PR.togglePages(true);
  assert.equal(r.node(".pv-page img").src, "/p/paper/pages/one.webp?w=1000");
  assert.equal(r.node(".pv-label").textContent, "第 1 / 2 页");
});

test("scrolling follows the reading position after another block was selected", () => {
  const r = reader();
  r.select("second"); r.read("second"); r.PR.togglePages(true);
  assert.equal(r.node(".pv-page img").src, "/p/paper/pages/two.webp?w=1000");
  r.read("first"); r.PR.syncPage(false);
  assert.equal(r.node(".pv-page img").src, "/p/paper/pages/one.webp?w=1000");
});

test("turning off follow retains the manually selected original page", () => {
  const r = reader();
  r.select("second"); r.PR.togglePages(true);
  r.node(".pv-follow input").checked = false;
  r.read("first"); r.PR.syncPage(false);
  assert.equal(r.node(".pv-page img").src, "/p/paper/pages/two.webp?w=1000");
});

test("reenabling follow immediately resumes at the viewport instead of a stale selection", () => {
  const r = reader();
  r.select("second"); r.read("first"); r.PR.togglePages(true);
  const follow = r.node(".pv-follow input"), scroller = r.node(".pv-scroll");
  follow.checked = false;
  scroller.listeners.pointerdown();
  scroller.scrollTop = 1018; scroller.listeners.scroll();
  assert.equal(r.node(".pv-label").textContent, "第 2 / 2 页");
  follow.checked = true;
  follow.listeners.change?.();
  assert.equal(r.node(".pv-label").textContent, "第 1 / 2 页");
  r.read("second"); r.PR.syncPage(false);
  assert.equal(r.node(".pv-label").textContent, "第 2 / 2 页");
});

const crossing = () => ({ page: 1, box: [0.08, 0.10, 0.92, 0.90], boxes: [[0.08, 0.60, 0.48, 0.90], [0.52, 0.10, 0.92, 0.30]] });

test("server and offline readers draw separate regions and scroll to the first column", () => {
  for (const mode of ["server", "static"]) {
    const r = reader(mode);
    r.PR.state.layout.first = crossing();
    r.PR.openPage(1, "first");
    const regions = r.node(".pv-hl").children;
    assert.equal(regions.length, 2);
    assert.equal(regions[0].className, "pv-region");
    assert.equal(parseFloat(regions[0].style.left), 7.6);
    assert.equal(parseFloat(regions[1].style.left), 51.6);
    assert.ok(Math.abs(parseFloat(regions[0].style.height) - 30.6) < 0.000001);
    assert.equal(r.node(".pv-scroll").scroll.top, 528);
    assert.equal(r.node(".pv-page img").src, "/p/paper/pages/one.webp" + (mode === "server" ? "?w=1000" : ""));
  }
});

test("clicks hit either column fragment but leave the gutter and unrelated text alone", () => {
  const r = reader();
  r.PR.state.layout.first = crossing();
  r.PR.openPage(1, "first");
  const page = r.node(".pv-page");
  for (const [x, y, expected] of [[0.20, 0.75, "b-first"], [0.70, 0.20, "b-first"], [0.50, 0.70, null], [0.70, 0.75, null]]) {
    r.PR.jumped = null;
    page.listeners.click({ currentTarget: page, clientX: x * 1000, clientY: page.getBoundingClientRect().top + y * 1000 });
    assert.equal(r.PR.jumped, expected);
  }
});

test("legacy single boxes work and layout refresh replaces the visible regions", () => {
  const r = reader();
  r.PR.state.layout.first = { page: 1, box: [0.08, 0.60, 0.48, 0.90] };
  r.PR.openPage(1, "first");
  assert.equal(r.node(".pv-hl").children.length, 1);
  r.PR.state.layout.first = crossing();
  r.events.get("remote")(["layout"]);
  assert.equal(r.node(".pv-hl").children.length, 2);
});


test("continuous pages load nearby images and scrollbar updates the page without follow stealing it", () => {
  const r = reader();
  r.PR.state.paper.meta.pages = Array.from({ length: 27 }, (_, i) => ({ img: `pages/${i + 1}.webp`, w: 612, h: 792 }));
  r.PR.togglePages(true);
  const scroller = r.node(".pv-scroll");
  assert.equal(scroller.children.length, 27);
  assert.equal(scroller.children.filter(p => p.children[0].src).length, 3);
  scroller.listeners.pointerdown();
  scroller.scrollTop = 6 * 1018;
  scroller.listeners.scroll();
  assert.match(r.node(".pv-label").textContent, /7 \/ 27/);
  assert.equal(r.node('[data-pv="pdf"]').href, "/p/paper/source.pdf#page=7");
  assert.ok(scroller.children[6].children[0].src);
  r.read("second"); r.PR.syncPage(false);
  assert.match(r.node(".pv-label").textContent, /7 \/ 27/);
  assert.equal(r.PR.jumped, undefined);
  r.PR.pageStep(1);
  assert.equal(scroller.scroll.top, 7 * 1018);
});

test("right scrollbar moves text and highlights, respects follow, and hands control back", () => {
  const r = reader();
  r.node("b-first"); r.node("b-second");
  r.PR.state.layout.first = { page: 1, box: [0.1, 0.1, 0.9, 0.8] };
  r.PR.state.layout.second = { page: 2, box: [0.1, 0.1, 0.9, 0.8] };
  r.PR.togglePages(true);
  const scroller = r.node(".pv-scroll");
  scroller.scrollTop = 1018;
  scroller.listeners.scroll();
  assert.equal(r.scrolls.length, 0, "programmatic scrolling must not move text");
  scroller.listeners.scrollend();
  scroller.listeners.scroll();
  assert.equal(r.scrolls.length, 1, "native scrollbar must work without pointerdown");
  assert.equal(r.node(".pv-hl").children.length, 1);
  assert.equal(r.scrolls[0].behavior, "instant");
  const position = scroller.scroll;
  r.read("first"); r.PR.syncPage(false);
  assert.equal(scroller.scroll, position, "reverse sync must not pull the panel back");
  r.node(".pv-follow input").checked = false;
  scroller.scrollTop = 0; scroller.listeners.scroll();
  assert.equal(r.scrolls.length, 1, "unchecked follow must not move text");
  r.node(".pv-follow input").checked = true;
  r.documentEvents.get("wheel")({ target: { closest: () => null } });
  r.PR.syncPage(false);
  assert.notEqual(scroller.scroll, position, "left scrolling immediately resumes forward sync");
});
