"""“问 AI”的对话记录：每篇论文一个 chat.json，里面可以有多个对话（像聊天客户端那样新建、切换、删除）。

{"threads": [{"id", "title", "model", "answer_style", "created", "updated",
              "messages": [{"role": "user", "content", "anchor", "quote", "note", "at"},
                           {"role": "assistant", "id", "content", "model", "answer_style", "anchor", "note", "at"}]}]}
旧版只有一个顶层 "messages"，读的时候当成第一个对话。
"""
from __future__ import annotations

from uuid import uuid4

from ..app.i18n import tr
from . import answer_styles
from ..library.paperdata import add_discussion
from ..library.store import Workspace, now_iso


def _normalize(chat: dict) -> dict:
    if chat is None:
        chat = {}
    threads = chat.setdefault("threads", [])
    legacy = chat.pop("messages", None)
    if legacy:
        threads.insert(0, {"id": "t-first", "title": _title(legacy[0].get("content", "")), "model": "",
                           "created": legacy[0].get("at", ""), "updated": legacy[-1].get("at", ""), "messages": legacy})
    for t in threads:
        t.setdefault("answer_style", answer_styles.DEFAULT)
        for m in t.get("messages", []):
            m.setdefault("answer_style", answer_styles.DEFAULT)
    return chat


def _title(q: str) -> str:
    q = " ".join((q or "").split())
    return (q[:22] + "…") if len(q) > 22 else (q or tr("新对话"))


def threads(ws: Workspace) -> list[dict]:
    """最近用过的在前。"""
    return sorted(_normalize(ws.load("chat")).get("threads", []), key=lambda t: t.get("updated", ""), reverse=True)


def get(ws: Workspace, tid: str | None) -> dict | None:
    return next((t for t in threads(ws) if t["id"] == tid), None) if tid else None


def new_id() -> str:
    return "t" + uuid4().hex


def append(ws: Workspace, tid: str, user: dict, answer: str, model_id: str, model_name: str, used: dict | None = None,
           *, sources=None, missing=None) -> dict:
    """存一问一答；对话不存在就新建（标题取第一个问题）。回答页边笔记里的问题时，同时写成那条笔记的回复。"""
    stamp = now_iso()
    style = answer_styles.parse(user.get("answer_style"))
    msg = {"id": "m" + uuid4().hex, "role": "assistant", "content": answer, "at": stamp,
           "model": model_name, "anchor": user.get("anchor"), "note": user.get("note"), "answer_style": style}
    if sources is not None:
        msg.update(sources=sources, missing=missing or [])
    if used and used.get("calls"):
        msg["usage"] = used  # 这条回答的 token 用量（usage.Meter 的快照）

    def apply(chat):
        _normalize(chat)
        t = next((x for x in chat["threads"] if x["id"] == tid), None)
        if not t:
            t = {"id": tid, "title": _title(user["content"]), "created": stamp, "messages": []}
            chat["threads"].append(t)
        t["messages"] += [{**user, "role": "user", "at": stamp, "answer_style": style}, msg]
        t.update(updated=stamp, model=model_id, answer_style=style, chat_options=user.get("chat_options", {}))
    ws.update("chat", apply)
    note_id = user.get("note")
    if note_id and answer.strip():
        disc = ws.load("discussion").get("entries", [])
        old = next((d for d in disc if d.get("reply_to") == note_id and d.get("kind") == "reply" and d.get("live")), None)
        entry = {"reply_to": note_id, "kind": "reply", "body": answer.strip(), "by": model_name, "live": True}
        if old:
            entry["id"] = old["id"]
        add_discussion(ws, [entry])
    return msg


def rename(ws: Workspace, tid: str, title: str) -> None:
    def apply(chat):
        for t in _normalize(chat)["threads"]:
            if t["id"] == tid:
                t["title"] = (title or "").strip()[:60] or t["title"]
    ws.update("chat", apply)


def delete(ws: Workspace, tid: str) -> None:
    ws.update("chat", lambda chat: _normalize(chat).update(threads=[t for t in chat["threads"] if t["id"] != tid]))


def pin(ws: Workspace, tid: str, mid: str) -> None:
    """把一条回答放到页边，成为那段旁边的一条 AI 讨论。"""
    t = get(ws, tid)
    msgs = (t or {}).get("messages", [])
    i = next((k for k, m in enumerate(msgs) if m.get("id") == mid and m.get("role") == "assistant"), None)
    if i is None:
        raise KeyError(mid)
    ans, q = msgs[i], (msgs[i - 1] if i and msgs[i - 1].get("role") == "user" else {})
    blocks = {b.get("id") for b in ws.load("paper").get("blocks", [])}
    entry = {"kind": "qa", "q": q.get("content", ""), "body": ans["content"], "by": ans.get("model", "")}
    if ans.get("anchor") in blocks:
        entry["anchor"] = ans["anchor"]
    add_discussion(ws, [entry])
