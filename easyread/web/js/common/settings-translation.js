/* Translation preferences stay visible beside the existing model controls. */
(function (PR) {
  "use strict";
  PR.translationSettingsHtml = function (s) {
    const c = s.cfg;
    const images = c.figure_images || {};
    const figureOutput = c.translate_figure_text === false ? "original" : images.enabled ? "image" : "text";
    const imageField = (key, label, placeholder, type = 'text') => '<label class="field"><span>' + PR.t(label) + '</span><input class="input" type="' + type + '" data-k="figure_images.' + key + '" value="' + PR.esc(images[key] || '') + '" placeholder="' + PR.esc(placeholder) + '" autocomplete="off"></label>';
    const select = (key, label, options, value, title = "") => '<label class="field"' + (title ? ' title="' + PR.esc(title) + '"' : '') + '><span>' + PR.t(label) + '</span><select class="input" data-k="' + key + '">' + PR.opt(options, value) + '</select></label>';
    return '<div class="translation-heading"><h4 class="set-h">' + PR.t("翻译设置") + '</h4><button class="btn sm line" id="testBtn">' + PR.t("测试连接") + '</button></div>' +
      '<div class="test-result" id="testRes" role="status"></div><div class="grid2 translation-limits">' +
      select('batch_pages', PR.t("每批页数"), [1,2,3,4].map(n => [n, PR.t("{n} 页", {n})]), c.batch_pages) +
      select('concurrency', PR.t("篇内并行段数"), [[0, PR.t("自动")], ...[1,2,3,4,5,6,7,8].map(n => [n,n])], c.concurrency || 0, PR.t("每段按页序翻译；自动模式最多并行 4 段")) +
      select('paper_concurrency', PR.t("并行论文数"), [1,2,3,4].map(n => [n, PR.t("{n} 篇", {n})]), c.paper_concurrency || 1, PR.t("修改后重启生效；多篇并行可能触发模型限流")) +
      select('page_cap', PR.t("整篇翻译确认阈值"), [30,60,100,200].map(n => [n, PR.t("{n} 页", {n})]).concat([[0,PR.t("不限")]]), c.page_cap ?? 60) +
      (c.engine === 'openai' ? select('openai.vision', PR.t("翻译模型输入"), [["text", PR.t("提取的文字")], ["images", PR.t("文字和 PDF 原页图像")]], c.openai.vision ? "images" : "text") : '') +
      '<label class="field"><span>' + PR.t("图中文字的输出形式") + '</span><select class="input" data-figure-output>' +
      PR.opt([["original", PR.t("保留原文")], ["text", PR.t("仅提供文字译文")], ["image", PR.t("提供文字译文和译图")]], figureOutput) + '</select></label>' +
      (figureOutput === "image" ? select('figure_images.provider', PR.t("译图服务"), [['codex', PR.t("Codex 订阅")], ['api', PR.t("图片 API（单独计费）")]], images.provider || 'codex') : '') + '</div>' +
      (figureOutput === "image" && images.provider === "api" ? '<div class="grid2">' +
        imageField('base_url', PR.t("译图接口地址"), 'https://api.openai.com/v1') +
        imageField('model', PR.t("图片编辑模型"), PR.t("输入模型 ID")) +
        imageField('api_key', 'API Key', PR.t("留空保留已存密钥"), 'password') + '</div>' : '') +
      '<div class="translation-prompt-row"><span>' + PR.t("翻译提示词") + '</span><button class="btn sm line" data-edit-translation-prompt>' + PR.t("编辑提示词") + '</button></div>';
  };
})(window.PR);
