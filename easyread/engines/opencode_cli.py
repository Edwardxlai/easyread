"""OpenCode noninteractive adapter: stdin prompt, JSON events, attached images.

Reference: https://opencode.ai/docs/cli/ and /docs/permissions/.
Each call starts a fresh session with all agent tools denied.
"""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..app.i18n import tr
from . import netcheck


def path(c):
    return shutil.which(c.get("command") or "opencode")


def build_args(exe, c, images):
    args = [exe, "run", "--format", "json", "--agent", "easyread-reader"]
    if c.get("model"):
        args += ["--model", c["model"]]
    for image in images:
        args += ["--file", str(Path(image).resolve())]
    return args


def environment():
    env = dict(netcheck.proxy_env() or os.environ)
    env.update(OPENCODE_DISABLE_AUTOUPDATE="true", OPENCODE_DISABLE_CLAUDE_CODE="true",
               OPENCODE_DISABLE_AUTOCOMPACT="true", OPENCODE_DISABLE_DEFAULT_PLUGINS="true",
               OPENCODE_PERMISSION=json.dumps({"*": "deny"}))
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps({
        "autoupdate": False, "share": "disabled", "permission": {"*": "deny"},
        "agent": {"easyread-reader": {"description": "Translate papers and answer reading questions without tools",
                    "mode": "primary", "disable": False, "permission": {"*": "deny"},
                    "prompt": "Answer the supplied question or translation task directly. Do not use tools."}},
    })
    return env


def prepare_runtime(work):
    """Expose the agent to both embedded CLI and persistent-server discovery.

    A reused OpenCode server does not inherit a new client's inline config.
    Keep the normal user provider/login configuration, and add only the private
    reading agent and tool restrictions inside this disposable project.
    """
    env = environment()
    root = Path(work).resolve()
    (root / "opencode.json").write_text(env["OPENCODE_CONFIG_CONTENT"], encoding="utf-8")
    agents = root / ".opencode" / "agents"
    agents.mkdir(parents=True)
    (agents / "easyread-reader.md").write_text(
        "---\ndescription: Translate papers and answer reading questions without tools\n"
        "mode: primary\npermission:\n  '*': deny\n---\n"
        "Answer the supplied question or translation task directly. Do not use tools.\n",
        encoding="utf-8",
    )
    env["PWD"] = str(root)  # New clients prefer PWD to process.cwd().
    return env


def parse(out):
    texts, error, used = {}, "", {"input": 0, "output": 0, "cached": 0}
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        part = ev.get("part") or {}
        if ev.get("type") == "text" and not part.get("synthetic") and not part.get("ignored"):
            texts[part.get("id") or str(len(texts))] = str(part.get("text") or "")
        if ev.get("type") == "error":
            problem = ev.get("error") or {}
            error = str(problem.get("data", {}).get("message") or problem.get("message") or problem) if isinstance(problem, dict) else str(problem)
        if ev.get("type") == "step_finish":
            tokens = part.get("tokens") or {}
            cached = (tokens.get("cache") or {}).get("read") or 0
            used["input"] += int(tokens.get("input") or 0) + int(cached) + int((tokens.get("cache") or {}).get("write") or 0)
            used["cached"] += int(cached)
            used["output"] += int(tokens.get("output") or 0) + int(tokens.get("reasoning") or 0)
    return "\n\n".join(texts.values()).strip(), error, used


def run(c, prompt, cwd, images, cancel=None, meter=None):
    from . import engines
    exe = path(c)
    if not exe:
        raise engines.EngineError(tr("找不到 OpenCode 命令，请先安装并配置模型"))
    # Do not inherit project agents, instructions or worktree access.
    with tempfile.TemporaryDirectory(prefix="easyread-opencode-") as work:
        proc = subprocess.Popen(build_args(exe, c, images), cwd=work, env=prepare_runtime(work),
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace", creationflags=engines._NO_WINDOW)
        out = engines._communicate(proc, prompt, int(c.get("timeout") or 1200), cancel)
    text, error, used = parse(out)
    if error or not text:
        raise engines.EngineError(tr("OpenCode 没有给出结果：{msg}", msg=error or out[-300:]))
    if meter is not None and any(used.values()):
        meter.add(**used)
    return text
