"""Conversation-local overrides, independent of translation/model-card defaults."""
from ..app import cli_models
from ..engines import agent_cli


def apply(ecfg: dict, options: dict | None) -> dict:
    if not isinstance(options, dict):
        return {}
    out = {}
    effort = options.get("reasoning_effort")
    if effort is not None:
        allowed = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        engine = ecfg["engine"]
        if engine == "claude":
            allowed = [""] if "haiku" in ecfg[engine].get("model", "") else ["", "low", "medium", "high", "xhigh", "max"]
        elif engine == "codex":
            listing = cli_models.codex()
            model = ecfg[engine].get("model") or listing["default"]
            match = next((m for m in listing["models"] if m["id"] == model), {})
            if match.get("reasoning_levels"):
                allowed = ["", *match["reasoning_levels"]]
        elif engine in agent_cli.ENGINES:
            allowed = ["", *agent_cli.SPECS[engine]["efforts"]]
        elif engine in ("codebuddy", "zcode", "qoder"):
            allowed = [""]
        if effort not in allowed:
            raise ValueError("Unsupported reasoning effort")
        ecfg[engine]["reasoning_effort"] = effort
        out["reasoning_effort"] = effort
    return out
