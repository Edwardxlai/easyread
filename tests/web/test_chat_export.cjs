const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function exporter(chat, mode, failure) {
  let handler;
  const result = { notices: [], closed: false };
  const go = { disabled: false }, content = {}, location = {};
  const dlg = {
    querySelector: selector => selector === '[data-export-location]' ? location : content,
    querySelectorAll: () => [go], addEventListener(_event, fn) { handler = fn; },
    classList: { add() {}, remove() { result.closed = true; } },
  };
  const PR = {
    t: (s, vars) => vars ? s.replace(/\{(\w+)\}/g, (m, k) => vars[k]) : s,
    esc: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    state: { paper: { meta: { title_en: 'Test paper' }, blocks: [] }, reader: {}, discussion: {}, chat },
    store: { mode }, pid: 'test', $: () => dlg,
    $$: () => [{ dataset: { exp: 'chat' }, checked: true }],
    ls: { get: (_key, fallback) => fallback, set() {} }, myNotes: () => [], debounce: fn => fn,
    api: async () => { if (failure) throw new Error(failure); return chat; },
    canChooseExportFile: () => false, exportDirectory: async () => 'Downloads',
    saveExport: async blob => { result.text = await blob.text(); return 'download'; },
    toast: text => result.notices.push(text),
  };
  const context = { window: { PR, addEventListener() {} }, document: { addEventListener() {} }, Blob };
  for (const file of ['reader/notespanel.js', 'common/export-dialog.js', 'reader/export.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js', file), 'utf8'), context);
  }
  return { PR, result, click: () => handler({ target: { closest: selector => selector === '[data-export-go]' ? go : null } }) };
}

test('Markdown export retains every conversation and complete answer, online and offline', async () => {
  const answer = '## Complete answer\n\n$$x^2$$\n\n```python\nx = 1\n```';
  const chat = { threads: [
    { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: answer }] },
    { messages: [{ role: 'user', content: 'second' }, { role: 'assistant', content: 'normal answer' }] },
  ] };
  for (const mode of ['server', 'static']) {
    const e = exporter(chat, mode);
    await e.PR.openExport(); await e.click();
    for (const text of [answer, 'first', 'second', 'normal answer']) assert.ok(e.result.text.includes(text));
    assert.equal(e.result.closed, true);
  }
});

test('export failure keeps the dialog open and escapes error text without creating a file', async () => {
  const e = exporter({}, 'server', '<img src=x onerror="alert(1)">');
  await e.PR.openExport(); await e.click();
  assert.equal(e.result.closed, false);
  assert.equal(e.result.text, undefined);
  assert.match(e.result.notices[0], /&lt;img/);
  assert.doesNotMatch(e.result.notices[0], /<img/);
});
