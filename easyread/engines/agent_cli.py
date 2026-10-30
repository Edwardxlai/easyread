"""另外三个本机 CLI：Grok Build（grok）、Antigravity CLI（agy）、Cursor CLI（agent）。

和 Claude Code / Codex 一样起一个子进程、用你已经登录的订阅，不需要 Key。三家的无头调用各不一样：
- grok：提示词太长不能放命令行，用 --prompt-file 读临时文件；--output-format json 最后给一个对象
  {"text", "stopReason", "usage": {...}}，出错是 {"type": "error", "message"}。
  不加 --always-approve：无头模式下要授权的工具调用（写文件、跑命令）一律被拒，读文件照常。
  实测（grok 1.0.50）：工具全开时它会到处 grep、想跑 python，被拒后整轮以 cancelled 结束、没有结果，所以只给 read_file，
  关掉网页搜索和用户配的 MCP（search_tool / use_tool）；默认推理强度一页要想 10 分钟，没选推理强度时用 low（约 2 分钟）。
- agy：只有 --input-format stream-json 能从 stdin 收提示词（-p 只收命令行参数）。stdin 写一行 user 事件，
  读最后的 {"event": "result", "result": {"status", "response", "usage"}}。工作区里读文件默认放行，写文件和命令要授权、无头时被拒。
- cursor：agent -p 没给提示词参数时从 stdin 读；--mode ask 是只读问答模式，--trust 免得无头时卡在“信任此目录”。
  --output-format json 给 {"type": "result", "is_error", "result"}，没有 token 用量。

原页图三家都不能当附件发，提示词里写路径，让它们自己用读文件的工具看（image_mode 里和 claude 同一种写法）。
它们找图时会先想跑命令（agy 用 Get-ChildItem 找 page-003.jpg），无头模式下被拒就交白卷，所以提示词末尾加一句 ONLY_READ。
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path

from ..app.i18n import tr
from .chat_tools import RESEARCH_PROMPT

SPECS = {
    "grok": {"name": "Grok Build", "commands": ("grok",), "efforts": ["low", "medium", "high"]},
    "agy": {"name": "Antigravity CLI", "commands": ("agy",), "efforts": ["low", "medium", "high", "xhigh", "max"]},
    "cursor": {"name": "Cursor CLI", "commands": ("agent", "cursor-agent"), "efforts": []},
}
ENGINES = tuple(SPECS)
ONLY_READ = "\n\n（只用读文件的工具看上面提到的图片或文件；不要运行命令、不要搜索、不要打开别的文件。看完直接输出最终结果。）"  # i18n-ok 提示词


def path(engine: str, c: dict) -> str | None:
    """设置里填了命令就只认它；没填按默认名找（Cursor 新版叫 agent，旧版叫 cursor-agent）。
    Grok Build 也会装一个 agent（就是 grok 本身，和 grok.exe 放在一起）：旁边有 grok 的 agent 不算 Cursor。"""
    if c.get("command"):
        return shutil.which(c["command"])
    for p in map(shutil.which, SPECS[engine]["commands"]):
        if p and not (engine == "cursor" and _grok_agent(p)):
            return p
    return None


def _grok_agent(p: str) -> bool:
    d = Path(p).parent
    return any((d / n).exists() for n in ("grok.exe", "grok"))


def run(engine: str, c: dict, prompt: str, cwd: Path, cancel=None, meter=None) -> str:
    from . import engines  # engines 引用了本文件，放这里免得循环导入
    exe = path(engine, c)
    name = SPECS[engine]["name"]
    if not exe:
        raise engines.EngineError(tr("找不到 {name} 命令：{cmd}（先装好并登录）", name=name, cmd=c.get("command") or SPECS[engine]["commands"][0]))
    timeout = int(c.get("timeout") or 1200)
    args = [exe] + build_args(engine, c)
    prompt += RESEARCH_PROMPT if c.get("_chat") else ONLY_READ
    if engine == "grok":
        fd, file = tempfile.mkstemp(suffix=".md", prefix="easyread-grok-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(prompt)
        try:
            out = engines._communicate(engines._popen(args[:1] + ["--prompt-file", file] + args[1:], cwd), "", timeout, cancel)
        finally:
            Path(file).unlink(missing_ok=True)
    elif engine == "agy":
        line = json.dumps({"event": "user", "message": {"content": prompt}}, ensure_ascii=False) + "\n"
        out = engines._communicate(engines._popen(args, cwd), line, timeout, cancel)
    else:
        out = engines._communicate(engines._popen(args, cwd), prompt, timeout, cancel)
    text, err, used = parse(engine, out)
    if meter is not None and used:
        meter.add(**used)
    if err or not text:
        raise engines.EngineError(tr("{name} 没有给出结果：{msg}", name=name, msg=err or (out or "")[-300:]))
    return text


def build_args(engine: str, c: dict) -> list[str]:
    """命令后面的参数（grok 的 --prompt-file 在 run 里补）。extra_args 是设置里没有界面的高级参数。"""
    model = c.get("model") or ""
    effort = c.get("reasoning_effort") or ""
    if engine == "grok":
        args = ["--output-format", "json", "--no-auto-update", "--tools", "read_file,search_tool" if c.get("_chat") else "read_file",
                "--disallowed-tools", "use_tool" if c.get("_chat") else "search_tool,use_tool"]
        if not c.get("_chat"):
            args += ["--disable-web-search"]
        args += ["--reasoning-effort", effort if effort in SPECS["grok"]["efforts"] else "low"]
        args += ["--model", model] if model else []
    elif engine == "agy":
        args = ["--input-format", "stream-json", "--output-format", "stream-json"] + (["--model", model] if model else [])
        if effort in SPECS["agy"]["efforts"]:
            args += ["--effort", effort]
    else:
        args = ["-p", "--output-format", "json", "--trust", "--mode", "ask"] + (["--model", model] if model else [])
    return args + list(c.get("extra_args") or [])


def parse(engine: str, out: str) -> tuple[str, str, dict | None]:
    """CLI 的输出 → (回答, 报错, 给 Meter 的用量)。"""
    from .engines import _json_lines
    events = _json_lines(out)
    if not events:  # 整个对象被排成了多行
        try:
            obj = json.loads((out or "").strip())
            events = [obj] if isinstance(obj, dict) else []
        except json.JSONDecodeError:
            pass
    if engine == "grok":
        res = next((e for e in reversed(events) if "text" in e or e.get("type") == "error"), None) or {}
        if res.get("type") == "error":
            return "", str(res.get("message") or ""), _usage(res.get("usage"), "cache_read_input_tokens")
        return str(res.get("text") or "").strip(), "", _usage(res.get("usage"), "cache_read_input_tokens")
    if engine == "agy":
        res = next((e.get("result") or {} for e in reversed(events) if e.get("event") == "result"), {})
        used = _usage(res.get("usage"), "cache_read_tokens")
        if res and res.get("status") != "SUCCESS":
            return "", str(res.get("error") or res.get("status") or ""), used
        return str(res.get("response") or "").strip(), "", used
    res = next((e for e in reversed(events) if e.get("type") == "result"), {})
    if res.get("is_error") or res.get("subtype", "success") != "success":
        return "", str(res.get("result") or res.get("subtype") or ""), None
    return str(res.get("result") or "").strip(), "", None


def _usage(u, cached_key: str) -> dict | None:
    """grok 的 input_tokens 不含命中缓存的部分，agy 的含；Meter 要的 input 是全部输入。"""
    if not isinstance(u, dict):
        return None
    cached = int(u.get(cached_key) or 0)
    inp = int(u.get("input_tokens") or 0)
    if cached_key == "cache_read_input_tokens":
        inp += cached + int(u.get("cache_creation_input_tokens") or 0)
    return {"input": inp, "cached": cached, "output": int(u.get("output_tokens") or 0) + int(u.get("thinking_tokens") or 0)}
