/* Reuse the existing contents drawer as an optional desktop sidebar. */
(function (PR) {
  "use strict";
  const body = document.body, drawer = PR.$("#drawer");
  const wide = matchMedia("(min-width: 1180px)");
  const toggleDrawer = PR.toggleDrawer, applyPrefs = PR.applyPrefs;
  const pin = PR.el("button", { class: "drawer-pin", type: "button" });
  drawer.prepend(pin);
  let active = false;

  function sync() {
    const was = active;
    active = wide.matches && !!PR.prefs.contentsPinned;
    body.classList.toggle("contents-pinned", active);
    pin.textContent = active ? PR.t("取消固定目录") : PR.t("固定目录到左侧");
    pin.setAttribute("aria-pressed", String(active));
    if (active && !was && PR.headings) toggleDrawer(true, "toc");
    if (!active && was) toggleDrawer(false);
    if (active !== was) PR.emit("contents-pin", active);
  }
  PR.applyPrefs = function () { applyPrefs(); sync(); };
  PR.toggleDrawer = function (force, which) {
    if (active && force === false) return;
    if (active && force == null && !which) {
      PR.setPref("contentsPinned", false, true);
      return;
    }
    toggleDrawer(active ? true : force, which);
  };
  pin.addEventListener("click", () => PR.setPref("contentsPinned", !PR.prefs.contentsPinned, true));
  wide.addEventListener("change", sync);
  PR.on("rendered", () => { if (active) toggleDrawer(true); });
  window.addEventListener("scroll", PR.throttle(() => {
    if (!active) return;
    const current = PR.currentHeading();
    drawer.querySelectorAll(".toc [data-go]").forEach(link => {
      const selected = link.dataset.go === current;
      link.classList.toggle("on", selected);
      if (selected) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }, 150), { passive: true });
  sync();
})(window.PR);
