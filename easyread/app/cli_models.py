"""Claude Code / Codex CLI 能选哪些模型，给设置页的下拉框用。

- Codex：读 ~/.codex/models_cache.json（Codex 自己从服务端拉的名单），只要 /model 里列出来的那些，按它的顺序；
  默认模型是 ~/.codex/config.toml 里的 model。
- Claude：opus / sonnet / haiku 是 Claude Code 的别名，会用它支持的最新版；
  实际是哪个版本记在 .models-seen.json（见 chat_models.remember）：每次回答时记一次；
  另外 probe_claude() 在服务启动时把还没记过的别名查一遍（Claude Code 升级后重查），名单里一开始就有版本号。
  不指定模型时 Claude Code 用哪个（“跟随默认”）：~/.claude/settings.json 里写了 model 就是它，没写就看探测时记下的 _default。
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path

from ..chat import chat_models
from ..engines import engines
from .i18n import tr
from .log import log
from ..engines.presets import PRESETS

_probing = threading.Lock()
CLAUDE_ALIASES = [("opus", "Opus", "最强"), ("sonnet", "Sonnet", "快、省"), ("haiku", "Haiku", "最快最省")]  # i18n-ok 显示时用 _alias_desc()


def _alias_desc(alias: str) -> str:
    return {"opus": tr("最强"), "sonnet": tr("快、省"), "haiku": tr("最快最省")}.get(alias, "")


def codex() -> dict:
    """{"default": slug, "models": [{"id", "name", "desc"}]}；Codex 没装或没登录过就是空名单。"""
    out: list[dict] = []
    try:
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        data = json.loads((home / "models_cache.json").read_text(encoding="utf-8"))
        ms = [m for m in data.get("models") or [] if m.get("visibility") == "list" and m.get("slug")]
        ms.sort(key=lambda m: m.get("priority", 99))
        out = [{"id": m["slug"], "name": m.get("display_name") or m["slug"], "desc": m.get("description") or "",
                "reasoning_levels": [r["effort"] for r in m.get("supported_reasoning_levels", []) if isinstance(r, dict) and r.get("effort")],
                "default_reasoning": m.get("default_reasoning_level") or ""} for m in ms]
    except (OSError, ValueError, AttributeError):
        pass
    return {"default": chat_models.codex_default_model(), "models": out,
            "configured_reasoning": chat_models.codex_config_value("model_reasoning_effort"),
            "configured_tier": chat_models.codex_config_value("service_tier")}


def claude_default() -> str:
    """Claude Code 不指定模型时用的那个，显示名（Claude Opus 5.5）；不知道就空。"""
    try:
        model = json.loads((Path.home() / ".claude" / "settings.json").read_text(encoding="utf-8")).get("model") or ""
    except (OSError, ValueError, AttributeError):
        model = ""
    actual = (chat_models.actual_of(model) or model) if model else chat_models.actual_of("_default")
    if actual in ("opus", "sonnet", "haiku", "fable"):  # 别名还没查到对应版本
        return "Claude " + actual.capitalize()
    return chat_models.pretty(actual) if actual else ""


def claude() -> dict:
    """{"default": "Claude Opus 5.5", "models": [{"id": "opus", "name": "Opus", "desc": "最强", "actual": "Claude Opus 5.5"}]}"""
    try:
        settings = json.loads((Path.home() / ".claude" / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        settings = {}
    effort = os.environ.get("CLAUDE_CODE_EFFORT_LEVEL") or settings.get("effortLevel") or ""
    return {"configured_reasoning": effort, "default": claude_default(), "models": [{"id": a, "name": n, "desc": _alias_desc(a), "actual": chat_models.pretty(chat_models.actual_of(a)) if chat_models.actual_of(a) else ""}
                       for a, n, _ in CLAUDE_ALIASES]}


def probe_claude(c: dict, version: str) -> None:
    """让 Claude Code 报一下 opus / sonnet / haiku 现在各指向哪个版本。
    它启动时第一行（init 事件）就带着实际模型名，这时还没发请求；读到就结束进程，不花 token。"""
    exe = engines.claude_path(c)
    if not exe or (chat_models.actual_of("_claude_version") == version
                   and all(chat_models.actual_of(a) for a in [x for x, _, _ in CLAUDE_ALIASES] + ["_default"])):
        return
    if not _probing.acquire(blocking=False):  # 上一轮还没查完
        return
    try:
        _probe(exe, version)
    finally:
        _probing.release()


def _probe(exe: str, version: str) -> None:
    for alias in [a for a, _, _ in CLAUDE_ALIASES] + ["_default"]:  # _default：不带 --model，看它默认用哪个
        proc = engines._popen([exe, "-p", *([] if alias == "_default" else ["--model", alias]), "--output-format", "stream-json", "--verbose",
                               "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"],
                              Path(tempfile.gettempdir()))
        try:
            proc.stdin.write(".")
            proc.stdin.close()
            for _, line in zip(range(20), proc.stdout):
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("type") == "system" and ev.get("subtype") == "init":
                    chat_models.remember(alias, ev.get("model", ""))
                    break
        except Exception:  # noqa: BLE001 —— 查不到就等第一次回答时再记
            log.info("查 Claude 别名 %s 失败", alias, exc_info=True)
        finally:
            proc.kill()
    chat_models.remember("_claude_version", version)


def listing() -> dict:
    catalog = {"claude": claude(), "codex": codex()}
    for engine in engines.agent_cli.ENGINES:
        last = chat_models.actual_of("last-default:" + engine)
        if last:
            catalog[engine] = {"last_used": last}
    return catalog


def default_model(engine: str) -> str:
    if engine == "claude":
        return claude_default()
    if engine == "codex":
        catalog = codex()
        return next((m["name"] for m in catalog["models"] if m["id"] == catalog["default"]), catalog["default"])
    return ""


def engine_label(cfg: dict) -> str:
    """文献库右上角的引擎标签：“Claude Code · Claude Opus 5.5”“DeepSeek · deepseek-v4-flash”。"""
    e = cfg.get("engine")
    if e == "openai":
        preset = next((p["name"] for p in PRESETS if p["id"] == cfg["openai"].get("preset")), "API")
        return f"{preset.split('（')[0]} · {cfg['openai'].get('model') or tr('未填模型')}"  # i18n-ok （ 是拆预设名
    name = engines.engine_name(e)
    if e in engines.CLI_ENGINES and not cfg[e].get("model"):
        return name + " · " + (default_model(e) or tr("跟随 CLI 默认（型号未确认）"))
    if e == "claude":  # 带上实际用的模型：Claude Code · Claude Opus 5.5
        m = cfg["claude"].get("model") or ""
        actual = chat_models.actual_of(m) if m else ""
        model = chat_models.pretty(actual) if actual else ("Claude " + m.capitalize() if m in ("opus", "sonnet", "haiku") else m) if m else claude_default()
    elif e == "codex":
        model = chat_models.label({"engine": "codex", "model": cfg["codex"].get("model") or ""})
    elif e in engines.CLI_ENGINES:
        model = cfg[e].get("model") or ""
    else:
        model = ""
    return f"{name} · {model}" if model and model != "GPT" else name
