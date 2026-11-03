"""句子级对齐：模型插的 ‖ 去掉后记成 sents；旧数据没有 sents 照常；补译、重译、修正都兼容。  python -m unittest tests.translate.test_sentences"""
import json
import shutil
import threading
import unittest
from unittest import mock

from easyread.engines import engines
from easyread.library import paperdata
from easyread.translate import prompts, sentences, translate
from tests.translate.test_translate import make_ws


class UnmarkTest(unittest.TestCase):
    def test_para_gets_sents_and_clean_text(self):
        b = {"id": "p1-1", "type": "para", "en": "We study X. ‖ It works (see Fig. 2).", "zh": "我们研究 X。‖它有效（见图 2）。"}
        sentences.attach([b])
        self.assertEqual(b["en"], "We study X. It works (see Fig. 2).")
        self.assertEqual(b["zh"], "我们研究 X。它有效（见图 2）。")
        self.assertEqual(b["sents"], [[11, 7], [34, 17]])
        self.assertTrue(sentences.valid(b))

    def test_mismatched_counts_fall_back_to_paragraph(self):
        b = {"id": "p1-1", "type": "para", "en": "A. ‖ B. ‖ C.", "zh": "甲。‖乙丙。", "sents": [[1, 1], [2, 2]]}
        sentences.attach([b])
        self.assertEqual((b["en"], b["zh"]), ("A. B. C.", "甲。乙丙。"))
        self.assertNotIn("sents", b)  # 对不上就不记，旧的也去掉

    def test_empty_sentence_is_not_alignment(self):
        self.assertEqual(sentences.unmark("A. ‖‖ B."), ("A. B.", None))
        self.assertEqual(sentences.unmark("A. ‖"), ("A.", None))

    def test_mark_inside_math_is_kept(self):
        b = {"id": "p", "type": "para", "en": "Let $\\|x‖$ be small. ‖ Done.", "zh": "设 $\\|x‖$ 很小。‖完成。"}
        sentences.attach([b])
        self.assertIn("‖$", b["en"])
        self.assertEqual(len(b["sents"]), 2)

    def test_norm_bars_in_text_are_not_boundaries(self):
        self.assertEqual(sentences.unmark("‖w‖ bound"), ("‖w‖ bound", None))
        self.assertEqual(sentences.unmark("norm ‖x‖. ‖ Next one."), ("norm ‖x‖. Next one.", [9]))
        b = {"id": "s1", "type": "heading", "en": "Bounds on ‖w‖", "zh": "‖w‖ 的界"}
        sentences.attach([b])
        self.assertEqual((b["en"], b["zh"]), ("Bounds on ‖w‖", "‖w‖ 的界"))

    def test_boundary_after_a_bold_or_italic_sentence(self):
        # Bold run-in headings come back as "**Overall findings.**‖": the closing marks sit between the stop and ‖.
        b = {"id": "p", "type": "para", "en": "**Overall findings.** ‖ Table 2 shows it.", "zh": "**总体发现。**‖表 2 给出了结果。"}
        sentences.attach([b])
        self.assertEqual((b["en"], b["zh"]), ("**Overall findings.** Table 2 shows it.", "**总体发现。**表 2 给出了结果。"))
        self.assertEqual(b["sents"], [[21, 9], [39, 19]])
        self.assertEqual(sentences.unmark("*斜体句子。*‖下一句。"), ("*斜体句子。*下一句。", [7]))
        self.assertEqual(sentences.unmark("**‖w‖** bound"), ("**‖w‖** bound", None))  # a bold norm is still not a boundary

    def test_korean_keeps_space_between_sentences(self):
        self.assertEqual(sentences.unmark("첫 문장입니다. ‖ 다음"), ("첫 문장입니다. 다음", [8]))

    def test_latin_target_keeps_space(self):
        self.assertEqual(sentences.unmark("Phrase un. ‖ Phrase deux."), ("Phrase un. Phrase deux.", [10]))

    def test_utf16_offsets_for_astral_chars(self):
        b = {"id": "p", "type": "para", "en": "𝑥 is big. ‖ Yes.", "zh": "𝑥 很大。‖是的。"}
        sentences.attach([b])
        self.assertEqual(b["sents"][0], [10, 6])  # 𝑥 在 JS 里占 2
        self.assertTrue(sentences.valid(b))

    def test_list_items_and_stray_marks(self):
        blocks = [{"id": "l", "type": "list", "items": [{"en": "One. ‖ Two.", "zh": "一。‖二。"}, {"en": "Solo.", "zh": "单独。"}]},
                  {"id": "s1", "type": "heading", "en": "Intro ‖", "zh": "引言"},
                  {"id": "f1", "type": "figure", "caption_en": "Figure 1: a. ‖ b.", "caption_zh": "图 1：甲。‖乙。"}]
        sentences.attach(blocks)
        self.assertEqual(blocks[0]["items"][0]["sents"], [[4, 2], [9, 4]])
        self.assertNotIn("sents", blocks[0]["items"][1])
        self.assertEqual(blocks[1]["en"], "Intro")
        self.assertNotIn("‖", blocks[2]["caption_en"] + blocks[2]["caption_zh"])

    def test_valid_rejects_changed_text(self):
        b = {"en": "A. B.", "zh": "甲。乙。", "sents": [[2, 2], [5, 4]]}
        self.assertTrue(sentences.valid(b))
        self.assertFalse(sentences.valid(dict(b, zh="甲。乙乙。")))  # 译文被改过
        self.assertFalse(sentences.valid(dict(b, sents=[[5, 4]])))
        self.assertFalse(sentences.valid({"en": "A.", "zh": "甲。"}))  # 旧数据


class SplitTest(unittest.TestCase):
    def test_split_en_skips_abbreviations_and_math(self):
        t = "Smith et al. showed this. Fig. 3 shows J. Doe results! Then 3.5 is fine. We use $x. Y$ here. Done."
        ends = sentences.split_en(t)
        self.assertEqual([t[:e].split()[-1] for e in ends], ["this.", "results!", "fine.", "here."])

    def test_mark_en_round_trip(self):
        en = "First one. Second one. Third."
        marked, cut = sentences.mark_en(en)
        self.assertEqual(marked, "First one. ‖ Second one. ‖ Third.")
        zh, sents = sentences.zh_sents(en, cut, "第一。‖第二。‖第三。")
        self.assertEqual(zh, "第一。第二。第三。")
        self.assertTrue(sentences.valid({"en": en, "zh": zh, "sents": sents}))
        self.assertIsNone(sentences.zh_sents(en, cut, "第一。‖第二第三。")[1])

    def test_mark_en_follows_stored_sents(self):
        b = {"en": "A b. C d.", "zh": "甲。乙。", "sents": [[4, 2], [9, 4]]}
        self.assertEqual(sentences.mark_en(b["en"], b["sents"])[0], "A b. ‖ C d.")


class MergeTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(2)

    def tearDown(self):
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_merge_stores_sents_and_old_format_untouched(self):
        paperdata.merge_blocks(self.ws, {"blocks": [
            {"id": "p1-1", "type": "para", "page": 1, "en": "A. ‖ B.", "zh": "甲。‖乙。"},
            {"id": "p1-2", "type": "para", "page": 1, "en": "Old style.", "zh": "旧格式。"}]}, done=[1])
        b1, b2 = self.ws.load("paper")["blocks"]
        self.assertEqual(b1["sents"], [[2, 2], [5, 4]])
        self.assertEqual(b2, {"id": "p1-2", "type": "para", "page": 1, "en": "Old style.", "zh": "旧格式。"})

    def test_set_block_text_replaces_or_drops_sents(self):
        paperdata.merge_blocks(self.ws, {"blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "A. ‖ B.", "zh": "甲。‖乙。"}]})
        paperdata.set_block_text(self.ws, "p1-1", "新译文")
        self.assertNotIn("sents", self.ws.load("paper")["blocks"][0])
        paperdata.set_block_text(self.ws, "p1-1", "新甲。新乙。", [[2, 3], [5, 6]])
        self.assertEqual(self.ws.load("paper")["blocks"][0]["sents"], [[2, 3], [5, 6]])

    def test_retranslate_prompt_marks_english(self):
        paperdata.merge_blocks(self.ws, {"blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "A b. ‖ C d.", "zh": "甲。‖乙。"}]})
        text, ends = prompts.retranslate(self.ws, "p1-1", "")
        self.assertIn("A b. ‖ C d.", text)
        self.assertEqual(ends, ("A b. C d.", [4]))

    def test_retranslate_keeps_alignment(self):
        paperdata.merge_blocks(self.ws, {"blocks": [{"id": "p1-1", "type": "para", "page": 1, "en": "A b. ‖ C d.", "zh": "甲。‖乙。"}]})
        with mock.patch.object(engines, "run", lambda *a, **k: json.dumps({"zh": "新甲。‖新乙。"})):
            translate.retranslate(self.ws, {}, "p1-1", "", None)
        b = self.ws.load("paper")["blocks"][0]
        self.assertEqual((b["zh"], b["sents"]), ("新甲。新乙。", [[4, 3], [9, 6]]))


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(2)
        self.cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}
        self.patches = [mock.patch.object(translate.pdfwork, "locate", lambda root: None),
                        mock.patch.object(translate, "tex_problems", lambda tex: [])]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_translate_batch_and_check_quote(self):
        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            self.assertIn("句子对齐", prompt)
            page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
            return json.dumps({"blocks": [{"id": f"p{page}-1", "type": "para", "page": page, "en": "One. ‖ Two.", "zh": "一。‖二。"}],
                               "checks": [{"anchor": f"p{page}-1", "quote": "一。‖二", "body": "x"}]})
        with mock.patch.object(engines, "run", run):
            self.assertEqual(translate.translate_pages(self.ws, self.cfg, [1, 2], threading.Event(), lambda *a: None), {})
        blocks = self.ws.load("paper")["blocks"]
        self.assertTrue(all(b["sents"] == [[4, 2], [9, 4]] for b in blocks))
        self.assertEqual(self.ws.load("discussion")["entries"][0]["quote"], "一。二")

    def test_fill_after_read_aligns_with_program_split(self):
        def structure(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
            return json.dumps({"blocks": [{"id": f"p{page}-1", "type": "para", "page": page, "en": "First. Second one."},
                                          {"id": f"s{page}", "type": "heading", "page": page, "en": "Intro. Part"}]})
        seen = []

        def fill(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            items = json.loads(prompt.split("要翻译的内容（键 → 英文）：\n", 1)[1])
            seen.append(items)
            self.assertIn("‖ 是句子分界", prompt)
            return json.dumps({"zh": {k: ("第一。‖第二。" if "‖" in v else "标题") for k, v in items.items()}})
        with mock.patch.object(engines, "run", structure):
            translate.translate_pages(self.ws, self.cfg, [1, 2], threading.Event(), lambda *a: None, read=True)
        with mock.patch.object(engines, "run", fill):
            self.assertEqual(translate.translate_pages(self.ws, self.cfg, [1, 2], threading.Event(), lambda *a: None), {})
        self.assertEqual(seen[0], {"p1-1": "First. ‖ Second one.", "s1": "Intro. Part"})  # 标题不切
        p = next(b for b in self.ws.load("paper")["blocks"] if b["id"] == "p1-1")
        self.assertEqual((p["en"], p["zh"], p["sents"]), ("First. Second one.", "第一。第二。", [[6, 3], [18, 6]]))
        self.assertEqual(next(b for b in self.ws.load("paper")["blocks"] if b["id"] == "s1")["zh"], "标题")


if __name__ == "__main__":
    unittest.main()
