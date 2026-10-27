"""BabelDOC PDF export jobs using EasyRead's configured translation API."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from ..app import config
from ..library.store import now_iso, read_json, write_json_atomic


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
        title = str(meta.get("title_en") or meta.get("title_zh") or
                    Path(str(meta.get("source") or ws.source_pdf.name)).stem)
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

    def start(self, ws) -> dict:
        if not ws.source_pdf or not ws.source_pdf.is_file():
            raise ValueError("找不到这篇论文的原始 PDF")
        stem = self._pdf_stem(ws)
        cfg = config.load()
        if cfg.get("engine") != "openai":
            raise ValueError("排版翻译需要 API 模型。请在“设置 → 模型”中将翻译引擎设为 API。")
        api = cfg.get("openai") or {}
        if api.get("api") != "chat":
            raise ValueError("BabelDOC 目前只支持 Chat Completions。请在“设置 → 模型”中切换接口格式。")
        base_url = str(api.get("base_url") or "").strip().rstrip("/")
        model = str(api.get("model") or "").strip()
        api_key = str(api.get("api_key") or "").strip()
        parsed = urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("请先在“设置 → 模型”中填写有效的 API 地址。")
        if not model or not api_key:
            raise ValueError("请先在“设置 → 模型”中配置模型名称和 API Key。")
        if len(base_url) > 2048 or len(model) > 200 or len(api_key) > 4096:
            raise ValueError("模型配置过长")
        command = shutil.which("babeldoc")
        if not command:
            raise ValueError("未安装 BabelDOC 命令。请按 README 的排版翻译说明安装。")
        with self.lock:
            if ws.id in self.running:
                raise ValueError("这篇论文已有 BabelDOC 任务在运行")
            job_id = uuid4().hex
            folder = self._folder(ws)
            folder.mkdir(parents=True, exist_ok=True)
            result = {"state": "running", "job_id": job_id, "message": "正在生成双语版和纯译文版 PDF…",
                      "model": model, "files": [], "updated": now_iso()}
            write_json_atomic(self._record(ws), result)
            self.running.add(ws.id)
        thread = threading.Thread(target=self._run, args=(ws, command, base_url, model, api_key, job_id, stem), daemon=True)
        thread.start()
        return result

    def _run(self, ws, command: str, base_url: str, model: str, api_key: str, job_id: str, stem: str):
        output = self._folder(ws) / job_id
        output.mkdir(parents=True, exist_ok=True)
        try:
            # Keep the key out of command-line arguments, process listings, EasyRead config and logs.
            with tempfile.TemporaryDirectory(prefix="easyread-babeldoc-") as temporary:
                path = Path(temporary) / "config.toml"
                path.write_text("[babeldoc]\nopenai = true\nopenai-model = " + json.dumps(model, ensure_ascii=False) +
                                "\nopenai-base-url = " + json.dumps(base_url, ensure_ascii=False) +
                                "\nopenai-api-key = " + json.dumps(api_key, ensure_ascii=False) + "\n", encoding="utf-8")
                os.chmod(path, 0o600)
                proc = subprocess.run([command, "--config", str(path), "--files", str(ws.source_pdf),
                                       "--output", str(output), "--watermark-output-mode", "no_watermark"],
                                      capture_output=True, text=True, errors="replace")
            dual = [p for p in output.glob("*.dual.pdf") if p.is_file()]
            mono = [p for p in output.glob("*.mono.pdf") if p.is_file()]
            if proc.returncode != 0 or len(dual) != 1 or len(mono) != 1:
                detail = ((proc.stderr or proc.stdout or "BabelDOC 运行失败").strip() if proc.returncode != 0
                          else "BabelDOC 未同时生成双语版和纯译文版 PDF")
                detail = detail.replace(api_key, "[已隐藏]")
                detail = re.sub(r"(?i)(api[_ -]?key\s*[:=]\s*)\S+", r"\1[已隐藏]", detail)
                raise RuntimeError(detail[-1500:])
            dual_name = f"{stem} - 对照版.pdf"
            mono_name = f"{stem} - 纯译文版.pdf"
            dual[0].rename(output / dual_name)
            mono[0].rename(output / mono_name)
            files = [dual_name, mono_name]
            state = {"state": "done", "job_id": job_id, "message": "双语版和纯译文版 PDF 已生成", "model": model,
                     "files": files, "updated": now_iso()}
        except Exception as exc:
            message = str(exc).replace(api_key, "[已隐藏]")
            state = {"state": "error", "job_id": job_id, "message": message[-1500:], "model": model,
                     "files": [], "updated": now_iso()}
        finally:
            api_key = ""
        with self.lock:
            write_json_atomic(self._record(ws), state)
            self.running.discard(ws.id)

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
