"""“问 AI”的流式输出：用一个本机假的 OpenAI 兼容接口测，包括推理模型的 <think> 被去掉。  python -m unittest tests.chat.test_chat"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from easyread.chat import chat, chat_models

PIECES = ["<think>先想", "一想</think>", "标准误差", "除以 $\sqrt{n}$", "。"]


class FakeAPI(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["stream"] is True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for p in PIECES:
            self.wfile.write(b"data: " + json.dumps({"choices": [{"delta": {"content": p}}]}).encode() + b"\n\n")
        self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
        self.wfile.write(b"data: [DONE]\n\n")


class ChatStreamTest(unittest.TestCase):
    def test_openai_stream_strips_think(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            cfg = {"engine": "openai", "openai": {"base_url": f"http://127.0.0.1:{srv.server_address[1]}/v1", "model": "fake", "api_key": "k"}}
            out = "".join(chat.stream(cfg, "问题", None, threading.Event()))
        finally:
            srv.shutdown()
            srv.server_close()
        self.assertEqual(out, "标准误差除以 $\sqrt{n}$。")

    def test_model_list_picks_preset_key(self):
        cfg = {"engine": "claude", "claude": {"model": ""}, "codex": {"model": ""},
               "chat": {"default": "ds", "models": [{"id": "ds", "name": "DeepSeek", "engine": "openai", "preset": "deepseek", "model": ""}]},
               "openai": {"preset": "zhipu", "base_url": "x", "model": "glm", "api_key": "zk", "keys": {"zhipu": "zk", "deepseek": "dk"}}}
        e, m = chat_models.engine_cfg(cfg, None)
        self.assertEqual((e["engine"], e["openai"]["api_key"], e["openai"]["model"], m["id"]), ("openai", "dk", "deepseek-flash", "ds"))

    def test_threads_and_legacy(self):
        import shutil, tempfile
        from pathlib import Path
        from easyread.chat import chat_store
        from easyread.library.store import Workspace, write_json_atomic
        root = Path(tempfile.mkdtemp())
        try:
            write_json_atomic(root / "paper.json", {"blocks": []})
            write_json_atomic(root / "chat.json", {"messages": [{"role": "user", "content": "旧问题"}, {"role": "assistant", "content": "旧回答"}]})
            ws = Workspace(root)
            chat_store.append(ws, "t2", {"content": "新问题"}, "新回答", "opus", "Claude Opus 5.5")
            ts = chat_store.threads(ws)
            self.assertEqual([t["title"] for t in ts], ["新问题", "旧问题"])
            chat_store.delete(ws, "t-first")
            self.assertEqual(len(chat_store.threads(ws)), 1)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_marks_only_when_asked_and_refs(self):
        import shutil, tempfile
        from pathlib import Path
        from easyread.library.store import Workspace, write_json_atomic
        root = Path(tempfile.mkdtemp())
        try:
            blocks = [{"id": "a", "type": "p", "zh": "甲段 $x$"}, {"id": "b", "type": "p", "zh": "乙段"}, {"id": "c", "type": "p", "zh": "丙段"}]
            write_json_atomic(root / "paper.json", {"meta": {}, "blocks": blocks})
            write_json_atomic(root / "reader.json", {"notes": {"n1": {"anchor": "a", "quote": "红色重点", "color": "pink", "kind": "highlight"},
                                                                "n2": {"anchor": "b", "quote": "黄色句子", "color": "yellow", "kind": "highlight"}}})
            ws = Workspace(root)
            refs = [{"anchor": "b", "quote": ""}, {"anchor": "c", "quote": "丙"}]
            plain = chat.prompt(ws, [{"role": "user", "content": "这两段什么关系"}], "b", "", "openai", refs)
            self.assertNotIn("红色重点", plain)           # 没问到标记，就不带
            self.assertIn("2 处标记", plain)
            self.assertIn("[c] 读者选中：「丙」", plain)   # 引用的第二段也在
            red = chat.prompt(ws, [{"role": "user", "content": "我标红的那些有什么联系"}], None, "", "openai")
            self.assertIn("红色重点", red)
            self.assertNotIn("黄色句子", red)              # 只带问到的颜色
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
