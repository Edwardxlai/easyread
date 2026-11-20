import io
import json
import shutil
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import Mock, patch

from pypdf import PdfWriter

from easyread.bulk import folder_files
from easyread.bulk.folder_sync import FolderSync
from easyread.library import trash
from easyread.library.library import Library, sha256_bytes
from easyread.pdf import sources
from easyread.server.library_api import LibraryLocation


def pdf(width=72):
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=width, height=72)
    writer.write(output)
    return output.getvalue()


class FolderSyncTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        local_home = patch("easyread.bulk.folder_sync.config.HOME", self.root / "profile")
        local_home.start()
        self.addCleanup(local_home.stop)
        self.a, self.b = self.root / "论文 A", self.root / "论文 B"
        self.a.mkdir()
        self.b.mkdir()
        self.app = SimpleNamespace(lib=Library(self.root / "library"), jobs=Mock())
        self.app.location = LibraryLocation(self.app)
        self.app.jobs.enqueue.side_effect = lambda ws, translate_after: ws.update(
            "job", lambda job: job.update(state="queued", translate=translate_after))
        self.sync = FolderSync(self.app)
        self.add("A", self.a)
        self.add("B", self.b, translate=True)
        self.data = pdf()
        self.pid = sha256_bytes(self.data)[:12]

    def add(self, name, path, translate=False):
        self.sync.configure({"action": "add", "name": name, "path": str(path), "translate": translate})

    def scan(self):
        self.sync.scan()
        self.sync.scan()

    def locations(self):
        return [(f["folder"], f["name"]) for f in self.sync.library()[1].get(self.pid, [])]

    def test_default_folder_imports_alongside_named_mappings(self):
        default = self.root / "Downloads"
        nested = default / "new"
        nested.mkdir(parents=True)
        self.assertIsNone(self.sync.settings()["default"])
        self.sync.configure({"action": "set_default", "path": str(default)})
        self.assertEqual([w["name"] for w in self.sync.settings()["roots"]], ["A", "B"])
        self.sync.scan()
        (nested / "paper.pdf").write_bytes(self.data[:100])
        self.scan()
        self.assertIsNone(self.app.lib.ws(self.pid))
        (nested / "paper.pdf").write_bytes(self.data)
        self.scan()
        self.assertTrue(self.sync.library()[0]["default_enabled"])
        self.assertEqual(self.sync.library()[0]["folders"], ["A", "B"])
        self.assertEqual(self.locations(), [("/new", "paper.pdf")])
        ws = self.app.lib.ws(self.pid)
        self.assertEqual(ws.source_pdf.read_bytes(), self.data)
        self.assertFalse(ws.load("job")["translate"])
        self.assertFalse(ws.load("item")["network_metadata"])

    def test_default_pause_persists_path_and_imports_backlog_without_translation(self):
        default = self.root / "Downloads"
        default.mkdir()
        self.sync.configure({"action": "set_default", "path": str(default), "translate": True})
        (default / "first.pdf").write_bytes(self.data)
        self.scan()
        self.sync.configure({"action": "set_default", "enabled": False})
        paused_data = pdf(width=99)
        (default / "paused.pdf").write_bytes(paused_data)
        with patch.object(folder_files, "walk", wraps=folder_files.walk) as walk:
            self.scan()
        self.assertNotIn(default, [call.args[0] for call in walk.call_args_list])
        paused_id = sha256_bytes(paused_data)[:12]
        self.assertIsNone(self.app.lib.ws(paused_id))
        self.assertIsNotNone(self.app.lib.ws(self.pid))
        self.assertEqual(self.locations(), [])
        self.sync = FolderSync(self.app)
        saved = self.sync.settings()["default"]
        self.assertEqual(saved["path"], str(default))
        self.assertFalse(saved["enabled"])
        self.assertTrue(saved["translate"])
        self.sync.configure({"action": "set_default", "enabled": True})
        self.scan()
        self.assertFalse(self.app.lib.ws(paused_id).load("job")["translate"])
        arrival = pdf(width=101)
        (default / "arrival.pdf").write_bytes(arrival)
        self.scan()
        self.assertTrue(self.app.lib.ws(sha256_bytes(arrival)[:12]).load("job")["translate"])

    def test_download_waits_for_complete_pdf_and_uses_folder_translation_setting(self):
        self.sync.scan()
        nested = self.b / "子目录"
        nested.mkdir()
        (nested / "ignore.pdf.crdownload").write_bytes(self.data)
        target = nested / "论文.PDF"
        target.write_bytes(self.data[:100])
        self.scan()
        self.assertFalse(self.app.lib.all())
        self.assertIn("B/子目录", self.sync.library()[0]["folders"])
        target.write_bytes(self.data)
        self.sync.scan()
        self.assertFalse(self.app.lib.all())
        self.sync.scan()
        ws = self.app.lib.ws(self.pid)
        self.assertEqual(self.locations(), [("B/子目录", "论文.PDF")])
        self.assertEqual(ws.source_pdf.read_bytes(), self.data)
        self.app.jobs.enqueue.assert_called_once()
        self.assertEqual(self.app.jobs.enqueue.call_args.args[0].id, self.pid)
        self.assertEqual(self.app.jobs.enqueue.call_args.kwargs, {"translate_after": True})

    def test_external_move_and_copy_keep_one_workspace_and_its_notes(self):
        file_a, file_b = self.a / "paper.pdf", self.b / "renamed.pdf"
        file_a.write_bytes(self.data)
        self.scan()
        ws = self.app.lib.ws(self.pid)
        ws.update("reader", lambda r: r.update(paper_note={"body": "Keep this"}))
        ws.patch_item({"tags": ["A", "Reading list"]})
        file_a.rename(file_b)
        self.scan()
        self.assertEqual(self.locations(), [("B", "renamed.pdf")])
        shutil.copyfile(file_b, file_a)
        self.scan()
        self.assertCountEqual(self.locations(), [("A", "paper.pdf"), ("B", "renamed.pdf")])
        self.assertEqual(len(self.app.lib.all()), 1)
        self.assertEqual(ws.load("reader")["paper_note"]["body"], "Keep this")
        self.assertEqual(ws.load("item")["tags"], ["A", "Reading list"])
        self.assertFalse(ws.load("job")["translate"])
        self.assertEqual(self.app.jobs.enqueue.call_count, 1)
        file_a.unlink()
        file_b.unlink()
        self.scan()
        self.assertEqual(self.locations(), [])
        self.assertEqual(ws.source_pdf.read_bytes(), self.data)
        self.assertEqual(ws.load("reader")["paper_note"]["body"], "Keep this")

    def test_pause_restart_and_unavailable_directory_preserve_state(self):
        src = self.a / "paper.pdf"
        src.write_bytes(self.data)
        self.sync.configure({"action": "update", "name": "A", "enabled": False})
        self.scan()
        self.assertIsNone(self.app.lib.ws(self.pid))
        self.sync = FolderSync(self.app)
        self.assertFalse(self.sync.settings()["roots"][0]["enabled"])
        self.sync.configure({"action": "update", "name": "A", "enabled": True})
        self.scan()
        self.a.rename(self.root / "offline")
        self.scan()
        self.assertTrue(self.sync.settings()["roots"][0]["error"])
        self.sync = FolderSync(self.app)
        self.assertEqual(self.locations(), [("A", "paper.pdf")])
        self.sync.configure({"action": "remove", "name": "A"})
        self.assertEqual(self.locations(), [])
        self.assertTrue(self.app.lib.ws(self.pid).source_pdf.is_file())

    def test_external_move_of_trashed_pdf_does_not_create_blank_library_entry(self):
        file_a, file_b = self.a / "paper.pdf", self.b / "paper.pdf"
        file_a.write_bytes(self.data)
        self.scan()
        deleted = self.app.lib.trash(self.pid)
        file_a.rename(file_b)
        self.scan()
        self.assertIsNone(self.app.lib.ws(self.pid))
        trash.restore(self.app.lib.root, deleted.name)
        self.assertEqual(self.locations(), [("B", "paper.pdf")])

    def test_rejects_overlapping_watches(self):
        nested = self.a / "nested"
        nested.mkdir()
        for path in (nested, self.a, self.root, self.app.lib.root):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.add("C", path)

    def test_existing_and_batch_arrivals_skip_automatic_translation(self):
        (self.b / "existing.pdf").write_bytes(self.data)
        self.scan()
        self.assertFalse(self.app.lib.ws(self.pid).load("job")["translate"])
        self.assertFalse(self.app.lib.ws(self.pid).load("item")["network_metadata"])
        for number in range(6):
            (self.b / f"batch-{number}.pdf").write_bytes(pdf(width=80 + number))
        self.scan()
        self.assertEqual(len(self.app.lib.all()), 7)
        self.assertTrue(all(not ws.load("job")["translate"] for ws in self.app.lib.all()))
        self.sync.configure({"action": "update", "name": "B", "network_metadata": True})
        data = pdf(width=100)
        (self.b / "new.pdf").write_bytes(data)
        self.scan()
        ws = self.app.lib.find_by_sha(sha256_bytes(data))
        self.assertTrue(ws.load("job")["translate"])
        self.assertTrue(ws.load("item")["network_metadata"])

    def test_six_same_name_replacements_skip_translation_through_restart_and_scan_budget(self):
        self.scan()
        paths = [self.b / f"{n}.pdf" for n in range(6)]
        for n, path in enumerate(paths):
            path.write_bytes(pdf(width=100 + n))
            self.scan()
        new_editions = [pdf(width=200 + n) for n in range(6)]
        for path, data in zip(paths, new_editions):
            path.write_bytes(data)

        with patch("easyread.bulk.folder_sync.IMPORTS_PER_SCAN", 2):
            self.sync = FolderSync(self.app)  # first observation must compare against saved stamps
            self.scan()
            self.sync = FolderSync(self.app)  # restart partway through the protected batch
            for _ in range(4):
                self.sync.scan()
        for data in new_editions:
            ws = self.app.lib.ws(sha256_bytes(data)[:12])
            self.assertIsNotNone(ws)
            self.assertFalse(ws.load("job")["translate"])

        next_edition = pdf(width=250)
        paths[0].write_bytes(next_edition)
        self.scan()
        self.assertTrue(self.app.lib.ws(sha256_bytes(next_edition)[:12]).load("job")["translate"])

    def test_default_mapping_counts_new_names_and_replacements_in_the_same_batch(self):
        folder = self.root / "Downloads"
        folder.mkdir()
        self.sync.configure({"action": "set_default", "path": str(folder), "translate": True})
        self.scan()
        paths = [folder / f"{n}.pdf" for n in range(6)]
        for n, path in enumerate(paths[:5]):
            path.write_bytes(pdf(width=300 + n))
        self.scan()
        self.assertEqual(sum(ws.load("job")["translate"] for ws in self.app.lib.all()), 5)
        for n, path in enumerate(paths):
            path.write_bytes(pdf(width=400 + n))
        self.scan()
        for path in paths:
            ws = self.app.lib.ws(sha256_bytes(path.read_bytes())[:12])
            self.assertFalse(ws.load("job")["translate"])

    def test_reenabling_auto_import_keeps_existing_pdfs_out_of_translation(self):
        self.sync.configure({"action": "update", "name": "B", "enabled": False, "network_metadata": True})
        directory = self.b / "nested"
        directory.mkdir()
        (directory / "paper.pdf").write_bytes(self.data)
        self.scan()
        self.assertNotIn("B/nested", self.sync.library()[0]["folders"])
        self.assertIsNone(self.app.lib.ws(self.pid))
        watch = self.sync.settings()["roots"][1]
        self.assertTrue(watch["translate"])
        self.assertTrue(watch["network_metadata"])
        self.sync.configure({"action": "update", "name": "B", "enabled": True})
        self.scan()
        ws = self.app.lib.ws(self.pid)
        self.assertFalse(ws.load("job")["translate"])
        self.assertTrue(ws.load("item")["network_metadata"])

    def test_edit_mapping_does_not_move_files_or_rewrite_tags(self):
        src = self.a / "paper.pdf"
        src.write_bytes(self.data)
        self.scan()
        ws = self.app.lib.ws(self.pid)
        ws.patch_item({"tags": ["A", "Unrelated"]})
        self.sync.configure({"action": "update", "name": "A", "new_name": "Reading"})
        self.assertEqual(self.locations(), [("Reading", "paper.pdf")])
        other = self.root / "Replacement"
        other.mkdir()
        self.sync.configure({"action": "update", "name": "Reading", "path": str(other)})
        self.scan()
        self.assertEqual(self.locations(), [])
        self.assertEqual(ws.load("item")["tags"], ["A", "Unrelated"])
        self.assertEqual(src.read_bytes(), self.data)

    def test_offline_metadata_extracts_ids_without_using_services(self):
        with patch.object(sources, "arxiv_meta") as arxiv, patch.object(sources, "s2_lookup") as s2:
            self.assertEqual(sources.enrich("arXiv:2310.12345 doi: 10.1234/example", {}, online=False),
                             {"arxiv": "2310.12345", "doi": "10.1234/example"})
            arxiv.assert_not_called()
            s2.assert_not_called()

    def test_unreadable_files_do_not_starve_later_imports(self):
        for n in range(24):
            (self.a / f"blocked-{n:02}.pdf").write_bytes(self.data)
        good = self.a / "z-readable.pdf"
        good.write_bytes(pdf(width=88))
        original = folder_files.read_stable

        def read(path, expected):
            if path.name.startswith("blocked-"):
                raise PermissionError("file temporarily locked")
            return original(path, expected)

        with patch.object(folder_files, "read_stable", side_effect=read):
            for _ in range(4):
                self.sync.scan()
        self.assertIsNotNone(self.app.lib.find_by_sha(sha256_bytes(good.read_bytes())))
        # Permission changes need no file rewrite; a later scan must retry them.
        for _ in range(3):
            self.sync.scan()
        self.assertEqual(len(self.locations()), 24)

    def test_failed_scan_save_keeps_batch_out_of_automatic_translation(self):
        self.sync.scan()
        for n in range(6):
            (self.b / f"batch-{n}.pdf").write_bytes(pdf(width=80 + n))
        with patch("easyread.bulk.folder_sync.write_json_atomic", side_effect=OSError("disk full")):
            self.sync.scan()
        self.scan()
        self.assertEqual(len(self.app.lib.all()), 6)
        self.assertTrue(all(not ws.load("job")["translate"] for ws in self.app.lib.all()))

    def test_unreadable_mapping_state_preserves_file_and_existing_library(self):
        (self.a / "paper.pdf").write_bytes(self.data)
        self.scan()
        good = self.sync.path.read_bytes()
        malformed = json.loads(good)
        malformed["A"]["enabled"] = "false"
        missing = json.loads(good)
        del missing["A"]["enabled"]
        for bad in (b'{"A":', b'[]', b'{"A": {}}', json.dumps(malformed).encode(), json.dumps(missing).encode()):
            with self.subTest(bad=bad):
                self.sync.path.write_bytes(bad)
                reopened = FolderSync(self.app)
                self.assertTrue(reopened.settings()["error"])
                self.assertFalse(reopened.library()[0]["active"])
                reopened.scan()
                with self.assertRaises(ValueError):
                    reopened.configure({"action": "add", "name": "A", "path": str(self.a)})
                self.assertEqual(self.sync.path.read_bytes(), bad)
                self.assertEqual(len(self.app.lib.list()), 1)
                self.assertEqual(self.app.lib.ws(self.pid).source_pdf.read_bytes(), self.data)
        self.sync.path.write_bytes(good)
        reopened = FolderSync(self.app)
        self.assertFalse(reopened.settings()["error"])
        self.assertTrue(reopened.library()[0]["active"])

    def test_mapping_paths_stay_with_the_local_profile_and_library(self):
        other = SimpleNamespace(lib=Library(self.root / "other-library"))
        self.assertEqual(FolderSync(other).settings()["roots"], [])
        with patch("easyread.bulk.folder_sync.config.HOME", self.root / "other-profile"):
            self.assertEqual(FolderSync(self.app).settings()["roots"], [])
        self.assertFalse(self.sync.path.is_relative_to(self.app.lib.root))
        self.assertEqual(len(FolderSync(self.app).settings()["roots"]), 2)

    def test_duplicate_of_unprepared_manual_import_only_prepares(self):
        ws, _ = self.app.lib.create_from_pdf(self.data, "manually-imported.pdf")
        self.scan()
        (self.b / "another-name.pdf").write_bytes(self.data)
        self.scan()
        self.assertFalse(ws.load("job")["translate"])
        self.assertEqual(self.locations(), [("B", "another-name.pdf")])

    def test_parallel_imports_publish_one_complete_workspace(self):
        start = Barrier(4)

        def import_one(number):
            start.wait(timeout=5)
            ws, fresh = self.app.lib.create_from_pdf(self.data, f"{number}.pdf")
            self.assertEqual(ws.source_pdf.read_bytes(), self.data)
            self.assertIsNotNone(ws.load("reader"))
            self.assertIsNotNone(ws.load("item"))
            return fresh

        with ThreadPoolExecutor(max_workers=4) as workers:
            self.assertEqual(sum(workers.map(import_one, range(4))), 1)
        self.assertEqual(len(self.app.lib.list()), 1)
