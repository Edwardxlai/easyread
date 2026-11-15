"""A provider's length limit is distinct from malformed JSON or a dropped connection."""
import json
import shutil
import threading
import unittest
from unittest.mock import patch

from easyread.engines import openai_api
from easyread.translate import translate
from tests.translate.test_translate import make_ws


class SinglePageOutputLimitTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(1)
        self.addCleanup(shutil.rmtree, self.ws.root)
        self.cfg = {"engine": "openai", "openai": {"model": "local-test", "vision": False}, "batch_pages": 1}
        self.original = {"blocks": [{"id": "p1", "page": 1, "type": "para", "en": "A short sentence."}]}

    def run_page(self, *outputs):
        responses = iter(outputs)

        def read(*args):
            data = next(responses)
            choice = {"message": {"content": json.dumps(data) if data else "partial"},
                      "finish_reason": "stop" if data else "length"}
            return openai_api._chat_text({"choices": [choice]}), {}

        with patch.object(translate.netcheck, "problem", return_value=None), patch.object(openai_api, "_read", read):
            return translate.translate_pages(self.ws, self.cfg, [1], threading.Event(), lambda *args: None)

    def test_split_response_when_bilingual_page_hits_limit(self):
        self.assertFalse(self.run_page(None, self.original, {"zh": {"p1": "短句。"}}))
        paper = self.ws.load("paper")
        self.assertEqual(paper["blocks"][0]["zh"], "短句。")
        self.assertEqual(paper["translation"]["en_pages"], [])

    def test_failed_fill_can_resume_and_failed_retranslation_preserves_text(self):
        self.assertIn(1, self.run_page(None, self.original, None))
        self.assertEqual(self.ws.load("paper")["translation"]["en_pages"], [1])
        self.assertFalse(self.run_page({"zh": {"p1": "短句。"}}))
        before = self.ws.load("paper")["blocks"]
        self.assertIn(1, self.run_page(None))
        self.assertEqual(self.ws.load("paper")["blocks"], before)
