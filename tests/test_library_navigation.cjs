const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = file => fs.readFileSync(path.join(__dirname, "../easyread/web/js/", file), "utf8");
const settled = () => new Promise(resolve => setImmediate(resolve));

function page(url = "http://127.0.0.1:8765/", storage = new Map(), state = null, blocked = false) {
  let current = new URL(url), seq = 0;
  const location = {
    get href() { return current.href; }, set href(value) { current = new URL(value, current); },
    get pathname() { return current.pathname; }, get search() { return current.search; },
  };
  const history = { state, replaceState(value, unused, url) { this.state = value; location.href = url; } };
  const nodes = new Map(), listeners = new Map(), windowEvents = new Map(), frames = [];
  let rows = [], items = [], categories = [], prefsResult = null;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", style: {}, dataset: {}, scrollTop: 0, offsetHeight: selector === ".list-head" ? 60 : 0,
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(name, fn) { this[name] = fn; },
      focus(options) { this.focused = options || true; },
      getBoundingClientRect() { return { top: 50, bottom: 650, height: 600 }; },
    });
    return nodes.get(selector);
  };
  Object.defineProperty(node("#list"), "innerHTML", {
    get() { return this.html || ""; },
    set(html) {
      this.html = html;
      rows = [...html.matchAll(/class="row[^\"]*" data-id="([^\"]+)"/g)].map(([unused, id], index) => ({
        dataset: { id }, classList: { toggle() {} },
        getBoundingClientRect() { const top = 110 + index * 120 - node(".main").scrollTop; return { top, bottom: top + 100 }; },
        scrollIntoView() { node(".main").scrollTop = Math.max(0, 60 + index * 120 - 250); },
      }));
    },
  });
  const PR = {
    uid: prefix => prefix + (++seq), $: node, $$: () => rows,
    ls: { get: (key, fallback) => fallback, set() {} },
    applyTheme() {}, useServerUi() {}, renderSide() {}, renderDetail() {},
    loadPrefs: async () => prefsResult || { library: { cats: categories } },
    icon: () => "", logo: () => "", esc: text => String(text || ""), debounce: fn => fn,
    api: async url => url === "/api/engines" ? { ready: true } : { items: structuredClone(items), engine: "none" },
  };
  const context = {
    window: { PR, addEventListener(name, fn) { windowEvents.set(name, fn); } },
    document: { addEventListener(name, fn, capture) { const key = (capture ? "capture:" : "") + name; if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(fn); } },
    location, history, URL, URLSearchParams,
    localStorage: { getItem: key => { if (blocked) throw new Error("storage blocked"); return storage.get(key) || null; },
      setItem: (key, value) => { if (blocked) throw new Error("storage blocked"); storage.set(key, value); } },
    requestAnimationFrame: fn => frames.push(fn), setTimeout() {}, clearTimeout() {},
  };
  vm.runInNewContext(source("common/library-nav.js"), context);
  return { PR, location, history, storage, node, listeners, windowEvents,
    get rows() { return rows; }, setItems(value) { items = value; },
    setPrefs(value) { prefsResult = value; },
    library(value, cats = ["调制器"]) {
      items = value; categories = cats;
      vm.runInNewContext(source("library/app.js"), context);
      PR.lib.VIEWS = [["all", "全部", "", () => true], ["unread", "未读", "", i => i.status === "unread"], ["reading", "在读", "", i => i.status === "reading"]];
      PR.lib.cats = () => categories;
      PR.lib.useServerSide = prefs => { categories = (prefs.library || {}).cats || categories; };
      return this;
    },
    async boot() { for (const fn of listeners.get("DOMContentLoaded") || []) fn(); await settled(); await settled(); frames.splice(0).forEach(fn => fn()); },
    async cachedBack() { windowEvents.get("pageshow")({ persisted: true }); await settled(); frames.splice(0).forEach(fn => fn()); },
  };
}

const papers = () => Array.from({ length: 20 }, (unused, i) => ({
  id: "p" + i, title_zh: "调制器 " + String(i).padStart(2, "0"), tags: i === 19 ? [] : ["调制器"],
  added: "2026-01-" + String(i + 1).padStart(2, "0"), last_opened: "", status: "unread",
}));

test("return restores category, query, sort and the visible paper through the real library scripts", async () => {
  const p = page().library(papers()); await p.boot();
  Object.assign(p.PR.lib, { tag: "调制器", q: "调制器", sort: "title" }); p.PR.lib.render();
  p.node(".main").scrollTop = 600;
  p.PR.lib.openReader("p6");
  assert.ok(p.location.search.includes("library="));
  const r = page(p.location.href, p.storage);
  r.PR.libraryNav.readerBack("p6");
  assert.equal(r.node("#backBtn").title, "返回“调制器”");
  const returned = page("http://127.0.0.1:8765" + r.node("#backBtn").href, p.storage).library(papers());
  await returned.boot();
  assert.equal(returned.PR.lib.tag, "调制器");
  assert.equal(returned.node("#q").value, "调制器");
  assert.equal(returned.node("#sort").value, "title");
  assert.equal(returned.PR.lib.selected, "p6");
  assert.equal(returned.node(".main").scrollTop, 600);
  assert.equal(returned.node("#list").focused.preventScroll, true);
  assert.equal(returned.location.search, "");
});

test("opening from details or the sidebar preserves normal links and records the category", async () => {
  for (const event of ["click", "auxclick", "contextmenu"]) {
    const p = page().library(papers()); await p.boot(); p.PR.lib.tag = "调制器";
    const link = { href: "/read/p4", getAttribute() { return this.href; }, closest: () => true };
    const target = { closest: () => link };
    for (const fn of p.listeners.get("capture:" + event)) fn({ target });
    assert.ok(link.href.startsWith("/read/p4?library="));
    const r = page("http://127.0.0.1:8765" + link.href, p.storage);
    r.PR.libraryNav.readerBack("p4"); assert.equal(r.node("#backBtn").title, "返回“调制器”");
  }
});

test("browser back, including a cached library, locates the paper after recent-open sorting changes", async () => {
  const p = page().library(papers()); await p.boot(); p.PR.lib.tag = "调制器"; p.PR.lib.render();
  p.node(".main").scrollTop = 900; p.PR.lib.openReader("p6");
  const updated = papers(); updated[6].last_opened = "2026-10-02"; updated[6].status = "reading";
  p.setItems(updated); p.location.href = "http://127.0.0.1:8765/"; await p.cachedBack();
  assert.equal(p.PR.lib.tag, "调制器"); assert.equal(p.PR.lib.selected, "p6");
  assert.equal(p.rows[0].dataset.id, "p6"); assert.equal(p.node(".main").scrollTop, 0);
});

test("new reading tabs retain separate sources through shared storage, and a fresh home does not restore old state", async () => {
  const p = page().library(papers()); await p.boot(); p.PR.lib.tag = "调制器"; p.PR.lib.openReader("p1");
  const first = p.location.href; p.location.href = "http://127.0.0.1:8765/";
  p.PR.lib.tag = null; p.PR.lib.view = "unread"; p.PR.lib.openReader("p2");
  const second = p.location.href;
  const a = page(first, p.storage), b = page(second, p.storage);
  a.PR.libraryNav.readerBack("p1"); b.PR.libraryNav.readerBack("p2");
  assert.equal(a.node("#backBtn").title, "返回“调制器”");
  assert.equal(b.node("#backBtn").title, "返回“未读”");
  const home = page("http://127.0.0.1:8765/", p.storage).library(papers()); await home.boot();
  assert.equal(home.PR.lib.view, "all"); assert.equal(home.PR.lib.tag, null); assert.equal(home.PR.lib.selected, null);
});

test("a removed paper, category or changed status cannot force another category or crash the return", async () => {
  for (const scenario of ["removed-paper", "removed-category", "changed-status"]) {
    const p = page().library(papers()); await p.boot();
    p.PR.lib.tag = scenario === "changed-status" ? null : "调制器";
    p.PR.lib.view = scenario === "changed-status" ? "unread" : "all";
    p.PR.lib.openReader("p3");
    const r = page(p.location.href, p.storage); r.PR.libraryNav.readerBack("p3");
    const list = papers().filter(i => scenario !== "removed-paper" || i.id !== "p3");
    if (scenario === "removed-category") list.forEach(i => { i.tags = []; });
    if (scenario === "changed-status") list.find(i => i.id === "p3").status = "reading";
    const home = page("http://127.0.0.1:8765" + r.node("#backBtn").href, p.storage).library(list, scenario === "removed-category" ? [] : ["调制器"]);
    await home.boot();
    if (scenario === "removed-category") { assert.equal(home.PR.lib.tag, null); assert.equal(home.PR.lib.selected, "p3"); }
    else assert.equal(home.PR.lib.selected, null);
    if (scenario === "changed-status") assert.equal(home.PR.lib.view, "unread");
  }
});

test("missing, mismatched and corrupted contexts and blocked storage fall back to normal navigation", async () => {
  const p = page().library(papers()); await p.boot(); p.PR.lib.openReader("p1");
  const r = page(p.location.href, p.storage); r.PR.libraryNav.readerBack("p2");
  assert.equal(r.node("#backBtn").href, undefined);
  p.storage.set("easyread-library-navigation", "{broken");
  assert.equal(r.PR.libraryNav.restore(), null);
  const blocked = page("http://127.0.0.1:8765/", new Map(), null, true).library(papers());
  await blocked.boot(); blocked.PR.lib.openReader("p1");
  assert.equal(blocked.location.pathname, "/read/p1"); assert.equal(blocked.location.search, "");
});
