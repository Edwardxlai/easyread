"""图块截图：按框重截、id 去重后才截、旧论文按定位补截，以及图内文字补译。"""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from pypdf import PdfWriter
from PIL import Image

from easyread import engines, figures, paperdata, prompts, prompts_en, translate
from easyread.store import Workspace, write_json_atomic


class FigureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.add_blank_page(width=100, height=100)
        writer.write(self.root / "source.pdf")

    def figure(self, box=None, page=1):
        return {"id": "fig1", "type": "figure", "page": page,
                "box": box or [.1, .1, .4, .4], "image_en": "Accuracy", "caption_en": "Figure 1"}

    def test_corrected_crop_changes_file_and_dimensions(self):
        a = self.figure()
        b = self.figure([.1, .1, .8, .8])
        with mock.patch.object(figures.pdfwork, "crop", wraps=figures.pdfwork.crop) as crop:
            figures.prepare_figures(self.root, [a, b], 2)
            figures.prepare_figures(self.root, [b], 2)
        self.assertEqual(crop.call_count, 2)
        self.assertNotEqual(a["src"], b["src"])
        with Image.open(self.root / a["src"]) as small, Image.open(self.root / b["src"]) as big:
            self.assertLess(small.width, big.width)

    def test_reused_id_on_another_page_cannot_share_crop(self):
        a, b = self.figure(), self.figure(page=2)
        figures.prepare_figures(self.root, [a, b], 2)
        self.assertNotEqual(a["src"], b["src"])

    def test_invalid_coordinates_and_pages_do_not_crop(self):
        for box in ([0, 0, float("nan"), 1], [0, 0, float("inf"), 1], [.8, 0, .2, 1]):
            self.assertIsNone(figures.figure_box(box))
        a = self.figure(page=0)
        a["src"] = "figures/old.webp"
        with mock.patch.object(figures.pdfwork, "crop") as crop:
            figures.prepare_figures(self.root, [a], 2)
        crop.assert_not_called()
        self.assertEqual(a["src"], "")
        self.assertNotIn("box", a)

    def test_failed_crop_drops_stale_source(self):
        a = self.figure()
        a["src"] = "figures/old.webp"
        with mock.patch.object(figures.pdfwork, "crop", side_effect=ValueError("bad crop")), mock.patch.object(figures.log, "exception"):
            figures.prepare_figures(self.root, [a], 2)
        self.assertEqual(a["src"], "")
        self.assertNotIn("box", a)

    def test_read_then_fill_keeps_image_and_user_edits(self):
        ws = Workspace(self.root)
        (self.root / "extract").mkdir()
        (self.root / "extract/page-001.txt").write_text("Accuracy", encoding="utf-8")
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 2}, "blocks": [], "translation": {}})
        write_json_atomic(self.root / "reader.json", {"edits": {"fig1#image": {"zh": "my edit"}}})
        before = (self.root / "reader.json").read_bytes()
        cfg = {"engine": "openai", "openai": {"vision": False}}
        with mock.patch.object(engines, "run", return_value=json.dumps({"blocks": [self.figure()]})), mock.patch.object(translate, "_problems", return_value=[]), mock.patch.object(translate.pdfwork, "locate"):
            translate._one_batch(ws, cfg, [1], 2, threading.Event(), lambda *a: None, read=True)
        b = ws.load("paper")["blocks"][0]
        crop = b["src"]
        self.assertTrue((self.root / crop).is_file())
        self.assertIn("fig1#image", prompts_en.todo([b]))
        with mock.patch.object(engines, "run", return_value=json.dumps({"zh": {"fig1#image": "translated label", "fig1#caption": "translated caption"}})), mock.patch.object(translate, "_problems", return_value=[]):
            translate._fill_batch(ws, cfg, [1], threading.Event(), lambda *a: None)
        b = ws.load("paper")["blocks"][0]
        self.assertEqual(b["image_zh"], "translated label")
        self.assertEqual(b["src"], crop)
        self.assertEqual(ws.load("paper")["translation"]["en_pages"], [])
        self.assertEqual((self.root / "reader.json").read_bytes(), before)
        self.assertIn("Accuracy", prompts.retranslate(ws, "fig1#image", ""))
        paperdata.set_block_text(ws, "fig1#image", "revised")
        self.assertEqual(ws.load("paper")["blocks"][0]["image_zh"], "revised")

    def test_id_dedup_happens_before_crop(self):
        ws = Workspace(self.root)
        (self.root / "extract").mkdir()
        old = self.figure([.5, .5, .9, .9], page=2)
        old["src"] = "figures/kept.webp"
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 2}, "blocks": [old], "translation": {}})
        cfg = {"engine": "openai", "openai": {"vision": False}}
        with mock.patch.object(engines, "run", return_value=json.dumps({"blocks": [self.figure()]})), mock.patch.object(translate, "_problems", return_value=[]), mock.patch.object(translate.pdfwork, "locate"):
            translate._one_batch(ws, cfg, [1], 2, threading.Event(), lambda *a: None)
        blocks = {b["id"]: b for b in ws.load("paper")["blocks"]}
        self.assertEqual(blocks["fig1"]["src"], "figures/kept.webp")
        self.assertTrue(blocks["fig1-2"]["src"].startswith("figures/crop-1-"))
        self.assertTrue((self.root / blocks["fig1-2"]["src"]).is_file())

    def test_retranslated_page_gets_fresh_crop(self):
        ws = Workspace(self.root)
        (self.root / "extract").mkdir()
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 2}, "blocks": [], "translation": {}})
        cfg = {"engine": "openai", "openai": {"vision": False}}
        srcs = []
        for box in ([.1, .1, .4, .4], [.1, .1, .8, .8]):
            with mock.patch.object(engines, "run", return_value=json.dumps({"blocks": [self.figure(box)]})), mock.patch.object(translate, "_problems", return_value=[]), mock.patch.object(translate.pdfwork, "locate"):
                translate._one_batch(ws, cfg, [1], 2, threading.Event(), lambda *a: None)
            srcs.append(ws.load("paper")["blocks"][0]["src"])
        self.assertNotEqual(srcs[0], srcs[1])

    def test_fill_backfills_old_paper_from_layout(self):
        ws = Workspace(self.root)
        fig = {"id": "fig1", "type": "figure", "page": 1, "src": "", "caption_en": "Figure 1"}
        tiny = {"id": "fig2", "type": "figure", "page": 1, "src": "", "caption_en": "Figure 2"}
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 2}, "blocks": [fig, tiny]})
        write_json_atomic(self.root / "layout.json", {"fig1": {"page": 1, "box": [.1, .1, .6, .5]},
                                                      "fig2": {"page": 1, "box": [.1, .6, .6, .62]}})
        self.assertEqual([m[0] for m in figures.missing(ws)], ["fig1"])
        self.assertEqual(figures.fill(ws), 1)
        blocks = {b["id"]: b for b in ws.load("paper")["blocks"]}
        self.assertTrue((self.root / blocks["fig1"]["src"]).is_file())
        self.assertEqual(blocks["fig2"]["src"], "")
        self.assertEqual(figures.missing(ws), [])

    def test_image_translation_missing_even_when_caption_is_done(self):
        b = self.figure()
        b["caption_zh"] = "done"
        self.assertEqual(prompts_en.todo([b]), {"fig1#image": "Accuracy"})
        self.assertIn("image_zh", prompts.rules("ja"))

    def auto_figure(self):
        ws = Workspace(self.root)
        block = {"id": "fig1", "type": "figure", "page": 1,
                 "src": figures.crop(self.root, 1, [.5, .4, .9, .7]), "caption_zh": "保留的译文"}
        write_json_atomic(self.root / "paper.json", {"meta": {"page_count": 2}, "blocks": [block]})
        write_json_atomic(self.root / "layout.json", {"fig1": {"page": 1, "box": [.1, .3, .9, .9], "src": "graphic"}})
        return ws, block

    def test_updated_layout_replaces_stale_auto_crop_once_and_keeps_notes(self):
        ws, old = self.auto_figure()
        write_json_atomic(self.root / "reader.json", {"notes": {"n": {"body": "已有笔记"}}})
        notes = (self.root / "reader.json").read_bytes()
        self.assertEqual(figures.fill(ws), 1)
        updated = ws.load("paper")["blocks"][0]
        self.assertNotEqual(updated["src"], old["src"])
        self.assertEqual(updated["caption_zh"], old["caption_zh"])
        self.assertEqual((self.root / "reader.json").read_bytes(), notes)
        with mock.patch.object(figures.pdfwork, "crop") as crop:
            self.assertEqual(figures.fill(ws), 0)
        crop.assert_not_called()

    def test_manual_box_and_custom_image_are_not_replaced(self):
        for manual in ({"box": [.5, .4, .9, .7]}, {"src": "figures/custom.webp"}):
            ws, old = self.auto_figure()
            ws.update("paper", lambda p: p["blocks"][0].update(manual))
            with mock.patch.object(figures.pdfwork, "crop") as crop:
                self.assertEqual(figures.fill(ws), 0)
            crop.assert_not_called()

    def test_concurrent_retranslation_does_not_get_overwritten(self):
        ws, old = self.auto_figure()
        original_crop = figures.crop

        def recrop(*args):
            ws.update("paper", lambda p: p["blocks"][0].update({"src": "figures/new.webp", "caption_zh": "新的译文"}))
            return original_crop(*args)

        with mock.patch.object(figures, "crop", side_effect=recrop):
            self.assertEqual(figures.fill(ws), 0)
        self.assertEqual(ws.load("paper")["blocks"][0]["src"], "figures/new.webp")

    def test_failed_refresh_retains_existing_crop(self):
        ws, old = self.auto_figure()
        with mock.patch.object(figures, "crop", side_effect=ValueError("bad crop")), mock.patch.object(figures.log, "exception"):
            self.assertEqual(figures.fill(ws), 0)
        self.assertEqual(ws.load("paper")["blocks"][0], old)

    def test_deleted_cached_image_is_recreated(self):
        ws, old = self.auto_figure()
        self.assertEqual(figures.fill(ws), 1)
        src = ws.load("paper")["blocks"][0]["src"]
        (self.root / src).unlink()
        self.assertEqual(figures.fill(ws), 1)
        self.assertTrue((self.root / src).is_file())


if __name__ == "__main__":
    unittest.main()
