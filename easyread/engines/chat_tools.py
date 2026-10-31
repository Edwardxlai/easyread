"""Per-call reading/research permissions; never persisted to model settings."""

READ_TOOLS = "Read,Glob,Grep,WebSearch,WebFetch"
DENIED_TOOLS = "Bash,Write,Edit,MultiEdit,NotebookEdit,Agent,Task"
RESEARCH_PROMPT = (
    "\n\nYou may read and search the paper files and use available web search/fetch tools "
    "when the question needs external sources. Cite source URLs for web claims and "
    "distinguish them from the paper. If a tool is unavailable, say so; never pretend "
    "to have searched. Do not modify files or run commands."
)


def for_chat(cfg: dict) -> dict:
    from .engines import for_translation
    out = for_translation(cfg)
    engine = cfg.get("engine")
    if engine and engine != "openai":
        out[engine] = {**out.get(engine, {}), "_chat": True}
    return out


def opencode_permissions(chat: bool) -> dict:
    permissions = {"*": "deny"}
    if chat:
        permissions.update({tool: "allow" for tool in ("read", "glob", "grep", "list", "websearch", "webfetch")})
    return permissions
