/* Claude Code / Codex 的模型下拉框，“翻译”和“问 AI”两页共用（API 的表单在 settings-api.js）。
   名单来自 /api/engines 的 models（后端 cli_models.py）：Codex 就是它 /model 里列的那些；Claude 的别名带上实际版本。
   Grok Build / Antigravity / Cursor / CodeBuddy CLI 没有现成的模型名单，模型名自己填，空着用 CLI 自己的默认。 */
(function (PR) {
  "use strict";
  /* efforts：能传的推理强度（和后端 agent_cli.SPECS 一致），空的就不显示推理强度 */
  PR.agentClis = {
    qoder: { name: "Qoder CN CLI", efforts: [] },
    opencode: { name: "OpenCode CLI", efforts: [] },
    zcode: { name: "ZCode CLI", efforts: [], defaultOnly: true },
    grok: { name: "Grok Build", efforts: ["low", "medium", "high"] },
    agy: { name: "Antigravity CLI", efforts: ["low", "medium", "high", "xhigh", "max"] },
    cursor: { name: "Cursor CLI", efforts: [] },
    codebuddy: { name: "CodeBuddy CLI", efforts: [] },
  };
  PR.isAgentCli = (k) => Object.prototype.hasOwnProperty.call(PR.agentClis, k);
  PR.isCli = (k) => k === "claude" || k === "codex" || PR.isAgentCli(k);
  PR.cliName = (k) => (k === "claude" ? "Claude Code" : k === "codex" ? "Codex CLI" : PR.isAgentCli(k) ? PR.agentClis[k].name : k);
  const FALLBACK = { claude: { models: [{ id: "opus", name: "Opus", desc: PR.t("最强") }, { id: "sonnet", name: "Sonnet", desc: PR.t("快、省") }, { id: "haiku", name: "Haiku", desc: PR.t("最快最省") }] },
    codex: { default: "", models: [] } };
  const lists = (s) => (s.models || FALLBACK);

  PR.modelDefault = (s, engine) => {
    const catalog = lists(s)[engine];
    if (!catalog || !catalog.default) return "";
    const match = (catalog.models || []).find(m => m.id === catalog.default);
    return match?.actual || match?.name || catalog.default;
  };
  PR.modelDefaultLabelText = (s, engine) => {
    const name = PR.modelDefault(s, engine);
    if (name) return PR.t("跟随默认（{model}）", {model: name});
    const last = lists(s)[engine]?.last_used;
    return last ? PR.t("CLI 默认（上次使用 {model}）", {model: last}) : PR.t("跟随 CLI 默认（型号未确认）");
  };

  PR.cliModelOptions = function (s, engine, value) {
    const L = lists(s)[engine] || FALLBACK[engine];
    let opts;
    if (engine === "claude") {
      opts = L.models.map((m) => [m.id, m.actual || PR.t("{name}（版本未确认）", {name: "Claude " + m.name})]);
    } else {
      opts = L.models.map((m) => [m.id, m.name]);
    }
    opts.unshift(["", PR.modelDefaultLabelText(s, engine)]);
    if (value && !opts.some(([v]) => v === value)) opts.push([value, value]);
    return opts;
  };
  PR.cliModelSelect = (s, engine, value, attrs) =>
    "<select class=\"input\" " + attrs + ">" + PR.opt(PR.cliModelOptions(s, engine, value), value) + "</select>";
  PR.modelDefaultLabel = function (s, f, key) {
    if (PR.isAgentCli(f.kind)) return PR.t("跟随默认");
    const L = lists(s)[f.kind] || {};
    const model = (L.models || []).find((m) => m.id === (f.model || L.default));
    const value = key === "reasoning_effort"
      ? L.configured_reasoning || (model && model.default_reasoning) || ""
      : L.configured_tier === "fast" ? PR.t("开启 Fast")
      : L.configured_tier === "default" || (f.kind === "codex" && !L.configured_tier) ? PR.t("标准速度") : "";
    return value ? PR.t("跟随默认（{model}）", { model: value }) : PR.t("使用默认设置");
  };

  PR.modelReasoningFields = function (s, f) {
    if (PR.isAgentCli(f.kind)) {
      const levels = PR.agentClis[f.kind].efforts;
      return levels.length ? '<div class="grid2"><label class="field"><span>' + PR.t("推理强度") + '</span><select class="input" data-reasoning="reasoning_effort">' +
        PR.opt([["", PR.t("跟随默认")], ...levels.map((v) => [v, v])], f.reasoning_effort || "") + "</select></label></div>" : "";
    }
    const L = lists(s)[f.kind] || {};
    const model = (L.models || []).find((m) => m.id === (f.model || L.default));
    let levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    if (f.kind === "codex") levels = model && model.reasoning_levels && model.reasoning_levels.length ? model.reasoning_levels : ["low", "medium", "high", "xhigh", "max"];
    if (f.kind === "claude") levels = /haiku/i.test(f.model) ? [] : ["low", "medium", "high", "xhigh", "max"];
    const opts = [["", PR.modelDefaultLabel(s, f, "reasoning_effort")], ...levels.map((v) => [v, v])];
    if (f.reasoning_effort && !levels.includes(f.reasoning_effort)) opts.push([f.reasoning_effort, f.reasoning_effort]);
    const field = (key, label, options) => '<label class="field"><span>' + label + '</span><select class="input" data-reasoning="' + key + '">' + PR.opt(options, f[key] || "") + '</select></label>';
    return '<div class="grid2">' + field("reasoning_effort", PR.t("推理强度"), opts) +
      (f.kind === "claude" ? "" : field("service_tier", "Fast", [["", PR.modelDefaultLabel(s, f, "service_tier")], ["fast", PR.t("开启 Fast")], ["default", PR.t("标准速度")]])) + '</div>';

  };

})(window.PR);
