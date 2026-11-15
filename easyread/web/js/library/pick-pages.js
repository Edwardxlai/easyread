/* 选页翻译（#55）：文献库详情里点“选页翻译…”，列出还没译的页，点几个页码再点“翻译”。
   只列没译的页：已经译好的不会被误点重译（要整篇重来用“全部重新翻译”）。
   i.todo 是服务端给的 "3-5,9"。Esc 或点外面关掉。 */
(function (PR) {
  "use strict";
  let cur = null;

  function pages(spec) { // "3-5,9" → [3,4,5,9]
    const out = [];
    String(spec || "").split(",").forEach((part) => {
      const [a, b] = part.split("-").map(Number);
      if (a) for (let n = a; n <= (b || a); n++) out.push(n);
    });
    return out;
  }

  function close() {
    if (!cur) return;
    cur.close();
    cur.remove();
    cur = null;
  }

  PR.pickPages = function (i) {
    close();
    const todo = pages(i.todo), picked = new Set();
    const box = PR.el("dialog", { class: "confirm pick-pages", "aria-label": PR.t("选几页翻译") },
      '<div class="cf-title">' + PR.t("选几页翻译") + "</div>" +
      '<div class="cf-body">' + PR.t("这里只列还没译的 {n} 页，点页码选中。", { n: todo.length }) + "</div>" +
      '<div class="pp-grid">' + todo.map((n) => '<button class="pp-page" data-pp="' + n + '">' + n + "</button>").join("") + "</div>" +
      PR.translationExtraHtml() + '<div class="cf-acts"><button class="btn sm pp-all" data-pp-all>' + PR.t("全选") + '</button><span class="pp-gap"></span>' +
      '<button class="btn sm" data-pp-cancel>' + PR.t("取消") + '</button><button class="btn sm accent" data-pp-go disabled></button></div>');
    document.body.appendChild(box);
    const go = box.querySelector("[data-pp-go]"), all = box.querySelector("[data-pp-all]");
    const sync = () => {
      box.querySelectorAll("[data-pp]").forEach((b) => b.classList.toggle("on", picked.has(+b.dataset.pp)));
      go.disabled = !picked.size;
      go.textContent = picked.size ? PR.t("翻译这 {n} 页", { n: picked.size }) : PR.t("翻译");
      all.textContent = picked.size === todo.length ? PR.t("全不选") : PR.t("全选");
    };
    sync();
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-pp]");
      if (b) { const n = +b.dataset.pp; picked.has(n) ? picked.delete(n) : picked.add(n); return sync(); }
      if (e.target.closest("[data-pp-all]")) { if (picked.size === todo.length) picked.clear(); else todo.forEach((n) => picked.add(n)); return sync(); }
      if (e.target.closest("[data-pp-cancel]")) return close();
      if (e.target.closest("[data-pp-go]") && picked.size) {
        const spec = [...picked].sort((a, b) => a - b).join(",");
        const translation_extra = box.querySelector('[data-translation-extra]').value.trim();
        close();
        try {
          await PR.api("/api/p/" + i.id + "/translate", { method: "POST", body: { pages: spec, translation_extra } });
          PR.toast(PR.t("已开始翻译")); PR.lib.load();
        } catch (err) { PR.toast(PR.esc(err.message)); }
      }
    });
    box.addEventListener("cancel", e => { e.preventDefault(); close(); });
    box.addEventListener("keydown", e => e.stopPropagation());
    box.addEventListener("click", e => {
      const r = box.getBoundingClientRect();
      if (e.target === box && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close();
    });
    cur = box;
    box.showModal();
  };
})(window.PR);
