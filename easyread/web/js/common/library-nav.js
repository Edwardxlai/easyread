/* 记录每次从文献库进入阅读页的位置；每个链接有独立记录，返回链接只带记录 ID。 */
(function (PR) {
  "use strict";
  const KEY = "easyread-library-navigation", PARAM = "library", HISTORY_KEY = "easyreadLibraryReturn";
  const idOk = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  const textOk = (s, max) => typeof s === "string" && s.length <= max;
  const valid = (s) => s && s.version === 1 && idOk(s.paper) && textOk(s.view, 40) &&
    (s.tag === null || textOk(s.tag, 128)) && textOk(s.q, 2000) && textOk(s.sort, 20) &&
    textOk(s.label, 128) && Number.isFinite(s.scroll) && s.scroll >= 0 &&
    (s.offset === null || Number.isFinite(s.offset));
  function records() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || "{}");
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (_) { return {}; }
  }
  function read(token) {
    if (!idOk(token)) return null;
    const all = records(), value = Object.prototype.hasOwnProperty.call(all, token) ? all[token] : null;
    return valid(value) ? value : null;
  }
  function rememberHistory(token, url) {
    try { history.replaceState({ ...(history.state || {}), [HISTORY_KEY]: token }, "", url); } catch (_) { /* 无法记录时仍可正常打开论文。 */ }
  }
  PR.libraryNav = {
    readerUrl(paper, state) {
      const url = "/read/" + encodeURIComponent(paper);
      const value = { ...state, paper, version: 1 };
      if (!valid(value)) return url;
      const token = PR.uid("l"), all = records();
      all[token] = value;
      // 每条记录保留自己的分类，多个阅读标签页不会互相覆盖。
      const keys = Object.keys(all);
      keys.slice(0, Math.max(0, keys.length - 100)).forEach((key) => delete all[key]);
      // 浏览器新标签页不一定复制会话存储，用同源存储让新标签页也能找到自己的来源。
      try { localStorage.setItem(KEY, JSON.stringify(all)); }
      catch (_) { return url; }
      rememberHistory(token, location.href);
      return url + "?" + PARAM + "=" + encodeURIComponent(token);
    },
    restore() {
      const token = (history.state || {})[HISTORY_KEY] || new URLSearchParams(location.search).get(PARAM);
      const value = read(token);
      if (value && location.pathname === "/") {
        const url = new URL(location.href);
        url.searchParams.delete(PARAM);
        rememberHistory(token, url.pathname + url.search + url.hash);
      }
      return value;
    },
    readerBack(paper) {
      const token = new URLSearchParams(location.search).get(PARAM), value = read(token);
      if (!value || value.paper !== paper) return;
      const back = PR.$("#backBtn");
      if (!back) return;
      back.href = "/?" + PARAM + "=" + encodeURIComponent(token);
      back.title = "返回“" + (value.tag || value.label || "文献库") + "”";
    },
  };
})(window.PR);
