const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function reader() {
  let keydown;
  const actions = [];
  const events = {};
  const PR = {
    state: {}, keysOn: true, hasPendingSelection: () => true,
    selectionAction: (...args) => actions.push(args),
    throttle: fn => fn, debounce: fn => fn, on(name, listener) { events[name] = listener; },
    libraryNav: { readerBack() {} }, applyPrefs() {},
    load: () => new Promise(() => {}), // Boot data is irrelevant to keyboard handling.
    keyAction: () => null,
  };
  const document = { body: { classList: { contains: () => false } }, querySelector: () => null,
    addEventListener: (type, fn) => { if (type === "keydown") keydown = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/main.js"), "utf8"), { window: { PR }, document });
  return {
    PR, actions, events,
    press(overrides = {}) {
      const event = { key: "Process", code: "Digit1", isComposing: true, target: { closest: () => null }, preventDefault() { this.prevented = true; }, ...overrides };
      keydown(event);
      return event;
    },
  };
}

test("adding four single-block highlights never rebuilds the marks in other blocks", () => {
  const { PR, events } = reader();
  const painted = [];
  Object.assign(PR, {
    noteMedia: { isRenaming: () => false },
    applyMarks: block => painted.push(block),
    renderMargin() {}, notesPanelOpen: () => false,
  });
  for (const anchor of ["p5-8", "p5-9", "p6-1", "p6-2"]) {
    events.reader({ op: "note", highlightBlocks: [anchor], note: { anchor } });
  }
  assert.deepEqual(painted, ["p5-8", "p5-9", "p6-1", "p6-2"]);
});

test("selection shortcuts recognize physical keys when an IME reports Process", () => {
  const r = reader();
  ["yellow", "green", "blue", "pink"].forEach((color, i) => {
    assert.equal(r.press({ code: "Digit" + (i + 1) }).prevented, true);
    assert.deepEqual(r.actions.at(-1), ["highlight", color]);
  });
  r.press({ code: "KeyN" });
  assert.deepEqual(r.actions.at(-1), ["note"]);
  r.press({ code: "KeyQ" });
  assert.deepEqual(r.actions.at(-1), ["question"]);
});

test("selection shortcuts never consume editing or modifier-key input", () => {
  const r = reader();
  for (const overrides of [
    { target: { closest: () => ({ tagName: "TEXTAREA" }) } },
    { ctrlKey: true }, { metaKey: true }, { altKey: true },
  ]) assert.equal(r.press(overrides).prevented, undefined);
  assert.equal(r.actions.length, 0);
});

test("disabled shortcuts and missing selections leave IME events alone", () => {
  const r = reader();
  r.PR.keysOn = false;
  assert.equal(r.press().prevented, undefined);
  r.PR.keysOn = true;
  r.PR.hasPendingSelection = () => false;
  assert.equal(r.press().prevented, undefined);
  assert.equal(r.actions.length, 0);
});

test("ordinary key values still work when physical codes are unavailable", () => {
  const r = reader();
  r.press({ key: "2", code: "", isComposing: false });
  assert.deepEqual(r.actions.at(-1), ["highlight", "green"]);
  r.press({ key: "N", code: "", isComposing: false });
  assert.deepEqual(r.actions.at(-1), ["note"]);
});

// The IME fix must not introduce the Shift+number pen switching from #81.
test("shift-number does not introduce a new pen binding", () => {
  const r = reader();
  assert.equal(r.press({ code: "Digit1", key: "!", shiftKey: true }).prevented, undefined);
  assert.equal(r.press({ code: "Digit1", shiftKey: true }).prevented, undefined);
  assert.equal(r.actions.length, 0);
});
