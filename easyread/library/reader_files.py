"""阅读页文件准备：定位与小图预热，参与文献库迁移的在途操作计数。"""
from __future__ import annotations

import sys
import threading
from pathlib import Path

from ..pdf import figures, pdfwork, links
from ..app import foreground
from ..app.log import log

_warming: set[str] = set()
_preparing: set[str] = set()
_PREPARE_GUARD = threading.Lock()
_PREPARE_SERIAL = threading.Lock()


def busy() -> bool:
    """Keep the browser-launched service alive while reader files are prepared."""
    with _PREPARE_GUARD:
        return bool(_preparing or _warming)


def prepare_later(ws, gate=None) -> None:
    """Return saved content first; upgrade layout and crops in one background job.

    Deduplicate simultaneous opens and serialize PDF preparation across papers so
    a library full of old documents cannot allocate several PDF layouts at once.
    The migration gate remains held from registration through the final crop.
    """
    if (ws.load("paper") or {}).get("meta", {}).get("source_type") == "web":
        return
    key = str(ws.root.resolve())
    with _PREPARE_GUARD:
        if key in _preparing or (ws.load("job") or {}).get("state") in ("queued", "running"):
            return
        if gate:
            gate.begin()
        _preparing.add(key)

    def run():
        try:
            with _PREPARE_SERIAL:
                # Translation may have started while this paper was waiting.
                if (ws.load("job") or {}).get("state") in ("queued", "running"):
                    return
                meta = (ws.load("paper") or {}).get("meta", {})
                if meta.get("source_pdf_path") and not meta.get("pages"):
                    # Prepare catalog-only entries on first open.
                    from ..translate.translate import prepare
                    prepare(ws)
                refresh_layout(ws)
                links.refresh(ws)
                if (ws.load("job") or {}).get("state") in ("queued", "running"):
                    return
                figures.fill(ws)
                warm(ws.root, gate)
        except Exception:  # noqa: BLE001
            log.exception("准备阅读页文件失败 %s", ws.root)
        finally:
            with _PREPARE_GUARD:
                _preparing.discard(key)
            if gate:
                gate.end()

    try:
        threading.Thread(target=run, name="reader-prepare", daemon=True).start()
    except Exception:
        with _PREPARE_GUARD:
            _preparing.discard(key)
        if gate:
            gate.end()
        raise


def refresh_layout(ws) -> None:
    if (ws.load("job") or {}).get("state") in ("queued", "running"):
        return
    try:
        pdfwork.refresh_layout(ws.root)
    except Exception:  # noqa: BLE001
        log.exception("重算原页定位失败 %s", ws.root)


def warm(root: Path, gate=None) -> None:
    with _PREPARE_GUARD:
        if str(root) in _warming or (root / "pages" / f"w{pdfwork.PANEL_WIDTH}").exists() and \
                len(list((root / "pages" / f"w{pdfwork.PANEL_WIDTH}").glob("*.webp"))) >= len(list((root / "pages").glob("page-*.webp"))):
            return
        if gate:
            gate.begin()  # 在线程启动前登记，避免请求结束到后台启动之间的迁移空档。
        _warming.add(str(root))

    def run():
        try:
            pdfwork.warm_variants(root)
        except Exception:  # noqa: BLE001
            log.exception("生成面板图失败 %s", root)
        finally:
            with _PREPARE_GUARD:
                _warming.discard(str(root))
            if gate:
                gate.end()
    try:
        threading.Thread(target=run, daemon=True).start()
    except Exception:
        with _PREPARE_GUARD:
            _warming.discard(str(root))
        if gate:
            gate.end()
        raise


def reveal(path: Path):
    import subprocess
    if sys.platform.startswith("win"):
        foreground.open_folder(str(path))
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])
