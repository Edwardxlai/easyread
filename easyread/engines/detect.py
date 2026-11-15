"""看看这台机器上有哪些现成能用的翻译引擎：Claude Code、Codex CLI、Grok / Antigravity / Cursor CLI、本机 Ollama。给设置页和首次引导用。"""
from __future__ import annotations

import json
import threading
import time
import urllib.request

from . import engines

_cache: dict = {}
_lock = threading.Lock()

_INSTALL_GUIDES = {
    "qoder": "https://docs.qoder.cn/cli/installation",
    "opencode": "https://opencode.ai/docs/",
    "zcode": "https://github.com/zai-org/ZCode/tree/main/apps/zcode-cli/docs/usage",
    "grok": "https://x.ai/cli",
    "agy": "https://antigravity.google/docs/cli",
    "cursor": "https://cursor.com/docs/cli/installation",
    "codebuddy": "https://www.codebuddy.cn/docs/cli/headless",
    "claude": "https://code.claude.com/docs/en/setup",
    "codex": "https://developers.openai.com/codex/cli/",
}


def cli_sources(found: dict) -> list[dict]:
    return [{"id": name, "name": engines.engine_name(name), "installed": bool(found.get(name, {}).get("found")),
             "install_url": _INSTALL_GUIDES.get(name, "")} for name in engines.CLI_ENGINES]



def _ollama() -> dict:
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=1.5) as r:
            models = [m.get("name") for m in json.loads(r.read()).get("models", []) if m.get("name")]
        return {"running": True, "models": models}
    except Exception:  # noqa: BLE001
        return {"running": False, "models": []}


def detect(cfg: dict, fresh: bool = False) -> dict:
    """查一次要 1–2 秒（要跑 claude --version）。有缓存就直接给，过期了在后台刷新，页面不用等。"""
    with _lock:
        cached = _cache.get("data")
        if cached and not fresh:
            if time.time() - _cache["at"] > 300 and not _cache.get("busy"):
                _cache["busy"] = True
                threading.Thread(target=_refresh, args=(cfg,), daemon=True).start()
            return cached
    return _refresh(cfg)


def warm(cfg: dict) -> None:
    """服务启动时先在后台查一遍，第一次打开设置就不用等。"""
    threading.Thread(target=_refresh, args=(cfg,), daemon=True).start()


def _refresh(cfg: dict) -> dict:
    out: dict = {}

    def cli(name):
        exe = engines.cli_path(name, cfg[name])
        out[name] = {"found": bool(exe), "version": engines._version(exe) if exe else ""}

    threads = [threading.Thread(target=cli, args=(e,)) for e in engines.CLI_ENGINES]
    threads.append(threading.Thread(target=lambda: out.__setitem__("ollama", _ollama())))
    for t in threads:
        t.start()
    for t in threads:
        t.join(40)
    with _lock:
        _cache.update(at=time.time(), data=out, busy=False)
    if out.get("claude", {}).get("found"):
        from ..app.cli_models import probe_claude
        threading.Thread(target=probe_claude, args=(cfg["claude"], out["claude"]["version"]), daemon=True).start()
    return out


def needs_key(o: dict) -> bool:
    from .presets import PRESETS
    p = next((x for x in PRESETS if x["id"] == o.get("preset")), None)
    if p:
        return p["key"]
    return not any(h in (o.get("base_url") or "") for h in ("127.0.0.1", "localhost"))


def ready(cfg: dict, found: dict) -> bool:
    """当前选的引擎看起来能用吗（首次引导据此提示）。"""
    e = cfg.get("engine")
    if e in engines.CLI_ENGINES:
        return bool(found.get(e, {}).get("found"))
    if e == "openai":
        o = cfg["openai"]
        return bool(o.get("base_url") and o.get("model") and (o.get("api_key") or not needs_key(o)))
    return True
