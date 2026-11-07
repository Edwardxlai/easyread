"""Code listings returned by a model must not discard a whole translation batch."""
import copy
import json
import shutil
import threading
import unittest
from unittest import mock

from easyread.library import checks, paperdata
from easyread.translate import codeblocks, sentences, terms, translate
from tests.translate.test_translate import make_ws


class CodeBlockTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(2)
        self.cfg = {"engine": "openai", "openai": {"vision": False}}

    def test_recover_sql_only_when_pdf_lines_confirm_the_separators(self):
        raw = "use master\ngo\n  select @@version\ngo"
        extract = self.ws.root / "extract"
        (extract / "page-001.txt").write_text(raw, encoding="utf-8")
        b = {"type": "para", "page": 1, "en": "use master||go||select @@version||go",
             "zh": "use master‖go‖select @@version‖go"}
        ambiguous = dict(b, en="use master||go||select a||b||go")
        codeblocks.restore_sql_lines([b, ambiguous], extract)
        self.assertTrue(codeblocks.has_fence(b["en"]))
        self.assertIn(raw, b["zh"])
        self.assertFalse(codeblocks.has_fence(ambiguous["en"]))

    def tearDown(self):
        shutil.rmtree(self.ws.root)

    def test_model_code_variants_save_both_pages_without_repair(self):
        code = 'def run(self, task):\n    return "$HOME", "<script>", "‖", "\\frac"'
        for kind in ("code", "listing"):
            for payload in ({"en": code}, {"code": code}, {"lines": code.split("\n")}):
                with self.subTest(kind=kind, payload=payload):
                    data = {"blocks": [
                        {"id": "p1-1", "type": "para", "page": 1, "en": "Text.", "zh": "正文。"},
                        {"id": "listing1", "type": kind, "page": 2, "lang": "python",
                         "caption_en": "Listing 1: Agent loop.", "caption_zh": "代码 1：代理循环。", **payload},
                    ]}
                    with mock.patch.object(translate.engines, "run", return_value=json.dumps(data)) as run, \
                            mock.patch.object(translate.pdfwork, "locate"):
                        translate._one_batch(self.ws, self.cfg, [1, 2], 2, threading.Event(), lambda *a: None)
                    self.assertEqual(run.call_count, 1)
                    paper = self.ws.load("paper")
                    self.assertEqual(paper["translation"]["done_pages"], [1, 2])
                    block = paper["blocks"][1]
                    self.assertEqual(block["type"], "para")
                    self.assertIn(code, block["en"])
                    self.assertIn(code, block["zh"])
                    self.assertIn("Listing 1: Agent loop.", block["en"])
                    self.assertIn("代码 1：代理循环。", block["zh"])
                    self.assertNotIn("sents", block)
                    self.assertEqual(checks.block_problems([block]), ([], []))

    def test_direct_merge_preserves_code_and_is_idempotent(self):
        code = 'print("```", "`x`", "A. ‖ B.")\n    next_step()'
        data = {"blocks": [{"id": "listing1", "type": "listing", "page": 1, "code": code}]}
        paperdata.merge_blocks(self.ws, data, done=[1], en_only=True)
        first = self.ws.load("paper")["blocks"][0]
        self.assertEqual(first["type"], "para")
        self.assertIn(code, first["en"])
        self.assertFalse(first.get("zh"))
        paperdata.merge_blocks(self.ws, {"blocks": [copy.deepcopy(first)]}, done=[1], en_only=True)
        self.assertEqual(self.ws.load("paper")["blocks"][0], first)

    def test_missing_code_and_unrelated_unknown_types_still_fail(self):
        for block in ({"type": "code"}, {"type": "listing", "lines": [{"bad": True}]}, {"type": "video", "en": "x"}):
            with self.subTest(block=block), self.assertRaises(ValueError):
                paperdata.merge_blocks(self.ws, {"blocks": [{"id": "bad", "page": 1, **block}]}, done=[1])
        self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [])

    def test_fenced_code_is_not_math_or_a_sentence_boundary(self):
        text = '```python\nprint("$HOME", "$invalid{", "A. ‖ B.")\n```'
        block = {"id": "p1", "type": "para", "en": text, "zh": text}
        self.assertEqual(checks.block_problems([block]), ([], []))
        sentences.attach([block])
        self.assertEqual(block["en"], text)
        self.assertEqual(block["zh"], text)
        self.assertNotIn("sents", block)
        self.assertEqual(sentences.split_en(text), [])
        problems, _ = checks.block_problems([{**block, "zh": text + "\nCaption $unclosed"}])
        self.assertTrue(problems, "prose outside the code still needs validation")

    def test_glossary_does_not_rewrite_code_literals(self):
        text = '```\nprint("偏差", "bias")\n```'
        data = {"glossary": [{"en": "bias", "zh": "偏差"}],
                "blocks": [{"id": "p1", "type": "para", "en": text, "zh": text}]}
        terms.unify([{"en": "bias", "zh": "偏倚"}], data)
        self.assertEqual(data["blocks"][0]["zh"], text)


if __name__ == "__main__":
    unittest.main()
