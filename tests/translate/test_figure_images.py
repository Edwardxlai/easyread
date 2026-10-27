import json
import shutil
import threading
import unittest
from unittest.mock import patch

from easyread.engines.engines import Cancelled, EngineError
from easyread.translate import figure_images, translate
from tests.engines.test_image_edit import png
from tests.translate.test_translate import make_ws


class FigureImagesTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(1)
        self.addCleanup(shutil.rmtree, self.ws.root)
        (self.ws.root / "figures").mkdir()
        (self.ws.root / "figures/original.png").write_bytes(png())
        self.block = {"id": "f1", "page": 1, "type": "figure", "src": "figures/original.png",
                      "image_en": "Input", "image_zh": "入力", "caption_zh": "図 1"}
        self.ws.update("paper", lambda p: (p["meta"].update(target="ja"), p.update(blocks=[self.block])))
        self.cfg = {"engine": "openai", "openai": {"vision": False}, "target": "de",
                    "figure_images": {"enabled": True, "provider": "api", "base_url": "https://images.example/v1", "model": "editor"}}
        self.cancel = threading.Event()

    def generate(self):
        figure_images.generate(self.ws, self.cfg, {1}, self.cancel, lambda msg: None)

    def block_now(self):
        return self.ws.load("paper")["blocks"][0]

    def test_preserves_fallback_and_uses_paper_language_and_reuses_saved_image(self):
        with patch.object(figure_images.image_edit, "edit", return_value=png()) as edit:
            self.generate()
            self.generate()
        self.assertEqual(edit.call_count, 1)
        self.assertIn("日本語", edit.call_args.args[2])
        self.assertIn("入力", edit.call_args.args[2])
        block = self.block_now()
        self.assertEqual({k: block[k] for k in self.block}, self.block)
        self.assertTrue((self.ws.root / block["translated_image"]["src"]).is_file())
        self.assertEqual(block["translated_image"]["target"], "ja")

    def test_disabled_unconfigured_and_disabled_figure_text_do_not_call(self):
        for settings in ({"figure_images": {}}, {"figure_images": {"enabled": True, "provider": "api"}}, {"translate_figure_text": False}):
            with self.subTest(settings=settings), patch.object(figure_images.image_edit, "edit") as edit:
                figure_images.generate(self.ws, {**self.cfg, **settings}, {1}, self.cancel, lambda msg: None)
                edit.assert_not_called()
                self.assertEqual(self.block_now(), self.block)

    def test_default_uses_subscription_without_api_settings(self):
        self.cfg["figure_images"] = {"enabled": True}
        with patch.object(figure_images.codex_image, "edit", return_value=png()) as codex, \
                patch.object(figure_images.image_edit, "edit") as api:
            self.generate()
        codex.assert_called_once()
        api.assert_not_called()
        self.assertIn("translated_image", self.block_now())

    def test_subscription_failure_never_falls_back_to_paid_api(self):
        self.cfg["figure_images"]["provider"] = "codex"
        with patch.object(figure_images.codex_image, "edit", side_effect=EngineError("quota")), \
                patch.object(figure_images.image_edit, "edit") as api:
            self.generate()
        api.assert_not_called()
        self.assertEqual(self.block_now(), self.block)

    def test_failure_or_cancel_keeps_text_and_original(self):
        for error in (EngineError("unsupported"), Cancelled()):
            with self.subTest(error=error), patch.object(figure_images.image_edit, "edit", side_effect=error):
                self.generate()
            self.assertEqual(self.block_now(), self.block)
            self.assertEqual(list((self.ws.root / "figures").iterdir()), [self.ws.root / self.block["src"]])

    def test_late_result_cannot_overwrite_recrop_retranslation_or_new_target(self):
        for change in ({"src": "figures/new.png"}, {"image_zh": "新しい訳"}, {"target": "fr"}):
            with self.subTest(change=change):
                self.ws.update("paper", lambda p: (p["meta"].update(target="ja"), p.update(blocks=[self.block])))

                def edit(*args):
                    self.ws.update("paper", lambda p: (p["meta"] if "target" in change else p["blocks"][0]).update(change))
                    return png()

                with patch.object(figure_images.image_edit, "edit", side_effect=edit):
                    self.generate()
                self.assertNotIn("translated_image", self.block_now())
                self.assertFalse(list((self.ws.root / "figures").glob("translated-*")))

    def test_missing_asset_can_be_generated_again(self):
        with patch.object(figure_images.image_edit, "edit", return_value=png()) as edit:
            self.generate()
            (self.ws.root / self.block_now()["translated_image"]["src"]).unlink()
            self.generate()
        self.assertEqual(edit.call_count, 2)

    def test_failure_of_one_figure_does_not_stop_the_next(self):
        self.ws.update("paper", lambda p: p["blocks"].append({**self.block, "id": "f2"}))
        with patch.object(figure_images.image_edit, "edit", side_effect=[EngineError("unsupported"), png()]):
            self.generate()
        blocks = self.ws.load("paper")["blocks"]
        self.assertNotIn("translated_image", blocks[0])
        self.assertIn("translated_image", blocks[1])

    def test_cancel_after_response_does_not_publish_image(self):
        def edit(*args):
            self.cancel.set()
            return png()
        with patch.object(figure_images.image_edit, "edit", side_effect=edit):
            self.generate()
        self.assertEqual(self.block_now(), self.block)
        self.assertFalse(list((self.ws.root / "figures").glob("translated-*")))

    def test_translation_job_succeeds_when_image_service_fails(self):
        def edit(*args):
            # The original and its translated labels have already been persisted.
            self.assertEqual(self.block_now()["image_zh"], "入力")
            self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [1])
            raise EngineError("unsupported")

        with patch.object(translate.engines, "run", return_value=json.dumps({"blocks": [self.block]})), \
                patch.object(translate.pdfwork, "locate"), patch.object(translate, "_problems", return_value=[]), \
                patch.object(figure_images.image_edit, "edit", side_effect=edit) as call:
            failed = translate.translate_pages(self.ws, self.cfg, [1], self.cancel, lambda *args: None)
        self.assertEqual(failed, {})
        call.assert_called_once()
        self.assertEqual(self.block_now()["image_zh"], "入力")

    def test_fill_existing_structure_also_generates_image(self):
        self.ws.update("paper", lambda p: (p["translation"].update(en_pages=[1], done_pages=[1]),
                                            p["blocks"][0].update(image_zh="", caption_zh="", caption_en="Figure 1")))
        answer = {"zh": {"f1#caption": "図 1", "f1#image": "入力"}}
        with patch.object(translate.engines, "run", return_value=json.dumps(answer)), \
                patch.object(figure_images.image_edit, "edit", return_value=png()) as edit:
            self.assertEqual(translate.translate_pages(self.ws, self.cfg, [1], self.cancel, lambda *args: None), {})
        edit.assert_called_once()
        self.assertIn("translated_image", self.block_now())

    def test_read_only_mode_does_not_generate(self):
        with patch.object(translate.engines, "run", return_value=json.dumps({"blocks": [self.block]})), \
                patch.object(translate.pdfwork, "locate"), patch.object(translate, "_problems", return_value=[]), \
                patch.object(figure_images.image_edit, "edit") as edit:
            translate.translate_pages(self.ws, self.cfg, [1], self.cancel, lambda *args: None, read=True)
        edit.assert_not_called()
