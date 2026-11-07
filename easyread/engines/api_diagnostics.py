"""Opt-in response diagnostics: EASYREAD_API_DIAGNOSTICS is a local directory.

Each HTTP attempt gets its own JSONL file. No request body, URL, cookies or
authorization headers are recorded. Raw responses may contain paper text.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path


_FIELDS = {"finish_reason", "finishMessage", "finishReason", "status",
           "incomplete_details", "refusal", "blockReason", "safetyRatings", "usage"}
_LIMIT = 16 * 1024 * 1024


class DiagnosticResponse:
    def __init__(self, response, options, output):
        self.response, self.output = response, output
        self.secret = options.get("api_key") or ""
        self.metadata = {}
        self.raw_bytes = 0
        self.done = False
        self._write({"kind": "request", "model": options.get("model"),
                     "api": options.get("api", "chat"),
                     "http_status": getattr(response, "status", getattr(response, "code", None)),
                     "request_ids": {key: self.headers.get(key) for key in
                                     ("x-request-id", "request-id", "x-goog-request-id", "cf-ray")
                                     if self.headers.get(key)}})

    @property
    def headers(self):
        return getattr(self.response, "headers", {}) or {}

    def _write(self, item):
        if self.output is None:
            return
        text = json.dumps(item, ensure_ascii=False)
        if self.secret:
            # Also redact the serialized form of keys containing JSON escapes.
            text = text.replace(self.secret, "[REDACTED]")
            text = text.replace(json.dumps(self.secret, ensure_ascii=False)[1:-1], "[REDACTED]")
        try:
            self.output.write(text + "\n")
            self.output.flush()
        except OSError:
            self._close()

    def _close(self):
        if self.output is not None:
            try:
                self.output.close()
            except OSError:
                pass
            self.output = None

    def _raw(self, raw):
        remaining = max(0, _LIMIT - self.raw_bytes)
        self.raw_bytes += len(raw)
        if remaining:
            self._write({"kind": "raw", "text": raw[:remaining].decode("utf-8", "replace")})

    def observe(self, event):
        if event is None:
            self.done = True
        elif isinstance(event, dict):
            if event.get("type") in ("response.completed", "response.incomplete", "response.failed"):
                self.metadata["terminal_event"] = event["type"]
            for key, value in event.items():
                if key in _FIELDS and value is not None:
                    self.metadata[key] = value
                if isinstance(value, (dict, list)):
                    self.observe(value)
        elif isinstance(event, list):
            for item in event:
                self.observe(item)

    def __iter__(self):
        for raw in self.response:
            self._raw(raw)
            yield raw

    def read(self, *args):
        raw = self.response.read(*args)
        self._raw(raw)
        try:
            self.observe(json.loads(raw))
        except (ValueError, UnicodeError):
            pass
        return raw

    def __enter__(self):
        self.response.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._write({"kind": "result", "done_marker": self.done,
                     "metadata": self.metadata, "raw_truncated": self.raw_bytes > _LIMIT,
                     "error_type": exc_type.__name__ if exc_type else None,
                     "error": str(exc) if exc else None})
        self._close()
        return self.response.__exit__(exc_type, exc, tb)


def capture(response, options):
    directory = os.environ.get("EASYREAD_API_DIAGNOSTICS")
    if not directory:
        return response
    try:
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        output = (root / f"api-{stamp}-{uuid.uuid4().hex}.jsonl").open("x", encoding="utf-8")
    except OSError:
        return response  # A diagnostic disk failure must not fail a translation.
    return DiagnosticResponse(response, options, output)


def observe(response, event):
    if isinstance(response, DiagnosticResponse):
        response.observe(event)


def http_error(error, options, detail):
    response = capture(error, options)
    if isinstance(response, DiagnosticResponse):
        response._raw(detail.encode("utf-8"))
        response.__exit__(type(error), error, error.__traceback__)
