"""Build the Python service used by the packaged Electron application."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "backend"
WORK = ROOT / "build" / "pyinstaller"


def python_with_pyinstaller() -> list[str]:
    candidates: list[str] = []
    configured = os.environ.get("PYTHON")
    if configured:
        candidates.append(configured)
    venv = ROOT / (".venv\\Scripts\\python.exe" if os.name == "nt" else ".venv/bin/python")
    if venv.exists():
        candidates.append(str(venv))
    candidates.append(sys.executable)
    for candidate in candidates:
        probe = subprocess.run([candidate, "-c", "import PyInstaller"], cwd=ROOT, capture_output=True)
        if probe.returncode == 0:
            return [candidate]
    raise SystemExit("未找到 PyInstaller。请运行：python -m pip install pyinstaller")


def check_dependencies(python: list[str]) -> None:
    required = ["pypdfium2", "pdfplumber", "PIL", "pypdf"]
    for mod in required:
        probe = subprocess.run(python + ["-c", f"import {mod}"], cwd=ROOT, capture_output=True)
        if probe.returncode != 0:
            raise SystemExit(f"缺少后端依赖 '{mod}'。请在打包前运行：python -m pip install -e .")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台默认不是 UTF-8，下面的中文提示会让脚本崩掉
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    for old in OUT.iterdir():
        if old.is_file() or old.is_symlink():
            old.unlink()
        elif old.is_dir():
            shutil.rmtree(old)
    python = python_with_pyinstaller()
    check_dependencies(python)
    cmd = python + ["-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
                    "--name", "easyread-backend", "--distpath", str(OUT),
                    "--workpath", str(WORK), "--specpath", str(WORK),
                    "--collect-all", "easyread",
                    "--collect-all", "pypdfium2",
                    "--collect-all", "pypdfium2_raw",
                    "--collect-all", "pdfplumber",
                    "--collect-all", "PIL",
                    "--collect-all", "pypdf",
                    str(ROOT / "scripts" / "backend_entry.py")]
    subprocess.run(cmd, cwd=ROOT, check=True)
    print(f"后端已生成：{OUT / ('easyread-backend.exe' if os.name == 'nt' else 'easyread-backend')}")


if __name__ == "__main__":
    main()
