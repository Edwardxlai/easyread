/* 记录每次从文献库进入阅读页的位置；每个链接有独立记录，返回链接只带记录 ID。 */
(function (PR) {
  "use strict";
  const KEY = "easyread-library-navigation", PARAM = "library", HISTORY_KEY = "easyreadLibraryReturn";
  const SNAPSHOT_KEY = "easyread-library-list", SNAPSHOT_TTL = 30 * 60 * 1000, SNAPSHOT_LIMIT = 1024 * 1024;
  const idOk = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  const textOk = (s, max) => typeof s === "string" && s.length <= max;
  const valid = (s) => s && s.version === 1 && idOk(s.paper) && textOk(s.view, 40) &&
    (s.tag === null || textOk(s.tag, s.view === "folder" ? 4096 : 128)) && textOk(s.q, 2000) && textOk(s.sort, 20) &&
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
    // Cache only list summaries, never the API token or document contents.
    rememberList(data) {
      if (!data || !Array.isArray(data.items)) return;
      const fields = ["id", "title_zh", "title_en", "short_zh", "target", "authors", "affiliation", "year", "date", "venue", "arxiv", "url", "doi", "pages", "done_pages", "en_pages", "abstract", "meta_override", "tags", "folder_files", "status", "starred", "added", "last_opened", "progress", "notes", "highlights", "open_questions", "discussions", "has_paper_note", "job", "thumb"];
      const items = data.items.map((item) => Object.fromEntries(fields.filter((k) => Object.prototype.hasOwnProperty.call(item, k)).map((k) => [k, item[k]])));
      const text = JSON.stringify({ version: 1, t: Date.now(), data: { items, engine: data.engine, engine_label: data.engine_label, version: data.version, trash: data.trash, folder_sync: data.folder_sync } });
      try {
        if (!items.length || text.length > SNAPSHOT_LIMIT) localStorage.removeItem(SNAPSHOT_KEY);
        else localStorage.setItem(SNAPSHOT_KEY, text);
      } catch (_) { /* Storage may be full or disabled; a loading state is still safe. */ }
    },
    cachedList() {
      const token = (history.state || {})[HISTORY_KEY] || new URLSearchParams(location.search).get(PARAM);
      if (!read(token)) return null;  // A fresh home must not restore a different navigation.
      try {
        const text = localStorage.getItem(SNAPSHOT_KEY);
        if (!text || text.length > SNAPSHOT_LIMIT) return null;
        const snap = JSON.parse(text), age = Date.now() - snap.t;
        if (snap.version !== 1 || !Number.isFinite(age) || age < 0 || age > SNAPSHOT_TTL || !snap.data || !Array.isArray(snap.data.items) || !snap.data.items.length) return null;
        if (!snap.data.items.every((i) => i && idOk(i.id) && Array.isArray(i.tags) && i.tags.every((tag) => textOk(tag, 128)))) return null;
        return snap.data;
      } catch (_) { return null; }
    },
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
      back.title = PR.t("返回“{name}”", { name: value.tag || value.label || PR.t("文献库") });
    },
  };
})(window.PR);
