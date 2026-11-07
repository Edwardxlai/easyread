import json
import tempfile
import unittest
from pathlib import Path

from easyread.chat import chat
from easyread.library import paperdata
from easyread.library.store import Workspace, write_json_atomic
from easyread.translate import prompts, terms


class GlossaryTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ws = Workspace(Path(tmp.name))
        self.path = self.ws.root / "paper.json"
        self.keep = {"en": "mean", "zh": "均值", "note": "reviewed"}
        self.block = {"id": "p1", "type": "para", "page": 1, "en": "Hello.", "zh": "你好。"}
        write_json_atomic(self.path, {"glossary": [self.keep, {"en": "bias"}], "blocks": [self.block]})

    def test_existing_paper_can_resume_retranslate_and_chat(self):
        before = self.path.read_bytes()
        for prompt in (prompts.translate(self.ws, [2], "openai", ""),
                       prompts.retranslate(self.ws, "p1", "")[0], chat._context(self.ws, None, "")):
            self.assertIn("mean = 均值", prompt)
            self.assertNotIn("bias =", prompt)
        self.assertEqual(self.path.read_bytes(), before)

    def test_merge_keeps_valid_terms_and_accepts_correction(self):
        corrected = {"en": "bias", "zh": "偏差"}
        batch = [None, "stray", {"en": "bias"}, {"zh": "缺词"}, {"en": " ", "zh": "空"},
                 {"en": "missing", "zh": " "}, {"en": "number", "zh": 5}, corrected,
                 {"en": "mean", "zh": "平均"}, {"en": "bias", "zh": "偏移"}]
        paperdata.merge_blocks(self.ws, {"glossary": batch}, done=[1])
        paper = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(paper["glossary"], [self.keep, corrected])
        self.assertEqual(paper["translation"]["done_pages"], [1])
        self.assertEqual(paper["blocks"], [self.block])

    def test_fill_keeps_translation_with_malformed_glossary(self):
        term = {"en": "hello", "zh": "您好"}
        for glossary, expected in ((42, [self.keep]), ([{"en": "oops"}, term], [self.keep, term])):
            with self.subTest(glossary=glossary):
                data = {"zh": {"p1": "您好。"}, "glossary": glossary}
                terms.unify(self.ws.load("paper")["glossary"], data)
                self.assertEqual(paperdata.fill_zh(self.ws, data, [1], {"p1"}), [])
                paper = json.loads(self.path.read_text(encoding="utf-8"))
                self.assertEqual(paper["glossary"], expected)
                self.assertEqual(paper["blocks"][0]["zh"], "您好。")
