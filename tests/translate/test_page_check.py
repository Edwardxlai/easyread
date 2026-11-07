"""一批几页里模型整页漏掉一页（#55）：漏的页不算译完，单独再译一次。  python -m unittest tests.translate.test_page_check"""
import json
import shutil
import threading
import unittest
from unittest import mock

from easyread.engines import engines
from easyread.translate import page_check, translate
from tests.translate.test_translate import make_ws

PAGE2 = ("Install the filter cartridge before turning on the water supply. Rotate the housing clockwise until it locks, "
         "then flush the system for five minutes and check every joint for leaks before regular use.")


def block(page, en="x"):
    return {"id": f"p{page}-1", "type": "para", "page": page, "en": en, "zh": "译文"}


class MissingPagesTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(2)
        self.addCleanup(shutil.rmtree, self.ws.root, ignore_errors=True)
        (self.ws.root / "extract" / "page-002.txt").write_text(PAGE2 + "\n\n2\n", encoding="utf-8")

    def test_page_with_text_but_no_blocks_is_missing(self):
        self.assertEqual(page_check.missing_pages(self.ws, [1, 2], {"blocks": [block(1)]}), [2])

    def test_continuation_or_wrong_page_number_is_not_missing(self):
        # 上一页那段接着写到这页，或者模型把块标成了第 1 页：原文在块里能找到
        en = "Some text on page one. " + PAGE2.replace("clockwise", "clock-\nwise")
        self.assertEqual(page_check.missing_pages(self.ws, [1, 2], {"blocks": [block(1, en)]}), [])

    def test_blank_or_reference_pages_are_not_checked(self):
        self.assertEqual(page_check.missing_pages(self.ws, [1, 2], {"blocks": [block(1)], "references": [{"n": 1}]}), [])
        (self.ws.root / "extract" / "page-002.txt").write_text("Figure 3\n\n2\n", encoding="utf-8")
        self.assertEqual(page_check.missing_pages(self.ws, [1, 2], {"blocks": [block(1)]}), [])

    def test_bibliography_page_without_entries_is_missing(self):
        # The model gave the References heading block but forgot the entries: they would be lost for good.
        (self.ws.root / "extract" / "page-002.txt").write_text(
            "The end of the conclusion.\nReferences\n" + "Carlos E. Jimenez, John Yang, and Karthik Narasimhan. SWE-bench. In ICLR, 2024.\n" * 3,
            encoding="utf-8")
        heading = {"id": "refs", "type": "references", "page": 2, "en": "References", "zh": "参考文献"}
        self.assertEqual(page_check.missing_pages(self.ws, [1, 2], {"blocks": [block(1), heading]}), [2])
        self.assertEqual(page_check.missing_pages(self.ws, [2], {"blocks": [heading]}), [2])  # a one-page batch too
        entries = [{"id": "Jimenez-2024", "text": "Carlos E. Jimenez …"}]
        self.assertEqual(page_check.missing_pages(self.ws, [1, 2], {"blocks": [block(1), heading], "references": entries}), [])
        # A heading alone at the foot of the page, entries starting on the next page: nothing is lost here.
        (self.ws.root / "extract" / "page-002.txt").write_text(PAGE2 + "\nReferences\n", encoding="utf-8")
        self.assertEqual(page_check.missing_pages(self.ws, [1, 2], {"blocks": [block(1), block(2, PAGE2), heading]}), [])


class RepairOldPapersTest(unittest.TestCase):
    """旧版本按批记完成，漏掉的页也在 done_pages 里：文献库列表里查一次，改回没译。"""

    def setUp(self):
        self.ws = make_ws(3)
        self.addCleanup(shutil.rmtree, self.ws.root, ignore_errors=True)
        other = ("Store the device in a dry place away from direct sunlight. Clean the outer surface with a soft cloth "
                 "and never use solvents, because they damage the coating and void the warranty.")
        (self.ws.root / "extract" / "page-002.txt").write_text(other, encoding="utf-8")
        (self.ws.root / "extract" / "page-003.txt").write_text(PAGE2, encoding="utf-8")
        # 第 3 页的原文其实在第 1 页那段里（续文），不算漏
        cont = "Intro. " + PAGE2
        self.ws.update("paper", lambda p: p.update(blocks=[block(1, cont)], translation={"done_pages": [1, 2, 3]}))

    def test_unmarks_only_empty_pages_once(self):
        from easyread.library.library import Library
        lib = Library(self.ws.root.parent)
        item = lib.summary(self.ws)
        self.assertEqual(sorted(self.ws.load("paper")["translation"]["done_pages"]), [1, 3])
        self.assertEqual((item["done_pages"], item["todo"]), (2, "2"))
        self.ws.update("paper", lambda p: p["translation"].update(done_pages=[1, 2, 3]))
        lib.summary(self.ws)  # 已经查过，不再动
        self.assertEqual(sorted(self.ws.load("paper")["translation"]["done_pages"]), [1, 2, 3])


class RetryMissingPageTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(2)
        self.addCleanup(shutil.rmtree, self.ws.root, ignore_errors=True)
        (self.ws.root / "extract" / "page-002.txt").write_text(PAGE2, encoding="utf-8")
        self.cfg = {"engine": "openai", "batch_pages": 2, "concurrency": 1, "openai": {"vision": False}}
        for p in (mock.patch.object(translate.pdfwork, "locate"), mock.patch.object(translate, "tex_problems", return_value=[]),
                  mock.patch.object(translate.netcheck, "problem", return_value=None)):
            p.start()
            self.addCleanup(p.stop)

    def run_pages(self, replies):
        calls = []

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
            calls.append(prompt)
            return json.dumps({"blocks": replies[len(calls) - 1]})
        with mock.patch.object(engines, "run", side_effect=run):
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2], threading.Event(), lambda *a: None)
        return failed, calls, self.ws.load("paper")["translation"]["done_pages"]

    def test_missing_page_is_translated_again_alone(self):
        failed, calls, done = self.run_pages([[block(1)], [block(2)]])
        self.assertEqual(failed, {})
        self.assertEqual(len(calls), 2)
        self.assertEqual(sorted(done), [1, 2])
        self.assertEqual(sorted(b["page"] for b in self.ws.load("paper")["blocks"]), [1, 2])

    def test_still_missing_is_reported_not_marked_done(self):
        failed, calls, done = self.run_pages([[block(1)], []])
        self.assertEqual(list(failed), [2])
        self.assertEqual(done, [1])


if __name__ == "__main__":
    unittest.main()
