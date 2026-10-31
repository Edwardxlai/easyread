const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function reader() {
  const listeners = new Map(), timers = new Map(), scrolls = [], observers = [];
  let nextTimer = 0;
  const PR = { state: {}, $: () => ({ offsetHeight: 50 }), throttle: fn => fn, on() {} };
  const window = {
    PR,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    scrollTo(value) { scrolls.push(value); if (value.behavior === "instant") context.scrollY = value.top; },
  };
  const context = {
    window, innerHeight: 800, scrollY: 0,
    document: { body: {}, documentElement: { scrollHeight: 20000 }, addEventListener() {} },
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    ResizeObserver: class {
      constructor(fn) { this.fn = fn; observers.push(this); }
      observe() {} disconnect() { this.disconnected = true; }
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/actions.js"), "utf8"), context);
  function block(top, height) {
    return {
      top, height, isConnected: true, style: { contentVisibility: "auto" }, closest() { return this; },
      getBoundingClientRect() { return { top: this.top - context.scrollY, height: this.height }; },
    };
  }
  return { PR, context, scrolls, observers, block, timers, fire(type) { [...(listeners.get(type) || [])].forEach(fn => fn()); } };
}

test("a long jump realigns after offscreen blocks and the target image change height", () => {
  const r = reader(), target = r.block(12000, 120);
  r.PR.centerOn(target);
  const initial = r.scrolls[0].top;
  r.context.scrollY = initial;
  target.top += 900;
  target.height = 400;
  r.fire("scrollend");
  assert.equal(r.context.scrollY, 12900 - 50 - (750 - 400) / 2);
  target.height = 600;
  r.observers[0].fn();
  assert.equal(r.context.scrollY, 12900 - 50 - (750 - 600) / 2);
  assert.equal(r.scrolls.at(-1).behavior, "instant");
});

test("manual input cancels corrections and restores normal deferred rendering", () => {
  const r = reader(), target = r.block(12000, 120);
  r.PR.centerOn(target);
  r.fire("wheel");
  target.top += 900;
  r.fire("scrollend"); r.observers[0].fn();
  assert.equal(r.scrolls.length, 1);
  assert.equal(target.style.contentVisibility, "auto");
  assert.equal(r.observers[0].disconnected, true);
  assert.equal(r.timers.size, 0);
});

test("a click after a find jump keeps the target laid out throughout pointerdown", () => {
  const r = reader(), target = r.block(12000, 120);
  r.PR.centerOn(target, true);
  r.fire("pointerdown");
  assert.equal(target.style.contentVisibility, "visible");
  const deferredStop = [...r.timers.values()].at(-1);
  deferredStop();
  assert.equal(target.style.contentVisibility, "auto");
  assert.equal(r.observers[0].disconnected, true);
});

test("a second jump cancels the first destination and clips tall targets to the document", () => {
  const r = reader(), first = r.block(12000, 120), second = r.block(19900, 1200);
  r.PR.centerOn(first);
  r.PR.centerOn(second, true);
  assert.equal(first.style.contentVisibility, "auto");
  assert.equal(r.observers[0].disconnected, true);
  assert.equal(r.context.scrollY, 19200);
  const count = r.scrolls.length;
  r.observers[0].fn();
  assert.equal(r.scrolls.length, count);
});
