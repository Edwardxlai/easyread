const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

function setup() {
  const clicks = [], calls = [], notices = [];
  const PR = {state: {job: {}, figure_images_enabled: true}, pid: 'paper1', store: {mode: 'server'}, blockById: {f1: {id: 'f1', type: 'figure'}},
    t: s => s, esc: String, throttle: fn => fn, on() {}, $$: () => [],
    $: () => ({classList: {remove() {}}}), flushPending: async () => true,
    api: async (url, options) => calls.push({url, body: options.body}), poll: async () => {}, toast: msg => notices.push(msg)};
  const document = {addEventListener: (name, fn) => {if (name === 'click') clicks.push(fn);}};
  vm.runInNewContext(fs.readFileSync('easyread/web/js/reader/actions.js', 'utf8'), {window: {PR, addEventListener() {}}, document,
    getSelection: () => ({toString: () => ''})});
  async function click(action, id) {
    const button = {dataset: {t: action}, closest: s => s === '#paper' ? {} : s === '.blk' && id ? {dataset: {id}} : null};
    const target = {closest: s => s === '[data-t]' || s.includes('a, button,') ? button : s === '#paper .blk' && id ? {dataset: {id}} : null};
    for (const fn of clicks) fn({target});
    await new Promise(resolve => setImmediate(resolve));
  }
  return {PR, calls, notices, click};
}

test('whole-paper, single-image and retry controls submit image-only jobs', async () => {
  const r = setup();
  await r.click('figure-images');
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls[0])), {url: '/api/p/paper1/figure-images', body: {force: false}});
  await r.click('figure-image', 'f1');
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls[1].body)), {ids: ['f1'], force: true});
  r.PR.state.job = {state: 'partial', image_failed: {f1: 'quota'}};
  await r.click('retry-figure-images');
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls[2].body)), {ids: ['f1'], force: true});
  await r.click('cancel-figure-images');
  assert.equal(r.calls[3].url, '/api/p/paper1/cancel');
  assert.ok(r.calls.every(c => !c.url.endsWith('/translate')));
});

test('pending edits are saved before generation and save failure does not submit', async () => {
  const r = setup();
  r.PR.flushPending = async () => false;
  await r.PR.generateFigureImages(['f1'], true);
  assert.equal(r.calls.length, 0);
  assert.match(r.notices[0], /保存文字修改/);
  r.PR.flushPending = async () => {assert.equal(r.calls.length, 0); return true;};
  await r.PR.generateFigureImages(['f1'], true);
  assert.equal(r.calls.length, 1);
});

test('active paper jobs and offline exports do not submit new image calls', async () => {
  const r = setup();
  r.PR.state.job = {state: 'running'};
  await r.PR.generateFigureImages();
  r.PR.state.job = {};
  r.PR.store.mode = 'static';
  await r.PR.generateFigureImages();
  assert.equal(r.calls.length, 0);
});

test('disabled generation cannot submit via stale controls', async () => {
  const r = setup();
  r.PR.state.figure_images_enabled = false;
  await r.click('figure-images');
  await r.click('figure-image', 'f1');
  assert.equal(r.calls.length, 0);
});
