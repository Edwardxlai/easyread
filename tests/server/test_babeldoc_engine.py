import tempfile
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from easyread.server import babeldoc_api, pdf_export_files


class BabelDocEngineTest(unittest.TestCase):
    def test_export_uses_original_filename_and_only_produces_chinese_pdf(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.pdf"
            source.write_bytes(b"%PDF-1.7")
            ws = SimpleNamespace(root=root, id="paper", source_pdf=source,
                                 load=lambda _: {"meta": {"source": "\u8bba\u65871.pdf", "title_en": "Different title", "target": "ja"}})
            jobs = babeldoc_api.BabelDocJobs()
            stem = jobs._pdf_stem(ws)
            self.assertEqual(stem, "\u8bba\u65871")
            destination = root / "chosen-folder"
            destination.mkdir()
            def generate(command, **kwargs):
                self.assertEqual(command[command.index("--target") + 1], "zh")
                self.assertIn("--mono-only", command)
                output = Path(command[command.index("--output") + 1])
                (output / "source.zh.mono.pdf").write_bytes(b"%PDF-translated")
                return subprocess.CompletedProcess(command, 0, "", "")
            with patch.object(babeldoc_api.subprocess, "run", side_effect=generate):
                jobs._run(ws, "babel-python", {"engine": "codex", "codex": {}}, "model", "job1", stem, destination)
            status = jobs.status(ws)
            self.assertEqual(status["state"], "done")
            self.assertEqual(status["files"], ["\u8bba\u65871-zh.pdf"])
            self.assertEqual(status["target"], "zh")
            self.assertEqual(jobs.file(ws, "job1", status["files"][0]).read_bytes(), b"%PDF-translated")
            self.assertIsNone(jobs.file(ws, "job1", "../source.pdf"))
            self.assertEqual(source.read_bytes(), b"%PDF-1.7")
            saved = Path(status["saved_files"][0])
            self.assertEqual(saved, destination / "\u8bba\u65871-zh.pdf")
            self.assertEqual(saved.read_bytes(), b"%PDF-translated")
            saved.write_bytes(b"keep existing file")
            with patch.object(babeldoc_api.threading, "Thread") as thread:
                copied = jobs.start(ws, output_dir=str(destination))
            thread.assert_not_called()
            self.assertEqual(saved.read_bytes(), b"keep existing file")
            self.assertEqual(Path(copied["saved_files"][0]).name, "\u8bba\u65871-zh (2).pdf")
            self.assertEqual(Path(copied["saved_files"][0]).read_bytes(), b"%PDF-translated")

    def test_output_directory_must_exist_before_starting_translation(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                pdf_export_files.output_directory(str(Path(folder) / "missing"))
            with self.assertRaises(ValueError):
                pdf_export_files.output_directory("relative-path")

    def test_save_failure_preserves_generated_pdf_for_download(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            ws = SimpleNamespace(root=root, id="paper")
            jobs = babeldoc_api.BabelDocJobs()
            output = root / "babeldoc" / "job1"
            output.mkdir(parents=True)
            pdf = output / "paper-zh.pdf"
            pdf.write_bytes(b"translated")
            record = {"state": "done", "job_id": "job1", "files": [pdf.name]}
            with patch.object(pdf_export_files, "copy_pdf", side_effect=PermissionError):
                result = jobs._save_output(ws, record, root)
            self.assertEqual(result["state"], "done")
            self.assertIn("save_error", result)
            self.assertEqual(result["files"], [pdf.name])
            self.assertEqual(pdf.read_bytes(), b"translated")

    def test_codex_export_uses_selected_engine_without_requiring_or_copying_api_key(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.pdf"
            source.write_bytes(b"%PDF-1.7")
            ws = SimpleNamespace(root=root, id="paper", source_pdf=source,
                                 load=lambda _: {"meta": {"title_en": "Paper"}})
            cfg = {"engine": "codex", "codex": {"model": "selected-model"},
                   "openai": {"api_key": "unused-secret"}}
            with patch.object(babeldoc_api.config, "load", return_value=cfg), \
                    patch.object(babeldoc_api.engines, "cli_path", return_value="codex"), \
                    patch.object(babeldoc_api.babeldoc_runtime, "python_path", return_value="babel-python"), \
                    patch.object(babeldoc_api.threading, "Thread") as thread:
                result = babeldoc_api.BabelDocJobs().start(ws)
            self.assertEqual(result["state"], "running")
            args = thread.call_args.kwargs["args"]
            self.assertEqual(args[1], "babel-python")
            self.assertEqual(args[2], {"engine": "codex", "codex": {"model": "selected-model"}})
            self.assertNotIn("unused-secret", str(args))
            thread.return_value.start.assert_called_once()
