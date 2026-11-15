/* 阅读器 Aa、全局设置、字号快捷键和手机版导出共用的排版规则。 */
(function (PR) {
  "use strict";

  PR.TYPE_DEFAULTS = { fs: 21, measure: 35, lh: 1.9, font: "serif", margin: true };
  PR.typeRanges = {
    fs: { min: 13, max: 28, step: 1 },
    measure: { min: 26, max: 50, step: 1 },
    lh: { min: 1.5, max: 2.4, step: 0.05 },
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
