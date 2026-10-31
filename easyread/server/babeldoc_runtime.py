"""Locate the optional BabelDOC Python environment without installing packages."""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path


def python_path() -> str:
    override = os.environ.get("EASYREAD_BABELDOC_PYTHON")
    if override:
        if Path(override).is_file():
            return override
        raise ValueError("EASYREAD_BABELDOC_PYTHON 指向的 Python 不存在")
    if importlib.util.find_spec("babeldoc"):
        return sys.executable
    command = shutil.which("babeldoc")
    if command:
        parent = Path(command).resolve().parent
        for candidate in (parent / "python.exe", parent / "python"):
            if candidate.is_file():
                return str(candidate)
    tool_dir = os.environ.get("UV_TOOL_DIR")
    uv = shutil.which("uv")
    if not tool_dir and uv:
        try:
            result = subprocess.run([uv, "tool", "dir"], capture_output=True, text=True,
                                    encoding="utf-8", timeout=5,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if result.returncode == 0:
                tool_dir = result.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    if tool_dir:
        root = Path(tool_dir) / "babeldoc"
        for candidate in (root / "Scripts" / "python.exe", root / "bin" / "python"):
            if candidate.is_file():
                return str(candidate)
    raise ValueError("未找到 PDF 生成组件。请按 README 的中文 PDF 说明安装 BabelDOC。")
