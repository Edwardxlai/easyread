"""ZCode's official --prompt/--attach protocol, using the existing local login.

Contract: zai-org/ZCode/apps/zcode-cli/docs/usage/02-cli-reference.md.
ZCode has no --model or stdin prompt option. Keep the command short by attaching
the task as UTF-8 text; use a disposable project to disable unrelated extensions
without changing the user's login, provider configuration or project settings.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..app.i18n import tr
from . import netcheck
from .chat_tools import RESEARCH_PROMPT


_RUNTIME_CONFIG = {
    "features": {"mcp": False, "subagent": False, "memory": False, "skill": False},
    "memory": {"use": False}, "plugins": {"enabled": False},
    "skills": {"enabled": False}, "hooks": {"enabled": False},
}
_DISALLOWED = "Bash Write Edit MultiEdit WebSearch WebFetch Agent Task AskUserQuestion EnterPlanMode ExitPlanMode"
_PROMPT = (
    "The attached easyread-task.txt contains the complete task and required output format. "
    "Read it in full and perform that task. If the attachment preview is truncated, use Read "
    "to read the remaining lines before answering. Other attachments are reference images. "
    "Return only the requested answer, without a plan or preamble. Do not modify files, "
    "run commands, search the web, or read unrelated files."
)


def path(c: dict) -> str | None:
    return shutil.which(c.get("command") or "zcode")


def build_args(c: dict, workdir: Path, images: list[Path]) -> list[str]:
    from .engines import EngineError
    # Do not silently pretend to honor options absent from the official parser.
    if any(c.get(key) for key in ("model", "reasoning_effort", "service_tier")):
        raise EngineError(tr("ZCode 跟随自身的模型设置，请在 ZCode 中切换模型和推理选项"))
    if c.get("extra_args"):
        raise EngineError(tr("ZCode 暂不支持额外参数，请清空 zcode.extra_args"))
    prompt = _PROMPT
    disallowed = _DISALLOWED
    if c.get("_chat"):
        prompt = _PROMPT.replace("run commands, search the web, or read unrelated files.", "run commands or read unrelated files.") + RESEARCH_PROMPT
        disallowed = " ".join(tool for tool in _DISALLOWED.split() if tool not in ("WebSearch", "WebFetch"))
    args = ["--prompt", prompt, "--cwd", str(workdir), "--mode", "plan",
            "--disallowed-tools", disallowed, "--workflow-mode", "disabled",
            "--output-format", "json", "--no-color", "--attach", str(workdir / "easyread-task.txt")]
    for img in images:
        args += ["--attach", str(img)]
    return args


def _result(out: str) -> dict:
    try:
        obj = json.loads(out)
        if isinstance(obj, dict):
            return obj
    except (ValueError, TypeError):
        pass
    # Tolerate diagnostic lines and the documented stream-json final result.
    from .engines import _json_lines
    return next((e for e in reversed(_json_lines(out)) if e.get("type") == "result"), {})


def run(c: dict, prompt: str, cwd: Path, images: list[Path], cancel=None, meter=None) -> str:
    from . import engines
    exe = path(c)
    if not exe:
        raise engines.EngineError(tr("找不到 {name} 命令：{cmd}（先装好并登录）", name="ZCode CLI", cmd=c.get("command") or "zcode"))
    env = dict(netcheck.proxy_env() or os.environ)
    # ZCode uses its own proxy variable. Preserve an explicit ZCode setting.
    proxy = env.get("HTTPS_PROXY") or env.get("https_proxy") or env.get("HTTP_PROXY") or env.get("http_proxy")
    if proxy:
        env.setdefault("ZCODE_HTTP_PROXY", proxy)
    images = [(img if img.is_absolute() else cwd / img).resolve() for img in images]
    try:
        with tempfile.TemporaryDirectory(prefix="easyread-zcode-") as folder:
            workdir = Path(folder)
            if c.get("_chat"):
                for name in ("paper.json", "reader.json"):
                    if (cwd / name).is_file():
                        shutil.copyfile(cwd / name, workdir / name)
            args = [exe, *build_args(c, workdir, images)]
            (workdir / "easyread-task.txt").write_text(prompt, encoding="utf-8")
            (workdir / "zcode.json").write_text(json.dumps(_RUNTIME_CONFIG), encoding="utf-8")
            with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as stderr:
                proc = subprocess.Popen(args, cwd=str(workdir), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=stderr, text=True, encoding="utf-8", errors="replace",
                                        creationflags=engines._NO_WINDOW, env=env)
                try:
                    out = engines._communicate(proc, "", int(c.get("timeout") or 1200), cancel)
                except engines.EngineError as exc:
                    stderr.seek(0)
                    detail = stderr.read().strip()
                    raise engines.EngineError(str(exc) + ("\n" + detail[-1000:] if detail else "")) from None
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait()
                stderr.seek(0)
                error_output = stderr.read().strip()
    except OSError as exc:
        raise engines.EngineError(tr("{name} 没有给出结果：{msg}", name="ZCode CLI", msg=str(exc))) from None
    res = _result(out)
    used = res.get("usage")
    if meter is not None and isinstance(used, dict):
        meter.add(input=int(used.get("inputTokens") or 0), cached=int(used.get("cacheReadTokens") or 0),
                  output=int(used.get("outputTokens") or 0))
    answer = res.get("response")
    answer = answer.strip() if isinstance(answer, str) else ""
    projection = res.get("projection")
    status = projection.get("status") if isinstance(projection, dict) else None
    if proc.returncode not in (0, None) or res.get("error") or status in ("error", "failed", "cancelled", "interrupted") or not answer:
        detail = str(res.get("error") or error_output or status or (out or "")[-300:])
        if proc.returncode not in (0, None):
            detail += "\n" + tr("退出码 {code}", code=proc.returncode)
        raise engines.EngineError(tr("{name} 没有给出结果：{msg}", name="ZCode CLI", msg=detail))
    return answer
