// Run with Electron; uses an isolated fixture and never opens the user's library.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'outputs', 'math-marks-check');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const url = name => pathToFileURL(path.join(root, 'easyread/web', name)).href;
const fixture = path.join(output, 'fixture.html');
fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${url('vendor/katex/katex.min.css')}">
<link rel="stylesheet" href="${url('css/base.css')}"><link rel="stylesheet" href="${url('css/reader.css')}">
<style>body{display:block;margin:32px;background:white;color:#222}#paper{font-size:24px;width:850px}
.blk{margin:28px 0}.zh{font-size:24px;line-height:1.7}h2{font:20px sans-serif}</style>
<main id="paper"><h2>行内公式</h2><div class="blk" id="b-inline" data-id="inline"><div class="zh" data-key="inline"></div></div>
<h2>独立公式</h2><div class="blk" id="b-display" data-id="display"><div class="math-body"></div></div></main>
<div id="selbar"></div><script src="${url('vendor/katex/katex.min.js')}"></script>`);
const timeout = setTimeout(() => { console.error('Math rendering check timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 620, webPreferences: { sandbox: true } });
  try {
    await win.loadFile(fixture);
    await win.webContents.executeJavaScript(`
      window.PR = {state:{reader:{notes:{}},discussion:{entries:[]}}, prefs:{}, store:{mode:'server'},
        $: s=>document.querySelector(s), $$:(s,el=document)=>[...el.querySelectorAll(s)],
        debounce:fn=>fn, myNotes:()=>Object.values(PR.state.reader.notes), noteEl:el=>el};
      document.querySelector('#b-inline .zh').innerHTML = '选中的公式 ' + katex.renderToString(String.raw\`x_i^2 + \\frac{a+b}{c}\`) + ' 与正文一致';
      document.querySelector('.math-body').innerHTML = katex.renderToString(String.raw\`E = \\sum_{i=1}^{n} x_i^2\`,{displayMode:true});
    `);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'easyread/web/js/reader/anchor.js'), 'utf8'));
    await win.webContents.executeJavaScript(`
      for(const id of ['inline','display']) {
        const el=document.querySelector('#b-'+id+' .katex');
        PR.state.reader.notes[id]={id,anchor:id,key:id,quote:PR.fullText(el),kind:'highlight',color:'yellow'};
      }
      PR.applyMarks();
      window.originalText=PR.fullText(document.querySelector('#paper'));
      document.fonts.ready;
    `);
    fs.writeFileSync(path.join(output, 'before.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'easyread/web/js/reader/math-marks.js'), 'utf8'));
    await win.webContents.executeJavaScript(`PR.applyMarks(); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(output, 'after.png'), (await win.webContents.capturePage()).toPNG());
    const result = await win.webContents.executeJavaScript(`(async () => {
      const check=(ok,msg)=>{if(!ok)throw Error(msg)};
      const paper=document.querySelector('#paper');
      check(PR.fullText(paper)===originalText,'Annotations changed copied text');
      for(const id of ['inline','display']) {
        const host=document.querySelector('#b-'+id);
        const bands=[...host.querySelectorAll('.math-band')];
        check(bands.length===1,'A single formula line still has separate bands: '+id);
        for(const band of bands) {
          const rect=band.getBoundingClientRect(), base=band.parentElement.getBoundingClientRect();
          check(rect.height>=base.height-1,'Band failed to cover formula height');
          check(getComputedStyle(band).backgroundColor!=='rgba(0, 0, 0, 0)','Invisible band');
        }
        check([...host.querySelectorAll('.math-fragment')].every(mark=>getComputedStyle(mark).backgroundColor==='rgba(0, 0, 0, 0)'), 'Glyph backgrounds remain');
      }
      const oldHeight=document.querySelector('#b-inline .math-band').getBoundingClientRect().height;
      document.querySelector('#b-inline .zh').style.fontSize='36px';
      await new Promise(resolve=>setTimeout(resolve,100));
      check(document.querySelector('#b-inline .math-band').getBoundingClientRect().height>oldHeight,'Bands did not resize');
      PR.state.reader.notes.inline.style='underline'; PR.applyMarks('inline');
      check(getComputedStyle(document.querySelector('#b-inline .math-band')).boxShadow!=='none','Underline lost');
      delete PR.state.reader.notes.inline.style;
      PR.state.reader.notes.inline.quote='x'; PR.applyMarks('inline');
      const partial=document.querySelector('#b-inline .math-band');
      check(partial.getBoundingClientRect().width<partial.parentElement.getBoundingClientRect().width,'Partial annotation expanded across formula');
      PR.state.reader.notes={}; PR.applyMarks();
      check(!paper.querySelector('mark.hl'),'Deleting annotations left bands behind');
      check(PR.fullText(paper)===originalText,'Deleting annotations changed text');
      return {inline:true,display:true,resize:true,underline:true,partial:true,delete:true};
    })()`);
    console.log(JSON.stringify(result));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, ...result }));
    clearTimeout(timeout); app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(error) }));
    console.error(error); clearTimeout(timeout); app.exit(1);
  }
});
