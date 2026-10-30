"""BabelDOC PDF export jobs using EasyRead's selected translation engine."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from uuid import uuid4

from ..app import config
from ..engines import engines
from ..library.store import now_iso, read_json, write_json_atomic
from . import babeldoc_runtime, pdf_export_files


class BabelDocJobs:
    def __init__(self):
        self.lock = threading.Lock()
        self.running: set[str] = set()

    @staticmethod
    def _folder(ws) -> Path:
        return ws.root / "babeldoc"

    @staticmethod
    def _record(ws) -> Path:
        return BabelDocJobs._folder(ws) / "status.json"

    @staticmethod
    def _pdf_stem(ws) -> str:
        meta = (ws.load("paper") or {}).get("meta") or {}
        title = Path(str(meta.get("source") or ws.source_pdf.name).replace("\\", "/")).stem
        title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", title)
        title = re.sub(r"\s+", " ", title).strip(" .")
        title = title.encode("utf-8")[:180].decode("utf-8", errors="ignore").rstrip(" .")
        if not title:
            raise ValueError("论文标题为空或无法用作文件名")
        return title

    def status(self, ws) -> dict:
        record = read_json(self._record(ws), None)
        if not record:
            return {"state": "idle", "files": []}
        record = dict(record)
        if record.get("state") == "running" and ws.id not in self.running:
            record.update(state="error", message="EasyRead 已重启，任务已中断。请重新开始。", updated=now_iso())
            write_json_atomic(self._record(ws), record)
        return record

    def start(self, ws, model: str = "", output_dir: str = "", regenerate: bool = False) -> dict:
        if not ws.source_pdf or not ws.source_pdf.is_file():
            raise ValueError("找不到这篇论文的原始 PDF")
        destination = pdf_export_files.output_directory(output_dir)
        with self.lock:
            previous = self.status(ws)
            if ws.id in self.running:
                if previous.get("output_dir", "") == str(destination or ""):
                    return previous
                raise ValueError("这篇论文正在生成 PDF，请完成后再选择其他输出目录")
            if (not regenerate and previous.get("state") == "done" and previous.get("target") == "zh"
                    and previous.get("files") and all(self.file(ws, previous["job_id"], name) for name in previous["files"])):
                result = self._save_output(ws, previous, destination)
                write_json_atomic(self._record(ws), result)
                return result
        stem = self._pdf_stem(ws)
        from .jobs import engine_for
        cfg = engine_for(config.load(), model)
        engine = cfg.get("engine")
        if engine not in (*engines.CLI_ENGINES, "openai"):
            raise ValueError("请先在“设置 → 模型”中选择翻译引擎")
        options = cfg.get(engine) or {}
        if engine in engines.CLI_ENGINES and not engines.cli_path(engine, options):
            raise ValueError(f"请先安装并登录 {engines.engine_name(engine)}")
        model = str(options.get("model") or engines.engine_name(engine))
        snapshot = {"engine": engine, engine: options}
        command = babeldoc_runtime.python_path()
        with self.lock:
            if ws.id in self.running:
                raise ValueError("这篇论文已有 BabelDOC 任务在运行")
            job_id = uuid4().hex
            folder = self._folder(ws)
            folder.mkdir(parents=True, exist_ok=True)
            result = {"state": "running", "job_id": job_id, "message": "正在生成中文 PDF…", "target": "zh",
                      "model": model, "files": [], "output_dir": str(destination or ""), "updated": now_iso()}
            write_json_atomic(self._record(ws), result)
            self.running.add(ws.id)
        thread = threading.Thread(target=self._run, args=(ws, command, snapshot, model, job_id, stem, destination), daemon=True)
        thread.start()
        return result

    def _run(self, ws, command: str, cfg: dict, model: str, job_id: str, stem: str, destination: Path | None = None):
        output = self._folder(ws) / job_id
        output.mkdir(parents=True, exist_ok=True)
        api_key = str((cfg.get("openai") or {}).get("api_key") or "")
        def redact(text):
            return text.replace(api_key, "[已隐藏]") if api_key else text
        try:
            runner = Path(__file__).resolve().parents[1] / "translate" / "babeldoc_runner.py"
            proc = subprocess.run([command, "-u", str(runner), "--input", str(ws.source_pdf),
                                   "--output", str(output), "--target", "zh", "--mono-only"],
                                  input=json.dumps(cfg), capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", env=dict(os.environ, PYTHONIOENCODING="utf-8"),
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            mono = [p for p in output.glob("*.mono.pdf") if p.is_file()]
            if proc.returncode != 0 or len(mono) != 1:
                detail = ((proc.stderr or proc.stdout or "BabelDOC 运行失败").strip() if proc.returncode != 0
                          else "未生成中文 PDF")
                detail = redact(detail)
                detail = re.sub(r"(?i)(api[_ -]?key\s*[:=]\s*)\S+", r"\1[已隐藏]", detail)
                raise RuntimeError(detail[-1500:])
            mono_name = f"{stem}-zh.pdf"
            mono[0].rename(output / mono_name)
            files = [mono_name]
            state = {"state": "done", "job_id": job_id, "message": "中文 PDF 已生成", "model": model, "target": "zh",
                     "files": files, "updated": now_iso()}
            state = self._save_output(ws, state, destination)
        except Exception as exc:
            message = redact(str(exc))
            state = {"state": "error", "job_id": job_id, "message": message[-1500:], "model": model,
                     "files": [], "output_dir": str(destination or ""), "updated": now_iso()}
        finally:
            api_key = ""
        with self.lock:
            write_json_atomic(self._record(ws), state)
            self.running.discard(ws.id)

    def _save_output(self, ws, record: dict, destination: Path | None) -> dict:
        result = {**record, "output_dir": str(destination or ""), "saved_files": [], "updated": now_iso()}
        result.pop("save_error", None)
        if destination:
            try:
                for name in record["files"]:
                    source = self._folder(ws) / record["job_id"] / name
                    result["saved_files"].append(str(pdf_export_files.copy_pdf(source, destination)))
            except OSError:
                result["save_error"] = "PDF 已生成，但无法保存到所选目录，请下载保存"
            except ValueError as exc:
                result["save_error"] = str(exc)
        return result

    def file(self, ws, job_id: str, name: str) -> Path | None:
        status = self.status(ws)
        if status.get("state") != "done" or status.get("job_id") != job_id or name not in status.get("files", []):
            return None
        if Path(name).name != name or not name.lower().endswith(".pdf"):
            return None
        path = self._folder(ws) / job_id / name
        return path if path.is_file() else None

    def delete(self, ws) -> dict:
        with self.lock:
            if ws.id in self.running:
                raise ValueError("这篇文献正在生成 PDF，完成后才能删除结果")
            folder = self._folder(ws)
            if folder.exists():
                shutil.rmtree(folder)
        return {"state": "idle", "files": []}
