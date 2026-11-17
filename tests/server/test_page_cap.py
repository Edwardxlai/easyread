"""整篇任务超过页数上限先确认；假引擎保留真实的翻译调度和落盘路径。"""
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.app import config
from easyread.server import settings_api
from easyread.translate import translate_api
from easyread.server.jobs import Jobs
from easyread.library.library import Library
from easyread.library.store import Workspace, write_json_atomic
from tests.server.test_jobs import StopWorker


class PageCapTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.lib = Library(Path(temp.name))
        self.cfg = {"engine": "openai", "page_cap": 60, "batch_pages": 200, "concurrency": 1,
                    "target": "zh", "openai": {"vision": False}}
        self.calls = []
        for p in (patch("easyread.server.jobs.config.load", side_effect=lambda: self.cfg),
                  patch("easyread.engines.engines.run", side_effect=self.fake_engine),
                  patch("easyread.translate.translate.netcheck.problem", return_value=""),
                  patch("easyread.translate.translate.pdfwork.locate"),
                  patch("easyread.translate.translate.tex_problems", return_value=[]),
                  patch("easyread.app.i18n.lang", return_value="zh")):
            p.start()
            self.addCleanup(p.stop)
        with patch("easyread.server.jobs.threading.Thread.start"):
            self.jobs = Jobs(self.lib)

    def paper(self, count, pid="paper0001"):
        root = self.lib.root / pid
        (root / "extract").mkdir(parents=True, exist_ok=True)
        ws = Workspace(root)
        pages = [{"n": n, "w": 600, "h": 800, "img": f"pages/page-{n:03d}.webp"} for n in range(1, count + 1)]
        write_json_atomic(ws.paper_path, {"meta": {"pages": pages, "page_count": count},
                                          "translation": {"done_pages": []}, "blocks": []})
        return ws

    def test_task_instructions_survive_confirmation_and_retry_but_not_new_jobs(self):
        ws = self.paper(1)
        self.jobs.enqueue(ws, translation_extra="Keep agent in English")
        self.jobs._write(ws, state="confirm")
        translate_api.enqueue(self.jobs, ws, {"confirmed": True})
        self.assertEqual(ws.load("job")["translation_extra"], "Keep agent in English")
        self.jobs._write(ws, state="error", failed={"1": "try again"})
        translate_api.enqueue(self.jobs, ws, {"failed": True})
        self.drain()
        self.assertEqual(self.calls[0]["cfg"]["translation_extra"], "Keep agent in English")
        self.assertNotIn("translation_extra", self.cfg)
        translate_api.enqueue(self.jobs, ws, {"pages": "1"})
        self.assertEqual(ws.load("job")["translation_extra"], "")

    def fake_engine(self, cfg, prompt, cwd, images=None, cancel=None, meter=None):
        if "Check all existing labels first" in prompt:
            return '{"selected":[],"labels":[]}'
        match = re.search(r"这次只(?:处理|翻译)第 ([\d, ]+) 页", prompt)
        pages = [int(n) for n in match[1].split(",")]
        self.calls.append({"pages": pages, "cfg": cfg, "root": str(cwd)})
        if "要翻译的内容（键 → 英文）：\n" in prompt:
            items = json.loads(prompt.split("要翻译的内容（键 → 英文）：\n", 1)[1])
            return json.dumps({"zh": {key: "译文" for key in items}})
        return json.dumps({"blocks": [{"id": f"p{n}-1", "type": "para", "page": n, "en": "Original text", "zh": "译文"} for n in pages]})

    def structured(self, ws, pages):
        def apply(paper):
            paper["translation"].update(done_pages=pages, en_pages=pages)
            paper["blocks"] = [{"id": f"p{n}-1", "type": "para", "page": n, "en": "Original text"} for n in pages]
        ws.update("paper", apply)

    def drain(self):
        get = self.jobs.bulk.get

        def next_job():
            if self.jobs.bulk.empty():
                raise StopWorker()
            return get()
        with patch.object(self.jobs.bulk, "get", side_effect=next_job), self.assertRaises(StopWorker):
            self.jobs._bulk_loop()

    def test_eighty_pages_wait_without_model_or_usage_and_not_busy(self):
        ws = self.paper(80)
        self.jobs.enqueue(ws, scope="all")
        with patch("easyread.server.jobs.usage.Meter") as meter:
            self.drain()
        meter.assert_not_called()
        self.assertEqual(self.calls, [])
        job = ws.load("job")
        self.assertEqual((job["state"], job["total"], job["page_cap"]), ("confirm", 80, 60))
        self.assertEqual(job["usage"], {})
        self.assertIn("要译 80 页", job["message"])
        self.assertFalse(self.jobs.busy())
        self.assertNotIn(ws.id, self.jobs.cancels)

    def test_confirmed_task_translates_all_eighty_pages(self):
        ws = self.paper(80)
        self.jobs.enqueue(ws)
        self.drain()
        self.assertEqual(translate_api.enqueue(self.jobs, ws, {"confirmed": True}), {"ok": True})
        self.drain()
        self.assertEqual(ws.load("job")["state"], "done")
        self.assertEqual(ws.load("paper")["translation"]["done_pages"], list(range(1, 81)))
        self.assertEqual(self.calls[0]["pages"], list(range(1, 81)))

    def test_explicit_range_eighty_pages_is_not_intercepted(self):
        ws = self.paper(80)
        self.jobs.enqueue(ws, scope="range:1-80")
        self.drain()
        self.assertEqual(ws.load("job")["state"], "done")
        self.assertEqual(len(self.calls[0]["pages"]), 80)

    def test_zero_cap_is_unlimited(self):
        self.cfg["page_cap"] = 0
        ws = self.paper(80)
        self.jobs.enqueue(ws)
        self.drain()
        self.assertEqual(ws.load("job")["state"], "done")
        self.assertEqual(len(self.calls[0]["pages"]), 80)

    def test_forty_pages_are_not_intercepted(self):
        ws = self.paper(40)
        self.jobs.enqueue(ws)
        self.drain()
        self.assertEqual(ws.load("job")["state"], "done")
        self.assertEqual(len(self.calls[0]["pages"]), 40)

    def test_body_scope_seventy_pages_waits(self):
        ws = self.paper(80)
        (ws.root / "extract" / "page-070.txt").write_text("Conclusion\nReferences\n[1] A. B.", encoding="utf-8")
        self.jobs.enqueue(ws, scope="body")
        self.drain()
        self.assertEqual((ws.load("job")["state"], ws.load("job")["total"]), ("confirm", 70))
        self.assertEqual(self.calls, [])

    def test_explicit_pages_are_not_intercepted(self):
        ws = self.paper(80)
        self.jobs.enqueue(ws, pages=list(range(1, 81)))
        self.drain()
        self.assertEqual(ws.load("job")["state"], "done")
        self.assertEqual(len(self.calls[0]["pages"]), 80)

    def test_translating_eighty_structured_english_pages_still_requires_confirmation(self):
        ws = self.paper(100)
        pages = list(range(1, 81))
        self.structured(ws, pages)
        translate_api.enqueue(self.jobs, ws, {"en": True})
        queued = ws.load("job")
        self.assertEqual(queued["scope"], "all")
        self.assertFalse(queued["read"])
        self.assertEqual(queued["pages"], pages)
        self.assertIs(queued["cap_check"], True)
        self.drain()
        job = ws.load("job")
        self.assertEqual((job["state"], job["total"]), ("confirm", 80))
        self.assertEqual((job["pages"], job["cap_check"]), (pages, True))
        summary = self.lib.summary(ws)["job"]
        self.assertEqual((summary["pages"], summary["cap_check"]), (pages, True))
        self.assertEqual(self.calls, [])
        # 等确认时后来又整理了页，确认的仍是最初计划，不能扩大到整篇。
        ws.update("paper", lambda p: p["translation"].update(done_pages=list(range(1, 91)), en_pages=list(range(1, 91))))
        translate_api.enqueue(self.jobs, ws, {"confirmed": True})
        self.drain()
        self.assertEqual(self.calls[0]["pages"], pages)

    def test_translate_structured_english_only_handles_ten_pages_even_without_cap(self):
        for cap in (60, 0):
            with self.subTest(cap=cap):
                self.cfg["page_cap"] = cap
                ws = self.paper(100, "partial" + str(cap))
                pages = list(range(1, 11))
                self.structured(ws, pages)
                translate_api.enqueue(self.jobs, ws, {"en": True})
                self.drain()
                self.assertEqual(ws.load("job")["state"], "done")
                self.assertEqual(self.calls[-1]["pages"], pages)

    def test_empty_english_page_plan_does_not_fall_back_to_whole_paper(self):
        ws = self.paper(100)
        self.cfg["page_cap"] = 0
        translate_api.enqueue(self.jobs, ws, {"en": True})
        self.drain()
        self.assertEqual(ws.load("job")["state"], "done")
        self.assertEqual(self.calls, [])

    def test_first_pages_choice_only_translates_structured_pages_in_waiting_plan(self):
        ws = self.paper(100)
        pages = list(range(11, 91))
        self.structured(ws, pages)
        translate_api.enqueue(self.jobs, ws, {"en": True})
        self.drain()
        self.assertEqual(ws.load("job")["state"], "confirm")
        translate_api.enqueue(self.jobs, ws, {"scope": "range:1-60"})
        self.drain()
        self.assertEqual(self.calls[0]["pages"], list(range(11, 61)))

    def test_only_remaining_pages_count_toward_cap(self):
        ws = self.paper(80)
        ws.update("paper", lambda p: p["translation"].update(done_pages=list(range(1, 31))))
        self.jobs.enqueue(ws)
        self.drain()
        self.assertEqual(self.calls[0]["pages"], list(range(31, 81)))

    def test_confirmed_requires_json_true_and_does_not_leak_to_new_tasks(self):
        ws = self.paper(80)
        for value in ("true", "false", 1, 0, None, False):
            with self.subTest(value=value):
                translate_api.enqueue(self.jobs, ws, {"confirmed": value})
                self.assertIs(ws.load("job")["confirmed"], False)
                self.drain()
                self.assertEqual(ws.load("job")["state"], "confirm")
        self.assertEqual(self.calls, [])
        self.jobs._write(ws, confirmed=True)
        self.jobs.enqueue(ws)
        self.assertIs(ws.load("job")["confirmed"], False)
        self.drain()
        self.assertEqual(ws.load("job")["state"], "confirm")

    def test_read_model_target_and_stored_cap_survive_first_pages_choice(self):
        ws = self.paper(80)
        self.jobs.enqueue(ws, read=True, scope="body", model="selected-model", target="fr")
        self.drain()
        job = self.lib.summary(ws)["job"]
        self.assertIn("要整理 80 页", job["message"])
        self.assertEqual((job["read"], job["model"], job["target"], job["page_cap"]), (True, "selected-model", "fr", 60))
        self.cfg.update(page_cap=30, target="de")
        translate_api.enqueue(self.jobs, ws, {"scope": "range:1-" + str(job["page_cap"])})
        queued = ws.load("job")
        self.assertEqual((queued["read"], queued["model"], queued["target"], queued["scope"]), (True, "selected-model", "fr", "range:1-60"))
        self.drain()
        self.assertEqual(self.calls[0]["pages"], list(range(1, 61)))
        self.assertEqual(self.calls[0]["cfg"]["target"], "fr")
        self.assertEqual(ws.load("paper")["translation"]["en_pages"], list(range(1, 61)))

    def test_confirm_all_preserves_original_scope_read_model_and_target(self):
        ws = self.paper(80)
        self.jobs.enqueue(ws, read=True, scope="body", model="selected-model", target="fr")
        self.drain()
        translate_api.enqueue(self.jobs, ws, {"confirmed": True})
        job = ws.load("job")
        self.assertEqual((job["scope"], job["read"], job["model"], job["target"]), ("body", True, "selected-model", "fr"))
        self.drain()
        self.assertEqual(len(self.calls[0]["pages"]), 80)

    def test_cancel_pending_task_is_done_and_retains_context(self):
        ws = self.paper(80)
        for read in (False, True):
            self.jobs.enqueue(ws, read=read, scope="body", model="selected-model")
            self.drain()
            before = ws.load("job")
            self.jobs.cancel(ws.id)
            after = ws.load("job")
            self.assertEqual(after["state"], "done")
            self.assertEqual(after["message"], "已导入，未整理" if read else "已导入，未翻译")
            for key in ("scope", "read", "model", "target", "page_cap"):
                self.assertEqual(after[key], before[key])
        self.assertEqual(self.calls, [])

    def test_restart_leaves_confirmation_pending(self):
        ws = self.paper(80)
        self.jobs.enqueue(ws)
        self.drain()
        before = ws.load("job")
        with patch("easyread.server.jobs.threading.Thread.start"):
            resumed = Jobs(self.lib)
        self.assertEqual(ws.load("job"), before)
        self.assertTrue(resumed.bulk.empty())
        self.assertFalse(resumed.busy())

    def test_waiting_large_paper_does_not_block_next_small_paper(self):
        big, small = self.paper(80), self.paper(40, "paper0002")
        self.jobs.enqueue(big)
        self.jobs.enqueue(small)
        self.drain()
        self.assertEqual(big.load("job")["state"], "confirm")
        self.assertEqual(small.load("job")["state"], "done")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["root"], str(small.root))

    def test_preparation_finishes_before_interception(self):
        ws = self.paper(80)
        prepared = ws.load("paper")
        write_json_atomic(ws.paper_path, {"meta": {}})
        self.jobs.enqueue(ws)
        with patch("easyread.server.jobs.translate.prepare", side_effect=lambda ws: write_json_atomic(ws.paper_path, prepared)) as prepare:
            self.drain()
        prepare.assert_called_once()
        self.assertEqual(ws.load("job")["state"], "confirm")
        self.assertEqual(self.calls, [])

    def test_settings_accepts_nonnegative_integers_only(self):
        self.assertEqual(config.DEFAULTS["page_cap"], 60)
        for invalid in (-1, True, False, 60.5, "60", None, [], {}):
            with self.subTest(value=invalid), patch.object(settings_api.config, "save") as save:
                with self.assertRaisesRegex(ValueError, "非负整数"):
                    settings_api.save_config({"page_cap": invalid})
                save.assert_not_called()
        for cap in (0, 30, 60, 100, 200):
            with patch.object(settings_api.config, "save", side_effect=lambda p: p), \
                    patch.object(settings_api.config, "public", side_effect=lambda c: c):
                self.assertEqual(settings_api.save_config({"page_cap": cap}), {"config": {"page_cap": cap}})
