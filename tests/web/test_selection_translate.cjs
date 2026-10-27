const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function reader() {
  const requests = [], popups = [], copied = [], speech = [];
  let current;
  const PR = {
    pid: 'paper',
    t: (s, vars) => vars ? s.replace('{msg}', vars.msg) : s,
    esc: s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    $: () => current,
    popover(_at, html, opts) {
      if (current) current.onClose();
      const nodes = { '.st-result': { setAttribute(k, v) { this[k] = v; } }, '[data-st-retry]': {}, '[data-st-copy]': {} };
      current = { html, nodes, onClose: opts.onClose, querySelector: s => nodes[s], addEventListener: (_t, fn) => { current.click = fn; } };
      popups.push(current);
    },
    hidePopover: () => { current.onClose(); current = null; }, toast() {},
    selectionSpeech: (root, text) => { const player = { root, text, dispose() { this.disposed = true; } }; speech.push(player); return player; },
    api: (url, opts) => new Promise((resolve, reject) => requests.push({ url, opts, resolve, reject })),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/selection-translate.js'), 'utf8'), {
    window: { PR }, navigator: { clipboard: { writeText: async text => copied.push(text) } },
  });
  return { PR, requests, popups, copied, speech, click: (popup, selector) => popup.click({ target: { closest: s => s === selector } }) };
}

test('translation keeps the full quote, shows loading, safely displays and copies the answer', async () => {
  const r = reader(), quote = '<script>word</script>\n' + 'long quote '.repeat(110);
  const pending = r.PR.translateSelection({ anchor: 'p1', quote, rect: {} });
  const popup = r.popups[0];
  assert.equal(r.speech[0].text, quote);
  assert.match(popup.html, /&lt;script&gt;/);
  assert.equal(popup.nodes['.st-result'].textContent, '正在翻译…');
  assert.equal(popup.nodes['[data-st-copy]'].disabled, true);
  assert.equal(r.requests[0].url, '/api/p/paper/translate-selection');
  assert.equal(r.requests[0].opts.body.text, quote);
  assert.equal(r.requests[0].opts.body.anchor, 'p1');
  const answer = '译义：<img src=x>\n用法：attend to';
  r.requests[0].resolve({ translation: answer }); await pending;
  assert.equal(popup.nodes['.st-result'].textContent, answer);
  assert.equal(popup.nodes['.st-result']['aria-busy'], 'false');
  assert.equal(popup.nodes['[data-st-copy]'].disabled, false);
  await r.click(popup, '[data-st-copy]');
  assert.deepEqual(r.copied, [answer]);
});

test('a failed request can retry the same selection', async () => {
  const r = reader();
  const pending = r.PR.translateSelection({ anchor: 'p1', quote: 'word', rect: {} });
  const popup = r.popups[0];
  r.requests[0].reject(new Error('<provider unavailable>')); await pending;
  assert.equal(popup.nodes['.st-result'].textContent, '翻译失败：<provider unavailable>');
  assert.equal(popup.nodes['[data-st-retry]'].hidden, false);
  const retry = r.click(popup, '[data-st-retry]');
  assert.equal(popup.nodes['[data-st-retry]'].hidden, true);
  r.requests[1].resolve({ translation: '词' }); await retry;
  assert.equal(popup.nodes['.st-result'].textContent, '词');
});

test('late answers never overwrite newer selections or reopen a closed popup', async () => {
  const r = reader();
  const first = r.PR.translateSelection({ anchor: 'p1', quote: 'first', rect: {} });
  const second = r.PR.translateSelection({ anchor: 'p2', quote: 'second', rect: {} });
  assert.equal(r.speech[0].disposed, true);
  r.requests[1].resolve({ translation: '第二个' }); await second;
  r.requests[0].resolve({ translation: '第一个' }); await first;
  assert.equal(r.popups[1].nodes['.st-result'].textContent, '第二个');
  const third = r.PR.translateSelection({ anchor: 'p3', quote: 'third', rect: {} });
  await r.click(r.popups[2], '[data-st-close]');
  assert.equal(r.speech[2].disposed, true);
  r.requests[2].resolve({ translation: '第三个' }); await third;
  assert.equal(r.PR.$(), null);
  assert.equal(r.popups.length, 3);
});

function selectionToolbar(mode, side) {
  const events = {}, clicks = {}, calls = [];
  const rect = { left: 100, top: 150, bottom: 170, width: 80 };
  const text = { data: 'We attend to tokens.', nodeType: 3 };
  const element = {
    classList: { contains: () => false },
    closest: selector => selector === '.blk' ? { dataset: { id: 'p1' } } : element,
    contains: () => true, querySelector: () => null,
  };
  text.parentElement = element;
  const range = { startContainer: text, endContainer: text, startOffset: 3, endOffset: 12, getBoundingClientRect: () => rect };
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range, removeAllRanges() { this.isCollapsed = true; } };
  const classes = new Set();
  const bar = { classList: { add: s => classes.add(s), remove: s => classes.delete(s), contains: s => classes.has(s) },
    offsetWidth: 400, offsetHeight: 36, style: {}, addEventListener: (event, fn) => { clicks[event] = fn; } };
  const PR = {
    state: {}, store: { mode }, prefs: {}, HL_COLORS: [], keysOn: false,
    $: () => bar, t: s => s, icon: () => '', debounce: fn => fn,
    zhOfEl: () => ({ dataset: { key: 'p1' } }), isEnEl: () => side === 'en',
    translateSelection: data => calls.push(data),
    startNote: () => assert.fail('Translation must not create a note'),
  };
  const document = {
    addEventListener: (event, fn) => { events[event] = fn; },
    createTreeWalker: () => { let seen = false; return { nextNode: () => { if (seen) return null; seen = true; return text; } }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/anchor.js'), 'utf8'), {
    window: { PR, getSelection: () => selection }, document, getSelection: () => selection,
    NodeFilter: { SHOW_TEXT: 4 }, innerWidth: 1000, setTimeout: fn => fn(),
  });
  events.mouseup({ target: { closest: () => null } });
  return { bar, calls, selection, click: () => clicks.click({ target: { closest: s => s === 'button[data-s]' ? { dataset: { s: 'translate' } } : null } }) };
}

test('selecting original or translated text exposes translation and passes the captured quote to the popup', () => {
  for (const side of ['en', 'zh']) {
    const r = selectionToolbar('server', side);
    assert.match(r.bar.innerHTML, /data-s="translate"/);
    r.click();
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].quote, 'attend to');
    assert.equal(r.calls[0].anchor, 'p1');
    assert.equal(r.calls[0].rect.top, 150);
    assert.equal(r.selection.isCollapsed, true);
    assert.equal(r.bar.classList.contains('open'), false);
  }
});

test('offline exports do not advertise an unavailable translation service', () => {
  assert.doesNotMatch(selectionToolbar('static', 'en').bar.innerHTML, /data-s="translate"/);
});
