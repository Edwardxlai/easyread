"""Missing math delimiters must reach the existing model-repair pass."""
import copy
import json
import shutil
import threading
import unittest
from unittest import mock

from easyread.library import checks
from easyread.translate import translate
from tests.translate.test_translate import make_ws


class MathDelimiterTest(unittest.TestCase):
    def test_bare_tex_is_reported_in_every_rendered_field(self):
        for text in (r"取 \alpha = \frac{1}{n}。", r"参数x_{i}。", r"误差\sigma。"):
            for fields in ({"en": text}, {"zh": text}, {"caption_en": text},
                           {"caption_zh": text}, {"image_en": text}, {"image_zh": text},
                           {"items": [{"en": text, "zh": text}]},
                           {"head": [[text]], "rows": [[text]]}):
                with self.subTest(text=text, fields=fields):
                    problems, _ = checks.block_problems([{"id": "p1", "type": "para", **fields}])
                    self.assertTrue(any("p1" in p and "$TeX$" in p for p in problems), problems)

    def test_valid_math_code_and_literal_text_are_not_flagged(self):
        for text in (r"取 $\alpha = \frac{1}{n}$。", r"取 \(\alpha\)。",
                     r"$$\frac{1}{n}$$", r"\[\frac{1}{n}\]",
                     r"`\alpha` 与 `x_{i}`", '```tex\n\\frac{1}{n}\n```',
                     r"价格 \$5 和 \$10。", r"C:\alpha\file.txt, file_name.txt, https://x.test/a_b",
                     "模型 BERT_base 的准确率为 95%。"):
            with self.subTest(text=text):
                problems, _ = checks.block_problems([{"id": "p1", "type": "para", "zh": text}])
                self.assertEqual(problems, [])

    def test_bare_tex_next_to_valid_math_is_still_reported(self):
        problems, tex = checks.block_problems([
            {"id": "p1", "type": "para", "zh": r"$x$ 的误差为 \sigma。"}])
        self.assertTrue(problems)
        self.assertIn(("p1", "x", False), tex)

    def test_all_renderer_delimiters_reach_katex_validation(self):
        for left, right, display in (("$", "$", False), (r"\(", r"\)", False),
                                     ("$$", "$$", True), (r"\[", r"\]", True)):
            with self.subTest(left=left):
                problems, tex = checks.block_problems([
                    {"id": "p1", "type": "para", "zh": left + r"\frac{1}{n}" + right}])
                self.assertEqual(problems, [])
                self.assertEqual(tex, [("p1", r"\frac{1}{n}", display)])


class MathRepairTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(1)
        self.cfg = {"engine": "openai", "openai": {"vision": False}}

    def tearDown(self):
        shutil.rmtree(self.ws.root)

    def test_translation_and_read_mode_repair_before_saving(self):
        for read in (False, True):
            with self.subTest(read=read):
                original = {"blocks": [{"id": "p1", "type": "para", "page": 1,
                                        "en": r"Let \alpha = \frac{1}{n}.",
                                        **({} if read else {"zh": r"令 \alpha = \frac{1}{n}。"})}]}
                fixed = copy.deepcopy(original)
                fixed["blocks"][0]["en"] = r"Let $\alpha = \frac{1}{n}$."
                if not read:
                    fixed["blocks"][0]["zh"] = r"令 $\alpha = \frac{1}{n}$。"
                clean = {"id": "p2", "type": "para", "page": 1, "en": "Already correct."}
                original["blocks"].append(clean)
                with mock.patch.object(translate.engines, "run", side_effect=[json.dumps(original), json.dumps(fixed)]) as run, \
                        mock.patch.object(translate.pdfwork, "locate"):
                    translate._one_batch(self.ws, self.cfg, [1], 1, threading.Event(), lambda *a: None, read=read)
                self.assertEqual(run.call_count, 2)
                self.assertIn("$TeX$", run.call_args.args[1])
                self.assertNotIn(clean["en"], run.call_args.args[1])
                self.assertEqual(self.ws.load("paper")["blocks"][1]["en"], clean["en"])
                self.assertEqual(self.ws.load("paper")["blocks"][0]["en"], fixed["blocks"][0]["en"])
                if not read:
                    self.assertEqual(self.ws.load("paper")["blocks"][0]["zh"], fixed["blocks"][0]["zh"])

    def test_fill_repairs_missing_delimiters_before_saving(self):
        self.ws.update("paper", lambda p: p.__setitem__("blocks", [
            {"id": "p1", "type": "para", "page": 1, "en": r"Let $\alpha$."},
            {"id": "tab1", "type": "table", "page": 1, "caption_en": "Results.",
             "head": [[r"$\alpha$"]], "rows": [["1"]]}]))
        # Only the table header is broken: array-valued translations need validation too.
        original = {"zh": {"p1": r"令 $\alpha$。", "tab1#caption": "结果。", "tab1#head": [[r"\alpha"]]}}
        fixed = copy.deepcopy(original)
        fixed["zh"]["tab1#head"] = [[r"$\alpha$"]]
        fixed["zh"]["p1"] = "unsolicited replacement"
        with mock.patch.object(translate.engines, "run", side_effect=[json.dumps(original), json.dumps(fixed)]) as run:
            translate._fill_batch(self.ws, self.cfg, [1], threading.Event(), lambda *a: None)
        self.assertEqual(run.call_count, 2)
        self.assertNotIn("tab1#caption", run.call_args.args[1])
        self.assertEqual(self.ws.load("paper")["blocks"][0]["zh"], original["zh"]["p1"])
        self.assertEqual(self.ws.load("paper")["blocks"][1]["head"], fixed["zh"]["tab1#head"])

    def test_fill_keeps_original_when_repair_is_not_better_or_loses_keys(self):
        original = {"zh": {"p1": r"令 \alpha。"}}
        for fixed in ({"zh": {"p1": r"令 \beta。"}}, {"zh": {"different": r"令 $\alpha$。"}}):
            with self.subTest(fixed=fixed):
                self.ws.update("paper", lambda p: p.__setitem__("blocks", [
                    {"id": "p1", "type": "para", "page": 1, "en": r"Let $\alpha$."}]))
                with mock.patch.object(translate.engines, "run", side_effect=[json.dumps(original), json.dumps(fixed)]) as run:
                    translate._fill_batch(self.ws, self.cfg, [1], threading.Event(), lambda *a: None)
                self.assertEqual(run.call_count, 2)
                self.assertEqual(self.ws.load("paper")["blocks"][0]["zh"], original["zh"]["p1"])


if __name__ == "__main__":
    unittest.main()
