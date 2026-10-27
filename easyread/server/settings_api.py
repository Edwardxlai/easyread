"""设置页的保存类接口（POST）。server.py 按路径转过来，每个函数收请求体、返回要回给页面的 JSON。"""
from __future__ import annotations

from urllib.parse import urlsplit

from ..chat import chat_models
from ..app import config
from ..app.api_keys import resolve, saved_keys
from ..engines import engines, openai_api
from ..translate import langs, instructions, prompt_style
from ..app.i18n import tr


def save_config(patch: dict) -> dict:
    patch.pop("translation_prompt_default", None)
    patch.pop("translation_prompt_effective", None)
    patch.pop("translation_extra", None)  # Task-only instructions must never become global.
    if "translation_prompt" in patch:
        patch["translation_prompt"] = prompt_style.validate(patch["translation_prompt"])
    if "translate_figure_text" in patch and type(patch["translate_figure_text"]) is not bool:
        raise ValueError("translate_figure_text must be a boolean")
    if "translation_instructions" in patch:
        patch["translation_instructions"] = instructions.validate(patch["translation_instructions"])
    patch.pop("library_dir", None)
    if "page_cap" in patch and (type(patch["page_cap"]) is not int or patch["page_cap"] < 0):
        raise ValueError(tr("页数确认上限必须是非负整数"))
    if "paper_concurrency" in patch and (type(patch["paper_concurrency"]) is not int
                                         or not 1 <= patch["paper_concurrency"] <= 4):
        raise ValueError(tr("同时翻译的论文数必须是 1 到 4 的整数"))
    if "target" in patch:
        patch["target"] = langs.valid(patch["target"])
    if isinstance(patch.get("openai"), dict):
        patch["openai"] = config.with_key(patch["openai"])
    if "figure_images" in patch:
        options = patch["figure_images"]
        if not isinstance(options, dict):
            raise ValueError("figure_images must be an object")
        if "enabled" in options and type(options["enabled"]) is not bool:
            raise ValueError("figure_images.enabled must be a boolean")
        if "provider" in options and options["provider"] not in ("codex", "api"):
            raise ValueError("figure_images.provider must be codex or api")
        for key in ("base_url", "api_key", "model"):
            if key in options:
                if not isinstance(options[key], str):
                    raise ValueError(f"figure_images.{key} must be a string")
                options[key] = options[key].strip()
        if options.get("base_url"):
            url = urlsplit(options["base_url"])
            if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password:
                raise ValueError(tr("译图接口地址必须是 HTTP 或 HTTPS 地址"))
        if "timeout" in options and (type(options["timeout"]) is not int or options["timeout"] <= 0):
            raise ValueError("figure_images.timeout must be a positive integer")
        patch["figure_images"] = config.with_key(options, "figure_images")
    return {"config": config.public(config.save(patch))}


def save_chat_models(body: dict) -> dict:
    """保存“问 AI”的名单和默认模型；或面板里只改默认。"""
    patch = {}
    if "models" in body:
        patch["models"] = chat_models.sanitize(body["models"])
    if body.get("default"):
        patch["default"] = str(body["default"])
    full = {"chat": patch}
    if isinstance(body.get("keys"), dict):  # 设置里给某家 API 填的 Key，和翻译那边共用
        keys = saved_keys(config.load()["openai"])
        keys.update({str(k): str(v).strip() for k, v in body["keys"].items() if v and not str(v).startswith("••••")})
        full["openai"] = {"keys": keys}
    config.save(full)
    return chat_models.listing(config.load())


def test_engine(body: dict) -> dict:
    cfg = config.load()
    if body.get("engine"):
        cfg["engine"] = body["engine"]
    return engines.test(cfg)


def list_models(body: dict) -> dict:
    """设置页“获取模型列表”：{base_url, preset, api_key}；Key 留空或打码时用这家已存的。"""
    key = str(body.get("api_key") or "").strip()
    if not key or key.startswith("••••"):
        key = resolve(config.load()["openai"], str(body.get("preset") or ""), str(body.get("base_url") or ""))
    try:
        return {"ok": True, "models": openai_api.models({"base_url": body.get("base_url"), "api_key": key})}
    except engines.EngineError as e:
        return {"ok": False, "message": str(e)[:300]}


POST = {"/api/config": save_config, "/api/chat/models": save_chat_models,
        "/api/config/test": test_engine, "/api/models/list": list_models}
