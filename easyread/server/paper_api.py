"""单篇论文的写接口 /api/p/<id>/<action>：笔记、条目字段、翻译、取消、删除等。
问 AI（chat）和笔记助手（notehelp）是流式回复，留在 server.py。"""
from __future__ import annotations

from ..chat import chat_store
from ..library import paperdata
from ..library.reader_files import reveal
from ..translate import translate_api
from ..app.i18n import tr


def post(app, ws, parts: list[str], body: dict):
    """返回要回给页面的 JSON；不认识的 action 返回 None。"""
    action = parts[4]
    if action == "translate-selection":
        from ..translate.selection import translate
        return translate(ws, body)
    if action == "chat-export":
        from ..export.chat_markdown import export
        return export(ws, body)
    if action == "figure-crop":
        if (ws.load("job") or {}).get("state") in ("queued", "running"):
            raise ValueError(tr("请等本篇翻译完成后再裁图"))
        from ..pdf.manual_crop import save
        return save(ws, body)
    if action == "chat" and len(parts) > 5:
        sub, tid = parts[5], body.get("thread", "")
        if sub == "pin":
            chat_store.pin(ws, tid, body.get("id", ""))
        elif sub == "rename":
            chat_store.rename(ws, tid, body.get("title", ""))
        elif sub == "delete":
            chat_store.delete(ws, tid)
        return {"threads": chat_store.threads(ws)}
    if action == "discussion_del":
        return {"deleted": paperdata.delete_discussion(ws, str(body.get("id", "")))}
    if action == "ops":
        ops = body.get("ops") or []
        if not isinstance(ops, list):
            raise ValueError(tr("ops 必须是数组"))
        res = ws.apply_reader_ops(ops, client=str(body.get("client", ""))[:40])
        res["versions"] = ws.versions()
        return res
    if action == "item":
        return ws.patch_item(body)
    if action == "translate":
        return translate_api.enqueue(app.jobs, ws, body)
    if action == "prepare":
        app.jobs.enqueue(ws, translate_after=False)
        return {"ok": True}
    if action == "reveal":  # 在资源管理器 / 访达里打开这篇的文件夹
        reveal(ws.root)
        return {"ok": True}
    if action == "cancel":
        app.jobs.cancel(ws.id)
        return {"ok": True}
    if action == "answer":
        return app.jobs.submit_small("answer", ws.id, note=body["note"])
    if action == "retranslate":
        return app.jobs.submit_small("retranslate", ws.id, key=body["key"], hint=body.get("hint", ""))
    if action == "delete":
        app.jobs.cancel(ws.id)
        return {"trash": str(app.lib.trash(ws.id))}
    return None
