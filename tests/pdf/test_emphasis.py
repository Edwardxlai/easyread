import json
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject

from easyread.library.store import Workspace, write_json_atomic
from easyread.pdf import emphasis, pdfwork
from easyread.translate.prompts import _page_texts

# Standard-14 bold/oblique report weight 0 and no italic flag: names decide. CMMI10 (TeX math italic)
# sets the italic flag on every variable and must stay plain.
CONTENT = (
    b"BT /F2 12 Tf 40 370 Td (Results) Tj ET "
    b"BT /F2 12 Tf 40 340 Td (Overall findings.) Tj /F1 12 Tf ( Most models fail on long tasks.) Tj ET "
    b"BT /F1 12 Tf 40 310 Td (An iterative loop runs first.) Tj ET "
    b"BT /F1 12 Tf 40 280 Td (We use the ) Tj /F3 12 Tf (iterative) Tj /F1 12 Tf ( setting here.) Tj ET "
    b"BT /F1 12 Tf 40 250 Td (Let ) Tj /F4 12 Tf (ab) Tj /F1 12 Tf ( be the fixed pair.) Tj ET "
    b"BT /F1 12 Tf 40 220 Td (In short, ) Tj /F2 12 Tf (agents degrade their own) Tj ET "
    b"BT /F2 12 Tf 40 205 Td (code over time) Tj /F1 12 Tf ( in every run.) Tj ET"
)


def make_pdf(path: Path) -> None:
    writer = PdfWriter()
    page = writer.add_blank_page(width=400, height=400)

    def font(base, flags=None):
        d = {NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject(base)}
        if flags is not None:
            d[NameObject("/FontDescriptor")] = writer._add_object(DictionaryObject({
                NameObject("/Type"): NameObject("/FontDescriptor"), NameObject("/FontName"): NameObject(base),
                NameObject("/Flags"): NumberObject(flags), NameObject("/ItalicAngle"): NumberObject(-14),
                NameObject("/FontBBox"): ArrayObject([NumberObject(0)] * 4), NameObject("/Ascent"): NumberObject(700),
                NameObject("/Descent"): NumberObject(-200), NameObject("/CapHeight"): NumberObject(700), NameObject("/StemV"): NumberObject(80)}))
        return writer._add_object(DictionaryObject(d))

    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({
        NameObject("/F1"): font("/Helvetica"), NameObject("/F2"): font("/Helvetica-Bold"),
        NameObject("/F3"): font("/Helvetica-Oblique"), NameObject("/F4"): font("/CMMI10", 64)})})
    content = DecodedStreamObject()
    content.set_data(CONTENT)
    page[NameObject("/Contents")] = writer._add_object(content)
    with path.open("wb") as out:
        writer.write(out)


class EmphasisTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.ws = Workspace(self.root)
        make_pdf(self.root / "source.pdf")
        write_json_atomic(self.root / "paper.json", {"blocks": []})
        pdfwork.extract_text(self.root / "source.pdf", self.root / "extract")

    def test_prompt_material_marks_bold_and_italic_but_not_headings_or_math(self):
        before = (self.root / "extract" / "page-001.txt").read_text(encoding="utf-8")
        prompt = _page_texts(self.ws, [1])
        self.assertIn("**Overall findings.** Most models fail", prompt)
        self.assertIn("We use the *iterative* setting", prompt)
        self.assertIn("An iterative loop", prompt)  # the same word in regular type earlier on the page stays plain
        self.assertNotIn("**Results**", prompt)  # a line bold end to end is a heading
        self.assertNotIn("*ab*", prompt)
        # A bold phrase that wraps onto the next line is one run.
        self.assertRegex(prompt, r"\*\*agents degrade their own\s+code over time\*\* in every run")
        # The page text on disk stays plain: locating and page checks compare against it.
        self.assertEqual((self.root / "extract" / "page-001.txt").read_text(encoding="utf-8"), before)

    def test_runs_are_cached_per_source_file(self):
        first = emphasis.ensure(self.ws)
        cache = json.loads((self.root / "extract" / "pdf-emphasis.json").read_text(encoding="utf-8"))
        self.assertEqual(cache["pages"], first)
        (self.root / "extract" / "pdf-emphasis.json").write_text(json.dumps({**cache, "pages": {"1": []}}), encoding="utf-8")
        self.assertEqual(emphasis.ensure(self.ws), {"1": []})  # same source: cached result is reused

    def test_runs_that_cannot_be_placed_safely_stay_plain(self):
        runs = [["b", "key", "a "]]
        self.assertEqual(emphasis.insert("a key and a key", runs), "a key and a key")  # ambiguous context
        self.assertEqual(emphasis.insert("the monkey", [["i", "key", "the mon"]]), "the monkey")  # inside a word
        self.assertEqual(emphasis.insert("Patel* and more", [["b", "Patel", ""]]), "Patel* and more")  # literal asterisk
        self.assertEqual(emphasis.insert("plain text", [["b", "missing", ""]]), "plain text")


if __name__ == "__main__":
    unittest.main()
