const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const english = { name: 'Local English', lang: 'en-US', localService: true };
const british = { name: 'Local British English', lang: 'en-GB', localService: true };
const remote = { name: 'Cloud English', lang: 'en-US', localService: false, default: true };
function player(voices = [remote, english], supported = true, text = 'attend to', prefs = {}) {
  const nodes = Object.fromEntries(['speak', 'slow', 'stop', 'speech-status', 'accent', 'voice'].map(k => [k, {
    disabled: k !== 'accent', hidden: k === 'stop', replaceChildren(...children) { this.children = children; },
  }]));
  const events = {}, windowEvents = {}, said = [];
  let cancelCount = 0;
  const synth = {
    getVoices: () => voices, speak: utterance => said.push(utterance), cancel: () => { cancelCount++; },
    addEventListener: (name, fn) => { events[name] = fn; }, removeEventListener: name => { delete events[name]; },
  };
  const PR = { t: (s, vars) => vars ? s.replace('{n}', vars.n) : s, el: (_tag, attrs) => attrs,
    ls: { get: (key, fallback) => prefs[key] ?? fallback, set: (key, value) => { prefs[key] = value; } } };
  const window = {
    PR, speechSynthesis: supported ? synth : undefined,
    SpeechSynthesisUtterance: function(text) { this.text = text; },
    addEventListener: (name, fn) => { windowEvents[name] = fn; }, removeEventListener: name => { delete windowEvents[name]; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/selection-speech.js'), 'utf8'), { window });
  const api = PR.selectionSpeech({ querySelector: selector => nodes[selector.slice(9, -1)] }, text);
  return { api, nodes, said, synth, events, windowEvents, prefs, cancels: () => cancelCount,
    voices: value => { voices = value; events.voiceschanged(); } };
}

test('normal and slow playback use only local voices, without any translation request', () => {
  const p = player();
  assert.equal(p.said.length, 0);
  p.nodes.speak.onclick();
  assert.equal(p.said[0].text, 'attend to');
  assert.equal(p.said[0].voice, english);
  assert.equal(p.said[0].lang, 'en-US');
  assert.equal(p.said[0].rate, 1);
  p.nodes.slow.onclick();
  assert.equal(p.cancels(), 1);
  assert.equal(p.said[1].rate, 0.75);
  p.said[0].onerror(); // Late cancellation cannot clear the new playback state.
  assert.equal(p.nodes.stop.hidden, false);
  assert.equal(p.nodes['speech-status'].textContent, '正在朗读…');
  p.said[1].onend();
  assert.equal(p.nodes.stop.hidden, true);
});

test('missing local voices stay disabled; asynchronously installed voices enable playback', () => {
  const p = player([remote]);
  assert.equal(p.nodes.speak.disabled, true);
  p.nodes.speak.onclick();
  assert.equal(p.said.length, 0);
  assert.match(p.nodes['speech-status'].textContent, /安装/);
  p.voices([remote, english]);
  assert.equal(p.nodes.speak.disabled, false);
  assert.equal(p.said.length, 0);
  p.nodes.speak.onclick();
  assert.equal(p.said.length, 1);
});

test('stop, close, and page departure cancel speech and release listeners', () => {
  const p = player();
  p.nodes.speak.onclick();
  p.nodes.stop.onclick();
  assert.equal(p.cancels(), 1);
  assert.equal(p.nodes.stop.hidden, true);
  p.nodes.speak.onclick();
  p.api.dispose(); p.api.dispose();
  assert.equal(p.cancels(), 2);
  assert.deepEqual(Object.keys(p.events), []);
  assert.deepEqual(Object.keys(p.windowEvents), []);
  assert.equal(p.nodes.speak.onclick, null);
  const q = player();
  q.nodes.speak.onclick(); q.windowEvents.pagehide();
  assert.equal(q.cancels(), 1);
});

test('playback failure is visible and retry remains available', () => {
  const p = player();
  p.nodes.speak.onclick(); p.said[0].onerror();
  assert.match(p.nodes['speech-status'].textContent, /失败/);
  assert.equal(p.nodes.stop.hidden, true);
  p.nodes.speak.onclick();
  assert.equal(p.said.length, 2);
});

test('unsupported browsers explain unavailability; Chinese selections use a Chinese local voice', () => {
  const p = player([], false);
  assert.equal(p.nodes.speak.disabled, true);
  assert.match(p.nodes['speech-status'].textContent, /不支持/);
  p.api.dispose();
  const chinese = { name: 'Chinese', lang: 'zh-CN', localService: true };
  const q = player([english, chinese], true, '注意');
  q.nodes.speak.onclick();
  assert.equal(q.said[0].voice, chinese);
  assert.equal(q.nodes.accent.hidden, true);
});

test('accent changes stop playback, persist the choice, and wait for an explicit play click', () => {
  const p = player([remote, english, british]);
  assert.equal(p.nodes.accent.value, 'en-US');
  p.nodes.speak.onclick();
  p.nodes.accent.value = 'en-GB'; p.nodes.accent.onchange();
  assert.equal(p.cancels(), 1);
  assert.equal(p.said.length, 1);
  assert.equal(p.nodes.stop.hidden, true);
  p.said[0].onerror();
  assert.equal(p.nodes['speech-status'].textContent, '本地语音 · 1 个音色');
  p.nodes.slow.onclick();
  assert.equal(p.said[1].voice, british);
  assert.equal(p.said[1].lang, 'en-GB');
  assert.equal(p.said[1].rate, 0.75);
  p.nodes.accent.value = 'en-US'; p.nodes.accent.onchange();
  assert.equal(p.said.length, 2);
  p.nodes.speak.onclick();
  assert.equal(p.said[2].voice, english);
  p.nodes.accent.value = 'en-GB'; p.nodes.accent.onchange();
  p.api.dispose();
  const q = player([english, british], true, 'next word', p.prefs);
  assert.equal(q.nodes.accent.value, 'en-GB');
  assert.equal(q.said.length, 0);
  q.nodes.speak.onclick();
  assert.equal(q.said[0].voice, british);
});

test('a missing accent never falls back to another accent or a cloud voice', () => {
  const cloudBritish = { ...remote, lang: 'en-GB' };
  const p = player([english, cloudBritish]);
  p.nodes.accent.value = 'en-GB'; p.nodes.accent.onchange();
  assert.equal(p.nodes.speak.disabled, true);
  assert.match(p.nodes['speech-status'].textContent, /英国/);
  p.nodes.speak.onclick();
  assert.equal(p.said.length, 0);
  p.voices([english, cloudBritish, british]);
  assert.equal(p.nodes.speak.disabled, false);
  assert.equal(p.said.length, 0);
  p.nodes.speak.onclick();
  assert.equal(p.said[0].voice, british);
});

test('ordinary reading voices are preferred over the first macOS effect voice', () => {
  const whisper = { ...english, name: 'Whisper', voiceURI: 'mac-whisper' };
  const samantha = { ...english, name: 'Samantha', voiceURI: 'mac-samantha' };
  const daniel = { ...british, name: 'Daniel', voiceURI: 'mac-daniel' };
  const p = player([whisper, samantha, british, daniel, remote]);
  assert.equal(p.nodes.voice.value, 'mac-samantha');
  assert.equal(p.nodes.voice.children.length, 2);
  assert.equal(p.nodes['speech-status'].textContent, '本地语音 · 2 个音色');
  assert.equal(p.said.length, 0);
  p.nodes.speak.onclick();
  assert.equal(p.said[0].voice, samantha);
  p.nodes.accent.value = 'en-GB'; p.nodes.accent.onchange();
  assert.equal(p.nodes.voice.value, 'mac-daniel');
  assert.equal(p.said.length, 1);
  p.nodes.speak.onclick();
  assert.equal(p.said[1].voice, daniel);
});

test('each accent remembers the selected voice by stable ID, without autoplay', () => {
  const alternate = { ...english, name: 'Another voice', voiceURI: 'local-alternate' };
  const otherBritish = { ...british, name: 'Another British', voiceURI: 'local-gb-alternate' };
  const voices = [english, alternate, british, otherBritish];
  const p = player(voices);
  p.nodes.speak.onclick();
  p.nodes.voice.value = 'local-alternate'; p.nodes.voice.onchange();
  assert.equal(p.cancels(), 1);
  assert.equal(p.said.length, 1);
  p.nodes.slow.onclick();
  assert.equal(p.said[1].voice, alternate);
  p.nodes.accent.value = 'en-GB'; p.nodes.accent.onchange();
  p.nodes.voice.value = 'local-gb-alternate'; p.nodes.voice.onchange();
  p.nodes.accent.value = 'en-US'; p.nodes.accent.onchange();
  assert.equal(p.nodes.voice.value, 'local-alternate');
  p.api.dispose();
  const q = player([...voices].reverse(), true, 'word', p.prefs);
  assert.equal(q.nodes.voice.value, 'local-alternate');
  q.nodes.accent.value = 'en-GB'; q.nodes.accent.onchange();
  assert.equal(q.nodes.voice.value, 'local-gb-alternate');
  assert.equal(q.said.length, 0);
});

test('other computers use their installed voices and handle missing saved voices', () => {
  const installed = { ...english, name: 'System English', voiceURI: 'other-platform', default: true };
  const p = player([english, installed], true, 'word', { 'easyread-speech-voice-en-US': 'mac-samantha' });
  assert.equal(p.nodes.voice.value, 'other-platform');
  p.nodes.speak.onclick();
  assert.equal(p.said[0].voice, installed);
  p.voices([]);
  assert.equal(p.nodes.voice.disabled, true);
  assert.equal(p.nodes.voice.children[0].text, '无可用音色');
  p.voices([installed]);
  assert.equal(p.nodes.voice.disabled, false);
  assert.equal(p.nodes.voice.value, 'other-platform');
  assert.equal(p.said.length, 1);
});

test('the real popover releases speech on replacement and outside click', () => {
  const listeners = {};
  const node = { addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {},
    offsetWidth: 400, offsetHeight: 300, querySelector: () => null };
  const PR = { state: {}, store: { mode: 'server' }, ls: { get: () => ({}) }, debounce: fn => fn,
    $: () => node, icon: () => '', logo: () => '', t: s => s, on() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/panels.js'), 'utf8'), {
    window: { PR }, document: { body: {}, addEventListener: (name, fn) => { listeners[name] = fn; } },
    matchMedia: () => ({ addEventListener() {} }), clearTimeout, setTimeout, innerWidth: 1000, innerHeight: 800,
  });
  const at = { getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 120, width: 80 }) };
  const first = player(), second = player();
  PR.popover(at, 'first selection', { sticky: true, onClose: first.api.dispose });
  first.nodes.speak.onclick();
  PR.popover(at, 'second selection', { sticky: true, onClose: second.api.dispose });
  assert.equal(first.cancels(), 1);
  second.nodes.speak.onclick();
  listeners.mousedown({ target: { closest: () => null } });
  assert.equal(second.cancels(), 1);
  PR.hidePopover();
  assert.equal(second.cancels(), 1);
});
