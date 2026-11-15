const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = file => fs.readFileSync(path.join(__dirname, "../../easyread/web/js/", file), "utf8");
const settled = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function page(url = "http://127.0.0.1:8765/", storage = new Map(), state = null, blocked = false) {
  let current = new URL(url), seq = 0, clock = 0, timerSeq = 0;
  const location = {
    get href() { return current.href; }, set href(value) { current = new URL(value, current); },
    get pathname() { return current.pathname; }, get search() { return current.search; },
  };
  const history = { state, replaceState(value, unused, url) { this.state = value; location.href = url; } };
  const nodes = new Map(), listeners = new Map(), windowEvents = new Map(), frames = [], timers = new Map(), requests = [];
  let rows = [], items = [], categories = [], prefsResult = null, libraryRead;
  const scheme = { matches: false, listeners: [] };
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", style: { setProperty() {} }, dataset: {}, scrollTop: 0, offsetHeight: selector === ".list-head" ? 60 : 0,
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      addEventListener(name, fn) { this[name] = fn; },
      getAttribute(name) { return this[name] ?? null; },
      appendChild() {}, contains() { return false; }, matches() { return false; },
      focus(options) { this.focused = options || true; },
      getBoundingClientRect() { return { top: 50, bottom: 650, height: 600 }; },
    });
    return nodes.get(selector);
  };
  node("#backBtn").href = "/";
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
    t: (s, values = {}) => s.replace(/\{(\w+)\}/g, (m, key) => values[key] ?? m),
    titles: i => ({ main: i.title_zh || i.title_en || "" }),
    uid: prefix => prefix + (++seq), $: node, $$: () => rows,
    ls: { get: (key, fallback) => key === "easyread-lib-side" ? { cats: categories, hidden: [], pinned: [] } : fallback, set() {} },
    applyTheme() {}, useServerUi() {}, renderSide() {}, renderDetail() {}, savePrefs() {},
    loadPrefs: async () => prefsResult || { library: { cats: categories } },
    icon: () => "", logo: () => "", esc: text => String(text || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"),
    debounce: fn => fn, throttle: fn => fn, el: () => node("element:" + (++seq)), on() {},
    api: async url => url === "/api/engines" ? { ready: true } : { items: structuredClone(items), engine: "none" },
  };
  const context = {
    window: { PR, addEventListener(name, fn) { windowEvents.set(name, fn); } },
    document: { body: node("body"), activeElement: node("active"), addEventListener(name, fn, capture) { const key = (capture ? "capture:" : "") + name; if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(fn); } },
    location, history, URL, URLSearchParams, AbortController,
    localStorage: { getItem: key => { if (blocked) throw new Error("storage blocked"); return storage.get(key) || null; },
      setItem: (key, value) => { if (blocked) throw new Error("storage blocked"); storage.set(key, value); },
      removeItem: key => { if (blocked) throw new Error("storage blocked"); storage.delete(key); } },
    matchMedia: () => ({ get matches() { return scheme.matches; }, addEventListener(name, fn) { if (name === "change") scheme.listeners.push(fn); } }),
    requestAnimationFrame: fn => frames.push(fn),
    setTimeout(fn, ms) { const id = ++timerSeq; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      requests.push({ url, options });
      const data = libraryRead ? libraryRead(options, requests.length) : PR.api(url);
      return Promise.resolve(data).then(value => ({ ok: true, status: 200, json: async () => value }));
    },
  };
  context.katex = require("../../easyread/web/vendor/katex/katex.min.js");
  vm.runInNewContext(source("common/markup.js"), context);
  vm.runInNewContext(source("common/library-nav.js"), context);
  const p = { PR, location, history, storage, node, listeners, windowEvents, requests,
    get rows() { return rows; }, setItems(value) { items = value; },
    setPrefs(value) { prefsResult = value; }, setLibraryRead(fn) { libraryRead = fn; },
    preferColorScheme(matches) { scheme.matches = matches; scheme.listeners.forEach(fn => fn({ matches })); },
    library(value, cats = ["分类"]) {
      items = value; categories = cats;
      vm.runInNewContext(source("library/app.js"), context);
      vm.runInNewContext(source("library/cat-tree.js"), context);
      vm.runInNewContext(source("library/categories.js"), context);
      vm.runInNewContext(source("library/sidebar.js"), context);
      PR.renderSide = () => {};
      return this;
    },
    reader(load) {
      PR.pid = location.pathname.split("/").pop();
      PR.state = { paper: null, reader: {}, discussion: { entries: [] } };
      PR.store = { mode: "server" }; PR.applyPrefs = () => {}; PR.load = load;
      vm.runInNewContext(source("reader/main.js"), context);
      return this;
    },
    async flush() { await settled(); await settled(); frames.splice(0).forEach(fn => fn()); },
    async boot() { for (const fn of listeners.get("DOMContentLoaded") || []) fn(); await this.flush(); },
    async cachedBack() { windowEvents.get("pageshow")({ persisted: true }); await this.flush(); },
    async advance(ms) {
      const end = clock + ms;
      while (true) {
        const next = [...timers].filter(([id, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at; timers.delete(next[0]); next[1].fn(); await this.flush();
      }
      clock = end;
    },
  };
  return p;
}

module.exports = { page, deferred, settled };
