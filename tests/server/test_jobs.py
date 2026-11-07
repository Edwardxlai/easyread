import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.server.jobs import Jobs
from easyread.library.library import Library
from easyread.library.store import Workspace, write_json_atomic


class StopWorker(Exception):
    pass


class JobsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lib = Library(Path(self.tmp.name))
        root = self.lib.root / "paper0001"
        root.mkdir()
        self.ws = Workspace(root)
        write_json_atomic(self.ws.paper_path, {"meta": {"pages": [{"n": 1}], "page_count": 1}})
        with patch("easyread.server.jobs.threading.Thread.start"):
            self.jobs = Jobs(self.lib)

    def drain(self, small=False):
        queue = self.jobs.small if small else self.jobs.bulk
        get = queue.get

        def next_job():
            if queue.empty():
                raise StopWorker()
            return get()
        with patch.object(queue, "get", side_effect=next_job), self.assertRaises(StopWorker):
            (self.jobs._small_loop if small else self.jobs._bulk_loop)()

    def test_duplicate_enqueue_preserves_queued_and_running_task(self):
        self.jobs.enqueue(self.ws, pages=[1])
        for state in ("queued", "running"):
            self.jobs._write(self.ws, state=state, message="original")
            before = self.ws.load("job")
            with self.assertRaisesRegex(ValueError, "已有任务"):
                self.jobs.enqueue(self.ws, pages=[2])
            self.assertEqual(self.ws.load("job"), before)
            self.assertEqual(self.jobs.bulk.qsize(), 1)

    def test_worker_marks_running_before_starting_work(self):
        self.jobs.enqueue(self.ws, pages=[1])

        def run(ws, job, cancel):
            self.assertEqual(ws.load("job")["state"], "running")
            with self.assertRaises(ValueError):
                self.jobs.enqueue(ws, pages=[2])
            self.jobs._write(ws, state="done")
        with patch.object(self.jobs, "_run_bulk", side_effect=run):
            self.drain()
        self.assertEqual(self.ws.load("job")["state"], "done")
        self.assertNotIn(self.ws.id, self.jobs.cancels)

    def test_cancel_during_preparation_is_not_reported_done(self):
        write_json_atomic(self.ws.paper_path, {"meta": {}})
        self.jobs.enqueue(self.ws, translate_after=False)
        with patch("easyread.server.jobs.config.load", return_value={"engine": "none"}), \
                patch("easyread.server.jobs.translate.prepare", side_effect=lambda ws: self.jobs.cancel(ws.id)):
            self.drain()
        self.assertEqual(self.ws.load("job")["state"], "cancelled")
        timing = self.ws.load("job")["timing"]
        self.assertEqual([e["stage"] for e in timing["events"]], ["prepare"])
        self.assertGreaterEqual(timing["elapsed_s"], timing["events"][0]["end_s"])

    def test_cancelled_queue_entry_is_skipped_and_can_be_retried(self):
        self.jobs.enqueue(self.ws, translate_after=False)
        self.jobs.cancel(self.ws.id)
        with patch.object(self.jobs, "_run_bulk") as run:
            self.drain()
        run.assert_not_called()
        self.jobs.enqueue(self.ws, translate_after=False)
        with patch.object(self.jobs, "_run_bulk", side_effect=lambda ws, job, ev: self.jobs._write(ws, state="done")) as run:
            self.drain()
        run.assert_called_once()

    def test_resume_finishes_before_workers_start(self):
        write_json_atomic(self.ws.root / "job.json", {"state": "running", "pages": [1]})
        states = []
        with patch("easyread.server.jobs.config.load", return_value={"paper_concurrency": 2}), \
                patch("easyread.server.jobs.threading.Thread.start", side_effect=lambda: states.append(self.ws.load("job")["state"])):
            resumed = Jobs(self.lib)
        self.assertEqual(states, ["queued"] * 3)
        self.assertEqual(resumed.bulk.qsize(), 1)

    def test_restart_of_legacy_job_only_schedules_untranslated_pages(self):
        pages = list(range(1, 97))
        saved = list(range(1, 61))
        write_json_atomic(self.ws.paper_path, {"meta": {"pages": [{"n": n} for n in pages]},
                          "translation": {"done_pages": saved}, "blocks": [{"id": "p1", "zh": "译文"}]})
        write_json_atomic(self.ws.root / "job.json", {"state": "running", "translate": True, "pages": pages})
        self.jobs._resume()
        before = self.ws.load("paper")
        with patch("easyread.server.jobs.config.load", return_value={"engine": "codex"}), \
                patch("easyread.server.jobs.translate.translate_pages", return_value={}) as translate:
            self.drain()
        self.assertEqual(translate.call_args.args[2], pages[60:])
        self.assertEqual(self.ws.load("paper"), before)

    def test_retranslate_after_restart_keeps_explicit_pages_until_their_new_result_is_saved(self):
        from easyread.library.paperdata import merge_blocks
        pages = [1, 2, 3]
        write_json_atomic(self.ws.paper_path, {"meta": {"pages": [{"n": n} for n in pages]},
                          "translation": {"done_pages": pages, "en_pages": [3]}})
        self.jobs.enqueue(self.ws, pages=pages)
        merge_blocks(self.ws, {"blocks": []}, done=[1])
        self.jobs.bulk.get_nowait()
        self.jobs._write(self.ws, state="running")
        self.jobs._resume()
        with patch("easyread.server.jobs.config.load", return_value={"engine": "codex"}), \
                patch("easyread.server.jobs.translate.translate_pages", return_value={}) as translate:
            self.drain()
        self.assertEqual(translate.call_args.args[2], [2, 3])

    def test_small_job_ids_are_unique_with_frozen_clock(self):
        with patch("time.time", return_value=1):
            ids = {self.jobs.submit_small("answer", self.ws.id, note="n1")["id"] for _ in range(10)}
        self.assertEqual(len(ids), 10)

    def test_removed_paper_does_not_leave_small_job_queued_forever(self):
        job = self.jobs.submit_small("answer", self.ws.id, note="n1")
        self.lib.trash(self.ws.id)
        self.drain(small=True)
        self.assertEqual(self.jobs.small_status()[0]["state"], "error")
        self.assertIn("已移除", job["message"])
