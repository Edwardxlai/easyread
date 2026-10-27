"""配置和数据位置。

从源码目录运行时，数据就放在源码目录（library/、config.json）；pip 安装后放在 ~/EasyRead。
环境变量 EASYREAD_HOME 改数据目录，EASYREAD_LIBRARY 临时指定文献库（测试、多库）。
"""
from __future__ import annotations

import copy
import os
from pathlib import Path

from ..chat.chat_models import DEFAULT_CHAT
from ..engines.presets import PRESET_GROUPS, PRESETS  # noqa: F401
from ..library.store import read_json, write_json_atomic

PACKAGE = Path(__file__).resolve().parent.parent
WEB = PACKAGE / "web"
_SOURCE = PACKAGE.parent
HOME = Path(os.environ.get("EASYREAD_HOME") or (_SOURCE if (_SOURCE / "pyproject.toml").exists() else Path.home() / "EasyRead"))
PROJECT = HOME  # 旧名，cli 里还在用
CONFIG_PATH = HOME / "config.json"
LOG_PATH = HOME / "easyread.log"
SERVER_INFO = HOME / ".server.json"

DEFAULTS = {
    "library_dir": str(HOME / "library"),
    "port": 8765,
    "engine": "claude",          # claude | codex | codebuddy | grok | agy | cursor（本机 CLI 无头）| openai（任意 OpenAI 兼容接口）| none
    "auto_translate": True,      # 导入后自动开始翻译
    "target": "zh",              # 译文语言，见 langs.py
    "translation_instructions": "",
    "translation_prompt": None,
    "translate_figure_text": True,
    "figure_images": {"enabled": False, "provider": "codex", "base_url": "", "api_key": "", "model": "", "timeout": 600},
    "opencode": {"command": "", "model": "", "extra_args": [], "timeout": 1200},
    "check_updates": True,       # 打开文献库时问 GitHub 有没有新版本（一天一次），见 updates.py
    "batch_pages": 2,            # 每次交给模型的页数
    "paper_concurrency": 1,      # 默认逐篇处理；手动设1-4，重启生效，会与每篇的分段并发相乘
    "page_cap": 60,              # 全文超过多少页先确认；0 表示不限
    "concurrency": 0,            # 同时译几段（分段并行，见 segments.py）；0 是自动，每段约 2 批、最多 4 段；手动最多 8 段
    "concurrency_v": 2,          # 1.3.1 起 concurrency 的意思变了，旧配置的 1 当成自动，见 load
    "claude": {"command": "claude", "model": "", "reasoning_effort": "", "extra_args": [], "timeout": 1200},
    "codex": {"command": "codex", "model": "", "reasoning_effort": "", "service_tier": "", "extra_args": [], "timeout": 1200},
    "codebuddy": {"command": "codebuddy", "model": "", "extra_args": [], "timeout": 1200},
    "zcode": {"command": "zcode", "model": "", "extra_args": [], "timeout": 1200},
    # 另外三个本机 CLI（见 agent_cli.py）；command 空着按默认名找，model 空着用 CLI 自己的默认
    "grok": {"command": "", "model": "", "reasoning_effort": "", "extra_args": [], "timeout": 1200},
    "agy": {"command": "", "model": "", "reasoning_effort": "", "extra_args": [], "timeout": 1200},
    "cursor": {"command": "", "model": "", "reasoning_effort": "", "extra_args": [], "timeout": 1200},
    # api：chat（/chat/completions）| responses（/responses），见 openai_api.py
    "openai": {"preset": "", "base_url": "", "api": "chat", "api_key": "", "model": "", "vision": False, "timeout": 600},
    # 阅读页右侧“问 AI”的模型名单和默认模型，见 chat_models.py
    "chat": copy.deepcopy(DEFAULT_CHAT),
}

def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def is_first_run() -> bool:
    return not CONFIG_PATH.exists()


def _saved() -> dict:
    raw = read_json(CONFIG_PATH, {}) or {}
    if raw.get("concurrency_v") != 2 and raw.get("concurrency") == 1:
        # 以前默认 1，而且切到本机 CLI 时设置页会强制改回 1，旧配置里的 1 多半不是自己选的：当成自动。
        # 存过一次之后带上 concurrency_v，再选 1 就是真的要一段一段译
        raw["concurrency"] = 0
    elif raw.get("concurrency_v") != 2 and isinstance(raw.get("concurrency"), int) and raw["concurrency"] > 4:
        raw["concurrency"] = 4  # 以前的 6 是“同时 6 批”，现在是“同时 6 段”：升级时不替老用户开到 4 段以上
    raw["concurrency_v"] = 2
    return raw


def load() -> dict:
    cfg = _merge(DEFAULTS, _saved())
    lib = os.environ.get("EASYREAD_LIBRARY") or os.environ.get("COREAD_LIBRARY")
    if lib:  # 测试或多库时临时指定文献库
        cfg["library_dir"] = lib
    return cfg


def temp_library() -> bool:
    return bool(os.environ.get("EASYREAD_LIBRARY") or os.environ.get("COREAD_LIBRARY"))


def save(patch: dict) -> dict:
    cfg = _merge(_merge(DEFAULTS, _saved()), patch)
    write_json_atomic(CONFIG_PATH, cfg)
    return load()


def with_key(o: dict, section: str = "openai") -> dict:
    """页面提交的 API 设置 → 要存的样子。按配置区和服务地址分别保存 Key，换来换去不用重填；
    页面发回来的打码 Key 或空 Key 表示不改。"""
    cur = load()[section]
    o = dict(o)
    key = o.pop("api_key", None)
    preset = o.get("preset", cur.get("preset")) or ""
    from .api_keys import key_id, saved_keys
    keys = saved_keys(cur)
    slot = key_id(preset, o.get("base_url", cur.get("base_url", "")))
    if key and not key.startswith("••••"):
        keys[slot] = key.strip()
    o["keys"] = keys
    o["api_key"] = keys.get(slot, "")
    return o


def public(cfg: dict) -> dict:
    """给页面看的配置：密钥只露后四位。"""
    from .api_keys import saved_keys
    from ..translate import prompt_style
    out = copy.deepcopy(cfg)
    out["translation_prompt_default"] = prompt_style.default(cfg.get("target"))
    out["translation_prompt_effective"] = prompt_style.effective(cfg)
    for section in ("openai", "figure_images"):
        if section not in out:
            continue
        out[section]["keys"] = saved_keys(cfg[section])
        key = out[section].get("api_key") or ""
        out[section]["api_key"] = ("••••" + key[-4:]) if key else ""
        out[section]["has_key"] = bool(key)
        out[section]["saved_keys"] = [k for k, v in (out[section].pop("keys", None) or {}).items() if v]
    return out


def library_dir(cfg: dict | None = None) -> Path:
    p = Path((cfg or load())["library_dir"])
    p.mkdir(parents=True, exist_ok=True)
    return p
