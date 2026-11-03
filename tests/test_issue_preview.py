"""Focused guards for the new local export, crop and CLI boundaries."""
import base64
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from easyread.engines import opencode_cli
from easyread.export.chat_markdown import export
from easyread.library.store import Workspace, write_json_atomic
from easyread.pdf.manual_crop import save
from easyread.pdf.figures import missing
from easyread.translate.instructions import apply, filter_figure_text


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ws = Workspace(Path(self.temp.name))

    def test_figure_preference_preserves_caption_and_body(self):
        data = {"blocks": [{"type": "figure", "image_en": "axis", "image_zh": "label", "caption_zh": "caption"}, {"type": "paragraph", "zh": "body"}]}
        filter_figure_text(data, {"translate_figure_text": False})
        self.assertEqual(data["blocks"], [{"type": "figure", "caption_zh": "caption"}, {"type": "paragraph", "zh": "body"}])
        self.assertIn("leave image_en and image_zh empty", apply("task", {"translate_figure_text": False}))
        self.assertEqual(apply("task", {}), "task")

    def test_crop_keeps_manual_choice_and_can_restore(self):
        original = {"id": "f1", "type": "figure", "page": 1, "src": "old.webp", "box": [.1,.1,.8,.8]}
        write_json_atomic(self.ws.paper_path, {"meta": {"pages": [{"n": 1}]}, "blocks": [original]})
        with patch("easyread.pdf.manual_crop.crop", return_value="figures/crop-manual.webp"):
            save(self.ws, {"id": "f1", "page": 1, "box": [.2,.2,.7,.7]})
        self.assertEqual(missing(self.ws), [])
        save(self.ws, {"id": "f1", "reset": True})
        self.assertEqual(self.ws.load("paper")["blocks"][0], original)

    def test_crop_rejects_bad_page_before_writing(self):
        write_json_atomic(self.ws.paper_path, {"meta": {"pages": [{"n": 1}]}, "blocks": [{"id": "f1", "type": "figure"}]})
        before = self.ws.paper_path.read_bytes()
        with self.assertRaises(ValueError):
            save(self.ws, {"id": "f1", "page": 2, "box": [.2,.2,.7,.7]})
        self.assertEqual(self.ws.paper_path.read_bytes(), before)

    def test_markdown_preserves_answer_and_bundles_only_paper_images(self):
        write_json_atomic(self.ws.paper_path, {"meta": {"title_en": "Paper", "doi": "10.1/demo"}})
        media = self.ws.root / "chat-media"; media.mkdir()
        (media / "image.png").write_bytes(b"test image")
        answer = "## Heading\n\n$$x^2$$\n\n```python\nx = 1\n```"
        write_json_atomic(self.ws.root / "chat.json", {"threads": [{"id": "t1", "messages": [
            {"role": "user", "content": "Explain", "images": ["chat-media/image.png"]},
            {"role": "assistant", "id": "m1", "content": answer}]}]})
        result = export(self.ws, {"thread": "t1", "id": "m1"})
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["data"]))) as z:
            self.assertEqual(len(z.namelist()), 2)
            md = z.read(next(n for n in z.namelist() if n.endswith(".md"))).decode()
            self.assertIn(answer, md)
            self.assertIn("assets/image.png", md)
            self.assertIn("https://doi.org/10.1/demo", md)

    def test_opencode_ignores_tool_text_and_surfaces_errors(self):
        events = [{"type": "text", "part": {"id": "p", "text": "answer"}},
                  {"type": "tool_use", "part": {"text": "untrusted tool result"}},
                  {"type": "text", "part": {"synthetic": True, "text": "internal summary"}}]
        self.assertEqual(opencode_cli.parse("\n".join(map(json.dumps, events)))[0], "answer")
        self.assertEqual(opencode_cli.parse('{"type":"error","error":{"data":{"message":"login required"}}}')[1], "login required")

    def test_opencode_disables_agent_tools_and_passes_images_as_arguments(self):
        with patch.object(opencode_cli.netcheck, "proxy_env", return_value=None):
            env = opencode_cli.environment()
        self.assertEqual(env.get("PATH"), os.environ.get("PATH"))
        self.assertEqual(json.loads(env["OPENCODE_PERMISSION"]), {"*": "deny"})
        config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(config["permission"], {"*": "deny"})
        args = opencode_cli.build_args("opencode", {"model": "provider/model"}, [Path("image.png")])
        self.assertNotIn("--agent", args)
        self.assertIn("provider/model", args)
        self.assertIn(str(Path("image.png").resolve()), args)


if __name__ == "__main__":
    unittest.main()
