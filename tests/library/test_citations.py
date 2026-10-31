import json
import tempfile
import unittest
from pathlib import Path

from easyread.library.citations import graph_for
from easyread.library.library import Library


class CitationGraphTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.lib = Library(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def paper(self, pid, title, refs=(), **meta):
        folder = self.root / pid
        folder.mkdir(exist_ok=True)
        (folder / "paper.json").write_text(json.dumps({"meta": {"title_en": title, **meta}, "references": list(refs)}))

    def test_both_directions_refresh_and_unmatched_references(self):
        self.paper("paperA", "An Introduction to Interesting Studies", [
            {"id": "12", "text": "Someone. A Thorough Study of Interesting Things. arXiv:2301.12345v2."},
            {"id": "13", "text": "An unknown work."},
        ])
        self.paper("paperB", "A Thorough Study of Interesting Things", arxiv="arXiv:2301.12345v1")
        a = graph_for(self.lib, "paperA")
        self.assertEqual([r["target"] for r in a["references"]], ["paperB", None])
        self.assertEqual(graph_for(self.lib, "paperB")["cited_by"], [
            {"id": "paperA", "title": "An Introduction to Interesting Studies", "ref_id": "12"}])
        self.paper("paperC", "A Different Work on Citations", [
            {"id": "VSP+17", "text": "Someone. An Introduction to Interesting Studies. 2020."}])
        self.assertEqual(graph_for(self.lib, "paperA")["cited_by"][0]["id"], "paperC")
        # Metadata overrides take effect without rewriting the reference list.
        (self.root / "paperB" / "item.json").write_text(json.dumps({"meta_override": {"arxiv": "arXiv:2401.99999", "title_en": "An Unrelated New Title"}}))
        self.assertIsNone(graph_for(self.lib, "paperA")["references"][0]["target"])

    def test_ambiguous_identifiers_and_titles_are_not_guessed(self):
        self.paper("paperA", "The Citing Article", [
            {"id": "1", "text": "Paper: A Common Title With Many Words. doi:10.1234/xyz"}])
        self.paper("paperB", "A Common Title With Many Words", doi="10.1234/xyz")
        self.paper("paperC", "A Common Title With Many Words", doi="https://doi.org/10.1234/xyz")
        self.assertIsNone(graph_for(self.lib, "paperA")["references"][0]["target"])
        self.assertEqual(graph_for(self.lib, "paperB")["cited_by"], [])

    def test_title_does_not_override_a_conflicting_identifier(self):
        self.paper("paperA", "The Citing Article", [
            {"id": "1", "text": "A Common Title With Many Words. doi:10.1234/different"}])
        self.paper("paperB", "A Common Title With Many Words", doi="10.1234/xyz")
        self.assertIsNone(graph_for(self.lib, "paperA")["references"][0]["target"])

    def test_unreadable_other_paper_marks_result_incomplete(self):
        self.paper("paperA", "The Citing Article")
        folder = self.root / "paperB"
        folder.mkdir()
        (folder / "paper.json").write_text("{broken")
        self.assertTrue(graph_for(self.lib, "paperA")["incomplete"])


if __name__ == "__main__":
    unittest.main()
