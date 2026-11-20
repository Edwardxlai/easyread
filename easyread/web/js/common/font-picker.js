/* Shared editable font selector for Aa and Settings → Reading. */
(function (PR) {
  "use strict";
  let field, menu, choices, active = -1;
  let families, request;

  function options(query) {
    const pinned = [["serif", PR.t("宋体")], ["sans", PR.t("黑体")]];
    const names = new Set(pinned.map(([, label]) => label.toLowerCase()));
    const local = new Set(families || []);
    if (field.dataset.choice.startsWith("local:")) local.add(field.dataset.choice.slice(6));
    if (families === null && query.trim()) local.add(query.trim()); // Offline export or unavailable enumeration.
    const rows = pinned.concat([...local].filter(name => !names.has(name.toLowerCase())).map(name => ["local:" + name, name]));
    const needle = query.trim().toLowerCase();
    return rows.filter(([, label]) => label.toLowerCase().includes(needle));
  }

  function place() {
    if (!field) return;
    if (!field.isConnected || !field.getClientRects().length) return close();
    const rect = field.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0, bottom = top + (viewport?.height || window.innerHeight);
    const left = viewport?.offsetLeft || 0, right = left + (viewport?.width || document.documentElement.clientWidth);
    const gap = 4, edge = 8;
    const below = bottom - rect.bottom - edge - gap, above = rect.top - top - edge - gap;
    const flip = below < Math.min(200, menu.scrollHeight) && above > below;
    const width = Math.min(rect.width, right - left - 2 * edge);
    menu.style.width = width + "px";
    menu.style.maxHeight = Math.max(0, Math.min(256, flip ? above : below)) + "px";
    menu.style.left = Math.max(left + edge, Math.min(rect.left, right - width - edge)) + "px";
    menu.style.top = (flip ? rect.top - gap - menu.offsetHeight : rect.bottom + gap) + "px";
  }

  function highlight(index, scroll) {
    menu.querySelector(".kb-on")?.classList.remove("kb-on");
    active = index;
    const row = menu.querySelector('[data-index="' + index + '"]');
    if (row) {
      row.classList.add("kb-on");
      field.setAttribute("aria-activedescendant", row.id);
      if (scroll) row.scrollIntoView({block: "nearest"});
    } else field.removeAttribute("aria-activedescendant");
  }

  function render() {
    choices = options(field.value);
    const rows = choices.map(([key, label], i) => {
      const chosen = key === field.dataset.choice;
      const firstLocal = i > 0 && key.startsWith("local:") && !choices[i - 1][0].startsWith("local:");
      return (firstLocal ? '<hr role="presentation">' : "") +
        '<button type="button" tabindex="-1" role="option" id="reading-font-option-' + i + '" data-index="' + i +
        '" aria-selected="' + chosen + '"><span>' + PR.esc(label) + '</span>' + (chosen ? PR.icon("check", "sm") : "") + "</button>";
    });
    menu.innerHTML = rows.join("") || '<div class="font-empty" role="status">' + PR.t("没有匹配的字体") + "</div>";
    menu.scrollTop = 0;
    highlight(field.value.trim() && choices.length ? 0 : -1, false);
    place();
  }

  function close() {
    if (!field) return;
    field.value = field.defaultValue;
    field.setAttribute("aria-expanded", "false");
    field.removeAttribute("aria-controls");
    field.removeAttribute("aria-activedescendant");
    menu.remove();
    field = menu = null;
  }

  function choose(index) {
    const option = choices[index];
    if (!option) return;
    const input = field, [key, label] = option;
    input.dataset.choice = key;
    input.defaultValue = label;
    close();
    const detail = key.startsWith("local:") ? {font: "custom", customFont: label} : {font: key, customFont: ""};
    input.dispatchEvent(new CustomEvent("change", {bubbles: true, detail}));
  }

  function open(input) {
    if (field === input) return;
    close();
    field = input;
    field.value = "";
    menu = document.createElement("div");
    menu.className = "menu menu-list open reading-font-list";
    menu.id = "reading-font-list";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", PR.t("字体"));
    menu.addEventListener("mousedown", e => e.preventDefault());
    menu.addEventListener("click", e => {
      const row = e.target.closest("[data-index]");
      if (row) choose(Number(row.dataset.index));
    });
    document.body.append(menu);
    field.setAttribute("aria-expanded", "true");
    field.setAttribute("aria-controls", menu.id);
    if (location.protocol === "file:") families = null;
    render();
    if (location.protocol !== "file:" && !Array.isArray(families) && !request) {
      request = PR.api("/api/fonts").then(result => { families = result.fonts; }, () => { families = null; })
        .finally(() => { request = null; if (field) render(); });
    }
  }

  document.addEventListener("click", e => {
    if (!e.target.matches(".reading-font")) return;
    if (field === e.target && e.clientX >= field.getBoundingClientRect().right - 30) close();
    else open(e.target);
  });
  document.addEventListener("pointerdown", e => {
    if (field && e.target !== field && !menu.contains(e.target)) close();
  }, true);
  document.addEventListener("focusout", e => { if (e.target === field) close(); });
  document.addEventListener("input", e => {
    if (!e.target.matches(".reading-font")) return;
    if (field !== e.target) { const text = e.target.value; open(e.target); field.value = text; }
    render();
  });
  document.addEventListener("keydown", e => {
    if (!e.target.matches?.(".reading-font") || e.isComposing || e.keyCode === 229) return;
    if (!field) {
      if (["Enter", "ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); open(e.target); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) open(e.target);
      else return;
    } else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { close(); return; }
    else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) choose(active); else close(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (choices.length) highlight(Math.max(0, Math.min(choices.length - 1, active + (e.key === "ArrowDown" ? 1 : -1))), true);
    }
    e.stopImmediatePropagation(); // Reader shortcuts and the surrounding dialog share Escape.
  }, true);
  document.addEventListener("scroll", e => { if (field && !menu.contains(e.target)) place(); }, true);
  document.addEventListener("transitionend", e => {
    if (field && e.propertyName === "transform" && e.target.contains(field)) place();
  });
  window.addEventListener("resize", place);
  window.visualViewport?.addEventListener("resize", place);
})(window.PR);
