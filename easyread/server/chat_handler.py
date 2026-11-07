"""HTTP streaming for the reader chat, including attachment lifecycle."""
import json
import threading
from ..chat import answer_styles, chat, chat_models, chat_store, documents
from ..app import config
from ..app.i18n import tr
from ..app.log import log
from ..engines import engines, usage

def handle(self, ws, body: dict):
    """流式回答：一行一个 JSON，{"t": 片段} … 最后 {"done": true, "id": …} 或 {"error": …}。"""
    text = (body.get("text") or "").strip()
    if not text:
        raise ValueError(tr("问题是空的"))
    thread = chat_store.get(ws, body.get("thread"))
    style = answer_styles.parse(body.get("answer_style", (thread or {}).get("answer_style")))
    cfg = config.load()
    ecfg, m = chat_models.engine_cfg(cfg, body.get("model"))
    from ..chat import chat_options
    options = chat_options.apply(ecfg, body.get("chat_options"))
    images = []
    model = chat_models.label(m)
    tid = thread["id"] if thread else chat_store.new_id()
    refs = [{"anchor": str(r.get("anchor") or ""), "quote": str(r.get("quote") or "")[:1000]}
            for r in (body.get("refs") or [])[:12] if isinstance(r, dict) and r.get("anchor")]
    first = refs[0] if refs else {}
    user = {"content": text, "anchor": body.get("anchor") or first.get("anchor"), "quote": (body.get("quote") or first.get("quote") or "")[:1000],
            "note": body.get("note"), "refs": refs, "answer_style": style, "chat_options": options, "images": images}
    user["documents"] = documents.extract(body.get("documents"))
    past = (thread or {}).get("messages", [])
    convo = [{"role": x["role"], "content": x["content"]} for x in past] + [{"role": "user", "content": text}]
    prompt_text = chat.prompt(ws, convo, user["anchor"], user["quote"], ecfg["engine"], refs, answer_style=style)
    prompt_text += documents.context((past + [user])[-chat.HISTORY:])
    images = chat.receive_images(ws, body.get("images"), ecfg)
    user["images"] = images
    self.send_response(200)
    self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
    self.send_header("Cache-Control", "no-store")
    self.send_header("Connection", "close")
    self.end_headers()
    self.close_connection = True
    cancel = threading.Event()
    pieces: list[str] = []
    meter = usage.Meter(ecfg["engine"])

    def send(obj):
        self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        self.wfile.flush()
    try:
        send({"model": model, "thread": tid, "answer_style": style,
              "documents": [{k: f[k] for k in ("name", "truncated")} for f in user["documents"]]})
        def seen(actual):
            chat_models.remember(m.get("model", ""), actual)
            if m.get("engine") == "claude":
                send({"model": chat_models.label(m)})
        attachments = chat.image_paths(ws, past + [user])
        image_options = {"images": attachments} if attachments else {}
        for piece in chat.stream(ecfg, prompt_text, ws.root, cancel, seen, meter, **image_options):
            pieces.append(piece)
            send({"t": piece})
        msg = chat_store.append(ws, tid, user, "".join(pieces), m["id"], model, meter.snapshot())
        send({"done": True, "id": msg["id"], "usage": msg.get("usage")})
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        cancel.set()  # 读者点了停止或关了页面
        if pieces:
            chat_store.append(ws, tid, {**user, "note": None}, "".join(pieces) + "\n\n" + tr("（已停止）"), m["id"], model, meter.snapshot())
    except engines.Cancelled:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("对话出错 %s", ws.id)
        try:
            send({"error": str(e)[:500]})
        except OSError:
            pass
    finally:
        saved = chat_store.get(ws, tid) or {}
        retained = {name for message in saved.get("messages", [])
                    for name in message.get("images", [])}
        for path in chat.image_paths(ws, [{"images": images}]):
            if path.relative_to(ws.root.resolve()).as_posix() not in retained:
                path.unlink(missing_ok=True)
