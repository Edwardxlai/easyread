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


QUOTE = "We survey small groups using virtual reality."


def analysis(matches=(), suggestions=()):
    return json.dumps({"matches": [{"id": i, "source": 1, "quote": QUOTE} for i in matches],
                       "suggestions": [dict(row, source=1, quote=QUOTE) for row in suggestions]})


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

    def test_unified_setting_migrates_previous_opt_ins_and_controls_all_routes(self):
        self.request(self.paper_path, {"add": ["Manual"]})
        self.assertEqual(self.request("/api/library")[1]["label_features"], {"ai_labels": False})
        for flags, enabled in (({"ai_label_match": True}, True), ({"ai_label_create": True}, True),
                               ({"ai_label_match": True, "ai_labels": False}, False), ({"ai_labels": True}, True)):
            with self.subTest(flags=flags), patch(self.model_call, return_value=analysis()) as model:
                prefs.path().unlink(missing_ok=True)
                self.assertEqual(self.request("/api/prefs", {"library": flags})[0], 200)
                self.assertEqual(self.request("/api/library")[1]["label_features"], {"ai_labels": enabled})
                for action in ("auto", "suggest", "generate", "preview"):
                    status, result = self.request(self.paper_path + "/" + action, {})
                    self.assertEqual(status, 200 if enabled else 400, result)
                self.assertEqual(model.call_count, 4 * int(enabled))
                self.assertEqual(self.request("/api/library")[1]["items"][0]["labels"], ["Manual"])

    def test_disabling_during_manual_ai_calls_discards_results(self):
        self.request("/api/library/labels", {"name": "Existing"})
        for action, feature in (("auto", prefs.AI_LABELS), ("preview", prefs.AI_LABELS)):
            prefs.save({"library": {feature: True}})

            def disable(*args, **kwargs):
                self.assertEqual(self.request("/api/prefs", {"library": {feature: False}})[0], 200)
                return analysis([1])

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
        with patch(self.model_call, return_value=analysis()) as model:
            self.assertEqual(self.request(self.paper_path + "/auto", {}), (200, {"added": []}))
        excerpt = " ".join(json.loads(model.call_args.args[1].splitlines()[-1])["sources"].values())
        self.assertIn("Our study used surveys", excerpt)
        self.assertNotIn("cited trial", excerpt.lower())

    def test_translated_only_blocks_do_not_count_as_verbatim_originals(self):
        prefs.save({"library": {"ai_labels": True}})
        library = Library(self.paper.parent)
        ws = library.ws(self.paper.name)
        ws.update("paper", lambda paper: paper.update(meta={}, blocks=[
            {"type": "para", "page": 1, "zh": "Translated text which is not the source."},
            {"type": "list", "page": 1, "items": [{"zh": "Translated list item."}]},
        ]))
        with patch(self.model_call) as model:
            status, preview = self.request(self.paper_path + "/preview", {})
            self.assertEqual((status, preview["matches"], preview["suggestions"]), (200, [], []))
            model.assert_not_called()

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
            self.assertEqual(data["title"], "Dialogue in social VR")
            self.assertIn(QUOTE, data["sources"].values())
            rules = {entry["name"]: entry["rule"] for entry in data["labels"].values()}
            self.assertIn("Manual", rules)
            self.assertEqual(rules["Survey"], rule)
            self.assertEqual(rules["VR"], "")
            self.assertIn("only when the paper meets the rule", prompt)
            self.assertEqual(self.request(self.paper_path, {"add": ["Concurrent"], "remove": ["Manual"]})[0], 200)
            selected = [int(i) for i, entry in data["labels"].items() if entry["name"] in ("VR", "Survey")]
            return "```json\n" + analysis(selected + [selected[0], 999, True, "Invented"]) + "\n```"

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

    def test_saved_evidence_can_be_read_from_details_with_tagging_switched_off(self):
        prefs.save({"library": {"ai_labels": True}})
        self.request("/api/library/labels", {"name": "Survey"})
        self.request(self.paper_path, {"add": ["Manual"]})
        with patch(self.model_call, return_value=analysis([2])) as model:
            status, preview = self.request(self.paper_path + "/preview", {})
            self.assertEqual(status, 200)
            self.request(self.paper_path + "/confirm", {"preview": preview["preview"], "selected": ["Survey"]})
            prefs.save({"library": {"ai_labels": False}})
            listing = self.request("/api/library")[1]["items"][0]
            self.assertEqual(listing["evidence_labels"], ["Survey"])
            self.assertEqual(self.request(self.paper_path + "/evidence?name=Survey"),
                             (200, {"name": "Survey", "rule": "", "quote": QUOTE, "anchor": "", "page": 1}))
            self.assertEqual(self.request(self.paper_path + "/evidence?name=Manual")[0], 409)
            self.request(self.paper_path, {"remove": ["Survey"]})
            self.assertEqual(self.request(self.paper_path + "/evidence?name=Survey")[0], 409)
            model.assert_called_once()

    def test_manual_removal_during_merge_resolves_prior_spelling_and_clears_evidence(self):
        write_json_atomic(self.catalog_path, {"Canonical": {"rule": "", "origin": "user", "aliases": ["Former"]}})
        write_json_atomic(self.paper / "item.json", {"labels": ["Former"], "label_evidence": {
            "Former": {"quote": QUOTE, "page": 1, "anchor": ""}}})
        item = self.request("/api/library")[1]["items"][0]
        self.assertEqual((item["labels"], item["evidence_labels"]), (["Canonical"], ["Canonical"]))
        self.assertEqual(self.request(self.paper_path + "/evidence?name=Canonical")[1]["quote"], QUOTE)
        self.assertEqual(self.request(self.paper_path, {"remove": ["Canonical"]})[1]["labels"], [])
        saved = json.loads((self.paper / "item.json").read_text(encoding="utf8"))
        self.assertEqual(saved["label_exclusions"], ["Canonical"])
        self.assertEqual(saved["label_evidence"], {})
        self.assertEqual(self.request(self.paper_path, {"add": ["Former"]})[1]["labels"], ["Canonical"])
        self.assertEqual(self.request("/api/library")[1]["labels"], ["Canonical"])

    def test_model_match_is_discarded_if_rule_changed_during_call(self):
        prefs.save({"library": {"ai_label_match": True}})
        self.assertEqual(self.request("/api/library/labels", {"name": "VR"})[0], 200)
        self.assertEqual(self.request("/api/library/labels/rule", {"name": "VR", "rule": "Studies about VR"})[0], 200)

        def complete(cfg, prompt, cwd, **options):
            self.assertEqual(self.request("/api/library/labels/rule", {"name": "VR", "rule": "Exclude surveys"})[0], 200)
            return analysis([1])

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

    def test_library_scan_covers_late_pages_with_cross_language_rules(self):
        from easyread.chat.paper_labeling import _sample
        from easyread.library.store import Workspace
        extracts = self.paper / "extract"
        extracts.mkdir()
        for page in range(1, 19):
            body = f"General observations on page {page}. " * 17
            if page in (4, 15):
                body += " Participants showed increased pupillary dilation."
            (extracts / f"page-{page:03}.txt").write_text(body, encoding="utf-8")
        samples = _sample(Workspace(self.paper), [], [paper_labels.Label("瞳孔测量")], bulk=True)
        self.assertEqual({s["page"] for s in samples if "pupillary dilation" in s["text"]}, {4, 15})

    def test_bulk_cross_language_terms_retrieve_only_actual_source_text(self):
        from easyread.chat.paper_labeling import _sample
        from easyread.library.store import Workspace
        extracts = self.paper / "extract"
        extracts.mkdir()
        for page in range(1, 81):
            text = f"General observations for day {page}. " * 18
            if page == 2:
                text += " Our assistants distributed questionnaires to visitors."
            (extracts / f"page-{page:03}.txt").write_text(text, encoding="utf-8")
        ws = Workspace(self.paper)
        with patch("easyread.chat.paper_labeling._ask", return_value={
                "retrieval_terms": "assistants distributed questionnaires inventedword"}) as translate:
            sources = _sample(ws, [], [paper_labels.Label("问卷", "团队现场发放问卷")], bulk=True)
        translate.assert_called_once()
        self.assertTrue(any(p["page"] == 2 and "distributed questionnaires" in p["text"] for p in sources))
        self.assertFalse(any("inventedword" in p["text"] for p in sources))

    def test_long_scan_audit_can_only_keep_evidenced_matches(self):
        from easyread.chat.paper_labeling import analyze
        from easyread.library.store import Workspace
        passage = "The website made the questionnaire available to park visitors."
        extracts = self.paper / "extract"
        extracts.mkdir()
        for page in range(1, 17):
            (extracts / f"page-{page:03}.txt").write_text((passage + " ") * 10, encoding="utf-8")
        labels = {n: paper_labels.Label(n, "questionnaire") for n in ("a", "b", "c", "d")}
        def model(instructions, data, **opts):
            row = {"source": 1, "quote": passage}
            if "approved" in instructions:
                self.assertEqual(set(data["labels"]), {1, 2, 3})
                return {"approved": [dict(row, id="1", source="1"), dict(row, id=2, quote="unsubstantiated"),
                                     dict(row, id="3", source=True), dict(row, id=4)]}
            return {"matches": [dict(row, id=i) for i in (1, 2, 3)], "suggestions": []}
        with patch("easyread.chat.paper_labeling._ask", side_effect=model):
            result = analyze(None, Workspace(self.paper), known=labels, bulk=True)
        self.assertEqual([row["name"] for row in result["matches"]], ["a"])

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
            sources = json.loads(prompt.splitlines()[-1])["sources"]
            self.assertIn(QUOTE, sources.values())
            self.assertFalse(any("cited experiment" in text for text in sources.values()))
            self.assertLessEqual(sum(map(len, sources.values())), EXCERPT_LIMIT + len(QUOTE))
            quote = "pupillometry with 64 subjects"
            source = next(i for i, text in sources.items() if quote in text)
            return json.dumps({"matches": [{"id": 1, "source": int(source), "quote": quote}], "suggestions": []})

        with patch(self.model_call, side_effect=classify):
            self.assertEqual(self.request(self.paper_path + "/auto", {}), (200, {"added": ["Eyes"]}))

    def test_suggestions_are_read_only_and_selected_rules_can_be_edited_before_saving(self):
        prefs.save({"library": {"ai_label_create": True}})
        self.request(self.paper_path, {"add": ["Manual"]})
        result = analysis(suggestions=[
            {"name": "manual", "rule": "Existing"}, {"name": "No rule", "rule": " "},
            *({"name": name, "rule": "Rule for " + name} for name in ("First", "FIRST", "Second", "Third", "Fourth")),
        ])
        before = self.catalog_path.read_bytes(), (self.paper / "item.json").read_bytes()
        with patch(self.model_call, return_value=result) as model:
            for _ in range(2):
                status, preview = self.request(self.paper_path + "/preview", {})
                self.assertEqual(status, 200)
                self.assertEqual([entry["name"] for entry in preview["suggestions"]], ["First", "Second", "Third"])
                self.assertEqual((self.catalog_path.read_bytes(), (self.paper / "item.json").read_bytes()), before)
            self.assertEqual(model.call_count, 2)
        self.assertEqual(preview["matches"], [])
        self.assertEqual(preview["suggestions"][1]["quote"], QUOTE)
        self.assertEqual(self.request(self.paper_path + "/confirm", {"preview": preview["preview"], "selected": ["Invented"]})[0], 400)
        self.assertEqual(self.request(self.paper_path + "/confirm", {"preview": preview["preview"], "selected": ["Second"],
                                                                    "rules": {"Second": "Edited condition"}})[0], 200)
        self.assertEqual(paper_labels.available(Library(self.paper.parent))["second"].origin, "user")
        self.assertEqual(self.request("/api/library/labels")[1]["labels"], [
            {"name": "Manual", "rule": ""}, {"name": "Second", "rule": "Edited condition"}])
        self.assertEqual(self.request("/api/library")[1]["items"][0]["labels"], ["Manual", "Second"])

    def test_generated_tags_save_required_rules_and_skip_existing_names(self):
        prefs.save({"library": {"ai_label_create": True}})
        write_json_atomic(self.catalog_path, {"VR": "Studies in VR"})
        rule = "Include research on how groups communicate within virtual spaces."

        def complete(cfg, prompt, cwd, **options):
            data = json.loads(prompt.splitlines()[-1])
            self.assertEqual(list(data["labels"].values()),
                             [{"name": "VR", "rule": "Studies in VR", "origin": "user", "aliases": []}])
            self.assertEqual(self.request("/api/library/labels", {"name": "Late tag"})[0], 200)
            return analysis(suggestions=[
                {"name": "vr", "rule": "An unrelated rule"},
                {"name": "Late tag", "rule": "Overwrite a concurrent creation"},
                {"name": "No rule", "rule": "  "},
                {"name": "Virtual group interaction", "rule": rule},
                {"name": "Social surveys", "rule": "Include survey research on social interaction."},
            ])

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
        for response, expected_status in (("{}", 400), (analysis([True, 999, "VR"]), 200),
                                          ('{"matches":[{"id":1,"source":1,"quote":"unsupported quote"}],"suggestions":[]}', 200),
                                          (analysis(), 200)):
            with self.subTest(response=response), patch(self.model_call, return_value=response):
                self.assertEqual(self.request(self.paper_path + "/auto", {})[0], expected_status)
        _, refreshed = self.request("/api/library")
        self.assertEqual(refreshed["labels"], ["VR"])
        self.assertEqual(refreshed["items"][0]["labels"], [])
