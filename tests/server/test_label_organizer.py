import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from easyread.library import paper_labels as tags
from easyread.chat import label_review as planner
from easyread.library import label_review
from easyread.library.library import Library
from easyread.library.store import read_json, write_json_atomic
from easyread.server import label_organizer, library_api


class OrganizerTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.library = Library(Path(directory.name))
        self.app = SimpleNamespace(lib=self.library)
        self.app.location = library_api.LibraryLocation(self.app)
        for name in ("paper-one", "paper-two"):
            root = self.library.root / name
            root.mkdir()
            write_json_atomic(root / "paper.json", {"meta": {"title_en": name},
                "blocks": [{"id": "methods", "type": "para", "page": 3,
                            "en": "We conducted a field study using surveys of 23 participants."}]})
        tags._save(self.library.root, {t.name.casefold(): t for t in (
            tags.Label("Manual", "Studies using surveys"),
            tags.Label("AI synonym", "Studies using surveys", origin="ai"),
            tags.Label("Keep me", "Qualitative field studies"))})
        tags.edit(self.library.root, self.library.ws("paper-one"), {"add": ["AI synonym"]})
        self.url = "/api/library/labels/organize"

    def model(self, prompt, data, **options):
        if "sources" in data:
            existing = next(i for i, label in data["labels"].items() if label["name"] == "Manual")
            source = next(iter(data["sources"]))
            quote = "field study using surveys of 23 participants"
            self.assertIn(quote, data["sources"][source])
            return {"matches": [{"id": existing, "source": source, "quote": quote}],
                    "suggestions": [{"name": "Field studies", "rule": "Reports a field study",
                                     "source": source, "quote": quote}]}
        ids = {tag["name"]: tag["id"] for tag in data["catalog"]}
        new_name = "Survey in the field" if data["reviewer_conversation"] else "Field research"
        return {"creates": [{"name": new_name, "rule": "Reports survey data from a field study",
                             "reason": "Shared methodology", "candidates": [0]}],
                "merges": [{"source": ids["Keep me"], "target": ids["Manual"], "reason": "Bad merge"},
                           {"source": ids["AI synonym"], "target": ids["Manual"], "reason": "Same criteria"}],
                "reply": "Review the two suggestions."}

    def post(self, action, **body):
        return library_api.post(self.app, self.url + "/" + action, body)

    def wait(self, state):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status = library_api.get(self.app, self.url)
            if status["state"] == state and not label_organizer.busy(self.app):
                return status
            time.sleep(.01)
        self.fail(status)

    def test_scan_feedback_and_one_checked_confirmation(self):
        with patch("easyread.chat.paper_labeling._ask", side_effect=self.model):
            initial = self.post("start")
            job = self.wait("review")
            self.assertEqual(job["id"], initial["id"])
            self.assertEqual((job["done"], job["assigned"]), (2, 2))
            self.assertEqual({t.name for t in tags.available(self.library).values()}, {"Keep me", "Manual", "AI synonym"})
            self.assertEqual(len(job["proposals"]), 2)
            opts = {"id": job["id"], "revision": job["revision"]}
            self.post("feedback", **opts, message="Mention surveys in the new name")
            revised = self.wait("review")
            with self.assertRaises(ValueError):
                self.post("confirm", **opts, selected=[])
            self.assertEqual(revised["revision"], job["revision"] + 1)
            new, merge = revised["proposals"]
            self.assertEqual(new["name"], "Survey in the field")
            self.assertEqual({p["page"] for p in new["papers"]}, {3})
            self.assertEqual(len(new["papers"]), 2)
            self.assertEqual(merge["source"], "AI synonym")
            confirm = dict(id=job["id"], revision=revised["revision"], selected=[merge["id"]])
            self.post("confirm", **confirm)
            self.wait("complete")
            self.assertEqual(self.post("confirm", **confirm)["state"], "complete")
            self.assertEqual(set(tags.available(self.library)), {"keep me", "manual"})
            self.assertEqual(tags.available(self.library)["manual"].aliases, ("AI synonym",))
            for ws in self.library.all():
                self.assertEqual(ws.load("item")["labels"], ["Manual"])
            self.assertEqual(self.app.location.active, 0)

    def test_synthesis_can_compare_candidates_to_papers_with_user_tags(self):
        catalog = {"field": tags.Label("Field", "Conducted fieldwork", aliases=("On site",)),
                   "other": tags.Label("Other", origin="ai")}
        records = [{"id": "first", "title": "First", "labels": ["On site", "Field", "Other"]},
                   {"id": "second", "title": "Second", "labels": ["Other"], "suggestions": [
                       {"name": "Surveys", "rule": "Used questionnaires", "quote": "We ran a survey."}]}]
        with patch("easyread.chat.paper_labeling._ask", return_value={"creates": [], "merges": []}) as model:
            planner.synthesize(catalog, records, [], [], None)
        data = model.call_args.args[1]
        self.assertEqual(data["papers_with_user_defined_tags"], {"Field": [1]})
        self.assertEqual(data["candidates"][0]["papers"], [2])

    def test_two_synonyms_from_one_paper_do_not_qualify_as_a_library_tag(self):
        record = {"id": "only-one-paper", "title": "Survey",
                  "suggestions": [{"name": name, "rule": "Collects survey responses",
                                   "quote": "We ran a survey.", "page": 1}
                                  for name in ("Survey", "Questionnaire")]}
        proposed = {"creates": [{"name": "Survey research", "rule": "Collects survey responses",
                                 "candidates": [0, 1]}], "merges": [], "reply": ""}
        with patch("easyread.chat.paper_labeling._ask", return_value=proposed) as model:
            rows, _ = planner.synthesize({}, [record], [], [], None)
            self.assertEqual(rows, [])
            candidates = model.call_args.args[1]["candidates"]
            self.assertEqual([c["papers"] for c in candidates], [[1], [1]])

    def test_confirmation_preserves_edited_ai_rules_manual_removals_and_notes(self):
        with patch("easyread.chat.paper_labeling._ask", side_effect=self.model):
            self.post("start")
            job = self.wait("review")
            tags.set_rule(self.library, {"name": "AI synonym", "rule": "User-edited rule"})
            ws = self.library.ws("paper-one")
            ws.patch_item({"tags": ["Reading group"], "status": "done"})
            ws.update("item", lambda i: i.update(label_exclusions=["Field research"]))
            selected = [p["id"] for p in job["proposals"]]
            self.post("confirm", id=job["id"], revision=job["revision"], selected=selected)
            done = self.wait("complete")
            self.assertEqual(len(done["applied"]), 1)
            self.assertEqual(len(done["warnings"]), 1)
            self.assertEqual(tags.available(self.library)["ai synonym"].origin, "user")
            self.assertEqual(ws.load("item")["labels"], ["AI synonym", "Manual"])
            self.assertEqual(ws.load("item")["tags"], ["Reading group"])
            self.assertEqual(ws.load("item")["status"], "done")
            other = self.library.ws("paper-two").load("item")
            self.assertIn("Field research", other["labels"])
            self.assertEqual(other["label_evidence"]["Field research"]["page"], 3)

    def test_checkpoint_resumes_without_repeating_completed_papers(self):
        started = threading.Event()
        calls = []

        def slow(prompt, data, **opts):
            if "sources" in data:
                calls.append(data["title"])
                if data["title"] == "paper-two" and len(calls) == 2:
                    started.set()
                    self.assertTrue(opts["cancel"].wait(3))
            return self.model(prompt, data, **opts)

        with patch("easyread.chat.paper_labeling._ask", side_effect=slow):
            job = self.post("start")
            self.assertTrue(started.wait(3))
            self.assertEqual(self.post("start")["id"], job["id"])
            self.post("pause", id=job["id"])
            paused = self.wait("paused")
            self.assertEqual(paused["done"], 1)
            # A different server process sees an unfinished journal as resumable after a crash.
            stored = read_json(self.library.root / label_organizer.STATE)
            stored["state"] = "running"
            write_json_atomic(self.library.root / label_organizer.STATE, stored)
            del self.app.label_organizer
            self.assertEqual(library_api.get(self.app, self.url)["state"], "paused")
            self.post("resume", id=job["id"])
            self.wait("review")
            self.assertEqual(calls, ["paper-one", "paper-two", "paper-two"])

    def test_retry_after_catalog_write_reconciles_merged_assignments(self):
        with patch("easyread.chat.paper_labeling._ask", side_effect=self.model):
            self.post("start")
            job = self.wait("review")
            merge = job["proposals"][1]
            opts = dict(id=job["id"], revision=job["revision"], selected=[merge["id"]])
            with patch.object(label_review, "_transfer", side_effect=OSError("fixture write interrupted")), \
                    self.assertLogs("easyread", level="ERROR"):
                self.post("confirm", **opts)
                self.wait("error")
            self.assertNotIn("ai synonym", tags.available(self.library))
            self.assertIn("AI synonym", self.library.ws("paper-one").load("item")["labels"])
            tags.set_rule(self.library, {"name": "Manual", "rule": "Narrower rule edited during recovery"})
            self.post("resume", id=job["id"])
            self.wait("complete")
            self.assertEqual(self.library.ws("paper-one").load("item")["labels"], ["Manual"])
            self.assertEqual(tags.available(self.library)["manual"].rule, "Narrower rule edited during recovery")
            self.assertEqual(self.post("confirm", **opts)["applied"], [merge["id"]])
