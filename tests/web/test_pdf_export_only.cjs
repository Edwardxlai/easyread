const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function setup() {
  const nodes = new Map(), requests = [], order = [];
  function node(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const events = {}, classes = new Set(selector === "#importDlg" ? ["open"] : []);
    const el = { value: "", checked: false, dataset: {}, disabled: false, clicks: 0,
      classList: { contains: x => classes.has(x), add: x => classes.add(x), remove: x => classes.delete(x) },
      addEventListener: (name, fn) => (events[name] ||= []).push(fn),
      click() { this.clicks++; order.push(selector); },
      fire(name) { for (const fn of events[name] || []) fn({ target: this }); },
      clickChild(selector) {
        const target = { closest: query => query === selector ? node(selector) : null };
        for (const fn of events.click || []) fn({ target });
      },
      querySelector: () => ({ value: "reader-only instruction" }),
    };
    nodes.set(selector, el);
    return el;
  }
  const pref = { after: "translate", scope: "all" };
  const PR = { $: node, t: text => text, esc: String, icon: () => "", lang: "zh", target: "zh", targetName: () => "Chinese",
    ls: { get: (key, fallback) => key === "easyread-import" ? { ...pref } : fallback, set() { throw Error("must not change import defaults"); } },
    lib: { engine: "codex", async load() {}, select() {}, openReader() {} }, toast() {},
    pickFolder: async () => { order.push("directory"); return null; },
    api: async (url, options) => {
      requests.push({ url, options });
      return url.endsWith("/babeldoc") ? { state: "running", files: [] } : { id: "paper", new: true };
    },
  };
  node("#impPdfExport").checked = true;
  node("#impModel").value = "chosen-model";
  node("#impTarget").value = "ja";
  node("#impPdfDirectory").value = "/chosen-output";
  const context = { window: { PR, addEventListener() {} }, document: { addEventListener() {} },
    setInterval() {}, setTimeout() {} };
  for (const file of ["pdf-export.js", "import.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/library", file), "utf8"), context);
  }
  const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const selectFile = () => { node("#fileInput").files = [{ name: "paper.pdf", type: "application/pdf" }]; node("#fileInput").fire("change"); };
  return { PR, node, requests, order, flush, selectFile };
}

test("PDF-only button opens a picker and starts only the translated PDF with the chosen model and folder", async () => {
  const p = setup();
  p.node("#importDlg").clickChild("#impPdfOnly");
  assert.equal(p.node("#fileInput").clicks, 1);
  p.selectFile(); await p.flush();
  const imported = new URL(p.requests[0].url, "http://localhost");
  assert.equal(imported.searchParams.get("translate"), "0");
  assert.equal(imported.searchParams.get("read"), "0");
  assert.equal(imported.searchParams.get("translation_extra"), "");
  assert.equal(p.requests[1].url, "/api/p/paper/babeldoc");
  assert.equal(p.requests[1].options.body.model, "chosen-model");
  assert.equal(p.requests[1].options.body.output_dir, "/chosen-output");
  assert.equal(p.node("#fileInput").dataset.pdfOnly, undefined);
});

test("PDF-only uses an entered link without starting reader translation", async () => {
  const p = setup();
  p.node("#arxivRef").value = "https://example.org/paper.pdf";
  p.node("#importDlg").clickChild("#impPdfOnly"); await p.flush();
  assert.equal(p.node("#fileInput").clicks, 0);
  assert.equal(p.requests[0].url, "/api/import-url");
  assert.equal(p.requests[0].options.body.translate, false);
  assert.equal(p.requests[0].options.body.read, false);
  assert.equal(p.requests[1].url, "/api/p/paper/babeldoc");
  assert.equal(p.node("#impPdfOnly").disabled, false);
});

test("cancelling the missing output folder leaves the import untouched", async () => {
  const p = setup();
  p.node("#impPdfDirectory").value = "";
  p.node("#importDlg").clickChild("#impPdfOnly");
  p.selectFile(); await p.flush();
  assert.deepEqual(p.order, ["#fileInput", "directory"]);
  assert.equal(p.requests.length, 0);
  assert.equal(p.node("#importDlg").classList.contains("open"), true);
});

test("cancelling PDF selection does not change the next normal import", async () => {
  const p = setup();
  p.node("#importDlg").clickChild("#impPdfOnly");
  p.node("#fileInput").fire("cancel");
  p.node("#impPdfExport").checked = false;
  p.node("#importDlg").clickChild("#pick");
  p.selectFile(); await p.flush();
  assert.equal(new URL(p.requests[0].url, "http://localhost").searchParams.get("translate"), "1");
  assert.equal(p.requests.length, 1);
});
