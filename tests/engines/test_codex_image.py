import io
import json
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

from easyread.app import i18n
from easyread.engines import codex_image, engines, usage
from tests.engines.test_image_edit import png


class CodexImageTest(unittest.TestCase):
    def setUp(self):
        self.cancel = threading.Event()
        self.proc = Mock()
        self.proc.poll.return_value = 0
        self.root = None

        def popen(args, **kwargs):
            self.args, self.env = args, kwargs["env"]
            self.root = Path(kwargs["cwd"])
            return self.proc

        for replacement in (patch.object(engines, "codex_path", return_value="codex"),
                            # Keep other subprocess users (e.g. macOS locale detection) real.
                            patch.object(codex_image, "subprocess", SimpleNamespace(
                                Popen=Mock(side_effect=popen), PIPE=codex_image.subprocess.PIPE)),
                            patch.object(codex_image.netcheck, "proxy_env", return_value={"OPENAI_API_KEY": "paid-secret", "CODEX_API_KEY": "other-secret", "OPENAI_BASE_URL": "https://paid.example", "PATH": "bin"})):
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_subscription_auth_and_real_image_result(self):
        def communicate(proc, prompt, timeout, cancel):
            self.assertTrue((self.root / "source.png").is_file())
            self.assertIn("built-in image generation", prompt)
            self.assertIn("Do not use API keys", prompt)
            (self.root / "result.png").write_bytes(png())
            return json.dumps({"type": "turn.completed", "usage": {"input_tokens": 40, "output_tokens": 10}})

        meter = usage.Meter("codex")
        with patch.object(engines, "_communicate", side_effect=communicate):
            result = codex_image.edit({"model": "chosen-model"}, png(), "Translate labels", self.cancel, meter)
        self.assertIn('--ignore-user-config', self.args)
        self.assertIn('forced_login_method="chatgpt"', self.args)
        self.assertIn('features.image_generation=true', self.args)
        self.assertNotIn('features.image_generation=false', self.args)
        self.assertNotIn('features.code_mode_host=false', self.args)
        self.assertIn('chosen-model', self.args)
        self.assertEqual(self.env, {"PATH": "bin"})
        self.assertEqual(meter.snapshot()["calls"], 1)
        with Image.open(io.BytesIO(result)) as image:
            self.assertEqual(image.format, "WEBP")
        self.assertFalse(self.root.exists())
        self.proc.wait.assert_called_once()

    def test_no_tool_result_is_an_error_and_is_not_retried(self):
        with patch.object(engines, "_communicate", return_value='{"type":"turn.failed"}') as call:
            with self.assertRaises(engines.EngineError):
                codex_image.edit({}, png(), "translate", self.cancel)
        call.assert_called_once()
        self.assertFalse(self.root.exists())

    def test_no_proxy_override_still_removes_paid_credentials(self):
        # Exercise language detection without relying on the host's preferences/cache.
        i18n.system_lang.cache_clear()
        self.addCleanup(i18n.system_lang.cache_clear)
        with patch.object(i18n, "choice", return_value="auto"), \
                patch.object(codex_image.netcheck, "proxy_env", return_value=None), \
                patch.dict(codex_image.os.environ, {"OPENAI_API_KEY": "paid-secret", "PATH": "test-bin"}, clear=True), \
                patch.object(engines, "_communicate", return_value=""):
            with self.assertRaises(engines.EngineError):
                codex_image.edit({}, png(), "translate", self.cancel)
        self.assertEqual(self.env, {"PATH": "test-bin"})

    def test_cancel_or_timeout_reaps_process_and_cleans_workspace(self):
        for error in (engines.Cancelled(), engines.EngineError("timeout")):
            with self.subTest(error=error):
                self.proc.reset_mock()
                self.proc.poll.return_value = None
                with patch.object(engines, "_communicate", side_effect=error):
                    with self.assertRaises(type(error)):
                        codex_image.edit({}, png(), "translate", self.cancel)
                self.proc.kill.assert_called_once()
                self.proc.wait.assert_called_once()
                self.assertFalse(self.root.exists())

    def test_cancelled_call_never_starts_cli(self):
        self.cancel.set()
        with self.assertRaises(engines.Cancelled):
            codex_image.edit({}, png(), "translate", self.cancel)
        self.assertIsNone(self.root)

    def test_invalid_image_and_symlink_are_not_published(self):
        for symlink in (False, True):
            def communicate(*args):
                if symlink:
                    (self.root / "result.png").symlink_to(self.root / "source.png")
                else:
                    (self.root / "result.png").write_text("not an image")
                return ""
            with self.subTest(symlink=symlink), patch.object(engines, "_communicate", side_effect=communicate):
                with self.assertRaises((engines.EngineError, OSError)):
                    codex_image.edit({}, png(), "translate", self.cancel)
