const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup(read) {
  const messages = [], inserted = [], listeners = new Set();
  let reads = 0;
  const editor = {
    isDestroyed: false, body: '', state: { selection: { from: 10 }, doc: { content: { size: 20 } } },
    getMarkdown() { return this.body; },
    on(_event, fn) { listeners.add(fn); }, off(_event, fn) { listeners.delete(fn); },
    chain() { return { focus() { return this; }, insertContentAt(at, images) { inserted.push({ at, images }); return this; }, run() { return true; } }; },
  };
  const context = {
    window: { PR: { t: text => text, toast: text => messages.push(text) } }, TextEncoder,
    FileReader: class { readAsDataURL(file) { reads++; read(this, file, editor, listeners); } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/src/note-images.js'), 'utf8').replace('export async', 'async') + '\nthis.insert = insertNoteImages;', context);
  return { editor, messages, inserted, listeners, reads: () => reads, insert: files => context.insert(editor, files) };
}
const png = (size = 10) => ({ name: 'figure.png', size, type: 'image/png' });
const loaded = reader => { reader.result = 'data:image/png;base64,AAAA'; reader.onload(); };

test('large images and oversized batches are rejected before reading', async () => {
  const s = setup(loaded);
  assert.equal(await s.insert([png(2 * 1024 * 1024 + 1)]), false);
  assert.equal(await s.insert([png(2 * 1024 * 1024), png(2 * 1024 * 1024)]), false);
  assert.equal(s.reads(), 0);
  assert.equal(s.inserted.length, 0);
  assert.equal(s.messages.length, 2);
});

test('read failure inserts no partial batch and reports an actionable error', async () => {
  const s = setup((reader, file) => file.name === 'bad.png' ? reader.onerror() : loaded(reader));
  assert.equal(await s.insert([png(), { ...png(), name: 'bad.png' }]), false);
  assert.equal(s.inserted.length, 0);
  assert.equal(s.messages.length, 1);
  assert.equal(s.listeners.size, 0);
});

test('insertion follows edits made while the image is being read', async () => {
  const s = setup((reader, _file, editor, listeners) => {
    editor.state.doc.content.size = 2;
    for (const fn of listeners) fn({ transaction: { mapping: { map: () => 1 } } });
    loaded(reader);
  });
  assert.equal(await s.insert([png()]), true);
  assert.equal(s.inserted[0].at, 1);
  assert.equal(s.inserted[0].images[0].attrs.alt, 'figure.png');
  assert.equal(s.listeners.size, 0);
});

test('a destroyed editor is not used after reading', async () => {
  const s = setup((reader, _file, editor) => { editor.isDestroyed = true; loaded(reader); });
  assert.equal(await s.insert([png()]), false);
  assert.equal(s.inserted.length, 0);
  assert.equal(s.listeners.size, 0);
});

test('note budget is checked again after concurrent typing', async () => {
  const s = setup((reader, _file, editor) => { editor.body = 'x'.repeat(4 * 1024 * 1024); loaded(reader); });
  assert.equal(await s.insert([png()]), false);
  assert.equal(s.inserted.length, 0);
  assert.equal(s.messages.length, 1);
});
