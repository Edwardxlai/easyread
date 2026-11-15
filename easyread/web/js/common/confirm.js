/* Shared, viewport-centered confirmation and text dialogs. */
(function (PR) {
  "use strict";
  let cur = null;

  function close(v) {
    if (!cur) return;
    const { box, done } = cur;
    cur = null;
    box.close();
    box.remove();
    done(v);
  }

  function open(o, withInput) {
    if (cur) close(cur.cancelValue);
    return new Promise((done) => {
      const box = PR.el("dialog", { class: "confirm", "aria-label": o.title || PR.t("确定") },
        '<div class="cf-title">' + PR.esc(o.title || "") + "</div>" +
        (o.body ? '<div class="cf-body">' + PR.esc(o.body) + "</div>" : "") +
        (withInput ? '<input class="input cf-input" maxlength="' + (o.max || 60) + '" placeholder="' + PR.esc(o.placeholder || "") + '">' : "") +
        '<div class="cf-acts"><button class="btn sm" data-cf="no">' + PR.t("取消") + '</button>' +
        (o.alt && !withInput ? '<button class="btn sm line" data-cf="alt">' + PR.esc(o.alt) + "</button>" : "") + '<button class="btn sm ' + (o.danger ? "danger-fill" : "accent") + '" data-cf="ok">' + PR.esc(o.ok || PR.t("确定")) + "</button></div>");
      document.body.appendChild(box);
      const inp = box.querySelector(".cf-input");
      if (inp) inp.value = o.value || "";
      const cancelValue = withInput ? null : false;
      const accept = () => withInput ? inp.value.trim() || null : true;
      box.addEventListener("cancel", e => { e.preventDefault(); close(cancelValue); });
      box.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.isComposing && e.target === inp) { e.preventDefault(); close(accept()); }
      });
      box.addEventListener("click", e => {
        const button = e.target.closest("[data-cf]");
        if (button) return close(button.dataset.cf === "alt" ? "alt" : button.dataset.cf === "ok" ? accept() : cancelValue);
        const r = box.getBoundingClientRect();
        if (e.target === box && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close(cancelValue);
      });
      cur = { box, done, cancelValue };
      box.showModal();
      (inp || box.querySelector(o.danger ? '[data-cf="no"]' : '[data-cf="ok"]')).focus();
      if (inp) inp.select();
    });
  }

  PR.confirm = (o) => open(o, false);
  PR.promptText = (o) => open(o, true);
})(window.PR);
