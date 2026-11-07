/* 共用小工具。所有脚本共用全局 PR 命名空间（不打包、不用构建，也能内联成单文件离线版）。 */
window.PR = window.PR || {};
(function (PR) {
  "use strict";

  PR.$ = (sel, root) => (root || document).querySelector(sel);
  PR.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  PR.el = function (tag, attrs, html) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    if (html != null) e.innerHTML = html;
    return e;
  };

  /* 译文语言的名字跟着界面语言写：中文界面“日语”，英文界面“Japanese” */
  PR.TARGETS = [["zh", PR.t("简体中文")], ["zh-Hant", PR.t("繁体中文")], ["en", PR.t("英语")], ["ja", PR.t("日语")], ["ko", PR.t("韩语")], ["es", PR.t("西班牙语")], ["fr", PR.t("法语")], ["de", PR.t("德语")], ["it", PR.t("意大利语")]];
  // 按钮上（“翻译成中文”）简体照旧叫中文，只在选语言的下拉里分简繁
  PR.targetName = (code) => code === "zh" || !code ? PR.t("中文") : (PR.TARGETS.find(([k]) => k === code) || PR.TARGETS[0])[1];

  /* 论文标题哪个当主标题：译文语言和界面语言一样时用译文标题（中文界面看中文译文），
     繁体也算中文；否则用英文原标题，译文标题放第二行。short 是侧栏用的短标题。
     译成英文时原标题可能是别的语言，不标 lang；原文本来就是英文、标题照抄的，第二行不重复 */
  PR.titles = function (i) {
    const tr = i.title_zh || "", en = i.title_en || "", lang = i.target || "zh";
    if (tr && (PR.lang.split("-")[0] === lang.split("-")[0] || !en)) return { main: tr, sub: tr === en ? "" : en, subLang: lang === "en" ? "" : "en", short: i.short_zh || tr.split(/[：:]/)[0] };
    return { main: en || PR.t("（未命名）"), sub: tr, subLang: lang, short: en.split(/:\s/)[0] || PR.t("（未命名）") };
  };

  PR.esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* 和 Python store.text_hash 一致：FNV-1a 32 位，按 UTF-16 码元 */
  PR.hashText = function (s) {
    let h = 0x811c9dc5;
    s = s || "";
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  };

  PR.nowIso = function () {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" +
      pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + String(d.getMilliseconds()).padStart(3, "0") +
      (off >= 0 ? "+" : "-") + pad(off / 60) + ":" + pad(off % 60);
  };

  PR.shortTime = function (iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return PR.t("{m}月{d}日 {time}", { m: d.getMonth() + 1, d: d.getDate(), time: pad(d.getHours()) + ":" + pad(d.getMinutes()) });
  };
  PR.relTime = function (iso) {
    if (!iso) return "";
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return PR.t("刚刚");
    if (s < 3600) return PR.t("{n} 分钟前", { n: Math.floor(s / 60) });
    if (s < 86400) return PR.t("{n} 小时前", { n: Math.floor(s / 3600) });
    if (s < 86400 * 30) return PR.t("{n} 天前", { n: Math.floor(s / 86400) });
    return new Date(iso).toLocaleDateString(PR.lang === "en" ? "en-US" : PR.lang === "zh-Hant" ? "zh-TW" : "zh-CN");
  };

  PR.uid = (p) => (p || "n") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  PR.debounce = function (fn, ms) {
    let t;
    const f = function () { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); };
    f.flush = () => { clearTimeout(t); fn(); };
    f.cancel = () => clearTimeout(t);
    return f;
  };
  PR.throttle = function (fn, ms) {
    let last = 0, t;
    return function () {
      const now = Date.now(), wait = ms - (now - last);
      clearTimeout(t);
      if (wait <= 0) { last = now; fn(); } else t = setTimeout(() => { last = Date.now(); fn(); }, wait);
    };
  };

  PR.ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  try { // 改名前（coread-*）存的偏好搬过来
    Object.keys(localStorage).filter((k) => k.startsWith("coread-")).forEach((k) => {
      const nk = "easyread-" + k.slice(7);
      if (localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k));
      localStorage.removeItem(k);
    });
  } catch (e) { /* ignore */ }

  /* 偏好存到本机数据目录的 prefs.json（换浏览器、清缓存都还在）；localStorage 只当缓存。离线单文件版没有服务，只用缓存。 */
  let prefQueue = {}, prefT = null;
  PR.savePrefs = function (section, obj) {
    prefQueue[section] = Object.assign(prefQueue[section] || {}, obj);
    clearTimeout(prefT);
    prefT = setTimeout(flushPrefs, 700);
  };
  function flushPrefs(leaving) {
    clearTimeout(prefT);
    if (!PR.token || location.protocol === "file:" || !Object.keys(prefQueue).length) return;
    const body = prefQueue; prefQueue = {};
    if (leaving) {  // 关页面、刷新时：keepalive 让请求在页面走掉后也能发完
      return fetch("/api/prefs", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "X-Token": PR.token }, body: JSON.stringify(body) }).catch(() => {});
    } else return PR.api("/api/prefs", { method: "POST", body }).catch(() => { /* 下次改动再存 */ });
  }
  window.addEventListener("pagehide", () => flushPrefs(true));
  PR.flushPrefs = () => flushPrefs(true);
  /* 桌面版退出前会来问一句：把偏好和补存写回去再停后端（见 electron/main.cjs） */
  if (window.easyreadDesktop && window.easyreadDesktop.onBeforeQuit) {
    window.easyreadDesktop.onBeforeQuit(() => Promise.all([flushPrefs(true), PR.flushProgress?.()]));
  }
  PR.loadPrefs = async function () {
    if (location.protocol === "file:") return {};
    try {
      const p = await PR.api("/api/prefs");
      if (p.reader) PR.ls.set("easyread-prefs", Object.assign(PR.ls.get("easyread-prefs", {}), p.reader));
      if (p.keys) PR.ls.set("easyread-keys", Object.fromEntries(Object.entries(p.keys).filter(([, v]) => v !== null)));
      return p;
    } catch (e) { return {}; }
  };

  PR.autosize = function (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };

  /* 图标：线性 20×20 */
  const P = {
    menu: "M3 5.5h14M3 10h14M3 14.5h9",
    back: "M12.5 4.5L7 10l5.5 5.5",
    search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5L17 17",
    plus: "M10 4v12M4 10h12",
    gear: "M8.58 4.69L8.73 2.81L11.27 2.81L11.42 4.69A5.5 5.5 0 0 1 12.75 5.24L14.19 4.02L15.98 5.81L14.76 7.25A5.5 5.5 0 0 1 15.31 8.58L17.19 8.73L17.19 11.27L15.31 11.42A5.5 5.5 0 0 1 14.76 12.75L15.98 14.19L14.19 15.98L12.75 14.76A5.5 5.5 0 0 1 11.42 15.31L11.27 17.19L8.73 17.19L8.58 15.31A5.5 5.5 0 0 1 7.25 14.76L5.81 15.98L4.02 14.19L5.24 12.75A5.5 5.5 0 0 1 4.69 11.42L2.81 11.27L2.81 8.73L4.69 8.58A5.5 5.5 0 0 1 5.24 7.25L4.02 5.81L5.81 4.02L7.25 5.24A5.5 5.5 0 0 1 8.58 4.69ZM12.4 10a2.4 2.4 0 1 0 -4.8 0a2.4 2.4 0 1 0 4.8 0z",
    star: "M10 3l2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.7 5.7 16l.9-4.7L3.1 8l4.8-.6z",
    note: "M4 4.5h12v8.5H9l-3.5 3v-3H4z",
    edit: "M13 3.5l3.5 3.5L7.5 16 3.5 16.5 4 12.5z",
    en: "M8.5 5h-5v10h5M3.5 10h4.5M12 9v6M12 11c.6-1.3 1.5-2 2.7-2 1.1 0 1.8.8 1.8 2.1V15",
    page: "M5 2.5h6.5L15 6v11.5H5zM11 2.5V6h4",
    image: "M3 3.5h14v13H3zM3 13l4-4 4 4 2-2 4 4M13.5 7h.01",
    redo: "M15.5 8.5A6 6 0 1 0 16 12M16 4v4.5h-4.5",
    copy: "M7 7h9v9H7zM4 13V4h9",
    trash: "M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10",
    pdf: "M5 2.5h6.5L15 6v11.5H5zM7.5 10h5M7.5 13h5",
    book: "M3.5 4.5c2.5-.8 4.8-.5 6.5.8 1.7-1.3 4-1.6 6.5-.8v11c-2.5-.8-4.8-.5-6.5.8-1.7-1.3-4-1.6-6.5-.8zM10 5.3v11",
    panel: "M3.5 4h13v12h-13zM12 4v12",
    upload: "M10 13V4M6.5 7.5L10 4l3.5 3.5M4 13.5V16h12v-2.5",
    x: "M5 5l10 10M15 5L5 15",
    folder: "M2.5 5.5v10h15V7.5H9.5l-2-2z",
    cloud: "M6 15.5h8.5a3.5 3.5 0 0 0 .4-6.97A5 5 0 0 0 5.3 9.6 3 3 0 0 0 6 15.5z",
    marker: "M11.5 3.5l4 4-6.5 6.5H5v-4zM4 17h12",
    chevron: "M6 8l4 4 4-4",
    arrowUp: "M10 15.5V4.5M5.5 9L10 4.5 14.5 9",
    stop: "M6.5 6.5h7v7h-7z",
    underline: "M6 3.5v5.5a4 4 0 0 0 8 0V3.5M4.5 16.5h11",
    more: "M5 10h.01M10 10h.01M15 10h.01",
    download: "M10 4v9M6.5 9.5L10 13l3.5-3.5M4 16h12",
    log: "M5 5h10M5 8.5h10M5 12h7M5 15.5h5",
    check: "M4.5 10.5l3.5 3.5 7.5-8",
    tag: "M3.5 3.5h6l7 7-6 6-7-7zM7 7h.01",
    pin: "M7.5 3.5h5l-.7 4.3 2.7 2.7v1.2h-9v-1.2l2.7-2.7zM10 11.7v4.8",
    link: "M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1",
    sparkle: "M10 3v4M10 13v4M3 10h4M13 10h4M5.5 5.5l2 2M12.5 12.5l2 2M14.5 5.5l-2 2M7.5 12.5l-2 2",
    question: "M7.5 7.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.8M10 14.5v.01M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
  };
  PR.HL_COLORS = [["yellow", PR.t("黄")], ["green", PR.t("绿")], ["blue", PR.t("蓝")], ["pink", PR.t("红")]];  // pink 历史上叫粉，现在画成红
  PR.logo = (cls) => '<svg class="' + (cls || "mark") + '" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="8" fill="#2d6173"/><path d="M16 10.5C13.6 8.8 10.4 8.3 7 8.6v14.2c3.4-.3 6.6.2 9 1.9 2.4-1.7 5.6-2.2 9-1.9V8.6c-3.4-.3-6.6.2-9 1.9z" fill="#f6f3ec"/><path d="M16 10.5v14.2" stroke="#2d6173" stroke-width="1.2"/><path d="M9.4 13.4h4M9.4 16.4h4M9.4 19.4h2.6" stroke="#9fb7bf" stroke-width="1.6" stroke-linecap="round"/><path d="M18.6 13.4h4M18.6 16.4h4M18.6 19.4h2.6" stroke="#e0a84f" stroke-width="1.6" stroke-linecap="round"/></svg>';
  PR.icon = (name, cls) => '<svg class="i' + (cls ? " " + cls : "") + '" viewBox="0 0 20 20" aria-hidden="true"><path d="' + (P[name] || "") + '"/></svg>';
  PR.icons = { menu: PR.icon("menu"), edit: PR.icon("edit", "sm"), note: PR.icon("note", "sm") };

  PR.toast = function (html, action, ms) {
    let t = PR.$("#toast");
    if (!t) { t = PR.el("div", { id: "toast", role: "status" }); document.body.appendChild(t); }
    t.innerHTML = "<span>" + html + "</span>";
    if (action) {
      const b = PR.el("button", { text: action.label });
      b.onclick = () => { t.classList.remove("open"); action.fn(); };
      t.appendChild(b);
    }
    t.classList.add("open");
    clearTimeout(PR._toastT);
    PR._toastT = setTimeout(() => t.classList.remove("open"), ms || 4200);
  };

  /* 服务接口：写操作带页面加载时拿到的令牌 */
  PR.api = async function (path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    let body = opts.body;
    if (body != null && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) { body = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
    if (opts.method && opts.method !== "GET") headers["X-Token"] = PR.token || "";
    const r = await fetch(path, { method: opts.method || "GET", headers, body, cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || PR.t("请求失败 {status}", { status: r.status }));
    return data;
  };

  /* 主题：文献库和阅读页共用 */
  PR.applyTheme = function (theme) {
    const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };

  /* 简单事件总线 */
  const subs = {};
  PR.on = (ev, fn) => (subs[ev] = subs[ev] || []).push(fn);
  PR.emit = (ev, data) => (subs[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

  /* 通用下拉菜单：items = [{label, icon, kbd, fn} | "-"] */
  PR.menu = function (anchorOrPoint, items) {
    let m = PR.$("#ctxmenu");
    if (!m) { m = PR.el("div", { id: "ctxmenu", class: "menu" }); document.body.appendChild(m); }
    m.innerHTML = '<div class="menu-list">' + items.map((it, i) => it === "-" ? "<hr>" :
      '<button data-i="' + i + '"' + (it.disabled ? " disabled" : "") + ">" + (it.icon ? PR.icon(it.icon, "sm") : "") + "<span>" + PR.esc(it.label) + "</span>" +
      (it.kbd ? '<span class="kbd">' + PR.esc(it.kbd) + "</span>" : "") + "</button>").join("") + "</div>";
    m.onclick = (e) => {
      const b = e.target.closest("[data-i]"); if (!b) return;
      const r = m.getBoundingClientRect();
      PR.lastMenuAt = { x: r.left, y: r.top };  // 菜单项要确认时，确认框就出在菜单原来的位置
      PR.closeMenu(); items[+b.dataset.i].fn();
      setTimeout(() => (PR.lastMenuAt = null), 0);
    };
    m.classList.add("open");
    const r = anchorOrPoint.getBoundingClientRect ? anchorOrPoint.getBoundingClientRect() : { left: anchorOrPoint.x, right: anchorOrPoint.x, top: anchorOrPoint.y, bottom: anchorOrPoint.y };
    const w = m.offsetWidth, h = m.offsetHeight;
    let x = anchorOrPoint.getBoundingClientRect ? r.right - w : r.left;
    let y = r.bottom + 4;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 4);
    m.style.left = Math.max(8, Math.min(innerWidth - w - 8, x)) + "px";
    m.style.top = y + "px";
  };
  PR.closeMenu = () => { const m = PR.$("#ctxmenu"); m && m.classList.remove("open"); };
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#ctxmenu")) PR.closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") PR.closeMenu(); });
})(window.PR);
