"""手机版导出：不带已译页的 PDF 原页，保留插图、没译的页、笔记讨论和改过的译文。"""
import json
import re
import tempfile
import unittest
from pathlib import Path

from easyread.export.build import build
from easyread.library.store import Workspace, write_json_atomic


class MobileExportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Workspace(Path(self.tmp.name))
        (self.ws.root / "pages").mkdir()
        for name in ("p1.webp", "p2.webp", "fig.webp"):
            (self.ws.root / "pages" / name).write_bytes(b"img-" + name.encode())
        write_json_atomic(self.ws.paper_path, {
            "meta": {"title_zh": "测试论文", "short_zh": "测试", "pages": [{"n": 1, "img": "pages/p1.webp"}, {"n": 2, "img": "pages/p2.webp"}]},
            "translation": {"done_pages": [1]},
            "blocks": [{"id": "a", "type": "para", "page": 1, "en": "Hi.", "zh": "你好"}, {"id": "f", "type": "figure", "page": 1, "src": "pages/fig.webp"}],
        })
        write_json_atomic(self.ws.discussion_path, {"entries": [{"id": "d1", "anchor": "a", "body": "AI 的解释"}]})
        write_json_atomic(self.ws.reader_path, {"edits": {"a": {"zh": "您好"}}, "notes": {"n1": {"id": "n1", "body": "我的笔记"}}})

    def data(self, page: Path) -> dict:
        html = page.read_text(encoding="utf-8")
        return html, json.loads(re.search(r'<script id="pr-data" type="application/json">(.*?)</script>', html, re.S).group(1))

    def test_mobile_drops_translated_pages_keeps_notes(self):
        html, d = self.data(build(self.ws, mobile=True))
        self.assertEqual(set(d["images"]), {"pages/p2.webp", "pages/fig.webp"})  # 第 2 页没译，正文要用原页图
        self.assertEqual(len(d["discussion"]["entries"]), 1)  # 笔记和讨论照样带上，手机上只读
        self.assertIn("n1", d["reader"]["notes"])
        self.assertIn('document.body.classList.add("mobile-read")', html)
        self.assertIn("body.mobile-read", html)
        self.assertTrue(build(self.ws, mobile=True).name.endswith("手机版.html"))

    def test_full_export_unchanged(self):
        html, d = self.data(build(self.ws))
        self.assertEqual(set(d["images"]), {"pages/p1.webp", "pages/p2.webp", "pages/fig.webp"})
        self.assertEqual(len(d["discussion"]["entries"]), 1)
        # Shared scripts may check mobile mode without enabling it in a full export.
        self.assertNotIn('document.body.classList.add("mobile-read")', html)
        self.assertNotIn("body.mobile-read", html)

    def test_exports_translated_image_with_original_and_text_fallback(self):
        (self.ws.root / "pages/translated.webp").write_bytes(b"translated-image")
        self.ws.update("paper", lambda p: p["blocks"][1].update(image_zh="译文", translated_image={"src": "pages/translated.webp"}))
        for mobile in (False, True):
            for assets in (None, self.ws.root / "assets"):
                with self.subTest(mobile=mobile, assets=assets):
                    _, data = self.data(build(self.ws, mobile=mobile, assets=assets))
                    self.assertIn("pages/translated.webp", data["images"])
                    self.assertIn("pages/fig.webp", data["images"])
                    self.assertEqual(data["paper"]["blocks"][1]["image_zh"], "译文")


if __name__ == "__main__":
    unittest.main()
