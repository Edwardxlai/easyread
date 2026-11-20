const assert = require("node:assert/strict");
const { test } = require("node:test");
const { page } = require("../helpers/library_page.cjs");

const papers = () => Array.from({ length: 20 }, (unused, i) => ({
  id: "p" + i, title_zh: "示例论文 " + String(i).padStart(2, "0"), tags: i === 19 ? [] : ["分类"],
  added: "2026-01-" + String(i + 1).padStart(2, "0"), last_opened: "", status: "unread",
}));

test("return restores category, query, sort and the visible paper through the real library scripts", async () => {
  const p = page().library(papers()); await p.boot();
  Object.assign(p.PR.lib, { tag: "分类", q: "分类", sort: "title" }); p.PR.lib.render();
  p.node(".main").scrollTop = 600;
  p.PR.lib.openReader("p6");
  assert.ok(p.location.search.includes("library="));
  const r = page(p.location.href, p.storage);
  r.PR.libraryNav.readerBack("p6");
  assert.equal(r.node("#backBtn").title, "返回“分类”");
  const returned = page("http://127.0.0.1:8765" + r.node("#backBtn").href, p.storage).library(papers());
  await returned.boot();
  assert.equal(returned.PR.lib.tag, "分类");
  assert.equal(returned.node("#q").value, "分类");
  assert.equal(returned.node("#sort").value, "title");
  assert.equal(returned.PR.lib.selected, "p6");
  assert.equal(returned.node(".main").scrollTop, 600);
  assert.equal(returned.node("#list").focused.preventScroll, true);
  assert.equal(returned.location.search, "");
});

test("opening from details or the sidebar preserves normal links and records the category", async () => {
  for (const event of ["click", "auxclick", "contextmenu"]) {
    const p = page().library(papers()); await p.boot(); p.PR.lib.tag = "分类";
    const link = { href: "/read/p4", getAttribute() { return this.href; }, closest: () => true };
    const target = { closest: () => link };
    for (const fn of p.listeners.get("capture:" + event)) fn({ target });
    assert.ok(link.href.startsWith("/read/p4?library="));
    const r = page("http://127.0.0.1:8765" + link.href, p.storage);
    r.PR.libraryNav.readerBack("p4"); assert.equal(r.node("#backBtn").title, "返回“分类”");
  }
});

test("return restores the exact paper tag even when a category shares its name", async () => {
  const items = papers();
  const name = "分类/标签";
  items[4].labels = [name, "社交 VR"];
  items[5].tags = [name];
  const load = p => {
    p.library(items, [name]);
    p.setLibraryRead(() => ({ items, labels: [name, "社交 VR"], engine: "none" }));
    return p;
  };
  const p = load(page()); await p.boot();
  Object.assign(p.PR.lib, { view: "label", tag: name }); p.PR.lib.render();
  assert.deepEqual(p.rows.map(row => row.dataset.id), ["p4"]);
  p.PR.lib.openReader("p4");
  const reader = page(p.location.href, p.storage);
  reader.PR.libraryNav.readerBack("p4");
  const returned = load(page("http://127.0.0.1:8765" + reader.node("#backBtn").href, p.storage));
  await returned.boot();
  assert.equal(returned.PR.lib.view, "label");
  assert.equal(returned.node("#viewTitle").textContent, name);
  assert.equal(returned.PR.lib.selected, "p4");
  assert.deepEqual(returned.rows.map(row => row.dataset.id), ["p4"]);
});

test("browser back, including a cached library, locates the paper after recent-open sorting changes", async () => {
  const p = page().library(papers()); await p.boot(); p.PR.lib.tag = "分类"; p.PR.lib.render();
  p.node(".main").scrollTop = 900; p.PR.lib.openReader("p6");
  const updated = papers(); updated[6].last_opened = "2026-10-02"; updated[6].status = "reading";
  p.setItems(updated); p.location.href = "http://127.0.0.1:8765/"; await p.cachedBack();
  assert.equal(p.PR.lib.tag, "分类"); assert.equal(p.PR.lib.selected, "p6");
  assert.equal(p.rows[0].dataset.id, "p6"); assert.equal(p.node(".main").scrollTop, 0);
});

test("new reading tabs retain separate sources through shared storage, and a fresh home does not restore old state", async () => {
  const p = page().library(papers()); await p.boot(); p.PR.lib.tag = "分类"; p.PR.lib.openReader("p1");
  const first = p.location.href; p.location.href = "http://127.0.0.1:8765/";
  p.PR.lib.tag = null; p.PR.lib.view = "unread"; p.PR.lib.openReader("p2");
  const second = p.location.href;
  const a = page(first, p.storage), b = page(second, p.storage);
  a.PR.libraryNav.readerBack("p1"); b.PR.libraryNav.readerBack("p2");
  assert.equal(a.node("#backBtn").title, "返回“分类”");
  assert.equal(b.node("#backBtn").title, "返回“未读”");
  const home = page("http://127.0.0.1:8765/", p.storage).library(papers()); await home.boot();
  assert.equal(home.PR.lib.view, "all"); assert.equal(home.PR.lib.tag, null); assert.equal(home.PR.lib.selected, null);
});

test("a removed paper, category or changed status cannot force another category or crash the return", async () => {
  for (const scenario of ["removed-paper", "removed-category", "changed-status"]) {
    const p = page().library(papers()); await p.boot();
    p.PR.lib.tag = scenario === "changed-status" ? null : "分类";
    p.PR.lib.view = scenario === "changed-status" ? "unread" : "all";
    p.PR.lib.openReader("p3");
    const r = page(p.location.href, p.storage); r.PR.libraryNav.readerBack("p3");
    const list = papers().filter(i => scenario !== "removed-paper" || i.id !== "p3");
    if (scenario === "removed-category") list.forEach(i => { i.tags = []; });
    if (scenario === "changed-status") list.find(i => i.id === "p3").status = "reading";
    const home = page("http://127.0.0.1:8765" + r.node("#backBtn").href, p.storage).library(list, scenario === "removed-category" ? [] : ["分类"]);
    await home.boot();
    if (scenario === "removed-category") { assert.equal(home.PR.lib.tag, null); assert.equal(home.PR.lib.selected, "p3"); }
    else assert.equal(home.PR.lib.selected, null);
    if (scenario === "changed-status") assert.equal(home.PR.lib.view, "unread");
  }
});

test("missing, mismatched and corrupted contexts and blocked storage fall back to normal navigation", async () => {
  const p = page().library(papers()); await p.boot(); p.PR.lib.openReader("p1");
  const r = page(p.location.href, p.storage); r.PR.libraryNav.readerBack("p2");
  assert.equal(r.node("#backBtn").href, "/");
  p.storage.set("easyread-library-navigation", "{broken");
  assert.equal(r.PR.libraryNav.restore(), null);
  const blocked = page("http://127.0.0.1:8765/", new Map(), null, true).library(papers());
  await blocked.boot(); blocked.PR.lib.openReader("p1");
  assert.equal(blocked.location.pathname, "/read/p1"); assert.equal(blocked.location.search, "");
});
