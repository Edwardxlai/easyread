import tempfile
import unittest
from pathlib import Path

from easyread.library.store import Workspace
from easyread.translate import footnotes


class FootnoteMarkersTest(unittest.TestCase):
    def test_missing_from_both_languages_uses_source_callout_and_a_same_page_note(self):
        with tempfile.TemporaryDirectory() as root:
            ws = Workspace(Path(root))
            extract = ws.root / "extract"
            extract.mkdir(exist_ok=True)
            (extract / "page-011.txt").write_text("pre- and post-search conjoint study, respectively.3 Then ...", encoding="utf-8")
            body = {"id": "p", "type": "para", "page": 11, "en": "In the conjoint study, respectively. Then ...", "zh": "计算 HHI。随后……"}
            note = {"id": "n", "type": "para", "page": 11, "role": "footnote", "num": "3"}
            self.assertFalse(footnotes.problems([body], footnotes.expected(ws, [body]), False))
            expected = footnotes.expected(ws, [body, note])
            self.assertEqual(len(footnotes.problems([body, note], expected, False)), 2)
            body.update(en="In the conjoint study, respectively.[^3] Then ...", zh="计算 HHI。[^3]随后……")
            self.assertEqual(footnotes.problems([body, note], expected, False), [])
            body["zh"] = "计算 HHI。随后……"
            self.assertEqual(len(footnotes.problems([body, note], expected, False)), 1)
            self.assertEqual(footnotes.problems([body, note], expected, True), [])
