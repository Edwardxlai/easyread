"""检查新版本：问 GitHub 最新的 Release，比当前版本新就告诉页面（文献库顶栏显示“有新版本”）。

一天最多问一次，结果记在数据目录的 update.json；没网、GitHub 连不上就当没有新版本，不报错。
帮助里关掉“自动检查新版本”后，只有点“检查更新”时才联网。
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.request

from .. import __version__
from . import config
from ..server import http
from .log import log
from ..library.store import read_json, write_json_atomic

REPO = "Edwardxlai/easyread"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
EVERY = 24 * 3600   # 成功问到后多久再问
RETRY = 3 * 3600    # 没问到（没网）多久后再试
_lock = threading.Lock()


def _path():
    return config.HOME / "update.json"


def parse(v: str) -> tuple[int, ...]:
    """'v1.2.10' → (1, 2, 10)；认不出的部分当 0。"""
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:3]) or (0,)


def newer(latest: str, current: str = __version__) -> bool:
    return parse(latest) > parse(current)


def _fetch() -> dict:
    req = urllib.request.Request(API, headers={"Accept": "application/vnd.github+json", "User-Agent": f"EasyRead/{__version__}"})
    with http.urlopen(req, timeout=8) as r:
        rel = json.loads(r.read())
    return {"latest": (rel.get("tag_name") or "").lstrip("v"), "url": rel.get("html_url") or f"https://github.com/{REPO}/releases/latest",
            "notes": (rel.get("body") or "")[:6000], "published": rel.get("published_at") or ""}


def check(force: bool = False) -> dict:
    """{"current", "latest", "newer", "url", "notes", "published", "enabled", "failed"}。force：手动点“检查更新”，关掉自动检查也照样问。

    failed：这次真去问了 GitHub 但没问到。latest 仍是上次缓存的版本，页面不能据此说“已经是最新版”。
    """
    out = {"current": __version__, "latest": "", "newer": False, "enabled": bool(config.load().get("check_updates", True)), "failed": False}
    if not out["enabled"] and not force:
        return out
    with _lock:  # 两个页面同时打开只问一次
        cache = read_json(_path(), {}) or {}
        age = time.time() - cache.get("checked", 0)
        if force or age > (EVERY if cache.get("latest") else RETRY):
            try:
                cache = {**_fetch(), "checked": time.time()}
            except Exception as e:  # noqa: BLE001  没网、限流、GitHub 改了格式：都当没有新版本
                log.info("检查新版本没成功：%s", e)
                cache = {**cache, "checked": time.time()}
                out["failed"] = True
            try:
                write_json_atomic(_path(), cache)
            except OSError:
                pass
    if cache.get("latest"):
        out.update(latest=cache["latest"], url=cache.get("url", ""), notes=cache.get("notes", ""),
                   published=cache.get("published", ""), newer=newer(cache["latest"]))
    return out
