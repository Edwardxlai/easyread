"""翻译调用 Codex 时不拉起用户自己配的 MCP 服务，也关掉翻译用不到的功能。

codex exec 每次启动都会把 ~/.codex/config.toml（或 CODEX_HOME 下的）里的 [mcp_servers.*] 全部拉起来：
npx 起的服务每个就是好几个 node 进程，分段并行 4 段时实测 300 多个进程、峰值 8 GB。翻译用不到这些工具。
这里读出配置里有哪些 MCP 服务，给每个传 -c mcp_servers.<名字>.enabled=false，再把 turn 结束时的 notify 钩子关掉。
不用 --ignore-user-config：那样会连用户自定义的 provider、model 一起丢掉。
读不到配置、解析不出来就不碰 MCP；Codex 版本不认这些键时会忽略，真报错时 run_codex 去掉它们再调一次，也就是退回现状。
"""
from __future__ import annotations

import os
import re
from pathlib import Path

# [mcp_servers.名字] 或 [mcp_servers."带点的名字"]；子表 [mcp_servers.名字.env] 不算新服务
_HEADER = re.compile(r"""(?m)^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]""")
_BARE = re.compile(r"[A-Za-z0-9_-]+")


def config_path() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"


def server_names(text: str) -> list[str]:
    out = []
    for m in _HEADER.finditer(text):
        raw = m.group(1)
        name = raw[1:-1].replace('\\"', '"') if raw[0] in "\"'" else raw
        if name and name not in out:
            out.append(name)
    return out


def _key(name: str) -> str:
    return name if _BARE.fullmatch(name) else '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def args(path: Path | None = None) -> list[str]:
    """codex exec 要加的 -c 参数。配置读不到、解析不出就只关功能、不碰 MCP。"""
    try:
        text = (path or config_path()).read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return features()  # 没有配置文件：没有 MCP 要关
    try:
        names = server_names(text)
    except Exception:  # noqa: BLE001 —— 解析不了就不碰 MCP
        return features()
    out: list[str] = []
    for n in names:
        out += ["-c", f"mcp_servers.{_key(n)}.enabled=false"]
    if re.search(r"(?m)^\s*notify\s*=", text.split("\n[", 1)[0]):
        out += ["-c", "notify=[]"]  # 每次结束时调用的提醒程序（Codex 桌面版的电脑操作组件），翻译用不到
    return out + features()


# 翻译用不到的功能：插件、应用、浏览器、电脑操作、生图、多代理、记忆……每个都会往每次调用里加工具定义，
# 有的还会拉起 node_repl 之类的进程。实测（codex-cli 0.159）空调用固定上下文从约 2.5 万 token 降到约 1.7 万，
# 进程从 19 个降到 3 个，内存从约 840 MB 降到约 200 MB。只关这一次调用，不改用户的配置。
# 版本不认某个名字时 Codex 照常忽略；真报错时 run_codex 会去掉这些参数再调一次。
FEATURES_OFF = ("apps", "plugins", "browser_use", "browser_use_external", "computer_use", "image_generation", "multi_agent",
                "memories", "goals", "skill_search", "in_app_browser", "tool_suggest", "realtime_conversation",
                "sleep_tool")


def features() -> list[str]:
    out: list[str] = []
    for f in FEATURES_OFF:
        out += ["-c", f"features.{f}=false"]
    return out
