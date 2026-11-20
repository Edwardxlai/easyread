/* 阅读器 Aa、全局设置、字号快捷键和手机版导出共用的排版规则。 */
(function (PR) {
  "use strict";

  PR.TYPE_DEFAULTS = { fs: 21, measure: 35, lh: 1.9, font: "serif", customFont: "", margin: true };
  PR.typeRanges = {
    fs: { min: 13, max: 28, step: 1 },
    measure: { min: 26, max: 50, step: 1 },
    lh: { min: 1.5, max: 2.4, step: 0.05 },
  };

  PR.readingFontField = function (prefs) {
    const local = prefs.font === "custom" && prefs.customFont;
    const value = local ? PR.esc(prefs.customFont) : prefs.font === "sans" ? PR.t("黑体") : PR.t("宋体");
    const key = local ? "local:" + value : prefs.font === "sans" ? "sans" : "serif";
    return '<input class="input reading-font" type="text" role="combobox" aria-expanded="false" aria-autocomplete="list" ' +
      'aria-label="' + PR.t("字体") + '" placeholder="' + PR.t("搜索字体") + '" autocomplete="off" spellcheck="false" ' +
      'data-choice="' + key + '" value="' + value + '">';
  };

  PR.applyReadingFont = (prefs, root) => {
    const style = root.style;
    const name = String(prefs.customFont || "").trim();
    for (const [key, fallback, sans] of [
      ["--reader-zh", "var(--serif-zh)", "var(--sans-zh)"],
      ["--reader-en", "var(--serif-en)", "var(--sans-en)"],
      ["--reader-table", "var(--serif-en), var(--serif-zh)", "var(--sans-en), var(--sans-zh)"],
    ]) {
      if (prefs.font === "custom" && name) style.setProperty(key, CSS.escape(name) + ", " + fallback);
      else if (prefs.font === "sans") style.setProperty(key, sans);
      else style.removeProperty(key);
    }
  };

  PR.typeValues = function (key) {
    const { min, max, step } = PR.typeRanges[key];
    const steps = Math.round((max - min) / step);
    return Array.from({ length: steps + 1 }, (_, i) => Number((min + i * step).toFixed(2)));
  };

  PR.clampFontSize = function (size) {
    const { min, max } = PR.typeRanges.fs;
    return Math.min(max, Math.max(min, size));
  };
})(window.PR);
