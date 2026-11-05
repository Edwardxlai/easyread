import io
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from easyread.engines import api_diagnostics, openai_api
from easyread.translate import translate
from tests.engines.test_api_stream_errors import sse
from tests.translate.test_translate import make_ws


class DiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {"EASYREAD_API_DIAGNOSTICS": self.temp.name})
        env.start()
        self.addCleanup(env.stop)
        self.options = {"base_url": "https://example.invalid/v1", "model": "fake", "api_key": "secret-key"}

    def records(self):
        return [[json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
                for path in sorted(Path(self.temp.name).glob("api-*.jsonl"))]

    def test_done_only_retries_are_saved_separately_and_redacted(self):
        event = {"choices": [{"delta": {"content": "partial secret-key"}}]}
        with patch.object(openai_api.http, "urlopen", side_effect=lambda *a, **kw: sse([event], done=True)), \
                patch.object(openai_api, "_sleep"), self.assertRaises(openai_api.StreamInterrupted):
            openai_api.complete(self.options, "request body must not be logged", [])
        attempts = self.records()
        self.assertEqual(len(attempts), 2)
        for rows in attempts:
            self.assertTrue(rows[-1]["done_marker"])
            self.assertEqual(rows[-1]["error_type"], "StreamInterrupted")
            self.assertNotIn("secret-key", json.dumps(rows))
            self.assertNotIn("request body must not be logged", json.dumps(rows))

    def test_success_records_request_id_finish_reason_and_usage(self):
        response = sse([{"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}],
                         "usage": {"prompt_tokens": 10, "completion_tokens": 2}}], done=True)
        response.status = 200
        response.headers = {"Content-Type": "text/event-stream", "x-request-id": "request-1",
                            "Set-Cookie": "must-not-log"}
        with patch.object(openai_api.http, "urlopen", return_value=response):
            self.assertEqual(openai_api.complete(self.options, "q", []), "ok")
        rows = self.records()[0]
        self.assertEqual(rows[0]["http_status"], 200)
        self.assertEqual(rows[0]["request_ids"], {"x-request-id": "request-1"})
        self.assertEqual(rows[-1]["metadata"]["finish_reason"], "stop")
        self.assertEqual(rows[-1]["metadata"]["usage"]["completion_tokens"], 2)
        self.assertNotIn("must-not-log", json.dumps(rows))

    def test_responses_safety_details_survive_error(self):
        event = {"type": "response.incomplete", "response": {"status": "incomplete",
                 "incomplete_details": {"reason": "content_filter"}, "refusal": "policy",
                 "safetyRatings": [{"blocked": True}], "finishMessage": "blocked"}}
        with patch.object(openai_api.http, "urlopen", return_value=sse([event])), \
                self.assertRaises(openai_api.EngineError):
            openai_api.complete({**self.options, "api": "responses"}, "q", [])
        meta = self.records()[0][-1]["metadata"]
        self.assertEqual(meta["terminal_event"], "response.incomplete")
        self.assertEqual(meta["refusal"], "policy")
        self.assertEqual(meta["safetyRatings"], [{"blocked": True}])

    def test_http_failure_has_own_record(self):
        error = urllib.error.HTTPError("https://example.invalid", 401, "Unauthorized",
                                       {"x-request-id": "denied"}, io.BytesIO(b"bad key"))
        with patch.object(openai_api.http, "urlopen", side_effect=error), self.assertRaises(openai_api.EngineError):
            openai_api.complete(self.options, "q", [])
        rows = self.records()[0]
        self.assertEqual(rows[0]["http_status"], 401)
        self.assertEqual(rows[-1]["error_type"], "HTTPError")

    def test_disabled_or_unwritable_diagnostics_do_not_change_response(self):
        response = sse([])
        with patch.dict(os.environ, {"EASYREAD_API_DIAGNOSTICS": ""}):
            self.assertIs(api_diagnostics.capture(response, self.options), response)
        with patch.object(Path, "mkdir", side_effect=OSError("read-only")):
            self.assertIs(api_diagnostics.capture(response, self.options), response)
        self.assertEqual(self.records(), [])
        response.close()

    def test_failed_translation_attempts_do_not_overwrite(self):
        ws = make_ws(1)
        self.addCleanup(shutil.rmtree, ws.root)
        cfg = {"engine": "openai", "openai": {"vision": False}}
        with patch.object(translate.engines, "run", side_effect=['{"blocks": "first', '{"blocks": "second']):
            for _ in range(2):
                with self.assertRaises(openai_api.EngineError):
                    translate._one_batch(ws, cfg, [1], 1, threading.Event(), lambda *a: None)
        saved = list((ws.root / "extract").glob("failed-001-*.txt"))
        self.assertEqual({p.read_text(encoding="utf-8") for p in saved},
                         {'{"blocks": "first', '{"blocks": "second'})
