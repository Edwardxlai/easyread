"""OpenAI 兼容接口：两种格式都支持。

- chat：POST {base}/chat/completions，几乎所有服务商都支持（DeepSeek、智谱、Ollama……）。
- responses：POST {base}/responses，OpenAI 新接口；DeepSeek 等也已支持。中转站只开了这个时选它。

另外 models() 读 {base}/models，给设置页“获取模型列表”用。
"""
from __future__ import annotations

import base64
import json
import math
import random
import threading
import time
import urllib.error
import urllib.request
import uuid
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Iterator

from .. import __version__
from ..server import http
from . import usage
from .engines import Cancelled, EngineError
from ..app.i18n import tr

def api_kinds() -> list[tuple[str, str]]:
    return [("chat", tr("Chat Completions（通用）")), ("responses", tr("Responses（OpenAI 新接口）"))]


def _hint(code: int) -> str:
    return {401: tr("（Key 不对或过期了）"), 402: tr("（余额不足）"), 403: tr("（没有权限用这个模型）"),
            404: tr("（地址、模型名或接口格式不对）"), 429: tr("（被限流了，稍后重试或换个模型）")}.get(code, "")


_SESSION = f"easyread-{uuid.uuid4()}"  # 每次启动一个，整个进程内不变


def kind(o: dict) -> str:
    return "responses" if o.get("api") == "responses" else "chat"


def _base(o: dict) -> str:
    base = (o.get("base_url") or "").strip().rstrip("/")
    if not base or not o.get("model"):
        raise EngineError(tr("API 没填地址或模型（设置 → 模型）"))
    return base


def _headers(o: dict, stream: bool = False) -> dict:
    # 要带 User-Agent：Python 默认的 "Python-urllib/x" 会被 Cloudflare 后面的接口（比如 OpenCode）直接拦掉，报 403 error code: 1010
    # x-opencode-session：OpenCode Go 要求带一个稳定的会话 ID，不带报 400 MissingSessionID；别的服务商会忽略这个头
    h = {"Content-Type": "application/json", "User-Agent": f"EasyRead/{__version__}", "x-opencode-session": _SESSION}
    if stream:
        h["Accept"] = "text/event-stream"
    if o.get("api_key"):
        h["Authorization"] = "Bearer " + o["api_key"]
    return h


def _body(o: dict, prompt: str, images: list[Path], stream: bool, temperature: float | None) -> dict:
    urls = ["data:image/jpeg;base64," + base64.b64encode(p.read_bytes()).decode() for p in images] if o.get("vision") else []
    if kind(o) == "responses":
        content = [{"type": "input_text", "text": prompt}] + [{"type": "input_image", "image_url": u} for u in urls]
        body = {"model": o["model"], "input": [{"role": "user", "content": content}], "store": False}
    else:
        content = [{"type": "text", "text": prompt}] + [{"type": "image_url", "image_url": {"url": u}} for u in urls] if urls else prompt
        body = {"model": o["model"], "messages": [{"role": "user", "content": content}]}
    if o.get("reasoning_effort"):
        if kind(o) == "responses":
            body["reasoning"] = {"effort": o["reasoning_effort"]}
        else:
            body["reasoning_effort"] = o["reasoning_effort"]
    if o.get("service_tier"):
        body["service_tier"] = o["service_tier"]
    if temperature is not None and not o.get("reasoning_effort"):
        body["temperature"] = temperature
    if stream:
        body["stream"] = True
        if kind(o) == "chat":
            body["stream_options"] = {"include_usage": True}  # 最后一块带上 token 用量；不认这个参数的接口会去掉再发
    return body


def _open(o: dict, body: dict, stream: bool):
    """发请求。有的模型（推理模型、Kimi K2 系列）不让改 temperature、有的接口不认 stream_options，报 400 时去掉再发。"""
    path = "/responses" if kind(o) == "responses" else "/chat/completions"
    for _ in range(3):
        req = urllib.request.Request(_base(o) + path, data=json.dumps(body).encode(), headers=_headers(o, stream))
        try:
            return http.urlopen(req, timeout=int(o.get("timeout") or 600))
        except urllib.error.HTTPError as e:
            detail = e.read(300).decode("utf-8", "replace")
            e.close()
            drop = next((k for k in ("temperature", "stream_options") if k in detail and k in body), None)
            if e.code == 400 and drop:
                body = {k: v for k, v in body.items() if k != drop}
                continue
            e.detail = detail
            raise


def _http_error(e: urllib.error.HTTPError) -> EngineError:
    return EngineError(tr("接口返回 {code}{hint}：{detail}", code=e.code, hint=_hint(e.code), detail=getattr(e, "detail", "")))


# ---------- 一次拿到整段（翻译用） ----------
# 接口没给 Retry-After 时每次等多久。限流多半按分钟算（每分钟请求数 / token 数），分段并行时几段一起撞上，
# 所以至少要能跨过一个整分钟：合计约 3 分钟，每次再随机错开 ±20%，免得几段同时醒来又一起被限流
_BACKOFF = (10, 20, 40, 60, 60)


def complete(o: dict, prompt: str, images: list[Path], cancel=None, meter=None) -> str:
    # 也用流式请求，收齐了再整段交出去：一次性返回要等整批译完才有第一个字节，推理模型一批常要好几分钟，
    # 中转站前面的 Cloudflare 等不了这么久（约 100 秒没有回包就断开，报 524）；流式一直有数据在传，不会被断开
    body = _body(o, prompt, images, True, None if kind(o) == "responses" else 0.2)
    text, used = "", {}
    for attempt in range(len(_BACKOFF) + 1):  # 限流、服务端错误、网络抖动：等一会儿再试
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        try:
            text, used = _fetch(o, body, cancel)
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < len(_BACKOFF):
                _sleep(_retry_after(e.headers.get("Retry-After"), _BACKOFF[attempt] * random.uniform(.8, 1.2)), cancel)
                continue
            raise _http_error(e)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            if attempt < 2:
                _sleep(5, cancel)
                continue
            raise EngineError(tr("连不上接口：{err}", err=e))
    if meter is not None:
        meter.add(**used)
    return text


def _fetch(o: dict, body: dict, cancel) -> tuple[str, dict]:
    """发请求、读完整个回答，给（全文, 用量）。请求放在线程里，点取消就不再等它（这次调用的回答丢掉），
    不然要等接口开始返回，常常要一分钟。"""
    if cancel is None:
        return _read(o, body, threading.Event())
    box: dict = {}

    def run():
        try:
            box["res"] = _read(o, body, cancel)
        except BaseException as e:  # 原样交回主线程，限流重试、连不上这些分支照旧
            box["err"] = e
    t = threading.Thread(target=run, daemon=True)
    t.start()
    while t.is_alive():
        t.join(0.3)
        if cancel.is_set() and t.is_alive():
            raise Cancelled()
    if "err" in box:
        raise box["err"]
    return box["res"]


def _read(o: dict, body: dict, cancel) -> tuple[str, dict]:
    with _open(o, body, True) as r:
        if "json" in r.headers.get("Content-Type", ""):  # 接口不认 stream，照旧一次性返回了整段
            res = json.loads(r.read())
            return (_responses_text(res) if kind(o) == "responses" else _chat_text(res)), usage.from_openai(res)
        last = _LastUsage()
        pieces = _responses_pieces(r, cancel, last) if kind(o) == "responses" else _chat_pieces(r, cancel, last)
        return "".join(pieces), last.used


class _LastUsage:
    """流式回答的用量只留最后一份：有的接口每一块都带上累计用量，一块一记就把一次调用记成了好几次。"""

    def __init__(self):
        self.used: dict = {}

    def add(self, **used):
        self.used = used


def _chat_text(res) -> str:
    try:
        choice = res["choices"][0]
        text = choice["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise EngineError(tr("接口返回格式不对：{res}", res=str(res)[:300]))
    _check_finish(choice.get("finish_reason"))
    return text


def _responses_text(res) -> str:
    if not isinstance(res, dict):
        raise EngineError(tr("接口返回格式不对：{res}", res=str(res)[:300]))
    _check_response_status(res)
    if "output" not in res:
        raise EngineError(tr("接口返回格式不对：{res}", res=str(res)[:300]))
    return "".join(c.get("text") or "" for item in res["output"] if item.get("type") == "message"
                   for c in item.get("content") or [] if c.get("type") == "output_text")


def _truncated() -> EngineError:
    return EngineError(tr("模型输出被截断了（超过它的输出长度上限）。在设置里把“每次交给模型的页数”调成 1 页再试。"))


def _check_finish(reason) -> None:
    if reason == "length":
        raise _truncated()
    if reason == "content_filter":
        raise EngineError(tr("模型输出被服务商的内容过滤器中断了。"))


def _check_response_status(res: dict) -> None:
    if res.get("status") == "incomplete":
        reason = (res.get("incomplete_details") or {}).get("reason")
        if reason == "max_output_tokens":
            raise _truncated()
        raise EngineError(tr("模型未完成回答：{reason}", reason=reason or tr("接口没有提供原因")))
    if res.get("status") == "failed":
        raise EngineError(tr("接口返回出错：{err}", err=res.get("error")))


def _retry_after(value: str | None, default: float) -> float:
    """Retry-After 可以是秒数或 HTTP 日期；不合法时使用正常退避。"""
    if not value:
        return default
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (ValueError, TypeError, OverflowError):
            return default
    return max(0, seconds) if math.isfinite(seconds) else default


def _sleep(seconds: float, cancel) -> None:
    end = time.time() + min(seconds, 120)
    while time.time() < end:
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        time.sleep(0.5)


# ---------- 逐字输出（问 AI 用） ----------
def stream(o: dict, text: str, cancel, meter=None) -> Iterator[str]:
    if cancel.is_set():
        raise Cancelled()
    body = _body(o, text, [], True, None if kind(o) == "responses" else 0.4)
    try:
        r = _open(o, body, True)
    except urllib.error.HTTPError as e:
        raise _http_error(e)
    except Exception as e:  # noqa: BLE001
        raise EngineError(tr("连不上接口：{err}", err=e))
    with r:
        if cancel.is_set():
            raise Cancelled()
        pieces = _responses_pieces(r, cancel, meter) if kind(o) == "responses" else _chat_pieces(r, cancel, meter)
        yield from _strip_think(pieces)


_DONE, _EMPTY, _PARTIAL = object(), object(), object()


def _payload(data: list[str]):
    """一条事件的 data 行合起来：[DONE]、空事件、还没收完整的 JSON 分别给标记，否则给解析结果。"""
    payload = "\n".join(data).strip()
    if payload == "[DONE]":
        return _DONE
    if not payload:
        return _EMPTY
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return _PARTIAL


def _events(r, cancel) -> Iterator[dict | None]:
    """按空行分隔 SSE 事件，同一事件的多个 data 行要合起来解析；[DONE] 给 None。
    有的中转接口事件之间只隔一个换行，或者最后一条后面没有空行就断开：
    已攒下的 data 本身就是完整 JSON 时，碰到下一行 data 或连接结束也照样交出去。"""
    data = []
    for raw in r:
        if cancel.is_set():
            raise Cancelled()
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        is_data = line.startswith("data:") or line == "data"
        if data and (not line or is_data):
            ev = _payload(data)
            if not (ev is _PARTIAL and is_data):  # 还不完整又来了 data 行：一条事件拆成了多行，接着攒
                data.clear()
                if ev is _DONE:
                    yield None
                    return
                if ev is not _EMPTY:
                    yield _check_event(ev)
        if is_data:
            data.append(line.partition(":")[2].removeprefix(" "))
    if data:
        ev = _payload(data)
        if ev is _DONE:
            yield None
        elif ev is not _EMPTY:
            yield _check_event(ev)


def _check_event(ev) -> dict:
    if ev is _PARTIAL:
        raise EngineError(tr("接口返回的流数据不是有效 JSON"))
    if not isinstance(ev, dict):
        raise EngineError(tr("接口返回的流数据格式不对"))
    return ev


def _chat_pieces(r, cancel, meter=None) -> Iterator[str]:
    finished = False
    for ev in _events(r, cancel):
        if ev is None:
            return
        if ev.get("error"):
            raise EngineError(tr("接口返回出错：{err}", err=ev["error"]))
        if ev.get("usage") and meter is not None:
            meter.add(**usage.from_openai(ev))
        choice = (ev.get("choices") or [{}])[0]
        _check_finish(choice.get("finish_reason"))
        finished = finished or bool(choice.get("finish_reason"))
        yield (choice.get("delta") or {}).get("content") or ""
    if not finished:
        raise EngineError(tr("接口连接提前结束，回答未完成，请重试。"))


def _responses_pieces(r, cancel, meter=None) -> Iterator[str]:
    for ev in _events(r, cancel):
        t = (ev or {}).get("type", "")
        if ev is None:
            return
        if t in ("response.completed", "response.incomplete", "response.failed"):
            res = ev.get("response") or {}
            _check_response_status({**res, "status": res.get("status") or t.split(".")[1]})
            if meter is not None:
                meter.add(**usage.from_openai(res))
            return
        if t == "response.output_text.delta":
            yield ev.get("delta") or ""
        elif t == "error":
            err = (ev.get("response") or {}).get("error") or ev.get("error") or ev.get("message")
            raise EngineError(tr("接口返回出错：{err}", err=err))
    raise EngineError(tr("接口连接提前结束，回答未完成，请重试。"))


def _strip_think(pieces: Iterator[str]) -> Iterator[str]:
    """推理模型把思考过程包在 <think> 里，读者不需要看。"""
    thinking = False
    pending = ""
    for piece in pieces:
        pending += piece
        while pending:
            tag = "</think>" if thinking else "<think>"
            index = pending.find(tag)
            if index >= 0:
                if not thinking and index:
                    yield pending[:index]
                pending = pending[index + len(tag):]
                thinking = not thinking
                continue
            # 留下可能是下一个标签开头的后缀，下一片到来后再判断。
            keep = next((n for n in range(len(tag) - 1, 0, -1) if pending.endswith(tag[:n])), 0)
            visible = pending[:-keep] if keep else pending
            if not thinking and visible:
                yield visible
            pending = pending[-keep:] if keep else ""
            break
    if pending and not thinking:
        yield pending


# ---------- 模型列表 ----------
def models(o: dict) -> list[str]:
    """GET {base}/models，返回模型名（排好序）。"""
    base = (o.get("base_url") or "").strip().rstrip("/")
    if not base:
        raise EngineError(tr("先填接口地址"))
    req = urllib.request.Request(base + "/models", headers=_headers(o))
    try:
        with http.urlopen(req, timeout=20) as r:
            res = json.loads(r.read())
    except urllib.error.HTTPError as e:
        e.detail = e.read(300).decode("utf-8", "replace")
        e.close()
        raise _http_error(e)
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        raise EngineError(tr("连不上接口：{err}", err=e))
    except json.JSONDecodeError:
        raise EngineError(tr("这个地址不提供模型列表，手填模型名"))
    items = res.get("data") if isinstance(res, dict) else res
    if not isinstance(items, list):  # Gemini 的旧格式是 {"models": [...]}
        items = (res or {}).get("models") or []
    ids = [str(m.get("id") or m.get("name") or "").removeprefix("models/") if isinstance(m, dict) else str(m) for m in items]
    return sorted({i for i in ids if i})
