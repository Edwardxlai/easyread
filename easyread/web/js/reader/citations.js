/* Local citation tree and bibliography-to-passage links. The tree is derived
   from the current library, and never claims to be a complete citation index. */
(function (PR) {
  "use strict";
  const cache = new Map();
  let generation = 0;
  function invalidate() { cache.clear(); generation++; }
  const E = PR.esc;
  function graph(id) {
    if (!cache.has(id)) {
      const request = PR.api("/api/p/" + encodeURIComponent(id) + "/citations");
      cache.set(id, request);
      request.catch(() => { if (cache.get(id) === request) cache.delete(id); });
    }
    return cache.get(id);
  }
  const searchUrl = (text) => "https://scholar.google.com/scholar?q=" + encodeURIComponent(text.slice(0, 300));
  const readUrl = (id) => "/read/" + encodeURIComponent(id);
  const search = (text) => '<a href="' + E(searchUrl(text)) + '" target="_blank" rel="noopener noreferrer">' + PR.t("搜索论文") + '</a>';
  const source = (url) => url ? '<a href="' + E(url) + '" target="_blank" rel="noopener noreferrer">' + PR.t("打开论文来源") + '</a> ' : '';
  function node(id, title, path, suffix) {
    const loop = path.includes("|" + id + "|");
    const link = '<a data-cite-paper href="' + readUrl(id) + (suffix || "") + '">' + E(title) + '</a>';
    if (loop) return '<div class="cite-tree-leaf">' + link + ' <span class="hint">' + PR.t("已在上层") + '</span></div>';
    return '<details class="cite-tree-node" data-cite-node="' + E(id) + '" data-path="' + E(path + id + "|") + '"><summary>' + link + '</summary><div class="cite-tree-children"></div></details>';
  }
  const importButton = (paper, ref) => '<button class="linkish" data-cite-import="' + E(paper) + '" data-cite-ref="' + E(ref) + '">' + PR.t("加入文献库") + '</button>';
  function groups(data, path) {
    const refs = data.references.map(r => {
      const prefix = r.id ? '[' + E(r.id) + '] ' : '';
      return r.target ? '<div class="cite-tree-entry">' + prefix + node(r.target, r.title, path, '') + '</div>'
        : '<div class="cite-tree-entry cite-unmatched">' + prefix + E(r.text) + '<div>' + importButton(data.paper.id, r.id) + ' ' + source(r.source_url) + search(r.text) + '</div></div>';
    }).join('');
    const citing = data.cited_by.map(r => node(r.id, r.title, path, '#ref-' + encodeURIComponent(r.ref_id))).join('');
    return (data.incomplete ? '<p class="hint">' + PR.t("部分论文数据无法读取，引用关系可能不完整。") + '</p>' : '') +
      '<details class="cite-tree-group" open><summary>' + PR.t("本文引用的文献（{n}）", {n: data.references.length}) + '</summary>' +
      (refs || '<p class="hint">' + PR.t("没有已整理的参考文献。") + '</p>') + '</details>' +
      '<details class="cite-tree-group" open><summary>' + PR.t("库中引用本文的论文（{n}）", {n: data.cited_by.length}) + '</summary>' +
      (citing || '<p class="hint">' + PR.t("没有发现匹配的库内论文。") + '</p>') + '</details>';
  }
  async function fill(details) {
    const container = details.querySelector(':scope > .cite-tree-children');
    if (!container || container.dataset.loaded) return;
    container.textContent = PR.t("加载中…");
    try {
      const d = await graph(details.dataset.citeNode);
      container.innerHTML = groups(d, details.dataset.path);
      container.dataset.loaded = '1';
    } catch (_) {
      container.textContent = PR.t("加载引用关系失败，收起后重新展开可重试。");
    }
  }
  PR.citationsDrawer = function (box) {
    invalidate(); // New imports, metadata edits and deletions change the graph.
    box.innerHTML = '<p class="hint">' + PR.t("仅显示本地文献库中已整理的引用；未匹配条目可搜索。展开论文继续查看双向引用。") + '</p>' +
      '<div class="cite-tree-root"><p class="hint">' + PR.t("加载中…") + '</p></div>';
    if (!box.citationToggleBound) {
      box.addEventListener('toggle', e => { if (e.target.matches('details[data-cite-node]') && e.target.open) fill(e.target); }, true);
      box.citationToggleBound = true;
    }
    const version = generation;
    graph(PR.pid).then(data => {
      if (version !== generation) return;
      decorate(data);
      if (!box.isConnected || !box.classList.contains('citations')) return;
      box.querySelector('.cite-tree-root').innerHTML = groups(data, '|' + PR.pid + '|');
    }).catch(() => {
      if (box.isConnected && box.querySelector('.cite-tree-root')) box.querySelector('.cite-tree-root').textContent = PR.t("加载引用关系失败，请重新打开引用面板。");
    });
  };
  // Decorate entries without replacing the rendered bibliography or reader's edits.
  function decorate(data) {
    const refs = new Map((data?.references || []).map(r => [r.id, r]));
    const locations = new Map();
    for (const a of PR.$$('#paper a.cite')) {
      const block = a.closest('#paper .blk');
      if (!block || block.classList.contains('blk-references')) continue;
      const byBlock = locations.get(a.dataset.ref) || new Map();
      byBlock.set(block.dataset.id, block);
      locations.set(a.dataset.ref, byBlock);
    }
    for (const r of PR.state.paper.references || []) {
      const id = String(r.id), row = document.getElementById('ref-' + id);
      if (!row) continue;
      row.querySelector('.ref-tools')?.remove();
      const container = row.lastElementChild, info = refs.get(id), found = locations.get(id);
      let html = '';
      if (info?.target) html += '<a data-cite-paper href="' + readUrl(info.target) + '">' + PR.t("打开库中论文") + '</a>';
      else if (PR.store.mode === 'server') html += (info ? importButton(PR.pid, id) + ' ' : '') + source(info?.source_url) + search(r.text || '');
      if (found?.size) {
        html += '<details><summary>' + PR.t("正文引用位置（{n}）", {n: found.size}) + '</summary>' +
          [...found].map(([bid, block]) => {
            const b = PR.blockById[bid] || {}, label = (b.page ? PR.t("第 {page} 页", {page: b.page}) + ' · ' : '') + (block.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 95);
            return '<a href="#b-' + E(bid) + '" data-cite-passage="' + E(bid) + '">' + E(label) + '</a>';
          }).join('') + '</details>';
      }
      if (html) { const tools = document.createElement('div'); tools.className = 'ref-tools'; tools.innerHTML = html; container.appendChild(tools); }
    }
  }
  function refresh() {
    decorate(null);
    const version = generation;
    if (PR.store.mode === 'server') graph(PR.pid).then(data => { if (version === generation) decorate(data); }).catch(() => {});
  }
  PR.refreshCitations = function () { invalidate(); refresh(); if (document.body.classList.contains('drawer-open')) PR.renderDrawer(); };
  PR.on('rendered', refresh);
  PR.on('block-rendered', refresh);
  PR.on('remote', changed => { if (changed.includes('paper')) invalidate(); });
  document.addEventListener('click', e => {
    const add = e.target.closest('[data-cite-import]');
    if (add) { e.preventDefault(); PR.importCitation(add.dataset.citeImport, add.dataset.citeRef); return; }
    const paper = e.target.closest('[data-cite-paper]');
    if (paper && !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault(); PR.citationNav.go(paper.href); return;
    }
    const a = e.target.closest('[data-cite-passage]');
    if (a) { e.preventDefault(); PR.jumpTo('b-' + a.dataset.citePassage); }
  });
})(window.PR);
