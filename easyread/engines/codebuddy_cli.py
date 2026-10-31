"""CodeBuddy CLI: reuse local login, send text/images through JSONL stdin.

Protocol and options: https://www.codebuddy.cn/docs/cli/headless,
https://www.codebuddy.cn/docs/cli/cli-reference and /cli/settings.
Images are attached directly, so no tools, MCP servers or hooks are needed.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..app.i18n import tr
from . import netcheck
from .chat_tools import READ_TOOLS, DENIED_TOOLS


def path(c: dict) -> str | None:
    return shutil.which(c.get("command") or "codebuddy")


def build_args(c: dict) -> list[str]:
    # Keep required restrictions last; never retry without them on older CLIs.
    args = list(c.get("extra_args") or [])
    managed = {"-y", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
               "--tools", "--allowedTools", "--disallowedTools", "--mcp-config", "--plugin-dir",
               "--settings", "--setting-sources", "--permission-mode", "--input-format", "--output-format", "--"}
    for arg in args:
        if arg.split("=", 1)[0] in managed:
            from .engines import EngineError
            raise EngineError(tr("CodeBuddy 的额外参数不能覆盖安全或输入输出设置：{arg}", arg=arg))
    if c.get("model"):
        args += ["--model", c["model"]]
    if c.get("_chat"):
        args += ["--allowedTools", READ_TOOLS, "--disallowedTools", DENIED_TOOLS]
    return args + ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                   "--tools", READ_TOOLS if c.get("_chat") else "", "--strict-mcp-config", "--permission-mode", "default",
                   "--setting-sources", "user", "--settings", '{"disableAllHooks":true}',
                   "--no-session-persistence"]


def _stdin(prompt: str, images: list[Path]) -> str:
    content = [{"type": "text", "text": prompt}]
    for img in images:
        media_type = mimetypes.guess_type(str(img))[0] or "image/jpeg"
        content.append({"type": "image", "source": {"type": "base64", "media_type": media_type,
                                                    "data": base64.b64encode(img.read_bytes()).decode("ascii")}})
    return json.dumps({"type": "user", "message": {"role": "user", "content": content}}, ensure_ascii=False) + "\n"


def _result(out: str) -> dict:
    from .engines import _json_lines
    # Accept both pretty-printed JSON and the documented JSONL event stream.
    try:
        obj = json.loads(out)
        events = [obj] if isinstance(obj, dict) else []
    except (ValueError, TypeError):
        events = _json_lines(out)
    return next((e for e in reversed(events) if isinstance(e, dict) and e.get("type") == "result"), {})


def run(c: dict, prompt: str, cwd: Path, images: list[Path], cancel=None, meter=None) -> str:
    from . import engines
    exe = path(c)
    if not exe:
        raise engines.EngineError(tr("找不到 {name} 命令：{cmd}（先装好并登录）", name="CodeBuddy CLI", cmd=c.get("command") or "codebuddy"))
    args = [exe, *build_args(c)]
    try:
        stdin_text = _stdin(prompt, images)
        env = dict(netcheck.proxy_env() or os.environ)
        # China-region WorkBuddy/CodeBuddy accounts; explicit environment wins.
        env.setdefault("CODEBUDDY_INTERNET_ENVIRONMENT", "internal")
        with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as stderr:
            proc = subprocess.Popen(args, cwd=str(cwd), stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8",
                                    errors="replace", creationflags=engines._NO_WINDOW, env=env)
            try:
                out = engines._communicate(proc, stdin_text, int(c.get("timeout") or 1200), cancel)
            except engines.EngineError as exc:
                stderr.seek(0)
                detail = stderr.read().strip()
                raise engines.EngineError(str(exc) + ("\n" + detail[-1000:] if detail else "")) from None
            stderr.seek(0)
            error_output = stderr.read().strip()
    except OSError as exc:
        raise engines.EngineError(tr("{name} 没有给出结果：{msg}", name="CodeBuddy CLI", msg=str(exc))) from None
    res = _result(out)
    u = res.get("usage")
    if meter is not None and isinstance(u, dict):
        cached = int(u.get("cache_read_input_tokens") or 0)
        meter.add(input=int(u.get("input_tokens") or 0) + cached + int(u.get("cache_creation_input_tokens") or 0),
                  cached=cached, output=int(u.get("output_tokens") or 0))
    text = res.get("result")
    text = text.strip() if isinstance(text, str) else ""
    if proc.returncode not in (0, None) or res.get("is_error") or res.get("subtype", "success") != "success" or not text:
        errors = res.get("errors")
        messages = [e if isinstance(e, str) else e.get("message") if isinstance(e, dict) else None
                    for e in errors] if isinstance(errors, list) else []
        detail = "\n".join(m.strip() for m in messages if isinstance(m, str) and m.strip())
        detail = detail or str(res.get("result") or res.get("error") or res.get("subtype") or (out or "")[-300:])
        if error_output:
            detail += "\n" + error_output[-1000:]
        if proc.returncode not in (0, None):
            detail += "\n" + tr("退出码 {code}", code=proc.returncode)
        raise engines.EngineError(tr("{name} 没有给出结果：{msg}", name="CodeBuddy CLI", msg=detail))
    return text
