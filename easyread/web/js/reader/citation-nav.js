/* A per-tab chain of citation visits, with the origin's exact reading spot. */
(function (PR) {
  'use strict';
  const KEY = 'easyread-citation-visits', FROM = 'cite_from', RETURN = 'cite_return';
  function read() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function valid(r) {
    return r && /^\/read\/[A-Za-z0-9_-]+(?:\?|$)/.test(r.url) &&
      r.progress && typeof r.progress.block === 'string' &&
      Number.isFinite(r.progress.off) && Number.isFinite(r.progress.ratio);
  }
  function record(token) {
    const data = read(), r = data[token];
    return valid(r) ? r : null;
  }
  function save(r) {
    const all = read(), token = PR.uid('v');
    all[token] = r;
    Object.keys(all).slice(0, Math.max(0, Object.keys(all).length - 100)).forEach(k => delete all[k]);
    try { sessionStorage.setItem(KEY, JSON.stringify(all)); return token; } catch (_) { return ''; }
  }
  PR.citationNav = {
    go(href) {
      const destination = new URL(href, location.href);
      if (destination.origin !== location.origin || !/^\/read\/[A-Za-z0-9_-]+$/.test(destination.pathname)) return;
      const current = new URL(location.href);
      current.hash = ''; current.searchParams.delete(RETURN);
      const p = PR.progressOp();
      const token = save({url: current.pathname + current.search, progress: {block:p.block, off:p.off, ratio:p.ratio},
        jumps: PR.snapshotJumpBack ? PR.snapshotJumpBack() : [],
        title: (PR.state.paper.meta || {}).short_zh || (PR.state.paper.meta || {}).title_zh || (PR.state.paper.meta || {}).title_en || PR.t('论文')});
      PR.captureProgress();
      if (token) {
        try { history.replaceState({...history.state, citationVisit:token}, '', location.href); } catch (_) { /* The explicit return link still works. */ }
        destination.searchParams.set(FROM, token);
      }
      location.assign(destination.pathname + destination.search + destination.hash);
    },
    setup() {
      const token = new URLSearchParams(location.search).get(FROM), r = record(token);
      const link = PR.$('#citationBack');
      if (!link || !r) return;
      const url = new URL(r.url, location.origin);
      url.searchParams.set(RETURN, token);
      link.href = url.pathname + url.search;
      link.textContent = PR.t('返回上一论文');
      link.title = PR.t('返回「{title}」的阅读位置', {title:r.title || PR.t('论文')});
      link.hidden = false;
    },
    restore() {
      const url = new URL(location.href), token = url.searchParams.get(RETURN) || (history.state || {}).citationVisit, r = record(token);
      if (!token) return false;
      url.searchParams.delete(RETURN);
      const state = {...history.state}; delete state.citationVisit;
      try { history.replaceState(state, '', url.pathname + url.search + url.hash); } catch (_) { /* Normal progress remains available. */ }
      if (!r || !PR.restoreCitationProgress(r.progress)) return false;
      if (PR.restoreJumpBack) PR.restoreJumpBack(r.jumps);
      return true;
    },
  };
})(window.PR);
