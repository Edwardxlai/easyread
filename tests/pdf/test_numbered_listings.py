"""A typeset listing with a figure caption participates in the normal reader pipeline."""
import json
import shutil
import threading
import unittest
from unittest.mock import patch

from easyread.pdf import numbered_listings, pdfwork
from easyread.translate import translate
from tests.pdf.test_figure_geometry import make_pdf
from tests.translate.test_translate import make_ws


class NumberedListingTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(1)
        self.addCleanup(shutil.rmtree, self.ws.root)
        self.cfg = {"engine": "openai", "openai": {"vision": False}, "batch_pages": 1}
        self.caption = "Fig. 1. A numbered example."
        make_pdf(self.ws.source_pdf, words=[
            ("1 begin {", .12, .22), ("2   value := 1", .12, .24), ("3 }", .12, .26),
            (self.caption, .12, .29), ("Other column.", .65, .24)])
        pdfwork.extract_text(self.ws.source_pdf, self.ws.root / "extract")

    def test_retry_then_crop_without_model_box(self):
        omitted = {"blocks": [{"id": "intro", "type": "para", "page": 1, "en": "Other column."}]}
        recovered = {"blocks": [*omitted["blocks"], {"id": "fig", "type": "figure", "page": 1,
                                                    "num": "1", "caption_en": self.caption}]}
        with patch.object(translate.engines, "run", side_effect=list(map(json.dumps, [omitted, recovered]))) as run:
            errors = translate.translate_pages(self.ws, self.cfg, [1], threading.Event(), lambda *args: None)
        self.assertFalse(errors)
        self.assertEqual(run.call_count, 2)
        self.assertIn(self.caption, run.call_args.args[1])
        figure = next(b for b in self.ws.load("paper")["blocks"] if b["id"] == "fig")
        self.assertTrue((self.ws.root / figure["src"]).is_file())
        x0, y0, x1, y1 = figure["abox"]
        self.assertLess(x0, .12)
        self.assertLess(y0, .22)
        self.assertLess(x1, .5)
        self.assertTrue(.25 < y1 < .28)

    def test_ordinary_list_and_in_text_reference(self):
        source = self.ws.root / "extract" / "page-001.txt"
        for contents in ("1 Start here\n2 Read this\n3 Finish here\n" + self.caption,
                         "1 a := 1\n2 b := 2\n3 }\nFig. 1 shows the result.",
                         "1 a := 1\n2 b := 2\n3 }\nAn unrelated paragraph.\n" + self.caption):
            source.write_text(contents, encoding="utf-8")
            self.assertFalse(numbered_listings.read_listings(source.parent, 1))
