"""翻译花了多少：token 数，Claude Code 订阅还能看到 5 小时 / 7 天额度用了百分之几。

每次调用模型后，各引擎把返回里的用量交给 Meter；整篇翻译时 Meter 的累计写进 job.json 给页面显示。
input 是全部输入 token（含命中缓存的部分），cached 是其中命中缓存的，output 是输出。
"""
from __future__ import annotations

import threading
import time
from .timing import Timeline

from ..library.store import read_json, write_json_atomic


class Meter:
    """一次翻译任务的累计用量。并发翻译时多个线程一起往里加。"""

    def __init__(self, engine: str = "", *, timed=False):
        self._lock = threading.Lock()
        self.timing = Timeline() if timed else None
        self.data: dict = {"engine": engine, "calls": 0, "input": 0, "cached": 0, "output": 0}

    def add(self, input: int = 0, cached: int = 0, output: int = 0, cost_usd: float | None = None, limits: dict | None = None,
            context_window: int | None = None):
        with self._lock:
            d = self.data
            d["calls"] += 1
            # 最近一次调用的上下文有多大（输入 + 输出）：问 AI 时每次都把之前的对话一起发，这就是当前对话占了多少上下文
            d["context"] = {"cached": int(cached or 0), "fresh": int(input or 0) - int(cached or 0), "output": int(output or 0)}
            if context_window:
                d["context_window"] = int(context_window)
            d["input"] += int(input or 0)
            d["cached"] += int(cached or 0)
            d["output"] += int(output or 0)
            if cost_usd is not None:
                d["cost_usd"] = round(d.get("cost_usd", 0) + float(cost_usd), 4)
            if limits:
                d["limits"] = limits  # 整个账号的额度（同时在用 Claude Code 干别的也算在里面），只记最新的
        if limits:
            remember(limits)

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self.data)


# ---------- 最近一次看到的订阅额度（全局，新对话也能显示） ----------
def _limits_path():
    from ..app import config
    return config.library_dir() / ".limits.json" if config.temp_library() else config.HOME / "limits.json"


def remember(limits: dict) -> None:
    try:
        write_json_atomic(_limits_path(), {"limits": limits, "at": int(time.time())})
    except OSError:
        pass


def latest() -> dict | None:
    """{"limits": {...}, "at": 时间戳}；还没用 Claude Code 订阅调用过就是 None。"""
    return read_json(_limits_path(), None)


def merge(total: dict | None, run: dict) -> dict:
    """把这次的用量加进这篇论文的累计（job.json 的 usage_total）。"""
    out = dict(total or {})
    for k in ("calls", "input", "cached", "output"):
        out[k] = int(out.get(k, 0)) + int(run.get(k, 0))
    if "cost_usd" in run:
        out["cost_usd"] = round(out.get("cost_usd", 0) + run["cost_usd"], 4)
    for k in ("engine", "limits"):
        if run.get(k):
            out[k] = run[k]
    return out


# ---------- 各引擎返回的用量 ----------
def from_claude(result: dict, rate_event: dict | None) -> dict:
    """claude -p --output-format stream-json 的 result 行，和其中的 rate_limit_event。"""
    u = result.get("usage") or {}
    cached = int(u.get("cache_read_input_tokens") or 0)
    rec = {"input": int(u.get("input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0) + cached,
           "cached": cached, "output": int(u.get("output_tokens") or 0)}
    windows = ((rate_event or {}).get("rate_limit_info") or {}).get("unifiedWindows") or {}
    if windows:  # 有额度信息就是订阅；订阅时 total_cost_usd 只是按官方价折算，不是真花的钱，不记
        rec["limits"] = {k: {"used": w.get("utilization"), "resets_at": w.get("resetsAt")}
                         for k, w in windows.items() if isinstance(w, dict)}
    elif result.get("total_cost_usd") is not None:
        rec["cost_usd"] = float(result["total_cost_usd"])
    window = next((m.get("contextWindow") for m in (result.get("modelUsage") or {}).values() if m.get("contextWindow")), None)
    if window:
        rec["context_window"] = window
    return rec


def from_codex(event: dict) -> dict:
    """codex exec --json 的 turn.completed 事件。"""
    u = event.get("usage") or {}
    return {"input": int(u.get("input_tokens") or 0), "cached": int(u.get("cached_input_tokens") or 0),
            "output": int(u.get("output_tokens") or 0)}


def from_openai(res: dict) -> dict:
    """Chat Completions 或 Responses 返回的 usage（DeepSeek 的缓存命中数字段名不一样）。"""
    u = (res or {}).get("usage") or {}
    if "prompt_tokens" in u:  # Chat Completions
        details = u.get("prompt_tokens_details") or {}
        cached = details.get("cached_tokens") or u.get("prompt_cache_hit_tokens") or 0
        return {"input": int(u.get("prompt_tokens") or 0), "cached": int(cached), "output": int(u.get("completion_tokens") or 0)}
    details = u.get("input_tokens_details") or {}
    return {"input": int(u.get("input_tokens") or 0), "cached": int(details.get("cached_tokens") or 0),
            "output": int(u.get("output_tokens") or 0)}
