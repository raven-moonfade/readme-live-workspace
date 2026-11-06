# -*- coding: utf-8 -*-
"""本机字体族枚举与字体名校验（Windows GDI，无 Qt 依赖）。"""

from __future__ import annotations

import ctypes
import functools
import os
import unicodedata
from typing import Set

_MAX_FAMILY_CHARS = 120
_FALLBACK_FAMILIES = {
    "Microsoft YaHei UI",
    "Microsoft YaHei",
    "SimHei",
    "SimSun",
    "Segoe UI",
    "Arial",
    "Consolas",
}


def _clean_family(value: str) -> str:
    text = unicodedata.normalize("NFC", str(value or "")).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1].strip()
    return text


def family_error(value: object) -> str | None:
    """结构校验；返回错误码，None 表示合法。"""
    if not isinstance(value, str):
        return "font_family_type"
    text = _clean_family(value)
    if not text:
        return "font_family_empty"
    if len(text) > _MAX_FAMILY_CHARS:
        return "font_family_too_long"
    if any(ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F for ch in text):
        return "font_family_control"
    if "\n" in text or "\r" in text or "\u2028" in text or "\u2029" in text:
        return "font_family_control"
    if "," in text or ";" in text:
        return "font_family_stack"
    return None


def normalize_family(value: object, fallback: str = "Microsoft YaHei UI") -> str:
    if family_error(value) is not None:
        return fallback
    return _clean_family(str(value))


def _fallback_families() -> Set[str]:
    return set(_FALLBACK_FAMILIES)


@functools.lru_cache(maxsize=1)
def installed_families() -> Set[str]:
    """返回本机字体族集合；非 Windows 或枚举失败时返回空集合。"""
    if os.name != "nt":
        return set()
    try:
        return _enum_windows_families()
    except Exception:
        return set()


def clear_font_cache() -> None:
    installed_families.cache_clear()


def is_installed(value: object) -> bool:
    error = family_error(value)
    if error is not None:
        return False
    families = installed_families()
    if not families:
        # 无法枚举时不做硬拒绝，交给 Qt fallback。
        return True
    wanted = _clean_family(str(value)).casefold()
    return any(name.casefold() == wanted for name in families)


def suggest_families(limit: int = 40) -> list[str]:
    families = installed_families()
    preferred = [
        "Microsoft YaHei UI",
        "Microsoft YaHei",
        "SimHei",
        "SimSun",
        "Segoe UI",
        "Arial",
        "Consolas",
    ]
    if not families:
        return preferred[:limit]
    by_fold = {name.casefold(): name for name in families}
    result = []
    for name in preferred:
        actual = by_fold.get(name.casefold())
        if actual and actual not in result:
            result.append(actual)
    for name in sorted(families, key=str.casefold):
        if name.startswith("@"):
            continue
        if name not in result:
            result.append(name)
        if len(result) >= limit:
            break
    return result


def _enum_windows_families() -> Set[str]:
    from ctypes import wintypes

    class LOGFONTW(ctypes.Structure):
        _fields_ = [
            ("lfHeight", wintypes.LONG),
            ("lfWidth", wintypes.LONG),
            ("lfEscapement", wintypes.LONG),
            ("lfOrientation", wintypes.LONG),
            ("lfWeight", wintypes.LONG),
            ("lfItalic", wintypes.BYTE),
            ("lfUnderline", wintypes.BYTE),
            ("lfStrikeOut", wintypes.BYTE),
            ("lfCharSet", wintypes.BYTE),
            ("lfOutPrecision", wintypes.BYTE),
            ("lfClipPrecision", wintypes.BYTE),
            ("lfQuality", wintypes.BYTE),
            ("lfPitchAndFamily", wintypes.BYTE),
            ("lfFaceName", wintypes.WCHAR * 32),
        ]

    class ENUMLOGFONTEXW(ctypes.Structure):
        _fields_ = [
            ("elfLogFont", LOGFONTW),
            ("elfFullName", wintypes.WCHAR * 64),
            ("elfStyle", wintypes.WCHAR * 32),
            ("elfScript", wintypes.WCHAR * 32),
        ]

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    hdc = user32.GetDC(None)
    if not hdc:
        return set()
    result: Set[str] = set()
    try:
        logfont = LOGFONTW()
        logfont.lfCharSet = 1  # DEFAULT_CHARSET
        logfont.lfFaceName = ""

        @ctypes.WINFUNCTYPE(
            ctypes.c_int,
            ctypes.POINTER(ENUMLOGFONTEXW),
            ctypes.c_void_p,
            wintypes.DWORD,
            wintypes.LPARAM,
        )
        def callback(elf, _metric, _font_type, _lparam):
            name = str(elf.contents.elfLogFont.lfFaceName or "").strip()
            if name and not name.startswith("@"):
                result.add(name)
            return 1

        gdi32.EnumFontFamiliesExW(
            hdc,
            ctypes.byref(logfont),
            callback,
            0,
            0,
        )
    finally:
        user32.ReleaseDC(None, hdc)
    return result

