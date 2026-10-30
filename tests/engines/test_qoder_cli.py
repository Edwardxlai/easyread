import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from easyread.app import config
from easyread.chat import chat, chat_models
from easyread.engines import engines, qoder_cli


class QoderCliTest(unittest.TestCase):
    def test_detects_cn_commands_without_switching_to_international_login(self):
        with mock.patch.object(qoder_cli.shutil, "which", side_effect=lambda cmd: "X:/qoderclicn.cmd" if cmd == "qoderclicn" else None) as which:
            self.assertEqual(engines.cli_path("qoder", {}), "X:/qoderclicn.cmd")
            self.assertEqual(which.call_args_list, [mock.call("qodercn"), mock.call("qoderclicn")])
        with mock.patch.object(qoder_cli.shutil, "which", return_value="custom.exe") as which:
            self.assertEqual(qoder_cli.path({"command": "custom"}), "custom.exe")
            which.assert_called_once_with("custom")

    def test_chat_can_research_but_translation_remains_read_only(self):
        for research in (False, True):
            args = qoder_cli.build_args({"_chat": research, "model": "auto"}, [Path("page.png")])
            tools = args[args.index("--tools") + 1].split(",")
            self.assertEqual("WebSearch" in tools, research)
            self.assertEqual("WebFetch" in tools, research)
            self.assertNotIn("Bash", tools)
            self.assertIn("--strict-mcp-config", args)
            self.assertIn(str(Path("page.png").resolve()), args)
        with self.assertRaises(engines.EngineError):
            qoder_cli.build_args({"extra_args": ["--yolo"]}, [])

    def invoke(self, response, code=0):
        with tempfile.TemporaryDirectory() as source:
            root = Path(source)
            (root / "paper.json").write_text('{"blocks":[]}', encoding="utf-8")
            proc = SimpleNamespace(returncode=code, poll=lambda: code, wait=lambda: code)
            seen = []

            def popen(args, cwd):
                self.assertEqual((cwd / "paper.json").read_text(encoding="utf-8"), '{"blocks":[]}')
                self.assertNotEqual(cwd, root)
                seen.append(cwd)
                return proc

            prompt = "question " * 10000
            with mock.patch.object(qoder_cli, "path", return_value="qodercn"), \
                    mock.patch.object(engines, "_popen", side_effect=popen), \
                    mock.patch.object(engines, "_communicate", return_value=response) as communicate:
                try:
                    value = qoder_cli.run({"_chat": True}, prompt, root, [])
                    communicate.assert_called_once_with(proc, prompt, 1200, None)
                    return value
                finally:
                    self.assertTrue(seen)
                    self.assertFalse(seen[0].exists())

    def test_json_and_stream_output(self):
        value = {"type": "result", "subtype": "success", "result": "answer"}
        self.assertEqual(self.invoke(json.dumps(value, indent=2)), "answer")
        self.assertEqual(self.invoke('diagnostic\n' + json.dumps(value)), "answer")

    def test_cli_failure_is_not_returned_as_answer(self):
        with self.assertRaisesRegex(engines.EngineError, "login required"):
            self.invoke(json.dumps({"type": "result", "is_error": True, "result": "login required"}), 1)

    def test_model_registration_and_chat_do_not_mutate_saved_config(self):
        items = chat_models.sanitize([{"id": "qc", "name": "Qoder", "engine": "qoder", "model": "auto"}])
        cfg = config.DEFAULTS | {"chat": {"models": items, "default": "qc"}}
        ecfg, _ = chat_models.engine_cfg(cfg, "qc")
        self.assertEqual(engines.image_mode(ecfg), "attached")
        with mock.patch.object(qoder_cli, "run", return_value="answer") as run, \
                mock.patch.object(engines.netcheck, "problem", return_value=None):
            self.assertEqual(engines.run(ecfg, "translation", Path.cwd()), "answer")
            self.assertFalse(run.call_args.args[0].get("_chat", False))
            self.assertEqual(list(chat.stream(ecfg, "question", Path.cwd(), threading.Event())), ["answer"])
            self.assertTrue(run.call_args.args[0]["_chat"])
        self.assertNotIn("_chat", ecfg["qoder"])
