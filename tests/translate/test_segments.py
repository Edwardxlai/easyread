"""分段并行：怎么切段、交界怎么告诉模型、术语冲突怎么统一。  python -m unittest tests.translate.test_segments"""
import json
import shutil
import threading
import unittest
from unittest import mock

from easyread.app import config
from easyread.engines import engines
from easyread.library.paperdata import merge_blocks
from easyread.translate import prompts, segments, terms, translate
from tests.translate.test_translate import make_ws


def write_pages(ws, texts: dict):
    for n, t in texts.items():
        (ws.root / "extract" / f"page-{n:03d}.txt").write_text(t, encoding="utf-8")


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(14)

    def tearDown(self):
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_workers_auto_and_explicit(self):
        self.assertEqual(segments.workers(0, 15), 4)
        self.assertEqual(segments.workers(None, 2), 1)
        self.assertEqual(segments.workers("x", 100), segments.AUTO_MAX)
        self.assertEqual(segments.workers(1, 15), 1)
        self.assertEqual(segments.workers(99, 15), 8)

    def test_single_lane_keeps_order(self):
        self.assertEqual(segments.plan([1, 2, 3, 4], 2, 1, self.ws.root), [[1, 2, 3, 4]])
        self.assertEqual(segments.plan([], 2, 4, self.ws.root), [])

    def test_slowest_lane_not_longer_than_needed(self):
        pages = list(range(1, 15))  # 7 批，4 段时最慢一段 2 批
        plan = segments.plan(pages, 2, 4, self.ws.root)
        self.assertEqual([p for seg in plan for p in seg], pages)
        self.assertTrue(all(len(seg) <= 4 for seg in plan), plan)

    def test_fewer_lanes_when_same_speed(self):
        plan = segments.plan(list(range(1, 11)), 2, 4, self.ws.root)  # 5 批：3 段（2,2,1 批）就和 4 段一样快
        self.assertEqual(len(plan), 3, plan)

    def test_cut_moves_to_clean_seam(self):
        # 第 4 页断在句子中间，第 5 页从新章节开始：有余量时切在 4|5，不切在 3|4
        write_pages(self.ws, {3: "This is the end of the sentence.", 4: "this continues the sentence and stops in the", 5: "3 Method\nWe do things."})
        plan = segments.plan(list(range(1, 9)), 2, 2, self.ws.root)  # 4 批 2 段，每段最多 4 页
        self.assertEqual(plan, [[1, 2, 3, 4], [5, 6, 7, 8]])
        write_pages(self.ws, {4: "We are done with this part here.", 5: "lower case continuation of the paragraph"})
        self.assertEqual(segments.seam_cost(self.ws.root, 4, 5), 3.0)
        self.assertEqual(segments.seam_cost(self.ws.root, 2, 5), 0.0)  # 中间隔着不译的页

    def test_footnote_and_leading_table_ignored(self):
        # 脚注末尾的句号不算句子写完；下一页先排的表格和题注不算开头（f8eeac73f437 第 8|9 页就是这样漏了半段）
        write_pages(self.ws, {4: "3) SAIL-PIW Wang et al. (2023) preserves historical knowledge\n1https://example.org/data/.\n8",
                              5: "Table 1 Main results on three datasets.\nReplay 0.0616 0.0386\n4) PISA models continual recommendation through updates"})
        self.assertEqual(segments.seam_cost(self.ws.root, 4, 5), 2.0)

    def test_page_numbers_ignored(self):
        write_pages(self.ws, {4: "The end of the whole section here.\n4\n", 5: "2.1 Setup\nText"})
        self.assertEqual(segments.seam_cost(self.ws.root, 4, 5), 0.0)


class TermsTest(unittest.TestCase):
    def test_unify_rewrites_this_batch(self):
        data = {"glossary": [{"en": "Error bar", "zh": "误差棒"}, {"en": "eval", "zh": "评测"}],
                "blocks": [{"type": "para", "en": "Error bars matter", "zh": "误差棒很重要"}, {"type": "list", "items": [{"en": "draw an error bar", "zh": "画误差棒"}]},
                           {"type": "table", "head": [["误差棒", "x"]], "caption_en": "Table 1: error bars", "caption_zh": "表 1：误差棒"},
                           {"type": "para", "en": "no such term here", "zh": "误差棒"}]}
        found = terms.unify([{"en": "error bar", "zh": "误差线"}], data)
        self.assertEqual(found, [("Error bar", "误差棒", "误差线")])
        self.assertEqual(data["blocks"][0]["zh"], "误差线很重要")
        self.assertEqual(data["blocks"][1]["items"][0]["zh"], "画误差线")
        self.assertEqual(data["blocks"][2]["head"], [["误差线", "x"]])
        self.assertEqual(data["blocks"][2]["caption_zh"], "表 1：误差线")
        self.assertEqual(data["blocks"][3]["zh"], "误差棒")  # 原文没有这个术语的块不动
        self.assertEqual(data["glossary"], [{"en": "eval", "zh": "评测"}])

    def test_substring_protected(self):
        data = {"glossary": [{"en": "variance", "zh": "方差"}],
                "blocks": [{"type": "para", "en": "covariance and variance", "zh": "协方差和方差，$x_{方差}$"}]}
        terms.unify([{"en": "variance", "zh": "变异"}, {"en": "covariance", "zh": "协方差"}], data)
        self.assertEqual(data["blocks"][0]["zh"], "协方差和变异，$x_{方差}$")  # 别的术语里的、公式里的不换
        data = {"glossary": [{"en": "mean", "zh": "media"}], "blocks": [{"type": "para", "en": "the mean", "zh": "multimedia media"}]}
        terms.unify([{"en": "mean", "zh": "promedio"}], data)
        self.assertEqual(data["blocks"][0]["zh"], "multimedia promedio")  # 拉丁字母只换整词
        data = {"glossary": [{"en": "standard error", "zh": "标准误"}], "zh": {"p1": "标准误和标准误差", "t#head": [["标准误"]]}}
        terms.unify([{"en": "standard error", "zh": "标准误差"}], data, {"p1": "standard errors", "t#head": "standard error"})
        self.assertEqual(data["zh"], {"p1": "标准误差和标准误差", "t#head": [["标准误差"]]})

    def test_short_terms_left_alone(self):
        self.assertEqual(terms.conflicts([{"en": "error", "zh": "标准误差"}], [{"en": "error", "zh": "误差"}]), [])
        self.assertEqual(terms.conflicts([{"en": "x", "zh": "甲乙"}], [{"en": "x", "zh": "丙"}]), [])
        self.assertEqual(terms.conflicts([{"en": "x", "zh": "甲乙"}], [{"en": "x", "zh": "甲乙"}]), [])
        self.assertEqual(terms.conflicts([{"en": "unlikelihood", "zh": "Unlikelihood（非似然训练）"}], [{"en": "unlikelihood", "zh": "非似然"}]), [])


class SkipHeadTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(8)
        self.patches = [mock.patch.object(translate.pdfwork, "locate", lambda root: None),
                        mock.patch.object(translate, "tex_problems", lambda tex: [])]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def run_job(self, cfg, pages, gl=lambda page: []):
        seen = {}
        lock = threading.Lock()

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
            with lock:
                seen[page] = prompt
            return json.dumps({"glossary": gl(page), "blocks": [{"id": f"p{page}-1", "type": "para", "page": page,
                                                                  "en": "error bar", "zh": "误差棒" if page > 4 else "误差线"}]}, ensure_ascii=False)
        with mock.patch.object(engines, "run", run):
            self.assertEqual(translate.translate_pages(self.ws, cfg, pages, threading.Event(), lambda *a: None), {})
        return seen

    def test_lane_start_told_to_skip_continuation(self):
        cfg = {"engine": "openai", "batch_pages": 2, "concurrency": 2, "openai": {"vision": False}}
        seen = self.run_job(cfg, list(range(1, 9)))
        self.assertEqual(sorted(seen), [1, 3, 5, 7])
        self.assertIn("第 4 页由另一批负责", seen[5])  # 第二段开头
        for p in (1, 3, 7):
            self.assertNotIn("由另一批负责", seen[p])
        self.assertIn("上一批最后一段", seen[7])  # 段内照旧接上一批
        self.assertNotIn("另外用", seen[1])  # openai 不看图：不提相邻页

    def test_seam_batches_peek_neighbour_image(self):
        cfg = {"engine": "claude", "batch_pages": 2, "concurrency": 2, "claude": {}}
        with mock.patch.object(translate.pdfwork, "engine_image", lambda root, n: root / f"page-{n}.jpg"), \
                mock.patch.object(translate.netcheck, "problem", lambda cfg: None):
            seen = self.run_job(cfg, list(range(1, 9)))
        self.assertIn("extract/page-005.jpg 的开头", seen[3])  # 前一段最后一批看下一页开头
        self.assertIn("extract/page-004.jpg 的末尾", seen[5])  # 后一段第一批看上一页末尾
        self.assertNotIn("另外用", seen[1])
        self.assertNotIn("另外用", seen[7])

    def test_serial_and_range_never_skip(self):
        cfg = {"engine": "openai", "batch_pages": 2, "concurrency": 1, "openai": {"vision": False}}
        seen = self.run_job(cfg, [5, 6, 7, 8])  # 第 4 页不在这次范围里：页首续文要译
        self.assertTrue(all("由另一批负责" not in p for p in seen.values()))

    def test_conflicting_terms_unified_on_merge(self):
        cfg = {"engine": "openai", "batch_pages": 2, "concurrency": 1, "openai": {"vision": False}}
        self.run_job(cfg, list(range(1, 9)), gl=lambda page: [{"en": "error bar", "zh": "误差棒" if page > 4 else "误差线"}])
        paper = self.ws.load("paper")
        self.assertEqual({b["zh"] for b in paper["blocks"]}, {"误差线"})
        self.assertEqual(paper["glossary"], [{"en": "error bar", "zh": "误差线"}])
        self.assertIn("术语统一", (self.ws.root / "job.log").read_text(encoding="utf-8"))

    def test_only_one_references_block(self):
        cfg = {"engine": "openai", "batch_pages": 2, "concurrency": 2, "openai": {"vision": False}}

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
            blocks = [{"id": "refs", "type": "references", "page": page, "en": "References", "zh": "参考文献"}] if page >= 3 else \
                [{"id": f"p{page}-1", "type": "para", "page": page, "en": "x", "zh": "译文"}]
            return json.dumps({"blocks": blocks, "references": [{"id": str(page), "text": f"ref {page}"}]})
        with mock.patch.object(engines, "run", run):
            translate.translate_pages(self.ws, cfg, list(range(1, 9)), threading.Event(), lambda *a: None)
        paper = self.ws.load("paper")
        refs = [b for b in paper["blocks"] if b["type"] == "references"]
        self.assertEqual([b["page"] for b in refs], [3])  # 两段各起了一个，留页码早的
        self.assertEqual(refs[0]["id"], "refs")  # 晚并进来的更早那块接过原来的 id，挂在上面的笔记不丢
        self.assertEqual(len(paper["references"]), 4)

    def test_unnumbered_reference_entries_are_all_kept_in_page_order(self):
        # Author-year bibliographies have no numbers; entries used to collide on an empty id and whole pages vanished.
        cfg = {"engine": "openai", "batch_pages": 2, "concurrency": 2, "openai": {"vision": False}}

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
            refs = [{"id": "", "text": f"Author{page}{c}. Title. 2024."} for c in "ab"]
            if page == 7:
                refs.append({"id": "", "text": "Author5a. Title. 2024."})  # sent again by a later batch
            return json.dumps({"blocks": [{"id": f"p{page}-1", "type": "para", "page": page, "en": "x", "zh": "译文"}],
                               "references": refs})
        with mock.patch.object(engines, "run", run):
            translate.translate_pages(self.ws, cfg, list(range(1, 9)), threading.Event(), lambda *a: None)
        texts = [r["text"].split(".")[0] for r in self.ws.load("paper")["references"]]
        self.assertEqual(texts, ["Author1a", "Author1b", "Author3a", "Author3b", "Author5a", "Author5b", "Author7a", "Author7b"])

    def test_reference_key_collision_preserves_entries_and_retry_is_idempotent(self):
        refs = [{"id": "Smith-2024", "text": "Smith. Paper A."},
                {"id": "Smith-2024", "text": "Smith. Paper B."}]
        self.ws.update("paper", lambda p: p.update(references=[{"id": "", "text": refs[0]["text"]}]))
        for entry in refs:
            merge_blocks(self.ws, {"references": [entry]})
        saved = self.ws.load("paper")["references"]
        self.assertEqual([r["text"] for r in saved], [r["text"] for r in refs])
        self.assertEqual(len({r["id"] for r in saved}), 2)
        self.assertEqual([r["cite_key"] for r in saved], ["Smith-2024", "Smith-2024"])
        merge_blocks(self.ws, {"references": refs})
        self.assertEqual(self.ws.load("paper")["references"], saved)

    def test_prev_paragraph_skips_footnote_and_flags_unfinished(self):
        def add(*blocks):
            self.ws.update("paper", lambda p: p["blocks"].extend(blocks))
        add({"id": "p4-7", "type": "para", "page": 4, "en": "3) SAIL-PIW preserves knowledge."},
            {"id": "p4-8", "type": "para", "page": 4, "en": "$^1$https://example.org/data/."})
        ctx = prompts._context(self.ws, [5, 6])
        self.assertIn("p4-7", ctx)  # 脚注排在最后也不拿它当上一段
        self.assertIn("不要再输出这段续文", ctx)
        add({"id": "p4-9", "type": "para", "page": 4, "en": "Then the eval will need to contain at least"})
        ctx = prompts._context(self.ws, [5, 6])
        self.assertIn("停在了半句", ctx)  # 上一批没补完：续文要由这批译
        self.assertNotIn("不要再输出这段续文", ctx)

    def test_prev_followed_by_math_or_ending_in_math_is_finished(self):
        add = lambda *bs: self.ws.update("paper", lambda p: p["blocks"].extend(bs))  # noqa: E731
        add({"id": "p4-1", "type": "para", "page": 4, "en": "Combining, we have"}, {"id": "eq3", "type": "math", "page": 4, "tex": "x"})
        self.assertNotIn("停在了半句", prompts._context(self.ws, [5, 6]))  # 后面跟着公式：那段已经结束
        add({"id": "p4-2", "type": "para", "page": 4, "en": "so the value is $x=1.$"})
        self.assertNotIn("停在了半句", prompts._context(self.ws, [5, 6]))
        add({"id": "p4-3", "type": "heading", "page": 4, "en": "3 Method"})
        self.assertNotIn("停在了半句", prompts._context(self.ws, [5, 6]))

    def test_fill_prompt_has_no_continuation_rules(self):
        from easyread.translate import prompts_en
        self.ws.update("paper", lambda p: p["blocks"].append({"id": "p4-1", "type": "para", "page": 4, "en": "stops in the"}))
        text = prompts_en.fill(self.ws, [5], {"p5-1": "x"})
        self.assertNotIn("停在了半句", text)
        self.assertNotIn("上一批最后一段", text)

    def test_prev_paragraph_only_from_adjacent_pages(self):
        self.ws.update("paper", lambda p: p["blocks"].append({"id": "p1-1", "type": "para", "page": 1, "en": "far away"}))
        self.assertNotIn("far away", prompts._context(self.ws, [5, 6]))
        self.assertIn("far away", prompts._context(self.ws, [2, 3]))


class ConfigMigrationTest(unittest.TestCase):
    def test_old_one_means_auto_until_saved(self):
        import tempfile
        from pathlib import Path
        d = Path(tempfile.mkdtemp(prefix="easyread-cfg-"))
        try:
            with mock.patch.object(config, "CONFIG_PATH", d / "config.json"):
                (d / "config.json").write_text(json.dumps({"concurrency": 1}), encoding="utf-8")
                self.assertEqual(config.load()["concurrency"], 0)
                config.save({"port": 9000})  # 存别的设置也不会把旧的 1 固化下来
                self.assertEqual(config.load()["concurrency"], 0)
                config.save({"concurrency": 1})  # 新设置页里自己选的 1 保留
                self.assertEqual(config.load()["concurrency"], 1)
                (d / "config.json").write_text(json.dumps({"concurrency": 3}), encoding="utf-8")
                self.assertEqual(config.load()["concurrency"], 3)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
