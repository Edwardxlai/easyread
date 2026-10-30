const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync('easyread/web/js/reader/citation-nav.js', 'utf8');

function page(url, storage, state = {}) {
  let cur = new URL(url, 'http://localhost');
  const link = {hidden:true}, history = {state, replaceState(s,_,next){this.state=s;cur=new URL(next,cur);}};
  const location = {get href(){return cur.href}, get origin(){return cur.origin}, get search(){return cur.search},
    assign(path){this.next = new URL(path,cur).href}};
  const PR = {pid:cur.pathname.split('/').pop(), state:{paper:{meta:{title_en:'Paper ' + cur.pathname}}},
    t:(s,v)=>v ? s.replace(/\{(\w+)\}/g,(m,k)=>v[k]) : s, uid:()=>'v'+(++storage.seq),
    progressOp:()=>({block:'p5',off:.37,ratio:.6}), captureProgress(){this.captured=true},
    snapshotJumpBack:()=>[{id:'p2', off:42, y:800, exact:true}],
    restoreJumpBack:s=>{PR.jumps=s}, restoreCitationProgress:p=>{PR.restored=p;return true}, $:()=>link};
  const sessionStorage = {getItem:k=>storage[k],setItem:(k,v)=>{storage[k]=v}};
  vm.runInNewContext(source,{window:{PR},location,history,sessionStorage,URL,URLSearchParams,Number});
  return {PR, location, history, link};
}

test('cross-paper visits return to the exact origin and preserve same-paper return steps', () => {
  const storage={seq:0};
  const a=page('/read/paperA?library=abc#ref-7',storage);
  a.PR.citationNav.go('/read/paperB#ref-3');
  assert.ok(a.PR.captured);
  assert.equal(a.history.state.citationVisit,'v1');
  assert.match(a.location.next,/\/read\/paperB\?cite_from=v1#ref-3$/);
  const b=page(a.location.next,storage);
  b.PR.citationNav.setup();
  assert.equal(b.link.hidden,false);
  assert.match(b.link.href,/\/read\/paperA\?library=abc&cite_return=v1$/);
  const returned=page(b.link.href,storage);
  assert.equal(returned.PR.citationNav.restore(),true);
  assert.deepEqual({...returned.PR.restored},{block:'p5',off:.37,ratio:.6});
  assert.equal(returned.PR.jumps[0].id,'p2');
  assert.equal(returned.location.search,'?library=abc');
  const nativeBack=page('/read/paperA?library=abc#ref-7',storage,{citationVisit:'v1'});
  assert.equal(nativeBack.PR.citationNav.restore(),true);
  assert.equal(nativeBack.PR.restored.block,'p5');
});

test('multiple hops preserve the previous visit chain', () => {
  const storage={seq:0}, a=page('/read/paperA',storage);
  a.PR.citationNav.go('/read/paperB');
  const b=page(a.location.next,storage); b.PR.citationNav.go('/read/paperC');
  const c=page(b.location.next,storage); c.PR.citationNav.setup();
  const backB=page(c.link.href,storage); assert.equal(backB.PR.citationNav.restore(),true);
  backB.PR.citationNav.setup();
  assert.match(backB.link.href,/\/read\/paperA\?cite_return=v1$/);
});
