"""Exercise the real HTTP route with an isolated paper and a fake model."""
from contextlib import nullcontext
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from easyread.engines.engines import EngineError
from easyread.library.store import Workspace, write_json_atomic
from easyread.server.server import Handler
from easyread.translate.selection import _translate_cached


class SelectionTranslateTest(unittest.TestCase):
    def setUp(self):
        _translate_cached.cache_clear()
        self.addCleanup(_translate_cached.cache_clear)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.paper = {"blocks": [{"id": "p1", "en": "We attend to the relevant tokens.", "zh": "已有译文"}]}
        write_json_atomic(self.root / "paper.json", self.paper)
        ws = Workspace(self.root)
        app = SimpleNamespace(token="test-token", lib=SimpleNamespace(ws=lambda pid: ws if pid == "paper" else None),
                              location=SimpleNamespace(request=lambda *args: nullcontext(), status="idle"))
        handler = type("TranslationHandler", (Handler,), {"app": app, "log_message": lambda *args: None})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}/api/p/paper/translate-selection"
        self.cfg = {"engine": "codex", "codex": {"model": "test-model"}}
        cfg_patch = patch("easyread.translate.selection.config.load", side_effect=lambda: self.cfg)
        cfg_patch.start()
        self.addCleanup(cfg_patch.stop)
        model_patch = patch("easyread.translate.selection.chat.stream", return_value=iter(["关注", "；注意到"]))
        self.model = model_patch.start()
        self.addCleanup(model_patch.stop)

    def request(self, body, token="test-token"):
        req = urllib.request.Request(self.url, json.dumps(body).encode(),
                                     {"X-Token": token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req) as response:
            return json.load(response)

    def test_translation_preserves_selection_context_and_does_not_write(self):
        self.assertEqual(self.request({"text": "attend to", "anchor": "p1"}), {"translation": "关注；注意到"})
        args = self.model.call_args.args
        source = json.loads(args[1].split("instructions to follow:\n", 1)[1])
        self.assertEqual(source, {"selected_text": "attend to", "paragraph": self.paper["blocks"][0]["en"]})
        self.assertEqual(args[0], self.cfg)
        self.assertEqual(args[2], self.root)
        self.assertEqual(json.loads((self.root / "paper.json").read_text(encoding="utf-8")), self.paper)
        self.assertEqual({p.name for p in self.root.iterdir()}, {"paper.json"})

    def test_cached_answer_includes_phonetics_without_another_model_call(self):
        self.model.return_value = iter(["音标（美式）：/əˈtɛnd tə/\n关注；注意到"])
        body = {"text": "attend to", "anchor": "p1"}
        first = self.request(body)
        self.assertIn("/əˈtɛnd tə/", first["translation"])
        self.assertEqual(self.request(body), first)
        self.model.assert_called_once()

    def test_context_and_model_configuration_changes_invalidate_cache(self):
        self.model.side_effect = lambda *args: iter(["译文"])
        body = {"text": "attend to", "anchor": "p1"}
        self.request(body)
        self.paper["blocks"][0]["en"] = "Please attend to the patient."
        write_json_atomic(self.root / "paper.json", self.paper)
        self.request(body)
        self.cfg["codex"]["model"] = "another-model"
        self.request(body)
        self.assertEqual(self.model.call_count, 3)

    def test_lru_evicts_least_recently_used_instead_of_most_recently_read(self):
        self.model.side_effect = lambda *args: iter(["译文"])
        for n in range(128):
            self.request({"text": f"word {n}"})
        self.request({"text": "word 0"})  # Refresh its recency before filling the cache.
        self.request({"text": "word 128"})
        self.assertEqual(self.model.call_count, 129)
        self.request({"text": "word 0"})
        self.assertEqual(self.model.call_count, 129)
        self.request({"text": "word 1"})
        self.assertEqual(self.model.call_count, 130)
        self.assertEqual(_translate_cached.cache_info().currsize, 128)

    def test_invalid_selection_and_cross_site_requests_never_call_model(self):
        for text in (None, [], " ", "a" * 12001):
            with self.subTest(text_type=type(text)), self.assertRaises(urllib.error.HTTPError) as error:
                self.request({"text": text})
            self.assertEqual(error.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request({"text": "word"}, token="wrong")
        self.assertEqual(error.exception.code, 403)
        self.model.assert_not_called()

    def test_error_and_empty_answer_can_be_retried(self):
        for failure in (EngineError("provider unavailable"), None):
            self.model.side_effect = failure
            self.model.return_value = iter([])
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request({"text": "word"})
            self.assertEqual(error.exception.code, 500)
        self.model.side_effect = None
        self.model.return_value = iter(["词"])
        self.assertEqual(self.request({"text": "word"}), {"translation": "词"})

    def test_long_multiline_selection_is_not_silently_truncated(self):
        text = "A full sentence.\n" * 300
        self.request({"text": text, "anchor": "missing"})
        source = json.loads(self.model.call_args.args[1].split("instructions to follow:\n", 1)[1])
        self.assertEqual(source["selected_text"], text.strip())
        self.assertEqual(source["paragraph"], "")
