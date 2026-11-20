/* 阅读器 Aa、全局设置、字号快捷键和手机版导出共用的排版规则。 */
(function (PR) {
  "use strict";

  PR.TYPE_DEFAULTS = { fs: 21, measure: 35, lh: 1.9, font: "serif", customFont: "", fontEn: true, fontCode: true, margin: true };
  PR.typeRanges = {
    fs: { min: 13, max: 28, step: 1 },
    measure: { min: 26, max: 50, step: 1 },
    lh: { min: 1.5, max: 2.4, step: 0.05 },
  };

  PR.sanitizeFontFamily = function (raw) {
    return String(raw || "")
      .split(",")
      .map((part) => part.replace(/["';{}\\\r\n\0<>]/g, "").trim())
      .filter(Boolean)
      .join(", ");
  };

  PR.quoteFontFamily = function (raw) {
    const clean = PR.sanitizeFontFamily(raw);
    if (!clean) return "";
    return clean.split(",").map((part) => '"' + part.trim() + '"').join(", ");
  };

  PR.resolveFonts = function (prefs) {
    const p = prefs || {};
    const font = p.font || "serif";
    const fontEn = p.fontEn !== false;
    const fontCode = p.fontCode !== false;
    const customName = font === "custom" ? PR.sanitizeFontFamily(p.customFont) : "";
    const quoted = customName ? PR.quoteFontFamily(customName) : "";

    if (font === "sans") {
      return {
        font: "sans",
        family: "",
        zh: "var(--sans-zh)",
        en: fontEn ? "var(--sans-en)" : "var(--serif-en)",
        code: "var(--mono)",
        table: fontEn ? "var(--sans-en), var(--sans-zh)" : "var(--serif-en-latin), var(--sans-zh)",
      };
    }
    if (quoted) {
      const zh = quoted + ", var(--serif-zh)";
      return {
        font: "custom",
        family: customName,
        zh,
        en: fontEn ? quoted + ", var(--serif-en)" : "var(--serif-en)",
        code: fontCode ? quoted + ", var(--mono)" : "var(--mono)",
        table: fontEn ? quoted + ", var(--serif-en), var(--serif-zh)" : "var(--serif-en-latin), " + zh,
      };
    }
    return {
      font: "serif",
      family: "",
      zh: "var(--serif-zh)",
      en: "var(--serif-en)",
      code: "var(--mono)",
      table: "var(--serif-en), var(--serif-zh)",
    };
  };

  PR.applyFontVars = function (prefs, root) {
    const el = root || document.documentElement;
    if (!el || !el.style) return;
    const f = PR.resolveFonts(prefs);
    if (f.font === "serif") {
      el.style.removeProperty("--reader-zh");
      el.style.removeProperty("--reader-en");
      el.style.removeProperty("--reader-code");
      el.style.removeProperty("--reader-table");
    } else {
      el.style.setProperty("--reader-zh", f.zh);
      el.style.setProperty("--reader-en", f.en);
      el.style.setProperty("--reader-code", f.code);
      el.style.setProperty("--reader-table", f.table);
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
