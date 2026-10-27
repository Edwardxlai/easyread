import base64
import io
import json
import threading
import unittest
import urllib.error
from email import policy
from email.parser import BytesParser
from unittest.mock import patch

from PIL import Image

from easyread.engines import image_edit
from easyread.engines.engines import Cancelled, EngineError


def png():
    stream = io.BytesIO()
    Image.new("RGB", (80, 40), "white").save(stream, "PNG")
    return stream.getvalue()


class ImageEditTest(unittest.TestCase):
    def setUp(self):
        self.options = {"base_url": "https://images.example/v1/", "model": "editor", "api_key": "secret"}

    def test_uploads_actual_image_and_prompt_and_decodes_response(self):
        response = {"data": [{"b64_json": base64.b64encode(png()).decode()}]}
        with patch.object(image_edit.http, "urlopen", return_value=io.BytesIO(json.dumps(response).encode())) as send:
            result = image_edit.edit(self.options, png(), "Translate to Japanese", threading.Event())
        req = send.call_args.args[0]
        self.assertEqual(req.full_url, "https://images.example/v1/images/edits")
        self.assertEqual(req.get_header("Authorization"), "Bearer secret")
        message = BytesParser(policy=policy.default).parsebytes(
            ("Content-Type: " + req.get_header("Content-type") + "\r\n\r\n").encode() + req.data)
        fields = {part.get_param("name", header="content-disposition"): part.get_payload(decode=True) for part in message.iter_parts()}
        self.assertEqual(fields["model"], b"editor")
        self.assertEqual(fields["prompt"], b"Translate to Japanese")
        self.assertEqual(fields["n"], b"1")
        with Image.open(io.BytesIO(fields["image"])) as source, Image.open(io.BytesIO(result)) as edited:
            self.assertEqual(source.size, (80, 40))
            self.assertEqual(edited.format, "WEBP")

    def test_url_result_download_does_not_forward_key(self):
        response = {"data": [{"url": "https://cdn.example/edited.png"}]}
        with patch.object(image_edit.http, "urlopen", side_effect=[io.BytesIO(json.dumps(response).encode()), io.BytesIO(png())]) as send:
            image_edit.edit(self.options, png(), "translate", threading.Event())
        self.assertEqual(send.call_args_list[1].args, ("https://cdn.example/edited.png",))
        self.assertNotIn("secret", str(send.call_args_list[1]))

    def test_invalid_outputs_are_not_accepted_as_images(self):
        for result in ({"data": []}, {"data": [{"b64_json": "garbage"}]},
                       {"data": [{"b64_json": base64.b64encode(b"not an image").decode()}]},
                       {"data": [{"url": "file:///etc/passwd"}]}):
            with self.subTest(result=result), patch.object(image_edit.http, "urlopen", return_value=io.BytesIO(json.dumps(result).encode())):
                with self.assertRaises(EngineError):
                    image_edit.edit(self.options, png(), "translate", threading.Event())

    def test_http_failure_is_not_retried_or_leaked(self):
        error = urllib.error.HTTPError(self.options["base_url"], 429, "secret", {}, io.BytesIO(b"secret"))
        with patch.object(image_edit.http, "urlopen", side_effect=error) as send:
            with self.assertRaises(EngineError) as caught:
                image_edit.edit(self.options, png(), "translate", threading.Event())
        self.assertEqual(send.call_count, 1)
        self.assertNotIn("secret", str(caught.exception))

    def test_cancel_discards_late_response(self):
        cancel, started, finish, ended = (threading.Event() for _ in range(4))

        def slow(*args):
            started.set()
            finish.wait(5)
            ended.set()
            return png()

        with patch.object(image_edit, "_request", side_effect=slow):
            timer = threading.Thread(target=lambda: (started.wait(2), cancel.set()))
            timer.start()
            try:
                with self.assertRaises(Cancelled):
                    image_edit.edit(self.options, png(), "translate", cancel)
                self.assertFalse(ended.is_set())
            finally:
                finish.set()
                timer.join(2)
                self.assertTrue(ended.wait(2))
