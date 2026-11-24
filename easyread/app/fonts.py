"""枚举本机已安装字体族名，供设置页“自定义字体”挑选与校验。"""
from __future__ import annotations

import ctypes
import ctypes.util
import shutil
import subprocess
import sys
import threading
from pathlib import Path

_cache: list[str] | None = None
_lock = threading.Lock()
_FONT_SUFFIXES = {".ttf", ".otf", ".ttc", ".otc"}


def _clean(names) -> list[str]:
    seen: dict[str, str] = {}
    for raw in names:
        name = str(raw or "").strip()
        if not name or name.startswith((".", "@")):
            continue
        key = name.casefold()
        if key not in seen:
            seen[key] = name
    return sorted(seen.values(), key=str.casefold)


def _fc_list() -> list[str]:
    exe = shutil.which("fc-list")
    if not exe:
        return []
    try:
        proc = subprocess.run(
            [exe, "--format=%{family}\n"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    out: list[str] = []
    for line in proc.stdout.splitlines():
        for part in line.split(","):
            name = part.strip()
            if name:
                out.append(name)
    return out


def _darwin_fonts() -> list[str]:
    ct_path = ctypes.util.find_library("CoreText")
    cf_path = ctypes.util.find_library("CoreFoundation")
    if not ct_path or not cf_path:
        return _fc_list()
    try:
        ct = ctypes.CDLL(ct_path)
        cf = ctypes.CDLL(cf_path)
    except OSError:
        return _fc_list()

    utf8 = 0x08000100
    ct.CTFontManagerCopyAvailableFontFamilyNames.restype = ctypes.c_void_p
    ct.CTFontManagerCreateFontDescriptorsFromURL.argtypes = [ctypes.c_void_p]
    ct.CTFontManagerCreateFontDescriptorsFromURL.restype = ctypes.c_void_p
    ct.CTFontDescriptorCopyAttribute.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    ct.CTFontDescriptorCopyAttribute.restype = ctypes.c_void_p

    cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
    cf.CFArrayGetCount.restype = ctypes.c_long
    cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
    cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
    cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
    cf.CFStringGetCString.restype = ctypes.c_bool
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFURLCreateFromFileSystemRepresentation.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_bool]
    cf.CFURLCreateFromFileSystemRepresentation.restype = ctypes.c_void_p
    cf.CFRelease.argtypes = [ctypes.c_void_p]

    buf = ctypes.create_string_buffer(1024)
    names: list[str] = []

    def read_cf_string(ref) -> str:
        if ref and cf.CFStringGetCString(ref, buf, len(buf), utf8):
            return buf.value.decode("utf-8", "replace")
        return ""

    arr = ct.CTFontManagerCopyAvailableFontFamilyNames()
    if arr:
        try:
            for i in range(cf.CFArrayGetCount(arr)):
                name = read_cf_string(cf.CFArrayGetValueAtIndex(arr, i))
                if name:
                    names.append(name)
        finally:
            cf.CFRelease(arr)

    # 补充扫描用户和本机字体目录，避免沙盒或字体服务未刷新时漏掉新装字体
    attr = cf.CFStringCreateWithCString(None, b"NSFontFamilyAttribute", utf8)
    if attr:
        try:
            for folder in (Path.home() / "Library" / "Fonts", Path("/Library/Fonts")):
                if not folder.is_dir():
                    continue
                for font_file in folder.rglob("*"):
                    if font_file.suffix.lower() not in _FONT_SUFFIXES or not font_file.is_file():
                        continue
                    raw_path = str(font_file).encode("utf-8")
                    url = cf.CFURLCreateFromFileSystemRepresentation(None, raw_path, len(raw_path), False)
                    if not url:
                        continue
                    try:
                        descs = ct.CTFontManagerCreateFontDescriptorsFromURL(url)
                        if not descs:
                            continue
                        try:
                            for i in range(cf.CFArrayGetCount(descs)):
                                desc = cf.CFArrayGetValueAtIndex(descs, i)
                                val = ct.CTFontDescriptorCopyAttribute(desc, attr)
                                if val:
                                    try:
                                        name = read_cf_string(val)
                                        if name:
                                            names.append(name)
                                    finally:
                                        cf.CFRelease(val)
                        finally:
                            cf.CFRelease(descs)
                    finally:
                        cf.CFRelease(url)
        except OSError:
            pass
        finally:
            cf.CFRelease(attr)

    return names or _fc_list()


def _win32_fonts() -> list[str]:
    names: list[str] = []
    try:
        class LOGFONTW(ctypes.Structure):
            _fields_ = [
                ("lfHeight", ctypes.c_long),
                ("lfWidth", ctypes.c_long),
                ("lfEscapement", ctypes.c_long),
                ("lfOrientation", ctypes.c_long),
                ("lfWeight", ctypes.c_long),
                ("lfItalic", ctypes.c_ubyte),
                ("lfUnderline", ctypes.c_ubyte),
                ("lfStrikeOut", ctypes.c_ubyte),
                ("lfCharSet", ctypes.c_ubyte),
                ("lfOutPrecision", ctypes.c_ubyte),
                ("lfClipPrecision", ctypes.c_ubyte),
                ("lfQuality", ctypes.c_ubyte),
                ("lfPitchAndFamily", ctypes.c_ubyte),
                ("lfFaceName", ctypes.c_wchar * 32),
            ]

        gdi32 = ctypes.windll.gdi32
        user32 = ctypes.windll.user32
        proc_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.POINTER(LOGFONTW), ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p)
        user32.GetDC.argtypes = [ctypes.c_void_p]
        user32.GetDC.restype = ctypes.c_void_p
        user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        user32.ReleaseDC.restype = ctypes.c_int
        gdi32.EnumFontFamiliesExW.argtypes = [ctypes.c_void_p, ctypes.POINTER(LOGFONTW), proc_type, ctypes.c_void_p, ctypes.c_ulong]
        gdi32.EnumFontFamiliesExW.restype = ctypes.c_int

        def callback(lf, _tm, _ftype, _lparam):
            face = lf.contents.lfFaceName.strip()
            if face:
                names.append(face)
            return 1

        cb = proc_type(callback)
        hdc = user32.GetDC(None)
        if hdc:
            try:
                lf = LOGFONTW()
                lf.lfCharSet = 1  # DEFAULT_CHARSET
                gdi32.EnumFontFamiliesExW(hdc, ctypes.byref(lf), cb, None, 0)
            finally:
                user32.ReleaseDC(None, hdc)
    except Exception:  # noqa: BLE001
        pass

    if names:
        return names

    try:
        import winreg
        subkey = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, subkey) as key:
                    i = 0
                    while True:
                        try:
                            title, _, _ = winreg.EnumValue(key, i)
                            i += 1
                            name = title.split("(", 1)[0].strip()
                            if name:
                                names.append(name)
                        except OSError:
                            break
            except OSError:
                continue
    except ImportError:
        pass
    return names


def _discover() -> list[str]:
    if sys.platform == "darwin":
        raw = _darwin_fonts()
    elif sys.platform == "win32":
        raw = _win32_fonts()
    else:
        raw = _fc_list()
    return _clean(raw)


def list_families(fresh: bool = False) -> list[str]:
    """返回本机已安装的字体族名列表（已去重、排序、过滤系统内部隐藏字体）。"""
    global _cache
    with _lock:
        if _cache is not None and not fresh:
            return list(_cache)
    found = _discover()
    with _lock:
        _cache = found
        return list(_cache)
