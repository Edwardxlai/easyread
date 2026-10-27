"""Image-only jobs share the paper queue, cancellation and persisted progress."""
from __future__ import annotations

from ..app.i18n import tr
from ..engines import usage
from ..engines.engines import Cancelled
from ..translate import figure_images


def select(ws, body: dict) -> list[str]:
    figures = {b["id"]: b for b in ws.load("paper").get("blocks", []) if b.get("type") == "figure" and b.get("src")}
    ids = body.get("ids", list(figures))
    if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or i not in figures for i in ids):
        raise ValueError(tr("没有可生成译图的图片，请先整理原文或截取图片"))
    if "force" in body and type(body["force"]) is not bool:
        raise ValueError("force must be a boolean")
    return list(dict.fromkeys(ids))


def run(jobs, ws, job, cfg, cancel):
    options = cfg.get("figure_images") or {}
    if not options.get("enabled"):
        raise ValueError(tr("请先在设置中开启生成译图"))
    if options.get("provider", "codex") not in ("codex", "api"):
        raise ValueError(tr("不支持此译图方式，保留原图和文字译文"))
    if options.get("provider") == "api" and (not options.get("base_url") or not options.get("model")):
        raise ValueError(tr("未配置译图接口，保留原图和文字译文"))
    cfg = {**cfg, "figure_images": options, "translate_figure_text": True}
    ids = set(job["figure_ids"])
    blocks = [b for b in ws.load("paper").get("blocks", []) if b.get("id") in ids and b.get("type") == "figure" and b.get("src")]
    missing = ids - {b["id"] for b in blocks}
    meter = usage.Meter("codex" if options.get("provider", "codex") == "codex" else "openai")
    state = {"done": 0, "total": len(blocks), "message": tr("正在生成译图")}

    def report():
        if cancel.is_set():
            raise Cancelled()
        jobs._write(ws, state="running", **state, usage=meter.snapshot())

    def say(message):
        state["message"] = message
        report()

    def progress(done, total):
        state.update(done=done, total=total)
        report()

    try:
        result = figure_images.generate(ws, cfg, {b.get("page") for b in blocks}, cancel, say, meter,
                                        block_ids=ids, force=job.get("force", False), allow_no_text=True, progress=progress)
    finally:
        run_usage = meter.snapshot()
        if run_usage["calls"]:
            ws.update("job", lambda j: j.update(usage=run_usage, usage_total=usage.merge(j.get("usage_total"), run_usage)))
    if cancel.is_set():
        raise Cancelled()
    result["failed"].update({i: tr("图片已移除或缺少原图") for i in missing})
    errors = result["failed"]
    jobs._write(ws, state="partial" if errors else "done", done=len(ids), total=len(ids),
                image_failed=errors, failed={}, error=next(iter(errors.values()), ""),
                message=tr("译图完成：生成 {n} 张，沿用 {skip} 张，失败 {failed} 张", n=result["generated"],
                           skip=result["skipped"], failed=len(errors)))
