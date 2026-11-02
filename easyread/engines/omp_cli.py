"""omp (oh-my-pi) print mode: stdin prompt, JSON events, images as @file arguments.

Reference: https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md.
Each call runs in a disposable directory with tools, skills, rules, extensions,
LSP and session persistence off, so only the supplied task and images are seen.
`--mode json` prints a message_update/text_delta event per piece of the answer as it is generated:
问 AI shows them as they arrive (stream), translation waits for the whole answer (run).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path

from ..app.i18n import tr
from . import netcheck

EFFORTS = ("minimal", "low", "medium", "high", "xhigh", "max")
_SYSTEM = "Answer the supplied question or translation task directly. Do not use tools."


def path(c: dict) -> str | None:
    return shutil.which(c.get("command") or "omp")


def build_args(exe: str, c: dict, images: list[Path]) -> list[str]:
    args = [exe, "-p", "--mode", "json", "--no-session", "--no-tools", "--no-skills", "--no-rules",
            "--no-extensions", "--no-lsp", "--no-title", "--system-prompt", _SYSTEM]
    if c.get("model"):
        args += ["--model", c["model"]]
    if c.get("reasoning_effort") in EFFORTS:
        args += ["--thinking", c["reasoning_effort"]]
    args += list(c.get("extra_args") or [])
    return args + ["@" + str(Path(image).resolve()) for image in images]


def parse(out: str) -> tuple[str, str, dict]:
    """Answer text, error message and token usage from the assistant messages."""
    final, ended = None, []
    for line in (out or "").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        if ev.get("type") == "agent_end" and isinstance(ev.get("messages"), list):
            final = ev["messages"]
        elif ev.get("type") == "message_end" and isinstance(ev.get("message"), dict):
            ended.append(ev["message"])
    messages = [m for m in (final if final is not None else ended) if isinstance(m, dict) and m.get("role") == "assistant"]
    texts, error, used = [], "", {"input": 0, "output": 0, "cached": 0}
    for m in messages:
        for part in m.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip():
                texts.append(str(part["text"]))
        if m.get("stopReason") in ("error", "aborted"):
            error = str(m.get("errorMessage") or m.get("stopReason"))
        u = m.get("usage") or {}
        if isinstance(u, dict):
            cached = int(u.get("cacheRead") or 0)
            used["input"] += int(u.get("input") or 0) + cached + int(u.get("cacheWrite") or 0)
            used["cached"] += cached
            used["output"] += int(u.get("output") or 0)
    return "\n\n".join(texts).strip(), error, used


def stream(c: dict, prompt: str, cwd: Path, images: list[Path], cancel=None, meter=None) -> Iterator[str]:
    """Answer text piece by piece. Usage and errors are read from the final messages once omp exits;
    an error after some text was shown is still raised, so a cut-off answer is never saved as complete."""
    from . import engines
    exe = path(c)
    if not exe:
        raise engines.EngineError(tr("找不到 {name} 命令：{cmd}（先装好并登录）", name="omp", cmd=c.get("command") or "omp"))
    images = [(img if img.is_absolute() else cwd / img).resolve() for img in images]
    env = dict(netcheck.proxy_env() or os.environ)
    timeout = int(c.get("timeout") or 1200)
    # Do not pick up project context files (AGENTS.md, rules) from the paper folder.
    with tempfile.TemporaryDirectory(prefix="easyread-omp-") as work, \
            tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as stderr:
        try:
            proc = subprocess.Popen(build_args(exe, c, images), cwd=work, env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                                    text=True, encoding="utf-8", errors="replace", creationflags=engines._NO_WINDOW)
        except OSError as exc:
            raise engines.EngineError(tr("{name} 没有给出结果：{msg}", name="omp", msg=str(exc))) from None
        done, expired = threading.Event(), threading.Event()
        deadline = time.monotonic() + timeout

        def watch():  # reading stdout blocks: cancel and timeout end the process instead
            while not done.wait(0.2):
                cancelled = cancel is not None and cancel.is_set()
                if cancelled or time.monotonic() > deadline:
                    if not cancelled:
                        expired.set()
                    proc.kill()
                    return

        threading.Thread(target=watch, daemon=True).start()
        lines, said = [], False
        try:
            try:
                proc.stdin.write(prompt)
                proc.stdin.close()
            except OSError:
                pass  # omp exited early (e.g. unknown model); its stderr explains why
            for line in proc.stdout:
                lines.append(line)
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                delta = ev.get("assistantMessageEvent") if isinstance(ev, dict) and ev.get("type") == "message_update" else None
                if isinstance(delta, dict) and delta.get("type") == "text_delta" and delta.get("delta"):
                    said = True
                    yield delta["delta"]
            proc.wait()
        finally:
            done.set()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        if cancel is not None and cancel.is_set():
            raise engines.Cancelled()
        if expired.is_set():
            raise engines.EngineError(tr("超过 {n} 秒没有结果", n=timeout))
        stderr.seek(0)
        detail = stderr.read().strip()
    out = "".join(lines)
    text, error, used = parse(out)
    if meter is not None and any(used.values()):
        meter.add(**used)
    if proc.returncode not in (0, None) or error or not text:
        msg = error or detail[-1000:] or out[-300:]
        if proc.returncode not in (0, None):
            msg += "\n" + tr("退出码 {code}", code=proc.returncode)
        raise engines.EngineError(tr("{name} 没有给出结果：{msg}", name="omp", msg=msg))
    if not said:  # an omp build without text deltas: the final message still carries the answer
        yield text


def run(c: dict, prompt: str, cwd: Path, images: list[Path], cancel=None, meter=None) -> str:
    return "".join(stream(c, prompt, cwd, images, cancel, meter)).strip()
