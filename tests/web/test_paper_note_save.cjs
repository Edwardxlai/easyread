const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function reader() {
  const events = { panel: {}, window: {}, document: {} }, commits = [];
  const textarea = { id: "paperNote", value: "", matches: () => false };
  const panel = { addEventListener: (type, fn) => events.panel[type] = fn };
  const PR = {
    state: { reader: {}, paper: {}, discussion: {} },
    $: s => s === "#paperNote" ? textarea : s === "#notespanel" ? panel : null,
    debounce(fn) { const delayed = () => {}; delayed.flush = fn; delayed.cancel = () => {}; return delayed; },
    ls: { set() {} }, paperNoteEditor: { update() {} },
    commit(op) { commits.push(op); PR.state.reader.paper_note = { body: op.body }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/notespanel.js"), "utf8"), {
    window: { PR, addEventListener: (type, fn) => events.window[type] = fn },
    document: { hidden: true, addEventListener: (type, fn) => events.document[type] = fn },
  });
  PR.renderNotesPanel = () => {};
  return { PR, events, textarea, commits, input(text) { textarea.value = text; events.panel.input({ target: textarea }); } };
}

test("leaving, hiding and switching panels save the current editor body before the debounce", () => {
  for (const event of ["pagehide", "beforeunload", "visibilitychange", "panel"]) {
    const r = reader();
    r.input("# 最新笔记\n- 尚未等待自动保存");
    assert.equal(r.commits.length, 0);
    if (event === "panel") r.PR.finishPanelNote();
    else (r.events.window[event] || r.events.document[event])();
    assert.equal(r.commits.length, 1);
    assert.equal(r.commits[0].body, r.textarea.value);
    r.PR.finishPanelNote();
    assert.equal(r.commits.length, 1); // 相同内容不重复提交。
  }
});

test("export and tab switching flush the latest text synchronously", () => {
  for (const selector of ["[data-np]", "[data-np-act]"]) {
    const r = reader();
    let exported;
    r.PR.openExport = () => exported = r.PR.state.reader.paper_note.body;
    r.input("最后一行");
    const button = { dataset: { np: "notes", npAct: "md" } };
    r.events.panel.click({ target: { closest: s => s === selector ? button : null } });
    assert.equal(r.PR.state.reader.paper_note.body, "最后一行");
    if (selector === "[data-np-act]") assert.equal(exported, "最后一行");
  }
});

test("clearing a saved note persists an empty body", () => {
  const r = reader();
  r.PR.state.reader.paper_note = { body: "原来的内容" };
  r.input(""); r.PR.finishPanelNote();
  assert.equal(r.commits[0].body, "");
});
