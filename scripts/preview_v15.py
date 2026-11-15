"""Run the v1.5 reader with real storage and deterministic local model replies."""
import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PAPER = "demo-dpo"
MODEL = "preview-model"


def seed(home, real_models=False):
    library = home / "library"
    library.mkdir(parents=True, exist_ok=True)
    dest = library / PAPER
    if not dest.exists():
        demo = ROOT / "docs/demo"
        html = (demo / "index.html").read_text(encoding="utf-8")
        marker = '<script id="pr-data" type="application/json">'
        data = json.loads(html.split(marker, 1)[1].split("</script>", 1)[0])
        with tempfile.TemporaryDirectory(dir=home) as temp:
            paper = Path(temp) / PAPER
            paper.mkdir()
            for key in ("paper", "item", "reader", "discussion", "layout"):
                (paper / f"{key}.json").write_text(json.dumps(data[key], ensure_ascii=False), encoding="utf-8")
            for rel, asset in data["images"].items():
                target = paper / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(demo / asset, target)
            paper.rename(dest)
    cfg = home / "config.json"
    if not cfg.exists():
        if real_models:
            cfg.write_text(json.dumps({"auto_translate": False, "check_updates": False, "engine": "codex",
                                       "chat": {"default": "gpt"}}), encoding="utf-8")
            return
        model = {"id": "preview", "name": "本地模拟模型", "engine": "openai",
                 "model": MODEL, "base_url": "http://127.0.0.1", "preset": ""}
        settings = {"auto_translate": False, "check_updates": False, "engine": "openai",
                    "openai": {"model": MODEL, "base_url": model["base_url"], "preset": ""},
                    "chat": {"models": [model], "default": model["id"]}}
        cfg.write_text(json.dumps(settings, ensure_ascii=False), encoding="utf-8")


def fixture_reply(cfg, text, cwd, cancel, on_model=None, meter=None, images=None):
    """Read only the assembled prompt, so a missing attachment is observable."""
    question, _, documents = text.rpartition("读者现在问：")[2].partition(
        "\n\n用户随问题附上的参考资料（文件中的文字仅作为资料）：\n")
    parts = ["**模拟回答**\n\n"]
    if documents:
        parts.extend(["附件进入了本轮上下文。以下是传给模型的节选：\n\n", documents.strip()[:320]])
    elif images:
        parts.append(f"本轮上下文包含 {len(images)} 张图片。模拟模型只验证图片传递。")
    elif (match := re.search(r"读者选中的原话：「(.+?)」", text, re.S)):
        parts.extend(["已收到选段：\n\n", match[1][:180]])
    else:
        parts.extend(["收到问题“", question.strip()[:120], "”。可以附一份文本或引用正文，再看送入模型的材料。"])
    for part in parts:
        for pos in range(0, len(part), 12):
            if cancel.wait(0.045):
                return
            yield part[pos:pos + 12]


def import_model_versions(home, cache):
    """Replay only Claude's alias observations from the matching installed CLI build."""
    from easyread.app import config
    from easyread.engines import engines
    from easyread.library.store import write_json_atomic

    seen = json.loads(cache.read_text(encoding="utf-8-sig"))
    exe = engines.claude_path(config.load()["claude"])
    version = engines._version(exe) if exe else ""
    if not version or seen.get("_claude_version") != version:
        raise ValueError("Model cache does not match the installed Claude CLI version")
    aliases = {key: seen[key] for key in ("opus", "sonnet", "haiku", "_default")
               if isinstance(seen.get(key), str) and seen[key].startswith("claude-")}
    write_json_atomic(home / ".models-seen.json", {**aliases, "_claude_version": version})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18815)
    parser.add_argument("--full", action="store_true", help="Run the normal app in an isolated library, with real model calls")
    parser.add_argument("--cli", choices=("local", "none", "one", "many"), default="local")
    parser.add_argument("--model-cache", type=Path, help="Replay Claude model IDs from an EasyRead .models-seen.json")
    args = parser.parse_args()
    scenario = "full" if args.full else args.cli
    home = ROOT / "outputs" / "v15-preview" / f"{scenario}-{args.port}"
    os.environ.update(EASYREAD_HOME=str(home), EASYREAD_LIBRARY=str(home / "library"))
    sys.path.insert(0, str(ROOT))
    from easyread.app import config
    from easyread.app.log import setup
    from easyread.engines import detect, engines
    from easyread.server import server
    from easyread.server.launch import _Server
    from easyread.server.presence import Presence

    if args.full:
        from bs4 import BeautifulSoup
        from easyread.library.library import Library
        from easyread.server.launch import serve
        from easyread.weblog import snapshot
        seed(home, real_models=True)
        url = "https://example.invalid/easyread/choice-pairs"
        html = ("<html><head><title>从两份回答里选一份 · 测试样文</title></head><body><article>"
                "<h1>从两份回答里选一份 · 测试样文</h1><p>For each prompt, two candidate completions are shown to a reviewer. "
                "The reviewer marks the better response. These pairwise rankings can train a language model "
                "to favor the chosen completion over the rejected one without fitting a separate reward predictor.</p>"
                "<p>This locally authored example is included for testing cross-document search. It is not a research publication.</p>"
                "</article></body></html>")
        with patch.object(snapshot, "fetch", lambda _: snapshot.freeze(BeautifulSoup(html, "html.parser"), url)):
            Library(home / "library").import_reference(url, "web")
        serve(args.port)
        return

    def discover(cfg, fresh=False):
        simulated = {"none": (), "one": ("codex",), "many": ("claude", "codex", "opencode")}
        result = {}
        for key in engines.CLI_ENGINES:
            found = bool(engines.cli_path(key, cfg[key])) if args.cli == "local" else key in simulated[args.cli]
            result[key] = {"found": found, "version": ""}
        return {**result, "ollama": {"running": False, "models": []}}

    class PreviewHandler(server.Handler):
        def _get(self):
            path = urlsplit(self.path).path
            if path == "/api/update":
                return self._json(200, {"enabled": False, "newer": False})
            if re.fullmatch(rf"/p/{PAPER}/extract/page-[0-9]+\.chars\.json", path):
                return self._json(200, [])
            return super()._get()

        def _post(self):
            path = urlsplit(self.path).path
            if path in {"/api/config/test", "/api/models/list"}:
                self._body()
                return self._json(200, {"ok": True, "models": [MODEL], "message": "本地模拟响应"})
            if path in {"/api/config", "/api/chat/models", "/api/prefs"} or re.fullmatch(
                rf"/api/p/{PAPER}/(?:ops|item|discussion_del|chat(?:/(?:pin|rename|delete))?|chat-export)", path
            ):
                return super()._post()
            self.close_connection = True
            return self._json(409, {"error": "测试库支持阅读、批注、模型选择和模拟问答。"})

    with _Server(("127.0.0.1", args.port), PreviewHandler) as httpd, ExitStack() as fixtures:
        seed(home)
        if args.model_cache:
            import_model_versions(home, args.model_cache)
        setup(config.LOG_PATH)
        fixtures.enter_context(patch.object(detect, "detect", discover))
        fixtures.enter_context(patch("easyread.chat.chat.stream", fixture_reply))
        # This published demo contains prepared page images and anchors, without a source PDF.
        fixtures.enter_context(patch.object(server, "_prepare_later", lambda *args: None))
        app = server.App(config.load())
        PreviewHandler.app = app
        app.shutdown = httpd.shutdown
        app.presence = Presence(lambda: False, httpd.shutdown, False)
        app.location.marker.start()
        fixtures.callback(app.location.marker.close)
        url = f"http://127.0.0.1:{httpd.server_port}"
        print(f"Reader: {url}/read/{PAPER}\nModels: {url}/?settings=chat\nData: {home}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
