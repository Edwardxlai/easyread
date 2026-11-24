import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.app import prefs
from easyread.server.jobs import Jobs
from easyread.engines.engines import EngineError
from easyread.library import paper_labels
from easyread.library.library import Library
from easyread.library.store import Workspace, write_json_atomic


def analysis(matches=(), suggestions=()):
    quote = "A survey on how small groups communicate"
    return json.dumps({"matches": [{"id": i, "source": 1, "quote": quote} for i in matches],
                       "suggestions": [dict(row, source=1, quote=quote) for row in suggestions]})


class StopWorker(Exception):
    pass


class JobsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lib = Library(Path(self.tmp.name))
        pref_path = patch.object(prefs, "path", return_value=self.lib.root / ".prefs.json")
        pref_path.start()
        self.addCleanup(pref_path.stop)
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

    def _save_translated_page(self, ws, cfg, pages, cancel, report, meter, read):
        def update(paper):
            paper["meta"]["title_en"] = "Group communication in virtual reality"
            paper["meta"]["abstract_en"] = "A survey on how small groups communicate in virtual reality."
            paper["translation"] = {"done_pages": pages, "en_pages": pages if read else []}
        ws.update("paper", update)
        report(len(pages), len(pages), "Saved")
        return {}

    def test_translation_can_assign_a_label_while_category_review_stays_pending(self):
        prefs.save({"library": {"ai_labels": True}, "ui": {"features": {"category_suggestions": True}}})
        paper_labels.create(self.lib.root, "Surveys")
        paper_labels.set_rule(self.lib, {"name": "Surveys", "rule": "Reports a survey"})

        def respond(cfg, prompt, *args, **kwargs):
            payload = json.loads(prompt.splitlines()[-1])
            if "categories" in payload:
                return json.dumps({"suggestions": [{"name": "Group studies", "reason": "Studies small groups"}]})
            return analysis([1])

        with patch("easyread.server.jobs.config.load", return_value={"engine": "codex", "codex": {}}), \
                patch("easyread.server.jobs.translate.translate_pages", side_effect=self._save_translated_page), \
                patch("easyread.engines.engines.run", side_effect=respond):
            self.jobs.enqueue(self.ws, pages=[1])
            self.drain()
        item = self.ws.load("item")
        self.assertEqual(item["labels"], ["Surveys"])
        self.assertEqual(item["category_review"]["state"], "pending")
        self.assertEqual(item["category_review"]["options"][0]["name"], "Group studies")
        self.assertNotIn("Group studies", item.get("tags", []))

    def test_translation_auto_labels_once_and_prefers_existing_rules(self):
        prefs.save({"library": {"ai_label_match": True, "ai_label_create": True}})
        for name, rule in (("VR", "Studies of virtual reality"), ("Surveys", "Studies that report a survey")):
            paper_labels.create(self.lib.root, name)
            paper_labels.set_rule(self.lib, {"name": name, "rule": rule})
        paper_labels.edit(self.lib.root, self.ws, {"add": ["VR"]})
        cfg = {"engine": "codex", "codex": {"model": "the-translation-model"}}

        def classify(actual, prompt, cwd, *, cancel, meter):
            self.assertEqual(actual["codex"]["model"], "the-translation-model")
            self.assertIsNotNone(meter)
            self.assertFalse(cancel.is_set())
            self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [1])
            data = json.loads(prompt.splitlines()[-1])
            self.assertEqual({entry["name"]: entry["rule"] for entry in data["labels"].values()},
                             {"Surveys": "Studies that report a survey", "VR": "Studies of virtual reality"})
            return analysis([1, 2], [{"name": "Redundant", "rule": "Another name for VR"}])

        with patch("easyread.server.jobs.config.load", return_value=cfg), \
                patch("easyread.server.jobs.translate.translate_pages", side_effect=self._save_translated_page), \
                patch("easyread.chat.paper_labeling.engines.run", side_effect=classify) as model:
            self.jobs.enqueue(self.ws, pages=[1])
            self.drain()
            self.assertEqual(self.ws.load("job")["state"], "done")
            self.assertEqual(self.ws.load("item")["labels"], ["VR", "Surveys"])
            self.assertTrue(self.ws.load("item")[paper_labels.TRANSLATION_DONE])
            self.assertNotIn("redundant", paper_labels.available(self.lib))

            paper_labels.edit(self.lib.root, self.ws, {"remove": ["Surveys"]})
            self.jobs.enqueue(self.ws, pages=[1])
            self.drain()
            model.assert_called_once()
            self.assertEqual(self.ws.load("item")["labels"], ["VR"])

    def test_translation_labels_retry_after_failure_and_create_only_without_matches(self):
        prefs.save({"library": {"ai_label_match": True, "ai_label_create": True}})
        paper_labels.create(self.lib.root, "Field trials")
        cfg = {"engine": "codex", "codex": {}}
        result = analysis(suggestions=[{"name": "Virtual groups", "rule": "Studies group behavior in virtual environments"}])
        with patch("easyread.server.jobs.config.load", return_value=cfg), \
                patch("easyread.server.jobs.translate.translate_pages", side_effect=self._save_translated_page) as translate, \
                patch("easyread.chat.paper_labeling.engines.run", side_effect=[EngineError("temporary model error"), result]) as model, \
                self.assertLogs("easyread", level="WARNING"):
            self.jobs.enqueue(self.ws, pages=[1])
            self.drain()
            self.assertEqual(self.ws.load("job")["state"], "done")
            self.assertNotIn(paper_labels.TRANSLATION_DONE, self.ws.load("item"))
            self.jobs.enqueue(self.ws)  # The translated page is already saved.
            self.drain()
            translate.assert_called_once()
            self.assertEqual(model.call_count, 2)
        self.assertEqual(self.ws.load("item")["labels"], ["Virtual groups"])
        self.assertTrue(self.ws.load("item")[paper_labels.TRANSLATION_DONE])
        self.assertEqual(paper_labels.available(self.lib)["virtual groups"].rule,
                         "Studies group behavior in virtual environments")

    def test_translation_tagging_skips_read_mode_and_failed_translation(self):
        prefs.save({"library": {"ai_label_match": True, "ai_label_create": True}})
        cfg = {"engine": "codex", "codex": {}}
        with patch("easyread.server.jobs.config.load", return_value=cfg), \
                patch("easyread.server.jobs.translate.translate_pages", side_effect=self._save_translated_page) as translate, \
                patch("easyread.chat.paper_labeling.engines.run") as model:
            self.jobs.enqueue(self.ws, pages=[1], read=True)
            self.drain()
            translate.side_effect = None
            translate.return_value = {1: "No translated text"}
            self.jobs.enqueue(self.ws, pages=[1])
            self.drain()
            self.assertEqual(self.ws.load("job")["state"], "partial")
            model.assert_not_called()

    def test_translation_waits_for_body_completion_and_checks_newly_saved_pages(self):
        from easyread.chat import paper_labeling

        cfg = {"engine": "codex", "codex": {}}
        texts = ["Prior work mentioned eye tracking.", "We recorded free speech.", "We estimated vowel duration."]
        self.ws.update("paper", lambda p: p.update(meta={"page_count": 3}, translation={"done_pages": [1]},
                       blocks=[{"id": f"p{i}", "type": "para", "page": i, "en": text}
                               for i, text in enumerate(texts, 1)]))
        def classify(page):
            paper_labeling.after_translation(self.lib, self.ws, cfg, threading.Event(), [page], report=lambda msg: None)

        def propose(instructions, data, **kwargs):
            source, quote = next(iter(data["sources"].items()))
            return {"matches": [], "suggestions": [{"name": "Acoustics", "rule": "Studies vowel acoustics.",
                                                    "source": source, "quote": quote}]}

        with patch.object(paper_labeling, "_ask", side_effect=propose) as ask:
            classify(1)
            ask.assert_not_called()
            prefs.save({"library": {"ai_labels": True}})
            classify(1)
            self.assertEqual(list(ask.call_args.args[1]["sources"].values()), texts[:1])
            self.assertEqual(self.ws.load("item")["labels"], [])
            self.assertEqual(self.ws.load("item")["label_checked_pages"], [1])
            classify(1)
            ask.assert_called_once()
            self.ws.update("paper", lambda p: p["translation"].update(done_pages=[1, 2]))
            classify(2)
            self.assertEqual(list(ask.call_args.args[1]["sources"].values()), texts[1:2])
            self.assertFalse(self.ws.load("item")[paper_labels.TRANSLATION_DONE])
            self.ws.update("paper", lambda p: p["translation"].update(done_pages=[1, 2, 3]))
            classify(3)
            self.assertEqual(list(ask.call_args.args[1]["sources"].values()), texts)
            item = self.ws.load("item")
            self.assertEqual(item["labels"], ["Acoustics"])
            self.assertEqual(item["label_checked_pages"], [1, 2, 3])
            self.assertTrue(item[paper_labels.TRANSLATION_DONE])
            self.assertEqual(paper_labels.available(self.lib)["acoustics"].origin, "ai")

    def test_switching_off_during_translation_drops_pending_result_and_allows_retry(self):
        from easyread.chat import paper_labeling

        cfg = {"engine": "codex", "codex": {}}
        self.ws.update("paper", lambda p: p.update(translation={"done_pages": [1]},
                       meta={"page_count": 1, "abstract_en": "We studied voter turnout."}))
        def disable(*args, **kwargs):
            prefs.save({"library": {"ai_labels": False}})
            return {"matches": [], "suggestions": []}

        prefs.save({"library": {"ai_labels": True}})
        with patch.object(paper_labeling, "_ask", side_effect=disable):
            paper_labeling.after_translation(self.lib, self.ws, cfg, threading.Event(), [1], report=lambda msg: None)
        self.assertFalse((self.ws.load("item") or {}).get("label_checked_pages"))

    def test_rule_changes_during_translation_keep_valid_matches_and_leave_tagging_retryable(self):
        prefs.save({"library": {"ai_label_match": True}})
        for name in ("Changed", "Removed", "Stable"):
            paper_labels.create(self.lib.root, name)
        paper_labels.edit(self.lib.root, self.ws, {"add": ["Removed"]})
        cfg = {"engine": "codex", "codex": {}}

        def classify(cfg, prompt, cwd, **kwargs):
            paper_labels.set_rule(self.lib, {"name": "Changed", "rule": "Only longitudinal studies"})
            paper_labels.edit(self.lib.root, self.ws, {"remove": ["Removed"]})
            return analysis([1, 2, 3])

        with patch("easyread.server.jobs.config.load", return_value=cfg), \
                patch("easyread.server.jobs.translate.translate_pages", side_effect=self._save_translated_page) as translate, \
                patch("easyread.chat.paper_labeling.engines.run", side_effect=classify) as model:
            self.jobs.enqueue(self.ws, pages=[1])
            self.drain()
            self.assertEqual(self.ws.load("item")["labels"], ["Stable"])
            self.assertNotIn(paper_labels.TRANSLATION_DONE, self.ws.load("item"))
            model.side_effect = None
            model.return_value = analysis([3])
            self.jobs.enqueue(self.ws)
            self.drain()
            self.assertTrue(self.ws.load("item")[paper_labels.TRANSLATION_DONE])
            translate.assert_called_once()

    def test_cancel_during_tagging_preserves_translated_page_and_skips_label_writes(self):
        prefs.save({"library": {"ai_label_create": True}})
        def classify(*args, **kwargs):
            self.jobs.cancel(self.ws.id)
            return analysis(suggestions=[{"name": "Late", "rule": "Should not be applied"}])

        with patch("easyread.server.jobs.config.load", return_value={"engine": "codex", "codex": {}}), \
                patch("easyread.server.jobs.translate.translate_pages", side_effect=self._save_translated_page), \
                patch("easyread.chat.paper_labeling.engines.run", side_effect=classify):
            self.jobs.enqueue(self.ws, pages=[1])
            self.drain()
        self.assertEqual(self.ws.load("job")["state"], "cancelled")
        self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [1])
        self.assertNotIn(paper_labels.TRANSLATION_DONE, self.ws.load("item"))
        self.assertEqual(paper_labels.available(self.lib), {})

    def test_offline_cli_can_retry_pending_tags_without_retranslating(self):
        from argparse import Namespace
        from easyread.app import cli
        prefs.save({"library": {"ai_label_match": True, "ai_label_create": True}})
        self.ws.update("paper", lambda p: p.update(meta={"title_en": "Survey", "abstract_en": "We ran a survey.", "pages": [{"n": 1}]},
                                                    translation={"done_pages": [1]}))
        with patch.object(cli, "find", return_value=self.ws), patch.object(cli, "running_server", return_value=None), \
                patch.object(cli, "out"), patch.object(cli.config, "load", return_value={"engine": "codex", "codex": {}}), \
                patch("easyread.translate.translate.translate_pages") as translate, \
                patch("easyread.chat.paper_labeling.engines.run", return_value=analysis()) as model:
            for _ in range(2):
                cli.cmd_translate(Namespace(id=self.ws.id, pages=None))
            translate.assert_not_called()
            model.assert_called_once()
            self.assertTrue(self.ws.load("item")[paper_labels.TRANSLATION_DONE])

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
