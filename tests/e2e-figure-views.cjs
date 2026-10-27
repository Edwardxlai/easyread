// Synthetic reader acceptance test using the project's Electron dependency.
// Run: node_modules/.bin/electron tests/e2e-figure-views.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../easyread/web');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 900 });
  try {
    await win.loadURL('about:blank');
    const styles = ['reader.css', 'reading-language.css'].map(f => fs.readFileSync(path.join(root, 'css', f), 'utf8')).join('\n');
    await win.webContents.insertCSS(styles);
    await win.webContents.executeJavaScript(`
      document.body.innerHTML = '<main id="paper"><section id="b-f1"></section></main>';
      const events = {};
      const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
      const block = {id: 'f1', type: 'figure', src: 'original.webp', image_en: 'OCR ORIGINAL', image_zh: 'OCR TRANSLATION',
        caption_en: 'Original caption', caption_zh: 'Translated caption',
        translated_image: {src: 'translated.webp', source: 'original.webp', target: 'zh', image_en: 'OCR ORIGINAL', image_zh: 'OCR TRANSLATION'}};
      window.PR = {
        state: {paper: {meta: {target: 'zh'}, blocks: [block]}, reader: {edits: {}}},
        prefs: {mode: 'zh', lead: 'translation', biOrder: 'translation'}, store: {mode: 'static'},
        $: s => document.querySelector(s), $$: s => Array.from(document.querySelectorAll(s)),
        el: (tag, attrs) => { const n = document.createElement(tag); for(const [k,v] of Object.entries(attrs)) n.setAttribute(k,v); return n; },
        on: (key, fn) => (events[key] ||= []).push(fn), emit: key => (events[key] || []).forEach(fn => fn('f1')),
        setPref: (key, value) => { PR.prefs[key] = value; document.body.classList.toggle('mode-bi', PR.prefs.mode === 'bi'); PR.applyReadingLanguage(); },
        t: s => s, targetName: s => s, esc: String, md: String, hashText: String,
        imageUrl: src => pixel + '#' + src, footnoteOptions: () => ({}), applyMarks() {},
      };
      void 0;
    `);
    for (const script of ['render.js', 'reading-language.js', 'figure-zoom.js']) {
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'js/reader', script), 'utf8'));
    }
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        PR.fitWide = () => {};
        PR.blockById.f1 = PR.state.paper.blocks[0]; PR.renderBlock('f1');
        await Promise.all(Array.from(document.querySelectorAll('.figure-media img'), img => {
          img.loading = 'eager';
          return img.decode();
        }));
        const check = (ok, msg) => { if (!ok) throw new Error(msg); };
        const visible = node => !!node && getComputedStyle(node).display !== 'none';
        const translated = () => document.querySelector('.figure-generated > .zh');
        const original = () => document.querySelector('.figure-generated > .en');
        const expect = (zh, en) => {
          check(visible(translated()) === zh && visible(original()) === en, 'wrong image visibility: ' + PR.readingView());
          check(!document.querySelector('[data-key="f1#image"]'), 'duplicate OCR text');
          check(visible(document.querySelector('.caption .zh')) === zh, 'caption and image translation differ');
          check(visible(document.querySelector('.caption .en')) === en, 'caption and original image differ');
        };
        PR.setView('translation'); expect(true, false);
        PR.setView('original'); expect(false, true);
        for (const first of ['original', 'translation']) {
          PR.setBiOrder(first); expect(true, true);
          const originalBefore = !!(original().compareDocumentPosition(translated()) & Node.DOCUMENT_POSITION_FOLLOWING);
          const originalAbove = original().getBoundingClientRect().top < translated().getBoundingClientRect().top;
          check(originalBefore === (first === 'original'), 'wrong image order');
          check(originalAbove === (first === 'original'), 'wrong visual order');
        }
        PR.setView('translation');
        document.querySelector('.blk').classList.add('show-en'); expect(true, true);
        document.querySelector('.blk').classList.remove('show-en');
        document.querySelector('[data-translated-figure]').dispatchEvent(new Event('error'));
        check(!translated() && !!document.querySelector('[data-key="f1#image"]'), 'load failure did not restore OCR');
        PR.renderBlock('f1');
        check(!translated(), 'rerender retried a broken image');
        PR.blockById.f1.translated_image.src = 'regenerated.webp'; PR.renderBlock('f1');
        expect(true, false);
        check(!document.querySelector('[data-t="figure-image"]'), 'disabled generation offers an action');
        return 'PASS: single views, both orders, matching captions, block expansion, no duplicate OCR, load fallback, regeneration';
      })()
    `);
    console.log(result);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
