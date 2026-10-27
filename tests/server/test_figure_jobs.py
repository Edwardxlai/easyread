import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from easyread.engines.engines import Cancelled, EngineError
from easyread.library.library import Library
from easyread.library.store import Workspace, write_json_atomic
from easyread.server import paper_api
from easyread.server.jobs import Jobs
from easyread.translate import figure_images
from tests.engines.test_image_edit import png


class FigureJobsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lib = Library(Path(self.tmp.name))
        root = self.lib.root / "paper0001"
        (root / "figures").mkdir(parents=True)
        (root / "figures/source.png").write_bytes(png())
        self.ws = Workspace(root)
        self.paper = {"meta": {"pages": [{"n": 1}], "target": "ja"},
                      "translation": {"done_pages": [1]}, "blocks": [
                          {"id": "p1", "type": "para", "page": 1, "zh": "Keep this translation"},
                          {"id": "f1", "type": "figure", "page": 1, "src": "figures/source.png", "caption_zh": "図 1"},
                          {"id": "f2", "type": "figure", "page": 1, "src": "figures/source.png", "image_zh": "ラベル"}]}
        write_json_atomic(self.ws.paper_path, self.paper)
        self.reader = {"notes": {"n1": {"anchor": "p1", "body": "My note"}}, "edits": {"f2#image": {"zh": "訂正ラベル"}}}
        write_json_atomic(self.ws.reader_path, self.reader)
        self.cfg = {"engine": "none", "translate_figure_text": False, "figure_images": {"enabled": True}}
        self.config = patch("easyread.server.jobs.config.load", return_value=self.cfg)
        self.config.start()
        self.addCleanup(self.config.stop)
        with patch("easyread.server.jobs.threading.Thread.start"):
            self.jobs = Jobs(self.lib)
        self.app = SimpleNamespace(jobs=self.jobs)

    def request(self, body):
        return paper_api.post(self.app, self.ws, ["", "api", "p", self.ws.id, "figure-images"], body)

    def process(self):
        self.jobs._process_bulk(self.jobs.bulk.get_nowait())

    def test_existing_paper_image_only_job_including_legacy_figures_and_user_edits(self):
        self.assertEqual(self.request({}), {"ok": True, "count": 2})
        with patch.object(figure_images.codex_image, "edit", return_value=png()) as edit, \
                patch("easyread.server.jobs.translate.translate_pages") as text:
            self.process()
        text.assert_not_called()
        self.assertEqual(edit.call_count, 2)
        self.assertIn("訂正ラベル", edit.call_args.args[2])
        after = self.ws.load("paper")
        for block in after["blocks"][1:]:
            self.assertTrue((self.ws.root / block["translated_image"]["src"]).is_file())
            block.pop("translated_image")
        self.assertEqual(after, self.paper)
        self.assertEqual(self.ws.load("reader"), self.reader)
        job = self.ws.load("job")
        self.assertEqual((job["state"], job["done"], job["total"]), ("done", 2, 2))

    def test_disabled_feature_rejects_new_requests_and_stops_queued_generation(self):
        self.cfg["figure_images"]["enabled"] = False
        with self.assertRaises(ValueError):
            self.request({})
        self.assertTrue(self.jobs.bulk.empty())
        self.cfg["figure_images"]["enabled"] = True
        self.request({})
        self.cfg["figure_images"]["enabled"] = False
        with patch.object(figure_images.codex_image, "edit") as edit:
            self.process()
        edit.assert_not_called()
        self.assertEqual(self.ws.load("paper"), self.paper)

    def test_whole_paper_skips_current_images_but_single_force_regenerates(self):
        with patch.object(figure_images.codex_image, "edit", return_value=png()) as edit:
            self.request({})
            self.process()
            old = copy.deepcopy(self.ws.load("paper")["blocks"])
            self.request({})
            self.process()
            self.assertEqual(edit.call_count, 2)
            self.request({"ids": ["f1"], "force": True})
            self.process()
            self.assertEqual(edit.call_count, 3)
        new = self.ws.load("paper")["blocks"]
        self.assertNotEqual(new[1]["translated_image"], old[1]["translated_image"])
        self.assertEqual(new[2], old[2])

    def test_failed_regeneration_keeps_previous_image_and_reports_failure(self):
        with patch.object(figure_images.codex_image, "edit", return_value=png()):
            self.request({"ids": ["f1"]})
            self.process()
        original = self.ws.load("paper")
        with patch.object(figure_images.codex_image, "edit", side_effect=EngineError("quota exhausted")):
            self.request({"ids": ["f1"], "force": True})
            self.process()
        self.assertEqual(self.ws.load("paper"), original)
        job = self.ws.load("job")
        self.assertEqual(job["state"], "partial")
        self.assertEqual(job["image_failed"], {"f1": "quota exhausted"})
        self.assertEqual(job["failed"], {})

    def test_cancel_stops_images_and_leaves_translation_and_notes_intact(self):
        def edit(*args):
            self.jobs.cancel(self.ws.id)
            raise Cancelled()
        self.request({})
        with patch.object(figure_images.codex_image, "edit", side_effect=edit) as call:
            self.process()
        self.assertEqual(call.call_count, 1)
        self.assertEqual(self.ws.load("job")["state"], "cancelled")
        self.assertEqual(self.ws.load("paper"), self.paper)
        self.assertEqual(self.ws.load("reader"), self.reader)

    def test_invalid_selection_and_duplicate_submission_do_not_queue(self):
        for body in ({"ids": []}, {"ids": ["p1"]}, {"ids": ["gone"]}, {"ids": "f1"}, {"force": "yes"}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.request(body)
        self.assertTrue(self.jobs.bulk.empty())
        self.request({"ids": ["f1"]})
        before = self.ws.load("job")
        with self.assertRaises(ValueError):
            self.request({"ids": ["f2"]})
        self.assertEqual(self.ws.load("job"), before)
        self.assertEqual(self.jobs.bulk.qsize(), 1)

    def test_restart_never_blindly_replays_inflight_generation(self):
        self.request({})
        self.jobs._write(self.ws, state="running")
        with patch("easyread.server.jobs.threading.Thread.start"):
            resumed = Jobs(self.lib)
        self.assertTrue(resumed.bulk.empty())
        self.assertEqual(self.ws.load("job")["state"], "cancelled")
        self.jobs._write(self.ws, state="queued")
        with patch("easyread.server.jobs.threading.Thread.start"):
            queued = Jobs(self.lib)
        self.assertEqual(queued.bulk.qsize(), 1)

    def test_reader_changes_while_generating_discard_the_old_result(self):
        def edit(*args):
            self.ws.update("reader", lambda r: r["edits"]["f2#image"].update(zh="new correction"))
            return png()
        self.request({"ids": ["f2"]})
        with patch.object(figure_images.codex_image, "edit", side_effect=edit):
            self.process()
        self.assertNotIn("translated_image", self.ws.load("paper")["blocks"][2])
        self.assertEqual(self.ws.load("job")["state"], "partial")
        self.assertFalse(list((self.ws.root / "figures").glob("translated-*")))
