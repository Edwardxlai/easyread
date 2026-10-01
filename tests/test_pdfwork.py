import tempfile
import unittest
from pathlib import Path

from PIL import Image

from easyread import pdfwork


class PdfworkTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.pages = self.tmp / "pages"
        self.pages.mkdir(parents=True)
        # Create a small sample image (800x600)
        self.img_small = self.pages / "page-001.webp"
        im1 = Image.new("RGB", (800, 600), color="white")
        im1.save(self.img_small, "WEBP")
        # Create a large sample image (1800x1200)
        self.img_large = self.pages / "page-002.webp"
        im2 = Image.new("RGB", (1800, 1200), color="white")
        im2.save(self.img_large, "WEBP")

    def test_page_variant_bounds_and_safety(self):
        # Path outside pages/ returns None
        self.assertIsNone(pdfwork.page_variant(self.tmp, "source.pdf", 1000))
        self.assertIsNone(pdfwork.page_variant(self.tmp, "pages/../source.pdf", 1000))
        # Nonexistent page returns None
        self.assertIsNone(pdfwork.page_variant(self.tmp, "pages/page-999.webp", 1000))

    def test_page_variant_small_image_returns_src(self):
        # Small image (width 800) requested with width 1000 returns original src
        res = pdfwork.page_variant(self.tmp, "pages/page-001.webp", 1000)
        self.assertEqual(res, self.img_small.resolve())

    def test_page_variant_large_image_resizes(self):
        # Large image (width 1800) requested with width 1000 is resized and saved to w1000/
        res = pdfwork.page_variant(self.tmp, "pages/page-002.webp", 1000)
        self.assertIsNotNone(res)
        self.assertEqual(res, self.pages / "w1000" / "page-002.webp")
        self.assertTrue(res.exists())
        with Image.open(res) as im:
            self.assertEqual(im.width, 1000)

    def test_warm_variants(self):
        pdfwork.warm_variants(self.tmp, width=1000)
        self.assertTrue((self.pages / "w1000" / "page-002.webp").exists())


if __name__ == "__main__":
    unittest.main()
