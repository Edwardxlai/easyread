const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

async function offlineReader() {
  const storage = new Map();
  const PR = {
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s),
    uid: () => "client", nowIso: () => "2026-10-01T00:00:00Z", emit() {},
    ls: { get: (key, fallback) => storage.get(key) || fallback, set: (key, value) => { storage.set(key, value); return true; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/store.js"), "utf8"), {
    window: { PR, addEventListener() {} }, location: { pathname: "" },
    document: { getElementById: () => ({ textContent: JSON.stringify({ paper: { meta: { source_sha256: "paper0001" } }, reader: {} }) }) },
    setTimeout() {}, clearTimeout() {},
  });
  await PR.load();
  return PR;
}

test("progress keeps the block, the position inside it and the ratio", async () => {
  const PR = await offlineReader();
  PR.commit({ op: "progress", block: "p2", off: 0.32, ratio: 0.43 });
  assert.equal(PR.state.reader.progress.block, "p2");
  assert.equal(PR.state.reader.progress.off, 0.32);
  assert.equal(PR.state.reader.progress.ratio, 0.43);
  PR.commit({ op: "progress", block: "p9", off: 0.1, ratio: 0.8 });  // 后到的位置说了算
  assert.equal(PR.state.reader.progress.block, "p9");
  assert.equal(PR.state.reader.progress.off, 0.1);
  PR.commit({ op: "progress", block: "p10", ratio: 0.9 });
  assert.equal(PR.state.reader.progress.off, undefined);
});

test('image feature changes in another tab propagate without paper changes', async () => {
  let enabled = false;
  const events = [];
  const PR = {t: s => s, uid: () => 'client', emit: name => events.push(name),
    ls: {get: (_key, fallback) => fallback, set: () => true}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/store.js'), 'utf8'), {
    window: {PR, addEventListener() {}}, location: {pathname: '/read/paper'},
    document: {getElementById: () => null}, setTimeout() {}, clearTimeout() {},
    fetch: async url => ({ok: true, json: async () => url.endsWith('/state')
      ? {paper: {meta: {}}, reader: {}, versions: {}, figure_images_enabled: enabled}
      : {figure_images_enabled: enabled}}),
  });
  await PR.load();
  assert.equal(PR.state.figure_images_enabled, false);
  enabled = true;
  await PR.poll();
  assert.equal(PR.state.figure_images_enabled, true);
  enabled = false;
  await PR.poll();
  assert.equal(PR.state.figure_images_enabled, false);
  assert.equal(events.filter(name => name === 'figure-images-setting').length, 2);
});

test("exit waits for an in-flight save and drains the newer progress", async () => {
  const pending = [];
  const PR = { t: s => s, uid: () => "client", nowIso: () => "2026-10-14T00:00:00Z", emit() {},
    ls: { get: (_key, fallback) => fallback, set: () => true } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/store.js"), "utf8"), {
    window: { PR, addEventListener() {} }, location: { pathname: "/read/paper" },
    document: { getElementById: () => null }, setTimeout() {}, clearTimeout() {},
    fetch: async (url, options) => url.endsWith("/state")
      ? { ok: true, json: async () => ({ paper: { meta: {} }, reader: {}, token: "token" }) }
      : new Promise(resolve => pending.push({ options, finish: () => resolve({ ok: true, json: async () => ({ rev: 1 }) }) })),
  });
  await PR.load();
  PR.commit({ op: "progress", block: "p1", off: 0.1 });
  const first = PR.flush();
  PR.commit({ op: "progress", block: "p2", off: 0.2 });
  let saved = false;
  const exit = PR.flushPending().then(value => { saved = value; });
  await Promise.resolve();
  assert.equal(saved, false);
  pending[0].finish();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  assert.equal(JSON.parse(pending[1].options.body).ops[0].block, "p2");
  assert.equal(pending[1].options.keepalive, true);
  assert.equal(saved, false);
  pending[1].finish(); await exit;
  assert.equal(saved, true);
  assert.equal(PR.store.pending, 0);
});

test("offline deletes survive delayed note creation and export/import", async () => {
  const note = { op: "note", note: { id: "n1", body: "old", updated: "2026-10-01T00:01:00Z" } };
  const remove = { op: "note_del", id: "n1", at: "2026-10-01T00:02:00Z" };
  for (const ops of [[note, remove], [remove, note]]) {
    const PR = await offlineReader();
    ops.forEach(op => PR.commit(op));
    assert.equal(PR.state.reader.notes.n1.deleted, true);
    assert.equal(PR.exportOps().ops.find(op => op.op === "note").note.deleted, true);
    PR.commit({ ...note, note: { ...note.note, updated: "2026-10-01T00:03:00Z" } });
    assert.ok(!PR.state.reader.notes.n1.deleted);
  }
});
