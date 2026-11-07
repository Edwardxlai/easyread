"""Clipboard image validation and transport; never calls a real model."""
import base64
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from contextlib import nullcontext
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
import urllib.error
import urllib.request

from PIL import Image

from easyread.chat import chat, chat_store
from easyread.engines import engines, openai_api
from easyread.library.store import Workspace


class ChatImagesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.ws = Workspace(Path(temporary.name))
        (self.ws.root / "paper.json").write_text('{"meta": {}, "blocks": []}', encoding="utf-8")
        out = io.BytesIO()
        Image.new("RGB", (16, 12), "blue").save(out, "PNG")
        self.data = "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()

    def test_validated_images_persist_as_scoped_png_and_survive_chat_history(self):
        names = chat.receive_images(self.ws, [self.data], {"engine": "codex"})
        self.assertRegex(names[0], r"^chat-media/[0-9a-f]{32}\.png$")
        with Image.open(self.ws.root / names[0]) as image:
            self.assertEqual((image.format, image.size), ("PNG", (16, 12)))
        chat_store.append(self.ws, "thread", {"content": "Explain", "images": names}, "Answer", "m", "Model")
        saved = chat_store.get(self.ws, "thread")["messages"]
        self.assertEqual(chat.image_paths(self.ws, saved), [self.ws.root / names[0]])
        self.assertEqual(chat.image_paths(self.ws, [{"images": ["../reader.json", "/outside.png", "chat-media/../../config.json"]}]), [])

    def test_invalid_image_type_count_size_and_pixels_are_rejected_before_writes(self):
        large = io.BytesIO()
        Image.new("1", (5000, 4000)).save(large, "PNG")
        invalid = ["not a list", [self.data] * 5, ["data:image/svg+xml;base64,PHN2Zy8+"],
                   ["data:image/png;base64,bm90LWFuLWltYWdl"], ["data:image/png;base64," + "A" * (13 * 1024 * 1024)],
                   ["data:image/png;base64," + base64.b64encode(large.getvalue()).decode()]]
        for images in invalid:
            with self.subTest(images=str(images)[:50]), self.assertRaises(ValueError):
                chat.receive_images(self.ws, images, {"engine": "codex"})
        self.assertFalse((self.ws.root / "chat-media").exists())

    def test_only_four_recent_safe_images_are_forwarded(self):
        names = []
        for _ in range(5):
            names.extend(chat.receive_images(self.ws, [self.data], {"engine": "codex"}))
        paths = chat.image_paths(self.ws, [{"images": names}])
        self.assertEqual(paths, [self.ws.root / name for name in names[-4:]])

    def test_codex_receives_image_paths_through_existing_adapter(self):
        names = chat.receive_images(self.ws, [self.data], {"engine": "codex"})
        paths = chat.image_paths(self.ws, [{"images": names}])
        with patch.object(chat.netcheck, "problem", return_value=None), patch.object(engines, "run", return_value="Seen") as run:
            self.assertEqual(list(chat.stream({"engine": "codex"}, "Explain", self.ws.root, threading.Event(), images=paths)), ["Seen"])
        self.assertEqual(run.call_args.args[3], paths)

    def test_claude_read_prompt_and_api_stream_include_images(self):
        paths = chat.image_paths(self.ws, [{"images": chat.receive_images(self.ws, [self.data], {"engine": "claude"})}])
        with patch.object(chat.netcheck, "problem", return_value=None), patch.object(chat, "_stream_claude", return_value=iter(["Seen"])) as claude:
            self.assertEqual(list(chat.stream({"engine": "claude", "claude": {}}, "Explain", self.ws.root, threading.Event(), images=paths)), ["Seen"])
        self.assertIn(str(paths[0]), claude.call_args.args[1])
        for api in ("chat", "responses"):
            options = {"engine": "openai", "openai": {"api": api, "model": "fake", "vision": False}}
            with patch.object(chat.netcheck, "problem", return_value=None), patch.object(openai_api, "stream", return_value=iter(["Seen"])) as stream:
                self.assertEqual(list(chat.stream(options, "Explain", self.ws.root, threading.Event(), images=paths)), ["Seen"])
            self.assertEqual(stream.call_args.kwargs["images"], paths)
            payload = openai_api._body(options["openai"], "Explain", paths, True, None)
            content = payload["input"][0]["content"] if api == "responses" else payload["messages"][0]["content"]
            url = content[1]["image_url"] if api == "responses" else content[1]["image_url"]["url"]
            self.assertTrue(url.startswith("data:image/png;base64,"))

    def test_http_chat_persists_attachment_serves_it_and_keeps_it_in_followups(self):
        from easyread.server.server import Handler
        app = SimpleNamespace(token="test-token", lib=SimpleNamespace(ws=lambda pid: self.ws if pid == "paper" else None),
                              location=SimpleNamespace(status="idle", request=lambda *args: nullcontext()))
        handler = type("ImageHandler", (Handler,), {"app":app, "log_message":lambda *args:None})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}"
        def post(body, token="test-token"):
            request = urllib.request.Request(url + "/api/p/paper/chat", json.dumps(body).encode(),
                                            {"Content-Type":"application/json", "X-Token":token})
            with urllib.request.urlopen(request) as response:
                return [json.loads(line) for line in response.read().decode().splitlines()]
        model = {"id":"fixture", "name":"Fixture model", "engine":"codex", "model":"fake"}
        with patch("easyread.server.server.config.load", return_value={}), \
                patch("easyread.server.server.chat_models.engine_cfg", return_value=({"engine":"codex", "codex":{}}, model)), \
                patch("easyread.server.server.chat.stream", side_effect=lambda *args, **kwargs: iter(["Image received"])) as stream:
            from tests.pdf.test_blank_footnotes import pdf
            extra = self.ws.root / "supplement.pdf"
            pdf(extra)
            documents = [{"name": "supplement.pdf", "data": base64.b64encode(extra.read_bytes()).decode()},
                         {"name": "notes.txt", "data": base64.b64encode(b"experiment group B").decode()}]
            events = post({"text":"Explain", "images":[self.data], "documents": documents})
            self.assertEqual([d["name"] for d in events[0]["documents"]], ["supplement.pdf", "notes.txt"])
            self.assertIn("Normal body paragraph", stream.call_args.args[1])
            self.assertIn("experiment group B", stream.call_args.args[1])
            tid = events[0]["thread"]
            saved = chat_store.get(self.ws, tid)["messages"][0]
            self.assertEqual(stream.call_args.kwargs["images"], [self.ws.root / saved["images"][0]])
            with urllib.request.urlopen(url + "/p/paper/" + saved["images"][0]) as response:
                self.assertEqual(response.headers.get_content_type(), "image/png")
                self.assertTrue(response.read().startswith(b"\x89PNG"))
            post({"text":"And its color?", "thread":tid})
            self.assertEqual(stream.call_args.kwargs["images"], [self.ws.root / saved["images"][0]])
            self.assertIn("Normal body paragraph", stream.call_args.args[1])
            with self.assertRaises(urllib.error.HTTPError):
                post({"text": "Invalid PDF", "documents": [{"name":"x.pdf","data":"eA=="}]})
            before = stream.call_count
            with self.assertRaises(urllib.error.HTTPError) as error:
                post({"text":"Invalid", "images":["data:image/png;base64,bm90LWFuLWltYWdl"]})
            self.assertEqual(error.exception.code, 400)
            self.assertEqual(stream.call_count, before)
            with self.assertRaises(urllib.error.HTTPError) as error:
                post({"text":"Not authorized", "images":[self.data]}, token="wrong")
            self.assertEqual(error.exception.code, 403)
            before_files = set((self.ws.root / "chat-media").glob("*.png"))
            stream.side_effect = RuntimeError("controlled model failure")
            events = post({"text": "Fail safely", "images": [self.data]})
            self.assertTrue(any("error" in event for event in events))
            self.assertEqual(set((self.ws.root / "chat-media").glob("*.png")), before_files)
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(url + "/p/paper/chat-media/../reader.json")
        self.assertEqual(error.exception.code, 404)
