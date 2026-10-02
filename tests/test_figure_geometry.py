"""真实 PDF 图像对象和矢量路径的定位回归，不依赖翻译模型。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

from easyread import pdfwork
from easyread.store import write_json_atomic


def make_pdf(path, images=(), paths=(), words=(), rotation=0):
    writer = PdfWriter()
    page = writer.add_blank_page(width=500, height=700)
    xobjects = DictionaryObject()
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                             NameObject("/Subtype"): NameObject("/Type1"),
                             NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/XObject"): xobjects,
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    commands = []
    for i, (x0, y0, x1, y1) in enumerate(images):
        image = DecodedStreamObject()
        image.set_data(bytes([30, 90, 150]) * 4)
        image.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"),
                      NameObject("/Width"): NumberObject(2), NameObject("/Height"): NumberObject(2),
                      NameObject("/ColorSpace"): NameObject("/DeviceRGB"), NameObject("/BitsPerComponent"): NumberObject(8)})
        name = f"/Im{i}"
        xobjects[NameObject(name)] = writer._add_object(image)
        commands.append(f"q {(x1 - x0) * 500} 0 0 {(y1 - y0) * 700} {x0 * 500} {(1 - y1) * 700} cm {name} Do Q")
    for x0, y0, x1, y1 in paths:
        commands.append(f"{x0 * 500} {(1-y1) * 700} {(x1-x0) * 500} {(y1-y0) * 700} re S")
    for text, x, y in words:
        commands.append(f"BT /F1 10 Tf 1 0 0 1 {x * 500} {(1-y) * 700} Tm ({text}) Tj ET")
    stream = DecodedStreamObject()
    stream.set_data("\n".join(commands).encode())
    page[NameObject("/Contents")] = writer._add_object(stream)
    if rotation:
        page.rotate(rotation)
    writer.write(path)


def loc(box, src="text"):
    return {"page": 1, "box": list(box), "src": src}


class FigureGeometryTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def extend(self, blocks, layout, **pdf):
        make_pdf(self.root / "source.pdf", **pdf)
        pdfwork._extend_captioned(blocks, layout, self.root)
        return layout

    def test_side_caption_keeps_left_and_lower_panels_despite_overestimated_paragraph(self):
        image = [.08, .36, .60, .86]
        layout = {"body": loc([.08, .10, .93, .90]), "fig": loc([.73, .56, .91, .69])}
        self.extend([{"id": "fig", "type": "figure"}], layout, images=[image])
        box = layout["fig"]["box"]
        self.assertEqual(layout["fig"]["src"], "graphic")
        self.assertLess(box[0], image[0])
        self.assertLess(box[1], image[1])
        self.assertGreater(box[2], .91)
        self.assertGreater(box[3], image[3])
        pdfwork._clamp_overlaps(layout)
        self.assertEqual(layout["fig"]["box"], box)

    def test_two_figures_on_same_page_stay_separate(self):
        layout = {"left": loc([.08, .72, .46, .77]), "right": loc([.54, .72, .92, .77])}
        blocks = [{"id": bid, "type": "figure"} for bid in layout]
        self.extend(blocks, layout, images=[[.08, .30, .46, .70], [.54, .30, .92, .70]])
        self.assertLess(layout["left"]["box"][2], .5)
        self.assertGreater(layout["right"]["box"][0], .5)
        self.assertTrue(all(l["src"] == "graphic" for l in layout.values()))

    def test_separate_subpanel_images_are_kept_without_publisher_logo(self):
        layout = {"fig": loc([.1, .72, .9, .77])}
        self.extend([{"id": "fig", "type": "figure"}], layout,
                    images=[[.1, .30, .46, .70], [.54, .30, .9, .70], [.08, .01, .22, .05]])
        self.assertEqual(layout["fig"]["src"], "graphic")
        self.assertAlmostEqual(layout["fig"]["box"][1], .292)
        self.assertLess(layout["fig"]["box"][0], .1)
        self.assertGreater(layout["fig"]["box"][2], .9)

    def test_caption_above_drawing(self):
        layout = {"fig": loc([.1, .20, .45, .25])}
        self.extend([{"id": "fig", "type": "figure", "caption_pos": "above"}], layout,
                    images=[[.1, .27, .45, .65]])
        self.assertEqual(layout["fig"]["src"], "graphic")
        self.assertGreater(layout["fig"]["box"][3], .65)

    def test_distant_top_row_is_connected_through_lower_panels(self):
        for kind in ("images", "paths"):
            with self.subTest(kind=kind):
                layout = {"fig": loc([.1, .7, .9, .75])}
                panels = [[.1, .08, .45, .26], [.55, .08, .9, .26],
                          [.1, .30, .45, .48], [.55, .30, .9, .48],
                          [.1, .52, .45, .67], [.55, .52, .9, .67]]
                self.extend([{"id": "fig", "type": "figure"}], layout, **{kind: panels})
                self.assertEqual(layout["fig"]["src"], "graphic")
                self.assertLess(layout["fig"]["box"][1], .08)

    def test_vector_plot_keeps_label_and_ignores_caption_background_and_footer(self):
        layout = {"fig": loc([.1, .72, .48, .77])}
        self.extend([{"id": "fig", "type": "figure"}], layout,
                    paths=[[.12, .30, .48, .68], [.095, .715, .485, .775], [.03, .91, .97, .91]],
                    words=[("axis", .1, .68), ("Figure 1", .1, .74)])
        self.assertEqual(layout["fig"]["src"], "graphic")
        self.assertLess(layout["fig"]["box"][0], .1)
        self.assertLess(layout["fig"]["box"][3], .8)

    def test_full_page_scan_and_inline_formula_use_existing_fallback(self):
        layout = {"body": loc([.1, .1, .9, .35]), "fig": loc([.1, .7, .9, .75])}
        self.extend([{"id": "fig", "type": "figure"}], layout,
                    images=[[0, 0, 1, 1], [.2, .2, .35, .24]])
        self.assertEqual(layout["fig"]["src"], "caption")
        self.assertAlmostEqual(layout["fig"]["box"][1], .355)

    def test_explicit_manual_box_and_table_are_preserved(self):
        layout = {"fig": loc([.1, .3, .5, .8], "manual"), "table": loc([.55, .7, .9, .75])}
        self.extend([{"id": "fig", "type": "figure", "box": [.1, .3, .5, .8]},
                     {"id": "table", "type": "table"}], layout,
                    images=[[.05, .2, .52, .9], [.55, .3, .9, .68]])
        self.assertEqual(layout["fig"], loc([.1, .3, .5, .8], "manual"))
        self.assertEqual(layout["table"]["src"], "caption")

    def test_nearby_table_graphic_is_not_assigned_to_figure(self):
        layout = {"fig": loc([.1, .72, .45, .77]), "table": loc([.55, .68, .9, .71])}
        self.extend([{"id": "fig", "type": "figure"}, {"id": "table", "type": "table"}], layout,
                    images=[[.1, .3, .45, .65], [.55, .3, .9, .65]])
        self.assertEqual(layout["fig"]["src"], "graphic")
        self.assertLess(layout["fig"]["box"][2], .5)

    def test_rotated_pdf_uses_rendered_page_coordinates(self):
        for rotation, expected in ((90, [.35, .1, .7, .45]), (270, [.3, .55, .65, .9])):
            with self.subTest(rotation=rotation):
                make_pdf(self.root / "source.pdf", images=[[.1, .3, .45, .65]],
                         words=[("Figure 1. Rotated drawing.", .1, .73)], rotation=rotation)
                write_json_atomic(self.root / "paper.json", {"blocks": [
                    {"id": "fig", "type": "figure", "page": 1, "caption_en": "Figure 1. Rotated drawing."}]})
                pdfwork.extract_text(self.root / "source.pdf", self.root / "extract")
                loc = pdfwork.locate(self.root)["fig"]
                self.assertEqual(loc["src"], "graphic")
                self.assertLess(loc["box"][0], expected[0])
                self.assertLess(loc["box"][1], expected[1])
                self.assertGreater(loc["box"][2], expected[2])
                self.assertGreater(loc["box"][3], expected[3])

    def test_old_layout_refreshes_from_pdf_once_without_changing_translation(self):
        make_pdf(self.root / "source.pdf", images=[[.08, .30, .60, .86]],
                 words=[("Figure 1. A side caption.", .72, .6)])
        paper = {"blocks": [{"id": "fig", "type": "figure", "page": 1,
                             "caption_en": "Figure 1. A side caption.", "caption_zh": "保留的译文"}]}
        write_json_atomic(self.root / "paper.json", paper)
        write_json_atomic(self.root / "layout.json", {"fig": loc([.72, .30, .94, .63], "caption")})
        pdfwork.extract_text(self.root / "source.pdf", self.root / "extract")
        (self.root / "extract/locate.version").write_text("3")
        before = (self.root / "paper.json").read_bytes()
        with patch.object(pdfwork, "locate", wraps=pdfwork.locate) as locate:
            pdfwork.refresh_layout(self.root)
            pdfwork.refresh_layout(self.root)
            locate.assert_called_once_with(self.root)
        import json
        new = json.loads((self.root / "layout.json").read_text())["fig"]
        self.assertEqual(new["src"], "graphic")
        self.assertLess(new["box"][0], .08)
        self.assertGreater(new["box"][3], .86)
        self.assertEqual((self.root / "paper.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
