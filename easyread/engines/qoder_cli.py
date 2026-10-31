"""Qoder CN headless CLI, using the installed CLI's own login and defaults.

Protocol: https://docs.qoder.cn/cli/cli-reference
No authentication files are read or copied; unsupported flags fail explicitly.
"""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from ..app.i18n import tr
from .chat_tools import READ_TOOLS, DENIED_TOOLS


def path(c: dict) -> str | None:
    commands = (c["command"],) if c.get("command") else ("qodercn", "qoderclicn")
    return next((found for command in commands if (found := shutil.which(command))), None)


def build_args(c: dict, images: list[Path]) -> list[str]:
    from .engines import EngineError
    if c.get("extra_args"):
        raise EngineError(tr("Qoder CN 暂不支持额外参数，请清空 qoder.extra_args"))
    allowed = READ_TOOLS if c.get("_chat") else "Read"
    args = ["-p", "--output-format", "json", "--permission-mode", "default",
            "--tools", allowed, "--allowed-tools", allowed,
            "--disallowed-tools", DENIED_TOOLS, "--strict-mcp-config",
            "--setting-sources", "user", "--settings", '{"disableAllHooks":true}',
            "--no-session-persistence"]
    if c.get("model"):
        args += ["--model", c["model"]]
    for image in images:
        args += ["--attachment", str(image.resolve())]
    return args


def result(out: str) -> dict:
    from .engines import _json_lines
    try:
        value = json.loads(out)
        if isinstance(value, dict):
            return value
    except ValueError:
        pass
    return next((ev for ev in reversed(_json_lines(out)) if ev.get("type") == "result"), {})


def run(c: dict, prompt: str, cwd: Path, images: list[Path], cancel=None, meter=None) -> str:
    from . import engines
    exe = path(c)
    if not exe:
        raise engines.EngineError(tr("找不到 {name} 命令：{cmd}（先装好并登录）", name="Qoder CN CLI", cmd=c.get("command") or "qodercn"))
    images = [(image if image.is_absolute() else cwd / image).resolve() for image in images]
    args = [exe, *build_args(c, images)]
    # A fresh task folder avoids inheriting project hooks or instructions. Chat
    # receives a copy of this paper only so Read can inspect beyond the excerpt.
    with tempfile.TemporaryDirectory(prefix="easyread-qoder-") as folder:
        work = Path(folder)
        if c.get("_chat"):
            for name in ("paper.json", "reader.json"):
                source = cwd / name
                if source.is_file():
                    shutil.copyfile(source, work / name)
        proc = engines._popen(args, work)
        try:
            out = engines._communicate(proc, prompt, int(c.get("timeout") or 1200), cancel)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
    value = result(out)
    text = value.get("result")
    if proc.returncode or value.get("is_error") or value.get("subtype", "success") != "success" or not isinstance(text, str) or not text.strip():
        detail = str(value.get("error") or value.get("result") or out[-500:])
        raise engines.EngineError(tr("{name} 没有给出结果：{msg}", name="Qoder CN CLI", msg=detail))
    used = value.get("usage")
    if meter is not None and isinstance(used, dict):
        cached = int(used.get("cache_read_input_tokens") or 0)
        meter.add(input=int(used.get("input_tokens") or 0) + cached + int(used.get("cache_creation_input_tokens") or 0),
                  cached=cached, output=int(used.get("output_tokens") or 0))
    return text.strip()
