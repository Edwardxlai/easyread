const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync('easyread/web/js/reader/citations.js', 'utf8');
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('citation tree exposes both directions, avoids cycles, and offers unmatched source links', async () => {
  const events = {}, requests = [];
  const graphs = {
    paperA: {paper:{id:'paperA'}, references: [{id:'1', text:'Paper B', target:'paperB', title:'B'}, {id:'2', text:'Unknown', target:null, source_url:'https://doi.org/10.1/test'}], cited_by: [{id:'paperC', title:'C', ref_id:'VSP+17'}]},
    paperB: {paper:{id:'paperB'}, references: [{id:'7', text:'Paper A', target:'paperA', title:'A'}], cited_by: [{id:'paperA', title:'A', ref_id:'1'}]},
  };
  const root = {innerHTML:''};
  const box = {isConnected:true, innerHTML:'', classList:{contains: s => s === 'citations'}, querySelector: () => root,
    addEventListener: (type, fn) => { events[type] = fn; }};
  const document = {addEventListener(){}, getElementById(){return null;}, createElement(){return {};}};
  const PR = {esc:escape, t:(s,v) => v ? s.replace(/\{(\w+)\}/g, (m,k) => v[k]) : s,
    pid:'paperA', store:{mode:'server'}, state:{paper:{references:[]}}, blockById:{}, $$:() => [], on(){},
    api:url => { requests.push(url); return Promise.resolve(graphs[url.split('/')[3]]); }};
  vm.runInNewContext(source,{window:{PR}, document, encodeURIComponent, Map, Promise});
  PR.citationsDrawer(box);
  await tick();
  assert.match(root.innerHTML, /本文引用的文献（2）/);
  assert.match(root.innerHTML, /库中引用本文的论文（1）/);
  assert.match(root.innerHTML, /href="\/read\/paperC#ref-VSP%2B17"/);
  assert.match(root.innerHTML, /https:\/\/doi.org\/10.1\/test/);
  assert.match(root.innerHTML, /scholar.google.com/);
  const child = {textContent:'',innerHTML:'',dataset:{}};
  const details = {dataset:{citeNode:'paperB',path:'|paperA|paperB|'}, open:true,
    matches:() => true, querySelector:() => child};
  events.toggle({target:details});
  await tick();
  assert.match(child.innerHTML, /已在上层/);
  assert.doesNotMatch(child.innerHTML, /data-cite-node="paperA"/);
  assert.deepEqual(requests, ['/api/p/paperA/citations','/api/p/paperB/citations']);
});

test('bibliography links back to the source passage and opens the matched paper', async () => {
  const events = {}, listeners = {}, body = {innerHTML:'', className:''};
  const block = {dataset:{id:'p1'}, classList:{contains:() => false}, textContent:'A paper cites the study.'};
  const cite = {dataset:{ref:'1'}, closest:() => block};
  const row = {lastElementChild:{appendChild(node){Object.assign(body,node);}}, querySelector:() => null};
  const document = {addEventListener:(type, fn) => {listeners[type]=fn;}, getElementById:id => id === 'ref-1' ? row : null,
    createElement:() => ({})};
  const PR = {esc:escape, t:(s,v) => v ? s.replace(/\{(\w+)\}/g,(m,k) => v[k]) : s,
    pid:'paperA', store:{mode:'server'}, state:{paper:{references:[{id:'1',text:'A study'}]}}, blockById:{p1:{page:4}},
    $$:sel => sel === '#paper a.cite' ? [cite,cite] : [], on:(name,fn) => {events[name]=fn;},
    api:() => Promise.resolve({references:[{id:'1',target:'paperB'}]}), jumpTo:id => { PR.jumped = id; }};
  vm.runInNewContext(source,{window:{PR}, document, encodeURIComponent, Map, Promise});
  events.rendered();
  await tick();
  assert.match(body.innerHTML, /href="\/read\/paperB"/);
  assert.match(body.innerHTML, /正文引用位置（1）/);
  assert.match(body.innerHTML, /data-cite-passage="p1"/);
  let prevented = false;
  listeners.click({target:{closest:sel => sel === '[data-cite-passage]' ? ({dataset:{citePassage:'p1'}}) : null}, preventDefault:() => {prevented=true;}});
  assert.ok(prevented);
  assert.equal(PR.jumped, 'b-p1');
});
