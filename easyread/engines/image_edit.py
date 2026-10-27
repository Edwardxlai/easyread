"""OpenAI-compatible Images Edits API. No automatic retries of paid edits.

The request thread owns the connection and returns bytes only. Cancellation
discards its result; only the caller may publish an image into the library.
"""
from __future__ import annotations

import base64
import io
import json
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid

from PIL import Image

from .. import __version__
from ..app.i18n import tr
from ..server import http
from .engines import Cancelled, EngineError


def _request(options: dict, source: bytes, prompt: str) -> bytes:
    boundary = "easyread-" + uuid.uuid4().hex
    chunks = []
    for key, value in {"model": options["model"], "prompt": prompt, "n": "1"}.items():
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    # Normalize crops and custom image formats to an accepted upload format.
    with Image.open(io.BytesIO(source)) as image:
        png = io.BytesIO()
        image.convert("RGBA" if "A" in image.getbands() else "RGB").save(png, format="PNG")
    chunks.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="figure.png"\r\nContent-Type: image/png\r\n\r\n'.encode(),
                   png.getvalue(), f'\r\n--{boundary}--\r\n'.encode()])
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": f"EasyRead/{__version__}"}
    if options.get("api_key"):
        headers["Authorization"] = "Bearer " + options["api_key"]
    req = urllib.request.Request(options["base_url"].rstrip("/") + "/images/edits", data=b"".join(chunks), headers=headers)
    timeout = options.get("timeout") or 600
    try:
        with http.urlopen(req, timeout=timeout) as response:
            result = json.loads(response.read())
        item = result["data"][0]
        if item.get("b64_json"):
            content = base64.b64decode(item["b64_json"], validate=True)
        else:
            url = item["url"]
            if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
                raise ValueError("Unsupported image URL")
            # Signed image URLs must never receive the API credential.
            with http.urlopen(url, timeout=timeout) as response:
                content = response.read()
        with Image.open(io.BytesIO(content)) as image:
            out = io.BytesIO()
            image.convert("RGBA" if "A" in image.getbands() else "RGB").save(out, format="WEBP", lossless=True)
        return out.getvalue()
    except urllib.error.HTTPError as error:
        error.close()
        raise EngineError(tr("译图接口返回 {code}", code=error.code)) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        raise EngineError(tr("译图接口连接失败或未返回有效图片")) from None
    except (KeyError, IndexError, TypeError, ValueError):
        raise EngineError(tr("译图接口未返回有效图片")) from None


def edit(options: dict, source: bytes, prompt: str, cancel) -> bytes:
    if cancel.is_set():
        raise Cancelled()
    result = {}

    def run():
        try:
            result["image"] = _request(options, source, prompt)
        except Exception as error:
            result["error"] = error

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    while worker.is_alive():
        worker.join(.2)
        if cancel.is_set():
            raise Cancelled()
    if cancel.is_set():
        raise Cancelled()
    if "error" in result:
        raise result["error"]
    return result["image"]
