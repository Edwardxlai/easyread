/* Private preload for the remote page. It receives saved text, with no exposed bridge. */
(() => {
  'use strict';
  const { ipcRenderer } = require('electron');
  const excluded = 'script,style,noscript,template,pre,code,svg,math,mjx-container,d-math,katex-formula,.katex,.MathJax,input,textarea,select,option,canvas,[role="slider"],[translate="no"],[contenteditable],[hidden],[aria-hidden="true"]';
  const norm = value => value.replace(/[\u202a-\u202e\u2066-\u2069]/g,'').replace(/\s+/g, ' ').trim();
  const changed = new Map();
  const dirty = new Set();
  let translations = new Map(), show = true, visible = false, pending = false;
  let observer, known = new Set();
  let scanAll = false, prune = false;
  const numbered = new Map();
  function chartTarget(label) {
    const key=norm(label);
    if(translations.has(key))return translations.get(key);
    const match=/^(.{1,60}\s)(\d+)$/.exec(key), pattern=match && numbered.get(match[1]);
    if(pattern?.count>=2)return pattern.prefix+match[2]+pattern.suffix;
  }

  function translateNode(node) {
    const item = changed.get(node);
    if (item?.value === node.data) return;
    if (item) changed.delete(node);
    const source = node.data;
    const translation = translations.get(norm(source));
    if (translation === undefined) return;
    const content = show === 'original-first' ? source.trim() + ' / ' + translation
      : show === 'translation-first' ? translation + ' / ' + source.trim() : translation;
    const value = source.match(/^\s*/)[0] + content + source.match(/\s*$/)[0];
    if (source === value) return;
    changed.set(node, { source, translation, value, mode: show });
    node.data = value;
  }

  const labelModel = () => ({
    mode:show,
    source:node => changed.get(node)?.value === node.data ? changed.get(node).source : node.data,
    known:key => known.has(norm(key)),
    target:chartTarget,
    display:source => {
      const target = translations.get(norm(source));
      if (!show || !target) return null;
      return show === 'original-first' ? source+' / '+target : show === 'translation-first' ? target+' / '+source : target;
    },
    translate:translateNode
  });
  globalThis.easyreadVisibleTexts = () => globalThis.easyreadLabels?.collect() || [];

  function scan(root) {
    const element = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
    if (!root.isConnected || !element || element.nodeType !== Node.ELEMENT_NODE || element.closest(excluded)) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateNode(root);
      return;
    }
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return node.matches(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let node; (node = walk.nextNode());) translateNode(node);
  }

  function paint() {
    pending = false;
    if (!visible) return;
    if (scanAll || prune) {
      for (const [node, item] of changed) {
        if (!node.isConnected || node.data !== item.value) { changed.delete(node); continue; }
        if (!scanAll || (show && item.mode === show && translations.get(norm(item.source)) === item.translation)) continue;
        changed.delete(node);
        node.data = item.source;
      }
    }
    if (show && translations.size) {
      if (scanAll) scan(document.body || document.documentElement);
      else for (const root of dirty) scan(root);
    }
    if (scanAll) globalThis.easyreadLabels?.sync(labelModel(),visible,show);
    if (savedMarks.length && (scanAll || (prune && painted.some(item => !item.range.startContainer.isConnected)) || (dirty.size && !painted.length))) queueMarkPaint();
    dirty.clear();
    scanAll = prune = false;
  }

  function schedule(all = false) {
    scanAll ||= all;
    if (pending || !observer || !visible) return;
    pending = true;
    setTimeout(paint, 120);
  }

  // Supplemental labels use viewport observation in the guest preload.

  // A range in the live document is stored in the same paragraph coordinates as the reader.
  const runIndex = new Map(), control = 'input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[role="slider"],canvas';
  let savedMarks = [], painted = [], markTimer, hadSelection = false, startedOnControl = false;
  const markNames = ['yellow','green','blue','pink'];
  function dynamicKey(node, source) {
    let index = 2166136261;
    let path = "", el = node.parentElement;
    while (el && el !== document.body) {
      let rank = 0;
      for (let p = el.previousElementSibling; p; p = p.previousElementSibling) if (p.localName === el.localName) rank++;
      path = el.localName + rank + "/" + path;
      el = el.parentElement;
    }
    for (const ch of path + source) index = Math.imul(index ^ ch.charCodeAt(0), 16777619);
    return "live-" + (index >>> 0).toString(36);
  }
  function segments(node, allowDynamic) {
    const item = changed.get(node);
    const source = item?.value === node.data ? item.source : node.data;
    const raw = norm(source);
    if (!raw) return [];
    const rows = runIndex.get(raw);
    let row = rows?.length === 1 ? rows[0] : null;
    if (!row && rows?.length) {
      // Duplicate runs (short links in particular) can belong to different paragraphs.
      const root = node.parentElement.closest("p,li,figcaption,td,h1,h2,h3,h4") || node.parentElement;
      const match = new Set();
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) {
        const peers = runIndex.get(norm(changed.get(n)?.source || n.data));
        if (peers?.length === 1) match.add(peers[0][0]);
      }
      const candidates = rows.filter(r => match.has(r[0]));
      if (candidates.length === 1) row = candidates[0];
    }
    if (!row && !allowDynamic) return [];
    const key = row?.[0] || dynamicKey(node, raw), anchor = row?.[0] || "head";
    const lead = node.data.length - node.data.trimStart().length;
    const clean = source.trim(), translation = item?.translation?.trim();
    const make = (side, at, value) => ({anchor,key,side,at,value,original:source.trim(), base:row ? (side === 'en' ? row[2] + (row[1].length-row[1].trimStart().length) : row[3]) : 0});
    if (!item || item.value !== node.data || !translation) return [make('en',lead,clean)];
    if (item.mode === 'original-first') return [make('en',lead,clean),make('zh',lead+clean.length+3,translation)];
    if (item.mode === 'translation-first') return [make('zh',lead,translation),make('en',lead+translation.length+3,clean)];
    return [make('zh',lead,translation)];
  }
  function textWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return n.matches(control+',script,style,noscript,.katex-mathml,[hidden]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    }});
  }
  function reportSelection() {
    if (!visible) return;
    const sel = getSelection();
    if (!sel?.rangeCount || sel.isCollapsed || startedOnControl) {
      if (hadSelection) ipcRenderer.send('easyread:guest-selection', null);
      hadSelection = false;
      return;
    }
    const range = sel.getRangeAt(0), root = range.commonAncestorContainer;
    if ((root.parentElement?.closest(control)) || document.activeElement?.matches(control)) return;
    const parts = [], walker = textWalker(root);
    let length = 0, node = root.nodeType === 3 ? root : walker.nextNode();
    while (node) {
      if (range.intersectsNode(node)) {
        const a = node === range.startContainer ? range.startOffset : 0;
        const b = node === range.endContainer ? range.endOffset : node.length;
        for (const s of segments(node, true)) {
          const lo = Math.max(a-s.at,0), hi = Math.min(b-s.at,s.value.length);
          if (hi <= lo) continue;
          const quote = s.value.slice(lo,hi);
          if (!quote.trim()) continue;
          length += quote.length;
          if (length > 24000 || parts.length >= 128) return;
          parts.push({anchor:s.anchor,key:s.key,side:s.side,start:s.base+lo,quote,
            prefix:s.value.slice(Math.max(0,lo-32),lo),suffix:s.value.slice(hi,hi+32),original:s.original.slice(0,5000),
            ...(s.anchor === "head" && s.value.length <= 24000 ? {value:s.value} : {})});
        }
      }
      node = walker.nextNode();
    }
    if (!parts.length) return;
    hadSelection = true;
    const rect = range.getBoundingClientRect();
    ipcRenderer.send('easyread:guest-selection',{parts, rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}});
  }
  function clearGuestSelection() {
    hadSelection = false;
    getSelection()?.removeAllRanges();
  }
  window.addEventListener('pointerdown', e => {
    if (!e.isTrusted) return;
    startedOnControl = e.composedPath().some(el => el.matches?.(control));
    if (hadSelection) {hadSelection=false; ipcRenderer.send('easyread:guest-selection',null);}
  },true);
  window.addEventListener('pointerup', e => {
    if (!e.isTrusted || e.button !== 0 || startedOnControl) return;
    setTimeout(reportSelection,0);
  },true);
  window.addEventListener('keyup', e => {
    if (e.isTrusted && (e.key === "Escape" || e.key === "Shift" || (e.shiftKey && e.key.startsWith("Arrow")))) reportSelection();
  },true);
  window.addEventListener('scroll', () => {
    if (hadSelection) { hadSelection=false; ipcRenderer.send('easyread:guest-selection',null); }
  },{passive:true,capture:true});
  ipcRenderer.on('easyread:selection-clear', clearGuestSelection);
  ipcRenderer.on('easyread:selection-reveal', (_event,id) => {
    painted.find(mark => mark.id === id)?.range.startContainer.parentElement?.scrollIntoView({block:'center'});
  });
  function queueMarkPaint() {
    clearTimeout(markTimer);
    markTimer = setTimeout(paintMarks,160);
  }
  function paintMarks() {
    if (!CSS.highlights || !visible) return;
    painted = [];
    const groups = new Map(), byKey = new Map();
    for (const m of savedMarks) {
      const key = m.key || m.anchor;
      if (!byKey.has(key)) byKey.set(key,[]);
      byKey.get(key).push(m);
    }
    if (byKey.size) {
      const dynamic = savedMarks.filter(m => m.key?.startsWith("live-"));
      const w = textWalker(document.body);
      for (let n; (n=w.nextNode());) {
        const source = changed.get(n)?.source || n.data;
        const fromArticle = runIndex.get(norm(source))?.some(row => byKey.has(row[0]));
        const fromDynamic = dynamic.some(m => n.data.includes(m.quote));
        if (!fromArticle && !fromDynamic) continue;
        for (const s of segments(n,fromDynamic)) for (const m of byKey.get(s.key) || []) {
          if ((m.side || 'zh') !== s.side) continue;
          const offset = m.start - s.base;
          let lo = Math.max(0,offset), hi = Math.min(s.value.length,offset+m.quote.length);
          if (hi<=lo || s.value.slice(lo,hi)!==m.quote.slice(lo-offset,hi-offset)) {
            lo = s.value.indexOf(m.quote);
            if (lo<0) continue;
            hi = lo + m.quote.length;
          }
          const range = document.createRange();
          range.setStart(n,s.at+lo);range.setEnd(n,s.at+hi);
          const name = 'er-'+m.color+(m.style === 'underline' ? '-u' : '');
          if (!groups.has(name)) groups.set(name,new Highlight());
          groups.get(name).add(range);painted.push({id:m.id,range});
        }
      }
    }
    for (const color of markNames) for (const suffix of ['','-u']) {
      const key = 'er-'+color+suffix;
      if (groups.has(key)) CSS.highlights.set(key,groups.get(key)); else CSS.highlights.delete(key);
    }
  }
  window.addEventListener('click', e => {
    if (!e.isTrusted || startedOnControl || !visible || !getSelection()?.isCollapsed || !painted.length) return;
    const pos=document.caretPositionFromPoint(e.clientX,e.clientY);
    if (!pos) return;
    const hit=painted.find(m=>m.range.isPointInRange(pos.offsetNode,pos.offset) && [...m.range.getClientRects()].some(r=>r.left<=e.clientX&&r.right>=e.clientX&&r.top<=e.clientY&&r.bottom>=e.clientY));
    if (hit) ipcRenderer.send('easyread:guest-selection',{mark:hit.id, rect:{x:e.clientX,y:e.clientY,width:1,height:1}});
  },true);
  ipcRenderer.on('easyread:selection-marks',(_e,marks)=>{savedMarks=marks;queueMarkPaint();});

  function observePage() {
    if (!observer) return;
    if (visible) {
      observer.observe(document.body || document.documentElement, { subtree: true, childList: true, characterData: true });
      schedule(true);
    } else {
      observer.disconnect();
      globalThis.easyreadLabels?.sync(labelModel(),false,show);
      dirty.clear();
    }
  }
  ipcRenderer.on('easyread:interactive-text', (_event, pairs, extra, runs) => {
    runIndex.clear();
    for (const row of runs || []) {
      const key = norm(row[1]);
      if (!key) continue;
      const group = runIndex.get(key) || [];
      group.push(row); runIndex.set(key, group);
    }
    // Both article runs and saved widget labels share the same dictionary.
    const values = new Map(), conflicts = new Set();
    for (const [source, translation] of pairs) {
      const key = norm(source), value = translation.trim();
      if (!key) continue;
      if (values.has(key) && values.get(key) !== value) conflicts.add(key);
      else values.set(key, value);
    }
    known = new Set([...values.keys(), ...[...values.values()].map(norm)]);
    for (const key of conflicts) values.delete(key);
    for (const [key, value] of values) if (key === norm(value)) values.delete(key);
    translations = values;
    numbered.clear();
    for(const [source,target] of values){
      const match=/^(.{1,60}\s)(\d+)$/.exec(source);
      const digits=target.match(/\d+/g);
      if(!match || digits?.length!==1 || digits[0]!==match[2])continue;
      const [prefix,suffix]=target.split(match[2]), old=numbered.get(match[1]);
      if(!old)numbered.set(match[1],{prefix,suffix,count:1});
      else if(old.prefix===prefix && old.suffix===suffix && old.count>0)old.count++;
      else old.count=-1;
    }
    schedule(true);
  });
  ipcRenderer.on('easyread:interactive-language', (_event, translated) => {
    const next = ['original-first', 'translation-first'].includes(translated) ? translated : translated === true;
    if (next === show) return;
    show = next;
    schedule(true);
  });
  ipcRenderer.on('easyread:interactive-visibility', (_event, shown) => {
    if (visible === shown) return;
    visible = shown === true;
    observePage();
  });
  window.addEventListener('DOMContentLoaded', () => {
    observer = new MutationObserver(records => {
      if (!show || !translations.size || scanAll) return;
      for (const record of records) {
        const target = record.target;
        const element = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
        if (!element || element.closest(excluded)) continue;
        if (record.type === 'characterData') {
          if (changed.get(target)?.value !== target.data) dirty.add(target);
        } else {
          for (const node of record.addedNodes) dirty.add(node);
          prune ||= record.removedNodes.length > 0;
        }
      }
      if (dirty.size || prune) schedule();
    });
    observePage();
  }, { once: true });
})();
