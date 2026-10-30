/* Vocabulary help stays beside the selection without creating a chat or editing the paper. */
(function (PR) {
  "use strict";

  PR.translateSelection = function (selection) {
    let speech, sizeObserver;
    const at = { getBoundingClientRect: () => selection.rect };
    PR.popover(at, '<section class="selection-translation" role="dialog" aria-label="' + PR.t("划词翻译") + '">' +
      '<div class="st-head"><strong>' + PR.t("划词翻译") + '</strong><button class="btn sm" data-st-close aria-label="' + PR.t("关闭") + '">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>' +
      '<div class="st-quote" dir="auto">' + PR.esc(selection.quote) + '</div>' +
      '<div class="st-speech"><select class="st-accent" data-st-accent aria-label="' + PR.t("朗读口音") + '">' +
      '<option value="en-US">' + PR.t("美音") + '</option><option value="en-GB">' + PR.t("英音") + '</option></select>' +
      '<button class="btn sm line" data-st-speak disabled>' + PR.t("朗读原文") + '</button>' +
      '<button class="btn sm line" data-st-slow disabled>' + PR.t("慢速朗读") + '</button>' +
      '<button class="btn sm line" data-st-stop hidden>' + PR.t("停止朗读") + '</button>' +
      '<details class="st-voice-options"><summary>' + PR.t("朗读音色") + '</summary>' +
      '<select class="st-voice" data-st-voice aria-label="' + PR.t("朗读音色") + '" disabled><option>' + PR.t("加载音色…") + '</option></select></details>' +
      '<span class="hint st-speech-status" data-st-speech-status role="status"></span></div>' +
      '<div class="st-result" dir="auto" role="status" aria-live="polite"></div>' +
      '<div class="st-actions"><button class="btn sm line" data-st-retry hidden>' + PR.t("重试") + '</button>' +
      '<button class="btn sm line" data-st-copy disabled>' + PR.t("复制译文") + '</button></div></section>', {
        sticky: true, wide: true, onClose: () => {
          if (speech) speech.dispose();
          if (sizeObserver) sizeObserver.disconnect();
        },
      });
    // Each request owns its own DOM nodes. A late answer cannot replace a newer popup.
    const root = PR.$("#popover .selection-translation");
    if (window.ResizeObserver) {
      sizeObserver = new window.ResizeObserver(() => {
        const pop = root.parentElement, r = selection.rect;
        let top = r.bottom + 8;
        if (top + pop.offsetHeight > window.innerHeight - 10) top = r.top - pop.offsetHeight - 8;
        pop.style.top = Math.max(58, top) + "px";
      });
      sizeObserver.observe(root);
    }
    speech = PR.selectionSpeech(root, selection.quote);
    const result = root.querySelector(".st-result"), retry = root.querySelector("[data-st-retry]"), copy = root.querySelector("[data-st-copy]");
    let translation = "";
    async function run() {
      retry.hidden = true; copy.disabled = true;
      result.textContent = PR.t("正在翻译…");
      result.setAttribute("aria-busy", "true");
      try {
        const data = await PR.api("/api/p/" + PR.pid + "/translate-selection", {
          method: "POST", body: { anchor: selection.anchor, text: selection.quote },
        });
        translation = data.translation;
        result.textContent = translation;
        copy.disabled = false;
      } catch (error) {
        result.textContent = PR.t("翻译失败：{msg}", { msg: error.message });
        retry.hidden = false;
      } finally { result.setAttribute("aria-busy", "false"); }
    }
    root.addEventListener("click", async (event) => {
      if (event.target.closest("[data-st-close]")) return PR.hidePopover();
      if (event.target.closest("[data-st-retry]")) return run();
      if (event.target.closest("[data-st-copy]")) {
        try { await navigator.clipboard.writeText(translation); PR.toast(PR.t("已复制")); }
        catch (_) { PR.toast(PR.t("复制失败，请手动选中")); }
      }
    });
    return run();
  };
})(window.PR);
