/* Claude Code / Codex 的模型下拉框，“翻译”和“问 AI”两页共用（API 的表单在 settings-api.js）。
   名单来自 /api/engines 的 models（后端 cli_models.py）：Codex 就是它 /model 里列的那些；Claude 的别名带上实际版本。
   Grok Build / Antigravity / Cursor / CodeBuddy CLI 没有现成的模型名单，模型名自己填，空着用 CLI 自己的默认。 */
(function (PR) {
  "use strict";
  /* efforts：能传的推理强度（和后端 agent_cli.SPECS 一致），空的就不显示推理强度 */
  PR.agentClis = {
    qoder: { name: "Qoder CN CLI", url: "https://docs.qoder.cn/cli/installation", efforts: [],
      hint: PR.t("使用本机已登录的 Qoder CN；模型留空跟随 CLI 默认，看图能力取决于所选模型"),
      setup: PR.t("安装并登录 Qoder CN CLI") },
    opencode: { name: "OpenCode CLI", url: "https://opencode.ai/docs/", efforts: [],
      hint: PR.t("模型名填写 provider/model，可在终端运行 opencode models 查看；留空使用 OpenCode 默认模型"),
      setup: PR.t("安装 OpenCode 并配置模型") },
    zcode: { name: "ZCode CLI", url: "https://github.com/zai-org/ZCode/tree/main/apps/zcode-cli/docs/usage", efforts: [], defaultOnly: true,
      hint: PR.t("使用本机 ZCode 登录态；模型和推理选项跟随 ZCode 设置，看图能力取决于所选模型"),
      setup: PR.t("安装并登录 ZCode CLI") },
    grok: { name: "Grok Build", url: "https://x.ai/cli", efforts: ["low", "medium", "high"] },
    agy: { name: "Antigravity CLI", url: "https://antigravity.google/docs/cli", efforts: ["low", "medium", "high", "xhigh", "max"] },
    cursor: { name: "Cursor CLI", url: "https://cursor.com/docs/cli/installation", efforts: [] },
    codebuddy: { name: "CodeBuddy CLI", url: "https://www.codebuddy.cn/docs/cli/headless", efforts: [],
      hint: PR.t("WorkBuddy 与 CodeBuddy 共用同账号积分；当前免费体验版不含 CLI 访问，需标准版及以上"),
      setup: PR.t("安装并登录 CodeBuddy CLI") },
  };
  PR.isAgentCli = (k) => Object.prototype.hasOwnProperty.call(PR.agentClis, k);
  PR.isCli = (k) => k === "claude" || k === "codex" || PR.isAgentCli(k);
  PR.cliName = (k) => (k === "claude" ? "Claude Code" : k === "codex" ? "Codex CLI" : PR.isAgentCli(k) ? PR.agentClis[k].name : k);
  const FALLBACK = { claude: { models: [{ id: "opus", name: "Opus", desc: PR.t("最强") }, { id: "sonnet", name: "Sonnet", desc: PR.t("快、省") }, { id: "haiku", name: "Haiku", desc: PR.t("最快最省") }] },
    codex: { default: "", models: [] } };
  const lists = (s) => (s.models || FALLBACK);

  /* 下拉框的选项：[[value, label]]，选项就写模型名。Codex 一个模型都没查到时才留一项“Codex 默认” */
  PR.cliModelOptions = function (s, engine, value) {
    const L = lists(s)[engine] || FALLBACK[engine];
    let opts;
    if (engine === "claude") {
      opts = L.models.map((m) => [m.id, m.actual || "Claude " + m.name]);
    } else {
      opts = L.models.map((m) => [m.id, m.name]);
      if (!opts.length) opts.unshift(["", PR.t("Codex 默认")]);
    }
    if (value && !opts.some(([v]) => v === value)) opts.push([value, value]);
    return opts;
  };
  PR.cliModelSelect = (s, engine, value, attrs) =>
    "<select class=\"input\" " + attrs + ">" + PR.opt(PR.cliModelOptions(s, engine, value), value) + "</select>";
  /* 以前存的“跟随 CLI 默认”（模型空着）→ 换成它现在实际用的那个，翻译固定用一个模型，不随 CLI 设置变 */
  PR.cliPin = function (s, engine, model) {
    if (model || (engine !== "claude" && engine !== "codex") || !s.models) return model;
    const L = s.models[engine] || {};
    if (engine === "codex") return L.default || "";
    const hit = (L.models || []).find((m) => m.actual && m.actual === L.default);
    return hit ? hit.id : "opus";
  };

  PR.modelDefaultLabel = function (s, f, key) {
    if (PR.isAgentCli(f.kind)) return PR.t("跟随默认");
    const L = lists(s)[f.kind] || {};
    const model = (L.models || []).find((m) => m.id === (f.model || L.default));
    const value = key === "reasoning_effort"
      ? L.configured_reasoning || (model && model.default_reasoning) || PR.t("未知")
      : L.configured_tier === "fast" ? PR.t("开启 Fast")
      : L.configured_tier === "default" || (f.kind === "codex" && !L.configured_tier) ? PR.t("标准速度") : PR.t("未知");
    return PR.t("跟随默认（{model}）", { model: value });
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
