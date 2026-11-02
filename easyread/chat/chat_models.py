"""“问 AI”用哪些模型：设置里一张短名单（默认 Claude Opus 5.5、Claude Sonnet 5.5、GPT），可以增删改。

每一项：{"id", "name", "engine": "claude" | "codex" | "codebuddy" | "opencode" | "zcode" | "omp" | "grok" | "agy" | "cursor" | "openai", "model", "preset"（API 服务商）, "base_url"（自定义地址时）,
         "api"（chat | responses，不填跟服务商默认）}
API 的 Key 用翻译引擎那边按服务商存的同一份（openai.keys），不用填两次。
"""
from __future__ import annotations

import copy
import re
from pathlib import Path

from ..engines import engines
from ..engines.presets import PRESETS
from ..app.i18n import tr

# opus / sonnet 是 Claude Code 的别名：它会用自己支持的最新版（升级 Claude Code 后自动变成 Opus 5.5 等），
# 实际用的是哪个版本，第一次回答时记下来显示在名单上。
DEFAULT_MODELS = [
    {"id": "opus", "name": "Claude Opus", "engine": "claude", "model": "opus"},
    {"id": "sonnet", "name": "Claude Sonnet", "engine": "claude", "model": "sonnet"},
    {"id": "gpt", "name": "GPT", "engine": "codex", "model": ""},
]
_SEEN_PATH = None  # config.HOME / ".models-seen.json"，懒加载避免循环导入


def _seen_path():
    from ..app import config
    return config.HOME / ".models-seen.json"


def pretty(model_id: str) -> str:
    """claude-opus-5-5 → Claude Opus 5.5；claude-sonnet-5 → Claude Sonnet 5。"""
    m = re.fullmatch(r"claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?", model_id or "")
    if not m:
        return model_id
    return f"Claude {m.group(1).capitalize()} {m.group(2)}" + (f".{m.group(3)}" if m.group(3) else "")


def remember(alias: str, actual: str) -> None:
    """记下别名实际对应的模型（Claude Code 在每次回答开头会报）。"""
    if not alias or not actual or alias == actual:
        return
    from ..library.store import read_json, write_json_atomic
    seen = read_json(_seen_path(), {}) or {}
    if seen.get(alias) != actual:
        seen[alias] = actual
        write_json_atomic(_seen_path(), seen)


def actual_of(alias: str) -> str:
    from ..library.store import read_json
    return (read_json(_seen_path(), {}) or {}).get(alias, "")
DEFAULT_CHAT = {"models": DEFAULT_MODELS, "default": "opus"}


def codex_default_model() -> str:
    """Codex CLI 没指定模型时用它自己配置里的（~/.codex/config.toml 的 model）。"""
    return codex_config_value("model")


def codex_config_value(key: str) -> str:
    """Read a top-level string for display, without exposing the full CLI config."""
    import os
    try:
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        text = (home / "config.toml").read_text(encoding="utf-8-sig")
    except OSError:
        return ""
    m = re.search(r'''(?m)^\s*''' + re.escape(key) + r'''\s*=\s*["']([^"']+)["']''', re.split(r"(?m)^\s*\[", text, maxsplit=1)[0])
    return m.group(1) if m else ""


def models(cfg: dict) -> list[dict]:
    return list((cfg.get("chat") or {}).get("models") or DEFAULT_MODELS)


def find(cfg: dict, mid: str | None) -> dict:
    ms = models(cfg)
    want = mid or (cfg.get("chat") or {}).get("default")
    return next((m for m in ms if m.get("id") == want), ms[0] if ms else DEFAULT_MODELS[0])


def _key(cfg: dict, preset: str, base_url: str = "") -> str:
    from ..app.api_keys import resolve
    return resolve(cfg["openai"], preset, base_url)


def engine_cfg(cfg: dict, mid: str | None) -> tuple[dict, dict]:
    """名单里的一项 → (engines 认的配置, 这一项)。"""
    m = find(cfg, mid)
    out = copy.deepcopy(cfg)
    out["engine"] = m["engine"]
    if m["engine"] in engines.CLI_ENGINES:
        out[m["engine"]]["model"] = m.get("model") or ""
        for key in ("reasoning_effort", "service_tier"):
            out[m["engine"]][key] = m.get(key) or ""
    elif m["engine"] == "openai":
        p = next((x for x in PRESETS if x["id"] == m.get("preset")), None)
        out["openai"] = {**out["openai"], "preset": m.get("preset") or "", "vision": False,
                         "base_url": m.get("base_url") or (p["base_url"] if p else out["openai"].get("base_url", "")),
                         "model": m.get("model") or (p["model"] if p else ""), "api_key": _key(cfg, m.get("preset") or "", m.get("base_url") or ""),
                         "api": m.get("api") or (p or {}).get("api") or "chat",
                         "reasoning_effort": m.get("reasoning_effort") or "", "service_tier": m.get("service_tier") or ""}
    else:
        raise engines.EngineError(tr("不认识的模型来源：{engine}", engine=m.get("engine")))
    return out, m


def translation_id(cfg: dict) -> str:
    """名单里哪一张就是翻译用的那个模型（设置里标着“翻译”的卡片）；对不上返回空。"""
    e = cfg.get("engine")
    for m in models(cfg):
        if m.get("engine") != e:
            continue
        if any((m.get(k) or "") != (cfg.get(e, {}).get(k) or "") for k in ("reasoning_effort", "service_tier")):
            continue
        if e in engines.CLI_ENGINES and (m.get("model") or "") == (cfg.get(e, {}).get("model") or ""):
            return m["id"]
        if e == "openai":
            o = cfg.get("openai", {})
            if (m.get("preset") or "") == (o.get("preset") or "") and (m.get("model") or "") == (o.get("model") or ""):
                return m["id"]
    return ""


def label(m: dict) -> str:
    """面板上显示的名字：Claude 别名显示实际版本（Claude Opus 5），Codex 没填模型时带上它实际用的模型。"""
    if m.get("engine") == "claude" and m.get("model") in ("opus", "sonnet", "haiku") and actual_of(m["model"]):
        return pretty(actual_of(m["model"]))
    if m.get("engine") == "codex" and (not m.get("name") or m.get("name") in ("GPT", m.get("model"))):
        from ..app import cli_models  # 用 Codex 里 /model 显示的名字，比如 GPT-6-Astra
        slug = m.get("model") or codex_default_model()
        return next((x["name"] for x in cli_models.codex()["models"] if x["id"] == slug), slug or "GPT")
    return m.get("name") or m.get("model") or tr("模型")


def listing(cfg: dict) -> dict:
    """给页面：名单 + 每项能不能用、来源说明。"""
    from ..engines.detect import detect, needs_key
    found = detect(cfg)
    out = []
    for m in models(cfg):
        e = m.get("engine")
        if e in engines.CLI_ENGINES:
            ready = bool(found.get(e, {}).get("found"))
            source = engines.engine_name(e)
            hint = "" if ready else tr("本机没找到 {source}", source=source)
        else:
            p = next((x for x in PRESETS if x["id"] == m.get("preset")), None)
            ready = bool(_key(cfg, m.get("preset") or "", m.get("base_url") or "")) or not needs_key({"preset": m.get("preset"), "base_url": m.get("base_url", "")})
            from ..app.api_keys import key_id
            profile = next((c for c in cfg["openai"].get("custom_apis", [])
                            if key_id("", c.get("base_url", "")) == key_id("", m.get("base_url", ""))), {})
            source = p["name"] if p else profile.get("name") or tr("自定义地址")
            hint = "" if ready else tr("还没填 {source} 的 Key（设置 → 模型 → 点这张卡片 → 修改）", source=source)
        out.append({**m, "label": label(m), "source": source, "ready": ready, "hint": hint,
                    "detail": (actual_of(m.get("model", "")) or m.get("model") or _claude_default()) if e == "claude"
                    else m.get("model") or (tr("{model}（跟随 Codex 默认）", model=codex_default_model()) if e == "codex" and codex_default_model() else "")})
    default = (cfg.get("chat") or {}).get("default") or (out[0]["id"] if out else "")
    return {"models": out, "default": default, "translate": translation_id(cfg), "presets": [{"id": p["id"], "name": p["name"], "models": p.get("models", []), "api": p.get("api", "chat")} for p in PRESETS]}


def sanitize(items: list[dict]) -> list[dict]:
    """设置页提交的名单：去掉空项、补 id。"""
    out, seen = [], set()
    for k, m in enumerate(items or []):
        e = m.get("engine")
        if e not in (*engines.CLI_ENGINES, "openai") or (e == "openai" and not (m.get("preset") or m.get("base_url"))):
            continue
        mid = re.sub(r"[^\w\-]", "-", str(m.get("id") or f"m{k}"))[:40] or f"m{k}"
        while mid in seen:
            mid += "-2"
        seen.add(mid)
        out.append({"id": mid, "name": str(m.get("name") or m.get("model") or tr("模型"))[:40], "engine": e,
                    "model": str(m.get("model") or "")[:120], "preset": str(m.get("preset") or ""), "base_url": str(m.get("base_url") or "")[:300],
                    "api": m.get("api") if m.get("api") in ("chat", "responses") else "",
                    "reasoning_effort": m.get("reasoning_effort") if m.get("reasoning_effort") in ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra") else "",
                    "service_tier": m.get("service_tier") if m.get("service_tier") in ("fast", "default") else ""})
    return out or copy.deepcopy(DEFAULT_MODELS)


def _claude_default() -> str:
    """“跟随 Claude Code 默认”的卡片下面写出实际是哪个：跟随默认（Claude Opus 5.5）"""
    from ..app.cli_models import claude_default  # cli_models 引用了本文件，放这里免得循环导入
    d = claude_default()
    return tr("跟随默认（{model}）", model=d) if d else tr("跟随默认")
