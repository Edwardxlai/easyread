"""Use the library HTTP routes and replace only the outbound model call."""
import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from easyread.app import config, prefs
from easyread.library import paper_labels
from easyread.library.library import Library
from easyread.library.store import write_json_atomic
from easyread.server.library_api import LibraryLocation
from easyread.server.server import Handler


class PaperLabelsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        pref_path = patch.object(prefs, "path", return_value=root / "prefs.json")
        pref_path.start()
        self.addCleanup(pref_path.stop)
        cfg = patch.object(config, "CONFIG_PATH", root / "config.json")
        cfg.start()
        self.addCleanup(cfg.stop)
        config.save({"engine": "none", "chat": {"default": "fixture", "models": [
            {"id": "fixture", "engine": "codex", "model": "fixture-model"},
        ]}})

        library = Library(root / "library")
        self.catalog_path = library.root / paper_labels.CATALOG
        paper = library.root / "example-paper"
        paper.mkdir()
        self.paper = paper
        write_json_atomic(paper / "paper.json", {"meta": {
            "title_en": "Dialogue in social VR", "abstract_en": "We survey small groups using virtual reality."
        }})
        write_json_atomic(paper / "item.json", {"tags": ["Methods/Survey"], "status": "reading"})
        self.paper_path = "/api/p/example-paper/labels"
        self.model_call = "easyread.chat.paper_labeling.engines.run"
        app = SimpleNamespace(lib=library, token="fixture-token", jobs=SimpleNamespace(small_status=lambda: []))
        app.location = LibraryLocation(app)
        handler = type("LabelsHandler", (Handler,), {"app": app, "log_message": lambda *args: None})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.port = server.server_port

    def request(self, path, body=None, token="fixture-token"):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("GET" if body is None else "POST", path, json.dumps(body) if body is not None else None,
                               {"X-Token": token, "Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_manual_edits_preserve_reusable_names_and_categories(self):
        self.assertEqual(self.request("/api/library")[1]["items"][0]["labels"], [])
        self.assertEqual(self.request("/api/library/labels", {"name": "Methods/Survey"}, token="bad")[0], 403)
        self.assertEqual(self.request("/api/library/labels", {"name": "  Methods/Survey "}),
                         (200, {"name": "Methods/Survey"}))
        status, result = self.request(self.paper_path, {"add": ["methods/survey", "社交 VR", "社交 VR"]})
        self.assertEqual(status, 200)
        self.assertEqual(result["labels"], ["Methods/Survey", "社交 VR"])
        self.assertEqual(self.request(self.paper_path, {"remove": ["METHODS/SURVEY"]})[0], 200)
        _, refreshed = self.request("/api/library")
        self.assertEqual(refreshed["labels"], ["Methods/Survey", "社交 VR"])
        self.assertEqual(refreshed["items"][0]["labels"], ["社交 VR"])
        self.assertEqual(refreshed["items"][0]["tags"], ["Methods/Survey"])
        self.assertEqual(refreshed["items"][0]["status"], "reading")

    def test_independent_opt_ins_control_ai_routes_and_preserve_manual_tags(self):
        self.request(self.paper_path, {"add": ["Manual"]})
        self.request("/api/library/labels", {"name": "Surveys"})
        self.assertEqual(self.request("/api/library")[1]["label_features"], {"ai_label_match": False, "ai_label_create": False})
        for match, create in ((True, False), (True, True), (False, True), (False, False)):
            flags = {"ai_label_match": match, "ai_label_create": create}
            with self.subTest(flags=flags), patch(self.model_call, return_value='{"selected":[],"labels":[]}') as model:
                self.assertEqual(self.request("/api/prefs", {"library": flags})[0], 200)
                self.assertEqual(self.request("/api/library")[1]["label_features"], flags)
                for action, enabled in (("auto", match), ("suggest", create), ("generate", create)):
                    status, result = self.request(self.paper_path + "/" + action, {})
                    self.assertEqual(status, 200 if enabled else 400, result)
                self.assertEqual(model.call_count, int(match) + 2 * int(create))
                self.assertEqual(self.request("/api/library")[1]["items"][0]["labels"], ["Manual"])

    def test_disabling_during_manual_ai_calls_discards_results(self):
        self.request("/api/library/labels", {"name": "Existing"})
        for action, feature in (("auto", prefs.AI_LABEL_MATCH), ("generate", prefs.AI_LABEL_CREATE)):
            prefs.save({"library": {feature: True}})

            def disable(*args, **kwargs):
                self.assertEqual(self.request("/api/prefs", {"library": {feature: False}})[0], 200)
                return '{"selected":[1],"labels":[{"name":"Late","rule":"A new rule"}]}'

            with self.subTest(action=action), patch(self.model_call, side_effect=disable):
                self.assertEqual(self.request(self.paper_path + "/" + action, {})[0], 400)
                library = self.request("/api/library")[1]
                self.assertEqual(library["labels"], ["Existing"])
                self.assertEqual(library["items"][0]["labels"], [])

    def test_unreadable_catalog_keeps_papers_browsable_and_rejects_edits(self):
        self.request(self.paper_path, {"add": ["Assigned"]})
        original = self.catalog_path.read_bytes()
        with patch("easyread.library.paper_labels.read_json", side_effect=PermissionError("unreadable catalog")):
            status, listing = self.request("/api/library")
            self.assertEqual(status, 200, listing)
            self.assertEqual(listing["items"][0]["labels"], ["Assigned"])
            self.assertEqual(listing["labels"], ["Assigned"])
            self.assertEqual(self.request("/api/library/labels", {"name": "Another"})[0], 400)
        self.assertEqual(self.catalog_path.read_bytes(), original)

    def test_structured_references_exclude_citations_when_extracted_heading_is_missing(self):
        prefs.save({"library": {"ai_label_match": True}})
        library = Library(self.paper.parent)
        ws = library.ws(self.paper.name)
        ws.update("paper", lambda paper: paper.update(blocks=[
            {"type": "para", "page": 2, "en": "Our study used surveys."},
            {"type": "references", "page": 2, "en": "References"},
        ]))
        extracts = self.paper / "extract"
        extracts.mkdir()
        (extracts / "page-002.txt").write_text("Our study used surveys. [1] Cited trial.", encoding="utf-8")
        (extracts / "page-003.txt").write_text("Another cited trial.", encoding="utf-8")
        self.request("/api/library/labels", {"name": "Trials"})
        with patch(self.model_call, return_value='{"selected":[]}') as model:
            self.assertEqual(self.request(self.paper_path + "/auto", {}), (200, {"added": []}))
        excerpt = json.loads(model.call_args.args[1].splitlines()[-1])["paper"]["excerpt"]
        self.assertIn("Our study used surveys", excerpt)
        self.assertNotIn("cited trial", excerpt.lower())

    def test_ai_appends_valid_matches_and_merges_a_concurrent_manual_edit(self):
        prefs.save({"library": {"ai_label_match": True}})
        for name in ("VR", "Survey", "Unrelated"):
            self.assertEqual(self.request("/api/library/labels", {"name": name})[0], 200)
        self.assertEqual(self.request(self.paper_path, {"add": ["Manual"]})[0], 200)
        rule = "Include studies using surveys as a research method."
        self.assertEqual(self.request("/api/library/labels/rule", {"name": "Survey", "rule": rule})[0], 200)

        def complete(cfg, prompt, cwd, **options):
            self.assertEqual(cfg["codex"]["model"], "fixture-model")
            self.assertTrue(cfg["codex"]["lean"])
            data = json.loads(prompt.splitlines()[-1])
            self.assertEqual(data["paper"], {
                "title": "Dialogue in social VR", "abstract": "We survey small groups using virtual reality."
            })
            rules = {entry["name"]: entry["rule"] for entry in data["labels"].values()}
            self.assertNotIn("Manual", rules)
            self.assertEqual(rules["Survey"], rule)
            self.assertEqual(rules["VR"], "")
            self.assertIn("only when the paper meets the rule", prompt)
            self.assertEqual(self.request(self.paper_path, {"add": ["Concurrent"], "remove": ["Manual"]})[0], 200)
            selected = [int(i) for i, entry in data["labels"].items() if entry["name"] in ("VR", "Survey")]
            return "```json\n" + json.dumps({"selected": selected + [selected[0], 999, True, "Invented"]}) + "\n```"

        with patch(self.model_call, side_effect=complete) as model:
            status, result = self.request(self.paper_path + "/auto", {})
            model.assert_called_once()
        self.assertEqual(status, 200, result)
        self.assertEqual(result["added"], ["Survey", "VR"])
        _, data = self.request("/api/library")
        self.assertEqual(data["items"][0]["labels"], ["Concurrent", "Survey", "VR"])
        self.assertNotIn("Invented", data["labels"])

    def test_rules_can_be_added_to_legacy_and_new_manual_labels(self):
        write_json_atomic(self.catalog_path, ["VR", "Unused"])
        self.assertEqual(self.request("/api/library/labels"), (200, {"labels": [
            {"name": "Unused", "rule": ""}, {"name": "VR", "rule": ""},
        ]}))
        rule = "Studies in virtual reality.\nExclude augmented reality."
        self.assertEqual(self.request("/api/library/labels/rule", {"name": "vr", "rule": rule}, token="bad")[0], 403)
        self.assertEqual(self.request("/api/library/labels/rule", {"name": "vr", "rule": rule}),
                         (200, {"name": "VR", "rule": rule}))
        draft = {"Group survey": "Include surveys about group interactions."}
        self.assertEqual(self.request(self.paper_path, {"add": list(draft), "new_rules": draft})[0], 200)
        self.assertEqual(self.request(self.paper_path, {"add": ["VR"], "new_rules": {"VR": "Replace the saved rule"}})[0], 400)
        self.assertEqual(json.loads(self.catalog_path.read_text(encoding="utf-8")), {**draft, "VR": rule, "Unused": ""})
        self.assertEqual(self.request("/api/library/labels/rule", {"name": "VR", "rule": ""})[1]["rule"], "")
        self.assertEqual(self.request("/api/library")[1]["items"][0]["labels"], list(draft))

    def test_model_match_is_discarded_if_rule_changed_during_call(self):
        prefs.save({"library": {"ai_label_match": True}})
        self.assertEqual(self.request("/api/library/labels", {"name": "VR"})[0], 200)
        self.assertEqual(self.request("/api/library/labels/rule", {"name": "VR", "rule": "Studies about VR"})[0], 200)

        def complete(cfg, prompt, cwd, **options):
            self.assertEqual(self.request("/api/library/labels/rule", {"name": "VR", "rule": "Exclude surveys"})[0], 200)
            return '{"selected":[1]}'

        with patch(self.model_call, side_effect=complete):
            self.assertEqual(self.request(self.paper_path + "/auto", {}), (200, {"added": []}))
        self.assertEqual(self.request("/api/library")[1]["items"][0]["labels"], [])

    def test_stale_rule_editor_cannot_overwrite_another_save(self):
        self.request("/api/library/labels", {"name": "VR"})
        path = "/api/library/labels/rule"
        first = {"name": "VR", "rule": "Only head-mounted displays", "previous_rule": ""}
        self.assertEqual(self.request(path, first)[0], 200)
        self.assertEqual(self.request(path, first)[0], 200)  # Lost response, identical retry.
        self.assertEqual(self.request(path, {**first, "rule": "Any screen"})[0], 400)
        self.assertEqual(self.request("/api/library/labels")[1]["labels"][0]["rule"], first["rule"])

    def test_rule_lookup_reads_registered_names_directly_and_finds_imported_assignments(self):
        write_json_atomic(self.catalog_path, {"WMT / BLEU": "Requires a BLEU score", "Other": ""})
        path = "/api/library/labels?name="
        with patch.object(Library, "all", side_effect=AssertionError("Unnecessary library scan")):
            self.assertEqual(self.request(path + "wmt%20%2F%20bleu"),
                             (200, {"labels": [{"name": "WMT / BLEU", "rule": "Requires a BLEU score"}]}))
            self.assertEqual(self.request("/api/library/labels/rule", {"name": "Other", "rule": "Edited"})[0], 200)
        write_json_atomic(self.paper / "item.json", {"labels": ["Imported"]})
        self.assertEqual(self.request(path + "imported")[1]["labels"], [{"name": "Imported", "rule": ""}])
        self.assertEqual(self.request(path + "absent")[1]["labels"], [])

    def test_match_reads_later_evidence_and_omits_reference_list_within_budget(self):
        from easyread.chat.paper_labeling import EXCERPT_LIMIT
        prefs.save({"library": {"ai_label_match": True}})
        extracts = self.paper / "extract"
        extracts.mkdir()
        for page in range(1, 16):
            (extracts / f"page-{page:03}.txt").write_text(f"General study background, page {page}. " * 150, encoding="utf-8")
        (extracts / "page-009.txt").write_text("Methods. We used pupillometry with 64 subjects.", encoding="utf-8")
        (extracts / "page-015.txt").write_text("Conclusion.\nReferences\nUnperformed cited experiment.", encoding="utf-8")
        (extracts / "page-016.txt").write_text("Other cited experiment.", encoding="utf-8")
        self.request("/api/library/labels", {"name": "Eyes"})
        self.request("/api/library/labels/rule", {"name": "Eyes", "rule": "Reports pupillometry with 64 subjects"})

        def classify(cfg, prompt, cwd, **options):
            paper = json.loads(prompt.splitlines()[-1])["paper"]
            self.assertIn("abstract", paper)
            self.assertIn("pupillometry with 64 subjects", paper["excerpt"])
            self.assertNotIn("cited experiment", paper["excerpt"])
            self.assertLessEqual(len(paper["excerpt"]), EXCERPT_LIMIT)
            return '{"selected":[1]}'

        with patch(self.model_call, side_effect=classify):
            self.assertEqual(self.request(self.paper_path + "/auto", {}), (200, {"added": ["Eyes"]}))

    def test_suggestions_are_read_only_and_selected_rules_can_be_edited_before_saving(self):
        prefs.save({"library": {"ai_label_create": True}})
        self.request(self.paper_path, {"add": ["Manual"]})
        result = json.dumps({"labels": [
            {"name": "manual", "rule": "Existing"}, {"name": "No rule", "rule": " "},
            *({"name": name, "rule": "Rule for " + name} for name in ("First", "FIRST", "Second", "Third", "Fourth")),
        ]})
        before = self.catalog_path.read_bytes(), (self.paper / "item.json").read_bytes()
        with patch(self.model_call, return_value=result) as model:
            for _ in range(2):
                status, preview = self.request(self.paper_path + "/suggest", {})
                self.assertEqual(status, 200)
                self.assertEqual([entry["name"] for entry in preview["suggestions"]], ["First", "Second", "Third"])
                self.assertEqual((self.catalog_path.read_bytes(), (self.paper / "item.json").read_bytes()), before)
            self.assertEqual(model.call_count, 2)
        self.request(self.paper_path, {"add": ["Second"], "new_rules": {"Second": "Edited condition"}})
        self.assertEqual(self.request("/api/library/labels")[1]["labels"], [
            {"name": "Manual", "rule": ""}, {"name": "Second", "rule": "Edited condition"}])
        self.assertEqual(self.request("/api/library")[1]["items"][0]["labels"], ["Manual", "Second"])

    def test_generated_tags_save_required_rules_and_skip_existing_names(self):
        prefs.save({"library": {"ai_label_create": True}})
        write_json_atomic(self.catalog_path, {"VR": "Studies in VR"})
        rule = "Include research on how groups communicate within virtual spaces."

        def complete(cfg, prompt, cwd, **options):
            data = json.loads(prompt.splitlines()[-1])
            self.assertEqual(data["existing_labels"], [{"name": "VR", "rule": "Studies in VR"}])
            self.assertEqual(self.request("/api/library/labels", {"name": "Late tag"})[0], 200)
            return json.dumps({"labels": [
                {"name": "vr", "rule": "An unrelated rule"},
                {"name": "Late tag", "rule": "Overwrite a concurrent creation"},
                {"name": "No rule", "rule": "  "},
                {"name": "Virtual group interaction", "rule": rule},
                {"name": "Social surveys", "rule": "Include survey research on social interaction."},
            ]})

        with patch(self.model_call, side_effect=complete) as model:
            status, result = self.request(self.paper_path + "/generate", {})
            model.assert_called_once()
        self.assertEqual(status, 200, result)
        self.assertEqual(result["added"], ["Virtual group interaction", "Social surveys"])
        _, data = self.request("/api/library")
        self.assertEqual(data["items"][0]["labels"], result["added"])
        _, definitions = self.request("/api/library/labels")
        saved = {entry["name"]: entry["rule"] for entry in definitions["labels"]}
        self.assertNotIn("No rule", saved)
        self.assertEqual(saved["VR"], "Studies in VR")
        self.assertEqual(saved["Late tag"], "")
        self.assertEqual(saved["Virtual group interaction"], rule)

    def test_empty_and_invalid_results_leave_paper_untouched(self):
        prefs.save({"library": {"ai_label_match": True}})
        with patch(self.model_call) as model:
            self.assertEqual(self.request(self.paper_path + "/auto", {})[0], 400)
            model.assert_not_called()
        self.assertEqual(self.request(self.paper_path, {"add": ["Would be new"], "remove": "not an array"})[0], 400)
        self.assertEqual(self.request("/api/library/labels", {"name": "VR"})[0], 200)
        for response, expected_status in (("{}", 400), ('{"selected":[true,999,"VR"]}', 400), ('{"selected":[]}', 200)):
            with self.subTest(response=response), patch(self.model_call, return_value=response):
                self.assertEqual(self.request(self.paper_path + "/auto", {})[0], expected_status)
        _, refreshed = self.request("/api/library")
        self.assertEqual(refreshed["labels"], ["VR"])
        self.assertEqual(refreshed["items"][0]["labels"], [])
