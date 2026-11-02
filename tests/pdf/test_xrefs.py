import tempfile
import unittest
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, Fit, FloatObject, NameObject, TextStringObject

from easyread.library.store import Workspace, write_json_atomic
from easyread.pdf import pdfwork, xrefs
from easyread.translate import prompts, translate

# Courier: every glyph is 0.6 em wide, so link rectangles sit on exact characters.
PAGE1 = (b"BT /F1 12 Tf 40 750 Td (Ann Lee) Tj ET BT /F1 7 Tf 90.4 755 Td (*) Tj ET "
         b"BT /F1 12 Tf 40 700 Td (See Figure 3 for details.) Tj ET "
         b"BT /F1 12 Tf 40 650 Td (We cite prior work) Tj ET BT /F1 7 Tf 169.6 655 Td (1) Tj ET "
         b"BT /F1 12 Tf 173.8 650 Td ( here.) Tj ET")
PAGE2 = b"BT /F1 12 Tf 40 690 Td (Figure 3: A plot.) Tj ET BT /F1 9 Tf 40 80 Td (1 A footnote.) Tj ET"


def make_pdf(path: Path) -> None:
    writer = PdfWriter()
    font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                                                NameObject("/BaseFont"): NameObject("/Courier")}))
    for data in (PAGE1, PAGE2):
        page = writer.add_blank_page(width=600, height=800)
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        content = DecodedStreamObject()
        content.set_data(data)
        page[NameObject("/Contents")] = writer._add_object(content)
    writer.add_named_destination("figure.3", 1, Fit.xyz(left=38, top=705))
    writer.add_named_destination("Hfootnote.1", 1, Fit.xyz(left=38, top=92))
    writer.add_named_destination("Hfootnote.2", 1, Fit.xyz(left=38, top=92))
    writer.add_named_destination("page.2", 1, Fit.xyz(left=0, top=800))  # a back-reference: not a place to link

    def link(rect, dest):
        return writer._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Link"),
            NameObject("/Rect"): ArrayObject([FloatObject(v) for v in rect]), NameObject("/Dest"): TextStringObject(dest)}))
    writer.pages[0][NameObject("/Annots")] = ArrayObject([
        link([118, 697, 127, 711], "figure.3"),       # only the number is linked, as \ref does
        link([169, 653, 174, 663], "Hfootnote.1"),
        link([88, 745, 96, 763], "Hfootnote.2"),      # the rectangle also grazes the name before the mark
        link([40, 647, 60, 661], "page.2"),
    ])
    with path.open("wb") as out:
        writer.write(out)


class XrefsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.ws = Workspace(self.root)
        make_pdf(self.root / "source.pdf")
        write_json_atomic(self.root / "paper.json", {"blocks": []})
        pdfwork.extract_text(self.root / "source.pdf", self.root / "extract")

    def test_page_text_marks_internal_links_and_footnote_marks(self):
        text = prompts.page_text(self.ws, 1)
        self.assertIn("See Figure [3](#) for details.", text)  # the model fills in #fig:3
        self.assertIn("work[^1]", text)
        self.assertIn("Ann Lee[^*]", text)
        self.assertNotIn("We cite [prior", text)  # a back-reference to a page is not a reference
        self.assertNotIn("](#)", self.ws.root.joinpath("extract", "page-001.txt").read_text(encoding="utf-8"))

    def test_marks_are_dropped_where_text_is_not_rendered_as_markdown(self):
        data = translate._normalize({"blocks": [], "meta": {"authors": "Ann Lee[^*]", "pages": [1]},
                                     "references": [{"id": "1", "text": "See [Section 2](#sec:2) and [a\\]b](#fig:1)."}]}, [1], set())
        self.assertEqual(data["meta"], {"authors": "Ann Lee", "pages": [1]})
        self.assertEqual(data["references"][0]["text"], "See Section 2 and a]b.")

    def test_locating_reads_the_printed_words_not_link_targets(self):
        block = {"type": "para", "en": "[Figure 3](#fig:3) shows [code](https://example.com/x)."}
        self.assertEqual(pdfwork.block_english(block), "Figure 3 shows code.")


if __name__ == "__main__":
    unittest.main()
