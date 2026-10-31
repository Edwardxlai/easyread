const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync('easyread/web/js/reader/citation-import.js', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(importResult) {
  const listeners={}, calls=[], buttons=[], classes=new Set();
  const nodes={
    '[data-ci-ref]':{value:'https://arxiv.org/abs/2301.12345',focus(){}},
    '[data-ci-status]':{textContent:'',after:b=>buttons.push(b)},
    '[data-ci-add]':{disabled:false}, '[data-ci-file]':{disabled:false,click(){}}, '[data-ci-pdf]':{value:''},
  };
  const dialog={innerHTML:'',className:'', classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},
    addEventListener:(type,fn)=>{listeners[type]=fn}, querySelector:sel=>nodes[sel]};
  const document={body:{appendChild(){}},createElement:tag=>tag==='div'?dialog:{dataset:{}}};
  const PR={esc:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),
    t:(s,v)=>v ? s.replace(/\{(\w+)\}/g,(m,k)=>v[k]) : s,
    api:(path, opts)=>{calls.push({path,opts}); return path.endsWith('/citations')
      ? Promise.resolve({references:[{id:'17',text:'A reference',source_url:'https://arxiv.org/abs/2301.12345',fingerprint:'abc123'}]})
      : importResult instanceof Error ? Promise.reject(importResult) : Promise.resolve(importResult)},
    refreshCitations(){this.refreshed=true},toast(){},citationNav:{go:path=>{PR.opened=path}}};
  vm.runInNewContext(source,{window:{PR},document,encodeURIComponent});
  const click = selector => listeners.click({target:{closest:s=>s===selector?{}:null},preventDefault(){}});
  return {PR,dialog,nodes,calls,buttons,click,listeners};
}

test('imports and links the chosen reference through one backend operation', async () => {
  const ui=setup({id:'paperB',new:true});
  await ui.PR.importCitation('paperA','17');
  assert.match(ui.dialog.innerHTML,/https:\/\/arxiv.org\/abs\/2301.12345/);
  assert.match(ui.dialog.innerHTML,/scholar.google.com/);
  ui.click('[data-ci-add]'); await tick();
  assert.equal(ui.calls[1].path,'/api/p/paperA/citation-import');
  assert.equal(ui.calls[1].opts.body.ref_id,'17');
  assert.equal(ui.calls[1].opts.body.fingerprint,'abc123');
  assert.match(ui.nodes['[data-ci-status]'].textContent,/已加入文献库并关联/);
  assert.equal(ui.buttons[0].dataset.ciOpen,'paperB');
  assert.ok(ui.PR.refreshed);
});

test('an import failure leaves the reference available for a PDF retry', async () => {
  const ui=setup(new Error('no accessible PDF'));
  await ui.PR.importCitation('paperA','17'); ui.click('[data-ci-add]'); await tick();
  assert.match(ui.nodes['[data-ci-status]'].textContent,/请检查文献库/);
  assert.equal(ui.nodes['[data-ci-file]'].disabled,false);
  assert.equal(ui.nodes['[data-ci-add]'].disabled,false);
});
