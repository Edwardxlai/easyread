const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

/* 版面用 document 坐标的 top / height 表示；视口 800 高，记的是 240（30%）那条线 */
function reader({ mode = "server", progress = {}, scrollY = 0 } = {}) {
  const layout = new Map([["b-head", { top: 0, height: 200 }]]);
  const timers = [], toasts = [], scrolls = [], on = new Map(), classes = new Set();
  const sandbox = {
    scrollY, innerHeight: 800,
    document: {
      documentElement: { scrollHeight: 5000 },  // 可滚 4200
      fonts: null,
      getElementById: id => {
        const box = layout.get(id);
        return box ? { id, getBoundingClientRect: () => ({ top: box.top - sandbox.scrollY, height: box.height }) } : null;
      },
    },
    window: {
      scrollTo: ({ top }) => { scrolls.push(top); sandbox.scrollY = top; },
      addEventListener: (name, fn) => on.set(name, fn),
      removeEventListener: (name, fn) => { if (on.get(name) === fn) on.delete(name); },
    },
    setTimeout: fn => timers.push(fn),
    clearTimeout() {},
  };
  const PR = {
    state: { paper: { blocks: [] }, reader: { progress } },
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s),
    plain: s => s, textFor: id => "正文 " + id, readingLine: () => 240,
    throttle: fn => fn,  // 多久记一次由 util.js 的节流管，这里只看记了什么
    readingBlock: () => "head",
    $$: () => [...layout.keys()].filter(id => id.startsWith("orig-")).map(id => sandbox.document.getElementById(id)),
    $: (sel) => (sel === "#paper" ? { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } } : null),
    blockById: {}, store: { mode },
    commit: op => { PR.committed.push(op); PR.state.reader.progress = { block: op.block, off: op.off, ratio: op.ratio }; },
    committed: [],
    toast: (text, opts) => toasts.push({ text, label: opts && opts.label }),
    flushPending: () => { PR.flushed = true; },
  };
  sandbox.PR = sandbox.window.PR = PR;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/progress.js"), "utf8"), sandbox);
  return {
    PR, sandbox, toasts, scrolls, on, classes,
    block(id, top, height) { layout.set("b-" + id, { top, height }); },
    page(n, top, height) { layout.set("orig-" + n, { top, height }); },
    read(id) { PR.readingBlock = () => id; },
    settle: async (n = 0) => { timers.splice(0, n || timers.length).forEach(fn => fn()); await new Promise(r => setImmediate(r)); },
  };
}

test("progress records the block, the position inside it, and the document ratio", () => {
  const r = reader({ scrollY: 1400 });
  r.block("p2", 1000, 2000);  // 240 那条线落在块顶下 640，块高 2000
  r.read("p2");
  assert.deepEqual({ ...r.PR.progressOp() }, { op: "progress", block: "p2", off: 0.32, ratio: 0.33 });
});

test("original PDF pages save their page anchor and offset when leaving", () => {
  const r = reader({ scrollY: 1400 });
  r.page(1, 200, 800); r.page(2, 1000, 2000); r.page(3, 3000, 1000);
  assert.deepEqual({ ...r.PR.progressOp() }, { op: "progress", block: "orig-2", off: 0.32, ratio: 0.33 });
  r.PR.watchProgress();
  r.on.get("pagehide")();
  assert.equal(r.PR.committed[0].block, "orig-2");
  assert.equal(r.PR.flushed, true);
});

test("reopening an original PDF restores the page offset after resizing", () => {
  const first = reader({ scrollY: 1400 });
  first.page(2, 1000, 2000);
  const r = reader({ progress: first.PR.progressOp() });
  r.page(2, 700, 1000);
  r.PR.state.paper.blocks = [{ id: "later-heading", type: "heading" }];
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [780]);
  assert.equal(r.PR.progressOp().block, "orig-2");
  assert.equal(r.PR.progressOp().off, 0.32);
  assert.deepEqual(r.toasts, [{ text: "已回到上次读到第 2 页", label: "回到顶部" }]);
});

test("mixed papers save the latest translated block or original page above the reading line", () => {
  const r = reader({ scrollY: 1400 });
  r.page(1, 200, 800); r.page(2, 1200, 1000); r.page(3, 3000, 1000);
  r.block("p1", 1000, 200); r.read("p1");
  assert.equal(r.PR.progressOp().block, "orig-2");
  r.block("p2", 1500, 500); r.read("p2");
  assert.equal(r.PR.progressOp().block, "p2");
});

test("an original page below the reading line does not replace the header", () => {
  const r = reader();
  r.page(1, 300, 1000);
  assert.equal(r.PR.progressOp().block, "head");
});

test("legacy PDF progress recorded as head falls back to its document ratio", () => {
  for (const off of [undefined, 1]) {
    const r = reader({ progress: { block: "head", ratio: 0.5, off } });
    r.page(1, 200, 2000); r.page(2, 2200, 2000);
    assert.equal(r.PR.restoreProgress(), true);
    assert.deepEqual(r.scrolls, [2100]);
  }
});

test("a real position inside a tall header still takes precedence over ratio", () => {
  const r = reader({ progress: { block: "head", off: 0.5, ratio: 0.2 } });
  r.block("head", 0, 1000);
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [260]);
});

test("a missing original page falls back to the document ratio", () => {
  const r = reader({ progress: { block: "orig-9", off: 0.4, ratio: 0.5 } });
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [2100]);
});

test("leaving captures the final scroll before sending pending operations", () => {
  const r = reader({ scrollY: 1400 });
  r.block("p2", 1000, 2000); r.read("p2"); r.PR.watchProgress();
  r.on.get("pagehide")();
  assert.equal(r.PR.committed[0].block, "p2");
  assert.equal(r.PR.committed[0].off, 0.32);
  assert.equal(r.PR.flushed, true);
});

test("nothing is recorded until the saved spot has been restored", async () => {
  const r = reader({ scrollY: 1400, progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.read("p2");
  await r.PR.flushProgress();
  assert.deepEqual(r.PR.committed, [], "还没回到上次的位置，不能拿现在的位置把记录盖掉");
  r.PR.watchProgress();
  await r.PR.flushProgress();
  assert.deepEqual(r.PR.committed, [], "回到原处没动，也不用写");
  r.sandbox.scrollY = 1600;
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 1, "之后往下读了才记");
});

test("the same spot is not written twice, a real move is", async () => {
  const r = reader({ scrollY: 1400 });
  r.block("p2", 1000, 2000);
  r.read("p2");
  r.PR.watchProgress();
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 1);
  assert.deepEqual({ ...r.PR.committed[0] }, { op: "progress", block: "p2", off: 0.32, ratio: 0.33 });
  assert.equal(r.PR.flushed, true, "退出前要把待发的操作发出去");
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 1, "没动就不重复记");
  r.block("p2", 1020, 2000);  // 挪一点，块内位置差 0.01
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 1);
  r.block("p2", 600, 2000);  // 块往上走一大截，块内位置差 0.2
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 2);
  assert.equal(r.PR.committed[1].off, 0.52);
});

test("opening a paper jumps straight to the saved spot", async () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.blockById = { p2: { id: "p2", page: 3 } };
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [1400], "块顶 + 块内位置 - 30% 那条线");
  assert.deepEqual(r.toasts, [{ text: "已回到上次读到第 3 页", label: "回到顶部" }]);
});

test("the jump is corrected once the page has laid out", async () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.restoreProgress();
  r.block("p2", 1600, 2000);  // 上面的段落排过版，比占位高度高
  await r.settle();
  assert.deepEqual(r.scrolls, [1400, 2000], "排好版后再对一次");
});

test("the jump keeps up while the page is still laying out", async () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.restoreProgress();
  r.block("p2", 1600, 2000);  // 字体排好，上面的段落比占位高度高
  await r.settle(1);
  assert.deepEqual(r.scrolls, [1400, 2000]);
  r.block("p2", 1900, 2000);  // 图片又排进来，接着把它挤走
  await r.settle(1);
  assert.deepEqual(r.scrolls, [1400, 2000, 2300], "版面还在变就继续跟，别只在最后对一次");
});

test("the estimated landing is never written over the recorded spot", async () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.restoreProgress();
  r.PR.watchProgress();          // 启动流程末尾会调它，但此刻位置还没对准
  r.block("p2", 1300, 2000);     // 字体还没排好，这时候量出来的是估的位置
  await r.PR.flushProgress();
  assert.deepEqual(r.PR.committed, [], "没对准就记下来，下次打开就会回到错的地方");
  await r.settle();              // 对准、亮出来
  r.block("p2", 2000, 2000);     // 之后真的往下读了
  await r.PR.flushProgress();
  assert.equal(r.PR.committed.length, 1, "对准之后照常记");
});

test("the paper stays hidden until the position is right", async () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.restoreProgress();
  assert.ok(r.classes.has("landing"), "落定之前先把正文藏起来，别让人看见估出来的位置");
  await r.settle();
  assert.ok(!r.classes.has("landing"), "对准了就亮出来");
});

test("the paper is shown at once when the user starts reading it", () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.restoreProgress();
  r.on.get("wheel")();
  assert.ok(!r.classes.has("landing"), "用户自己动了就立刻显示，不能留个空白");
});

test("the correction is skipped once the user has scrolled", async () => {
  const r = reader({ progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.restoreProgress();
  r.block("p2", 1600, 2000);
  r.on.get("wheel")();
  await r.settle();
  assert.deepEqual(r.scrolls, [1400], "用户自己动了就不打扰");
});

test("a paper left at the top is left alone", () => {
  const r = reader({ progress: { block: "head", off: 0, ratio: 0 } });
  assert.equal(r.PR.restoreProgress(), false);
  assert.deepEqual(r.scrolls, []);
  assert.deepEqual(r.toasts, []);
});

test("an old record without a position inside the block starts at that block", () => {
  const r = reader({ progress: { block: "p2", ratio: 0.5 } });  // 1.4.2 及以前记的只有 ratio
  r.block("p2", 1000, 2000);
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [760], "有块就按块落位：全文比例是拿当时的估算高度算的，能差好几段");
});

test("a block that is gone falls back to the document ratio", () => {
  const r = reader({ progress: { block: "p9", off: 0.5, ratio: 0.5 } });
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [2100]);
  assert.equal(r.toasts[0].label, "回到顶部");
});

test("the offline single-file build still asks before moving", () => {
  const r = reader({ mode: "static", progress: { block: "p2", off: 0.32, ratio: 0.33 } });
  r.block("p2", 1000, 2000);
  r.PR.blockById = { p2: { id: "p2", page: 3 } };
  assert.equal(r.PR.restoreProgress(), true);
  assert.deepEqual(r.scrolls, [], "导出的单文件版不替人决定");
  assert.deepEqual(r.toasts, [{ text: "上次读到第 3 页", label: "接着读" }]);
});
