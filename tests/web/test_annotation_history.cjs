const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

async function reader() {
  const handlers = {}, storage = new Map();
  const PR = { t: s => s, uid: () => "client", nowIso: () => new Date().toISOString(), emit() {},
    toast() {}, ls: { get: (key, fallback) => storage.get(key) || fallback, set: (key, value) => { storage.set(key, value); return true; } } };
  const context = vm.createContext({ window: { PR, addEventListener() {} }, location: { pathname: "" },
    document: { addEventListener: (key, fn) => { handlers[key] = fn; }, body: { classList: { contains: () => false } },
      getElementById: () => ({ textContent: JSON.stringify({ paper: { meta: { source_sha256: "history" } }, reader: {} }) }) },
    setTimeout() {}, clearTimeout() {} });
  for (const file of ["store", "annotation-history", "highlight-ranges"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/" + file + ".js"), "utf8"), context);
  await PR.load();
  const put = patch => PR.commit({ op: "note", note: { ...PR.state.reader.notes.n, ...patch, updated: PR.nowIso() } });
  return { PR, handlers, put };
}

test("extend, bridge, undo and toggle plain highlights without stacking or deleting notes", async () => {
  const { PR } = await reader();
  const text = "ABCDEFGHIJKLMNO", el = {}, active = () => Object.values(PR.state.reader.notes).filter(n => !n.deleted);
  let seq = 0;
  PR.uid = () => "n" + ++seq;
  PR.myNotes = active;
  PR.repliesTo = () => [];
  PR.saveNote = n => PR.commit({ op: "note", note: { ...n, updated: PR.nowIso() } });
  const draw = (start, end, color = "yellow", style) => PR.toggleHighlight({
    id: PR.uid(), anchor: "p", key: "p", start, quote: text.slice(start, end), kind: "highlight", color, style, body: "", created: PR.nowIso(),
  }, part => ({ part, el, text, start: part.start, end: part.start + part.quote.length }));
  const spans = () => active().filter(n => !n.body).map(n => [n.quote, n.color]).sort();
  draw(1, 4); draw(6, 9);
  const joined = draw(3, 7);
  assert.deepEqual(spans(), [["BCDEFGHI", "yellow"]]);
  assert.ok(PR.undoAnnotation(joined.id));
  assert.deepEqual(spans(), [["BCD", "yellow"], ["GHI", "yellow"]]);
  assert.ok(PR.redoAnnotation());
  PR.saveNote({ id: "keep", anchor: "p", kind: "note", body: "keep this", quote: "BCD" });
  assert.ok(draw(1, 9).erased);
  assert.deepEqual(spans(), []);
  assert.equal(active()[0].body, "keep this");
  PR.undoAnnotation();
  draw(3, 6, "green");
  assert.deepEqual(spans(), [["BC", "yellow"], ["DEF", "green"], ["GHI", "yellow"]]);
  PR.undoAnnotation();
  assert.ok(draw(3, 6).erased);
  assert.deepEqual(spans(), [["BC", "yellow"], ["GHI", "yellow"]]);
  const id = active().find(n => n.quote === "BC").id;
  assert.equal(draw(1, 3, "yellow", "underline").id, id);
  assert.equal(active().find(n => n.id === id).style, "underline");
  assert.deepEqual(spans(), [["BC", "yellow"], ["GHI", "yellow"]]);
  PR.saveNote({ ...PR.state.reader.notes[id], style: undefined, id: "legacy-marker" });
  assert.ok(draw(1, 3, "yellow", "underline").erased);
  assert.deepEqual(spans(), [["GHI", "yellow"]]);
  const attached = active().find(n => n.quote === "GHI");
  PR.saveNote({ ...attached, body: "my note", media_refs: [{ id: "fig1" }] });
  assert.equal(draw(6, 9, "yellow", "underline").id, attached.id);
  assert.ok(draw(6, 9, "yellow", "underline").erased);
  assert.equal(PR.state.reader.notes[attached.id].unmarked, true);
  assert.equal(PR.state.reader.notes[attached.id].body, "my note");
  assert.equal(PR.state.reader.notes[attached.id].media_refs[0].id, "fig1");
});

test("add, recolor, delete, undo and redo all persist through the offline operation queue", async () => {
  const { PR, put } = await reader();
  put({ id: "n", anchor: "p1", quote: "text", kind: "highlight", color: "yellow", body: "Keep this note" });
  put({ color: "blue", style: "underline" });
  PR.commit({ op: "note_del", id: "n" });
  assert.equal(PR.undoAnnotation(), true);
  assert.equal(PR.state.reader.notes.n.color, "blue");
  assert.equal(PR.state.reader.notes.n.body, "Keep this note");
  assert.equal(PR.undoAnnotation(), true);
  assert.equal(PR.state.reader.notes.n.color, "yellow");
  assert.equal(PR.state.reader.notes.n.style, undefined);
  assert.equal(PR.undoAnnotation(), true);
  assert.equal(PR.state.reader.notes.n.deleted, true);
  assert.equal(PR.redoAnnotation(), true);
  assert.equal(PR.state.reader.notes.n.color, "yellow");
  assert.ok(PR.exportOps().ops.length);
  put({ color: "green" });
  assert.equal(PR.redoAnnotation(), false);
});

test("Ctrl+Z and Command+Z handle annotations, while text fields keep native undo", async () => {
  const { PR, handlers, put } = await reader();
  put({ id: "n", anchor: "p1", quote: "text", kind: "highlight", color: "yellow" });
  let prevented = 0;
  const event = { key: "z", code: "KeyZ", ctrlKey: true, target: { closest: () => true }, preventDefault() { prevented++; } };
  handlers.keydown(event);
  assert.equal(prevented, 0);
  assert.equal(PR.state.reader.notes.n.deleted, undefined);
  event.target.closest = () => false;
  handlers.keydown(event);
  assert.equal(prevented, 1);
  assert.equal(PR.state.reader.notes.n.deleted, true);
  handlers.keydown({ ...event, ctrlKey: false, metaKey: true, shiftKey: true });
  assert.equal(PR.state.reader.notes.n.deleted, undefined);
  handlers.keydown({ ...event, ctrlKey: false, metaKey: true });
  assert.equal(PR.state.reader.notes.n.deleted, true);
});

test("undo does not overwrite an annotation modified remotely", async () => {
  const { PR, put } = await reader();
  put({ id: "n", anchor: "p1", quote: "text", kind: "highlight", color: "yellow" });
  PR.state.reader.notes.n.body = "Changed on another device";
  assert.equal(PR.undoAnnotation(), false);
  assert.equal(PR.state.reader.notes.n.body, "Changed on another device");
});

test("server key ordering does not prevent undo of a formula spanning annotation", async () => {
  const { PR, put } = await reader();
  PR.nowIso = () => "2099-10-15T16:00:00.000+08:00";
  put({ id: "n", anchor: "p1", quote: "text formula", kind: "highlight", color: "blue", style: "underline",
    parts: [{ anchor: "p1", key: "p1", quote: "text" }, { anchor: "eq1", key: "eq1", quote: "formula", math: true }] });
  PR.state.reader.notes.n = JSON.parse(JSON.stringify(PR.state.reader.notes.n, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
  assert.equal(PR.undoAnnotation(), true);
  assert.equal(PR.state.reader.notes.n.deleted, true);
  assert.equal(PR.redoAnnotation(), true);
  assert.equal(PR.state.reader.notes.n.parts[1].anchor, "eq1");
});
