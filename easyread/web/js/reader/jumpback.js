/* 跳转后能回去：点引用 [n]、“公式 (4)”、目录、笔记卡片这类跳到远处时，记下原来的位置，
   左下角出现“返回刚才读的地方”；浏览器的后退（Alt+←、鼠标侧键、手机返回手势）也能回去。跳了几次就能回几次。 */
(function (PR) {
  "use strict";
  const stack = [];
  let btn = null;
  let group = null, dismissed = false;
  let hit = null;  // 刚才点的是哪一段（点了这段里的 [n]、“公式 (4)”），回来时高亮的就是它
  document.addEventListener("pointerdown", (e) => {
    const b = e.target.closest && e.target.closest('#paper [id^="b-"]');
    hit = b ? { el: b, t: Date.now() } : null;
  }, true);

  /* 在跳转前调用：目标就在眼前（一屏以内）就不记 */
  PR.rememberSpot = function (target) {
    const r = target.getBoundingClientRect();
    if (r.top > -innerHeight * 0.5 && r.bottom < innerHeight * 1.5) return;
    const from = hit && Date.now() - hit.t < 3000 && hit.el.isConnected ? hit.el : null;  // 从目录、笔记卡片跳的就没有
    hit = null;
    const id = from ? from.id.slice(2) : PR.readingBlock();
    const el = document.getElementById("b-" + id) || document.getElementById("b-head");
    stack.push({ id, off: el ? el.getBoundingClientRect().top : 0, y: scrollY, exact: !!from });
    if (stack.length > 30) stack.shift();
    try { history.pushState({ easyreadBack: stack.length }, "", location.href); } catch (e) { /* file:// 下可能不让改历史 */ }
    dismissed = false;
    show();
  };

  // Keep same-paper return steps when a citation opens another paper.
  PR.snapshotJumpBack = () => stack.map(s => ({...s}));
  PR.restoreJumpBack = function (saved) {
    if (!Array.isArray(saved)) return;
    stack.length = 0;
    saved.slice(-30).forEach(s => {
      if (s && typeof s.id === "string" && Number.isFinite(s.off) && Number.isFinite(s.y)) stack.push(s);
    });
    if (stack.length) { dismissed = false; show(); }
  };

  function label() {
    const s = stack[stack.length - 1];
    const sec = s && PR.blockById[s.id] && PR.sectionOf ? PR.sectionOf(s.id) : "";
    return sec ? PR.t("返回刚才读的地方：{sec}", { sec }) : PR.t("返回刚才读的地方");
  }
  function show() {
    if (!btn) {
      group = PR.el("div", { class: "jump-back" });
      btn = PR.el("button", { class: "jump-back-go", type: "button", title: PR.t("回到跳转前的位置（浏览器后退也可以）") });
      btn.onclick = () => (history.state && history.state.easyreadBack ? history.back() : goBack());
      const close = PR.el("button", { class: "jump-back-close", type: "button", title: PR.t("关闭"), "aria-label": PR.t("关闭") });
      close.textContent = "×";
      close.onclick = () => { dismissed = true; group.hidden = true; };
      group.append(btn, close);
      document.body.appendChild(group);
    }
    btn.innerHTML = PR.icon("back", "sm") + "<span>" + PR.esc(label()) + "</span>" + (stack.length > 1 ? "<em>" + stack.length + "</em>" : "");
    group.hidden = dismissed;
  }
  function goBack() {
    const s = stack.pop();
    if (!s) return;
    const el = document.getElementById("b-" + s.id);
    if (el && s.exact) {  // 知道是从哪段跳走的：把那段放回屏幕中间并高亮
      PR.centerOn(el);
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    } else if (el) window.scrollTo({ top: scrollY + el.getBoundingClientRect().top - s.off, behavior: "smooth" });  // 不知道：回到原来的位置，不乱高亮
    else window.scrollTo({ top: s.y, behavior: "smooth" });
    if (stack.length) show(); else group.hidden = true;
  }
  window.addEventListener("popstate", () => { if (stack.length) goBack(); });

  /* 自己滚回原处了，按钮就收起来 */
  window.addEventListener("scroll", PR.debounce(() => {
    const s = stack[stack.length - 1];
    if (!s || !group || group.hidden) return;
    const el = document.getElementById("b-" + s.id);
    if (el && Math.abs(el.getBoundingClientRect().top - s.off) < innerHeight * 0.4) { stack.pop(); if (stack.length) show(); else group.hidden = true; }
  }, 300), { passive: true });
})(window.PR);
