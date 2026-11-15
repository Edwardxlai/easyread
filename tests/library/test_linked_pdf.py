import hashlib
import json
import re
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from contextlib import nullcontext
from http.server import ThreadingHTTPServer
from pathlib import Path

from pypdf import PdfWriter

from easyread.library import cloudlib, paperdata, reader_files, trash
from easyread.library.library import Library
from easyread.pdf import figures, pdfwork
from easyread.server.server import Handler, _safe


class LinkedPDFTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.pdf = self.root / "original.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=60, height=80)
        writer.write(self.pdf)
        self.data = self.pdf.read_bytes()
        self.lib = Library(self.root / "library")

    def linked(self):
        return self.lib.import_pdf_path(self.pdf, link=True)[0]

    def test_filename_title_survives_translation_and_duplicate_import(self):
        for link in (False, True):
            with self.subTest(link=link):
                lib = Library(self.root / ("linked" if link else "copied"))
                ws, _ = lib.import_pdf_path(self.pdf, {"title_en": "Paper title"}, link=link, keep_filename=True)
                ws.update("paper", lambda paper: paper["meta"].update(title_zh="Translated title"))
                _, fresh = lib.create_from_pdf(self.data, "renamed.pdf")
                self.assertFalse(fresh)
                item = lib.summary(ws)
                self.assertEqual(item["display_title"], self.pdf.name)
                self.assertEqual(item["title_en"], "Paper title")
                self.assertEqual(item["title_zh"], "Translated title")

    def test_link_import_uses_external_pdf_without_creating_source_copy(self):
        ws, fresh = self.lib.import_pdf_path(self.pdf, link=True)
        self.assertTrue(fresh)
        self.assertEqual(ws.id, hashlib.sha256(self.data).hexdigest()[:12])
        self.assertEqual(ws.source_pdf, self.pdf.resolve())
        self.assertFalse((ws.root / "source.pdf").exists())
        self.assertEqual(self.pdf.read_bytes(), self.data)

    def test_default_copy_and_duplicate_link_import_preserve_reading_data(self):
        ws, _ = self.lib.import_pdf_path(self.pdf)
        ws.apply_reader_ops([{"op": "progress", "ratio": .5},
                             {"op": "paper_note", "body": "Keep my note"}])
        ws.patch_item({"tags": ["Keep my category"], "starred": True})
        before = {name: (ws.root / (name + ".json")).read_bytes()
                  for name in ("paper", "reader", "discussion", "item")}
        duplicate, fresh = self.lib.import_pdf_path(self.pdf, link=True)
        self.assertEqual(duplicate.id, ws.id)
        self.assertFalse(fresh)
        self.assertEqual(ws.source_pdf, ws.root / "source.pdf")
        for name, data in before.items():
            self.assertEqual((ws.root / (name + ".json")).read_bytes(), data)

    def test_explicit_conversion_removes_only_equal_stored_copy(self):
        ws, _ = self.lib.import_pdf_path(self.pdf)
        ws.apply_reader_ops([{"op": "paper_note", "body": "Keep my note"}])
        original_reader = ws.reader_path.read_bytes()
        original_item = ws.item_path.read_bytes()
        paper = ws.load("paper")
        with self.assertRaises(ValueError):
            self.lib.convert_pdf_to_link(ws.id, self.pdf)
        self.lib.convert_pdf_to_link(ws.id, self.pdf, remove_copy=True)
        self.assertEqual(ws.source_pdf, self.pdf.resolve())
        self.assertFalse((ws.root / "source.pdf").exists())
        self.assertEqual(ws.reader_path.read_bytes(), original_reader)
        self.assertEqual(ws.item_path.read_bytes(), original_item)
        after = ws.load("paper")
        after["meta"].pop("source_pdf_path")
        self.assertEqual(after, paper)
        self.assertEqual(self.pdf.read_bytes(), self.data)

    def test_conversion_rejects_changed_stored_copy_and_internal_target(self):
        ws, _ = self.lib.import_pdf_path(self.pdf)
        with self.assertRaises(ValueError):
            self.lib.convert_pdf_to_link(ws.id, ws.root / "source.pdf", remove_copy=True)
        (ws.root / "source.pdf").write_bytes(self.data + b"changed")
        before = ws.paper_path.read_bytes()
        with self.assertRaises(ValueError):
            self.lib.convert_pdf_to_link(ws.id, self.pdf, remove_copy=True)
        self.assertEqual(ws.paper_path.read_bytes(), before)
        self.assertTrue((ws.root / "source.pdf").exists())

    def test_render_extract_engine_image_and_figure_use_link(self):
        ws = self.linked()
        pages = pdfwork.prepare(ws.root)
        self.assertEqual(len(pages), 1)
        self.assertTrue((ws.root / "pages/page-001.webp").is_file())
        self.assertTrue((ws.root / "extract/page-001.txt").is_file())
        self.assertTrue(pdfwork.engine_image(ws.root, 1).is_file())
        self.assertTrue((ws.root / figures.crop(ws.root, 1, [.1, .1, .9, .9])).is_file())
        self.assertFalse((ws.root / "source.pdf").exists())

    def test_first_reader_open_prepares_linked_pdf_without_eager_import_cache(self):
        ws = self.linked()
        self.assertFalse((ws.root / "pages").exists())
        finished = threading.Event()
        lock = threading.Lock()
        active = 0
        def begin():
            nonlocal active
            with lock:
                active += 1
                finished.clear()
        def end():
            nonlocal active
            with lock:
                active -= 1
                if active == 0:
                    finished.set()
        gate = types.SimpleNamespace(begin=begin, end=end)
        reader_files.prepare_later(ws, gate)
        self.assertTrue(finished.wait(10))
        self.assertEqual(ws.load("paper")["meta"]["page_count"], 1)
        self.assertTrue((ws.root / "pages/page-001.webp").is_file())
        self.assertFalse((ws.root / "source.pdf").exists())

    def test_trash_restore_purge_and_cloud_copy_do_not_touch_external_pdf(self):
        ws = self.linked()
        dest = self.root / "cloud-copy"
        dest.mkdir()
        cloudlib._copy_verified(ws.root, dest / ws.id)
        self.assertEqual(cloudlib._sha(ws.root), hashlib.sha256(self.data).hexdigest())
        self.assertFalse((dest / ws.id / "source.pdf").exists())
        removed = self.lib.trash(ws.id)
        trash.restore(self.lib.root, removed.name)
        self.assertEqual(self.lib.ws(ws.id).source_pdf, self.pdf.resolve())
        removed = self.lib.trash(ws.id)
        trash.purge(self.lib.root, removed.name)
        self.assertEqual(self.pdf.read_bytes(), self.data)

    def test_missing_link_is_actionable_and_non_pdf_and_url_are_rejected(self):
        ws = self.linked()
        self.pdf.unlink()
        with self.assertRaisesRegex(ValueError, re.escape(str(self.pdf))):
            _ = ws.source_pdf
        with self.assertRaises(ValueError):
            self.lib.import_pdf_path("https://example.org/paper.pdf", link=True)
        invalid = self.root / "invalid.pdf"
        invalid.write_text("not a pdf")
        with self.assertRaises(ValueError):
            self.lib.import_pdf_path(invalid, link=True)

    def test_source_http_serves_external_pdf_and_keeps_other_paths_scoped(self):
        renamed = self.pdf.with_suffix(".html")
        self.pdf.rename(renamed)
        self.pdf = renamed  # PDF response type must not depend on the source filename.
        ws = self.linked()
        app = types.SimpleNamespace(lib=self.lib,
                                    location=types.SimpleNamespace(request=lambda *a: nullcontext(), status="idle"))
        handler = type("LinkedHandler", (Handler,), {"app": app, "log_message": lambda *a: None})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/p/{ws.id}/source.pdf"
        with urllib.request.urlopen(url) as response:
            self.assertEqual(response.read(), self.data)
            self.assertEqual(response.headers["Content-Type"], "application/pdf")
        self.assertIsNone(_safe(ws.root, "../../original.pdf"))
        self.pdf.unlink()
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(url)
        self.assertEqual(error.exception.code, 409)
        self.assertIn(str(self.pdf), json.loads(error.exception.read())["error"])

    def test_model_metadata_cannot_change_pdf_source(self):
        for link in (False, True):
            with self.subTest(link=link):
                lib = Library(self.root / f"library-{link}")
                ws, _ = lib.import_pdf_path(self.pdf, link=link)
                original = ws.source_pdf
                paperdata.merge_blocks(ws, {"meta": {"source_pdf_path": str(self.root / "other.pdf")}, "blocks": []})
                self.assertEqual(ws.source_pdf, original)


if __name__ == "__main__":
    unittest.main()
