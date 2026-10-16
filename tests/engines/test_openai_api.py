"""OpenAI 兼容接口的两种格式（chat / responses）、去掉 temperature 重试、模型列表。  python -m unittest tests.engines.test_openai_api"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from easyread.engines import openai_api, usage

SEEN = []


class FakeAPI(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj, ctype="application/json"):
        data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("User-Agent", "").startswith("Python-urllib"):  # 像 Cloudflare 那样拦默认 UA（#10）
            return self._send(403, b"error code: 1010", "text/plain")
        self._send(200, {"object": "list", "data": [{"id": "b-model"}, {"id": "a-model"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append((self.path, body))
        if not self.headers.get("x-opencode-session"):  # 像 OpenCode Go 那样要求会话 ID（#10）
            return self._send(400, {"type": "error", "error": {"type": "MissingSessionID"}})
        if body.get("model") == "slow":
            import time
            time.sleep(3)
        if body.get("model") == "fixed-temp" and "temperature" in body:
            return self._send(400, {"error": {"message": "invalid temperature: only 1 is allowed for this model"}})
        stream = body.get("stream") and body.get("model") != "json-only"  # json-only：像不认 stream 的接口，照旧一次性返回
        if self.path.endswith("/responses"):
            if stream:
                evs = [{"type": "response.created"}, {"type": "response.reasoning_text.delta", "delta": "想一想"},
                       {"type": "response.output_text.delta", "delta": "你"}, {"type": "response.output_text.delta", "delta": "好"},
                       {"type": "response.completed", "response": {"status": "completed", "usage": {"input_tokens": 9, "output_tokens": 2}}}]
                return self._send(200, b"".join(b"event: x\ndata: " + json.dumps(e).encode() + b"\n\n" for e in evs), "text/event-stream")
            return self._send(200, {"object": "response", "status": "completed", "output": [
                {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "想一想"}]},
                {"type": "message", "content": [{"type": "output_text", "text": '{"ok": true}'}]}]})
        if stream:  # 推理过程不算回答；有的接口每一块都带累计用量
            evs = [{"choices": [{"delta": {"role": "assistant", "reasoning_content": "想一想"}}], "usage": {"prompt_tokens": 7, "completion_tokens": 1}},
                   {"choices": [{"delta": {"content": "chat-"}}], "usage": {"prompt_tokens": 7, "completion_tokens": 2}},
                   {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 7, "completion_tokens": 3}}]
            return self._send(200, b"".join(b"data: " + json.dumps(e).encode() + b"\n\n" for e in evs) + b"data: [DONE]\n\n", "text/event-stream")
        return self._send(200, {"choices": [{"message": {"content": "chat-ok"}, "finish_reason": "stop"}]})


class OpenAIApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        SEEN.clear()

    def test_responses_complete(self):
        meter = usage.Meter()
        out = openai_api.complete({"base_url": self.base, "model": "m", "api": "responses"}, "问题", [], meter=meter)
        self.assertEqual(out, "你好")                          # 只要 message，不要推理过程
        path, body = SEEN[0]
        self.assertEqual(path, "/v1/responses")
        self.assertIs(body["stream"], True)
        self.assertNotIn("temperature", body)
        self.assertEqual(body["input"][0]["content"][0], {"type": "input_text", "text": "问题"})
        self.assertEqual((meter.data["calls"], meter.data["input"], meter.data["output"]), (1, 9, 2))

    def test_chat_complete_streams_and_counts_usage_once(self):
        # 一次性返回要等整批译完，推理模型常要几分钟，中转站前面的 Cloudflare 等不了（524）：翻译也走流式
        meter = usage.Meter()
        self.assertEqual(openai_api.complete({"base_url": self.base, "model": "m"}, "q", [], meter=meter), "chat-ok")
        body = SEEN[0][1]
        self.assertIs(body["stream"], True)
        self.assertEqual(body["stream_options"], {"include_usage": True})
        self.assertEqual((meter.data["calls"], meter.data["input"], meter.data["output"]), (1, 7, 3))  # 只记最后一份

    def test_complete_reads_whole_json_when_stream_is_ignored(self):
        for api, want in [("chat", "chat-ok"), ("responses", '{"ok": true}')]:  # responses 照样只要 message
            with self.subTest(api=api):
                meter = usage.Meter()
                o = {"base_url": self.base, "model": "json-only", "api": api}
                self.assertEqual(openai_api.complete(o, "q", [], meter=meter), want)
                self.assertEqual(meter.data["calls"], 1)

    def test_responses_stream(self):
        o = {"base_url": self.base, "model": "m", "api": "responses"}
        self.assertEqual("".join(openai_api.stream(o, "问题", threading.Event())), "你好")

    def test_cancel_does_not_wait_for_response(self):
        import time
        from easyread.engines.engines import Cancelled
        cancel = threading.Event()
        self.assertEqual(openai_api.complete({"base_url": self.base, "model": "m"}, "q", [], cancel), "chat-ok")
        threading.Timer(0.2, cancel.set).start()
        start = time.monotonic()
        with self.assertRaises(Cancelled):
            openai_api.complete({"base_url": self.base, "model": "slow"}, "q", [], cancel)
        self.assertLess(time.monotonic() - start, 1.5)  # 接口 3 秒才回，点了取消不用等它

    def test_chat_drops_temperature_when_rejected(self):
        self.assertEqual(openai_api.complete({"base_url": self.base, "model": "fixed-temp"}, "q", []), "chat-ok")
        self.assertEqual([("temperature" in b) for _, b in SEEN], [True, False])

    def test_models(self):
        self.assertEqual(openai_api.models({"base_url": self.base + "/"}), ["a-model", "b-model"])


if __name__ == "__main__":
    unittest.main()
