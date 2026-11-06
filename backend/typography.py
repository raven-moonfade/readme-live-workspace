# -*- coding: utf-8 -*-
"""直播浮窗分类字体与排版解析。

排版字段独立保存于 ``config.legacy.json`` 的 ``overlay.typography``，不进入
canonical ``styles``；解析顺序为内置主题 -> global -> types[kind]。
"""

from __future__ import annotations

import copy
import unicodedata
from typing import Any, Dict, Mapping

from .fonts import family_error, normalize_family
from .styles import THEME_PRESETS

OVERLAY_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter", "like", "social")
TYPOGRAPHY_SCHEMA_VERSION = 1
TYPOGRAPHY_FIELDS = ("font_family", "line_height", "letter_spacing")

_DEFAULT_FONT = "Microsoft YaHei UI"
_DEFAULT_LINE_HEIGHT = 1.55


def empty_typography_types() -> Dict[str, Dict[str, Any]]:
    return {kind: {field: None for field in TYPOGRAPHY_FIELDS} for kind in OVERLAY_TYPES}


def default_typography() -> Dict[str, Any]:
    return {
        "schema_version": TYPOGRAPHY_SCHEMA_VERSION,
        "global": {field: None for field in TYPOGRAPHY_FIELDS},
        "types": empty_typography_types(),
    }


def theme_typography(theme: str) -> Dict[str, Any]:
    preset = THEME_PRESETS.get(theme, THEME_PRESETS["classic"])
    return {
        "font_family": normalize_family(preset.get("font_family"), _DEFAULT_FONT),
        "line_height": _normalize_line_height(preset.get("line_height")) or _DEFAULT_LINE_HEIGHT,
        "letter_spacing": 0.0,
    }


def _canonical_kind(kind: str) -> str:
    if kind == "sc":
        return "super_chat"
    if kind in OVERLAY_TYPES:
        return kind
    raise ValueError("unknown overlay type: %s" % kind)


def _normalize_line_height(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not (1.0 <= number <= 2.5):
        return None
    return round(number, 2)


def _normalize_letter_spacing(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not (0.0 <= number <= 8.0):
        return None
    return round(number * 4.0) / 4.0


def _normalize_field(name: str, value: Any) -> Any:
    if value is None:
        return None
    if name == "font_family":
        if family_error(value) is not None:
            return None
        return normalize_family(value, _DEFAULT_FONT)
    if name == "line_height":
        return _normalize_line_height(value)
    if name == "letter_spacing":
        return _normalize_letter_spacing(value)
    return None


def _apply_layer(target: Dict[str, Any], source: Any) -> None:
    if not isinstance(source, Mapping):
        return
    for name in TYPOGRAPHY_FIELDS:
        if name not in source:
            continue
        cleaned = _normalize_field(name, source.get(name))
        if cleaned is not None:
            target[name] = cleaned


def normalize_typography(source: Any) -> Dict[str, Any]:
    result = default_typography()
    value = source if isinstance(source, Mapping) else {}
    global_src = value.get("global")
    if isinstance(global_src, Mapping):
        _apply_layer(result["global"], global_src)
    types_src = value.get("types")
    if isinstance(types_src, Mapping):
        for kind in OVERLAY_TYPES:
            override = types_src.get(kind)
            if not isinstance(override, Mapping):
                continue
            for name in TYPOGRAPHY_FIELDS:
                if name not in override:
                    continue
                if override.get(name) is None:
                    result["types"][kind][name] = None
                    continue
                cleaned = _normalize_field(name, override.get(name))
                if cleaned is not None:
                    result["types"][kind][name] = cleaned
    return result


def _extract_overlay(source: Any) -> Dict[str, Any]:
    value = source if isinstance(source, Mapping) else {}
    if isinstance(value.get("config"), Mapping):
        value = value["config"]
    if isinstance(value.get("overlay"), Mapping):
        value = value["overlay"]
    return dict(value)


def _theme_of(overlay: Mapping[str, Any]) -> str:
    styles = overlay.get("styles") if isinstance(overlay.get("styles"), Mapping) else {}
    theme = styles.get("theme", overlay.get("theme", "classic"))
    return theme if theme in THEME_PRESETS else "classic"


def typography_from_legacy(overlay: Mapping[str, Any], theme: str) -> Dict[str, Any]:
    result = default_typography()
    preset = theme_typography(theme)
    raw_family = overlay.get("font_family")
    if raw_family is not None:
        family = normalize_family(raw_family, _DEFAULT_FONT)
        if family != preset["font_family"]:
            result["global"]["font_family"] = family
    raw_line = overlay.get("line_height")
    if raw_line is not None:
        line = _normalize_line_height(raw_line)
        if line is not None and line != preset["line_height"]:
            result["global"]["line_height"] = line
    return result


class TypographyResolver:
    def __init__(self, config_snapshot: Mapping[str, Any] | None):
        overlay = _extract_overlay(config_snapshot)
        theme = _theme_of(overlay)
        raw = overlay.get("typography")
        if isinstance(raw, Mapping) and isinstance(raw.get("global"), Mapping):
            self._typography = normalize_typography(raw)
        else:
            self._typography = typography_from_legacy(overlay, theme)
        self._theme = theme
        self._cache: Dict[str, Dict[str, Any]] = {}

    def resolve(self, kind: str) -> Dict[str, Any]:
        canonical = _canonical_kind(kind)
        cached = self._cache.get(canonical)
        if cached is not None:
            return copy.deepcopy(cached)
        resolved = theme_typography(self._theme)
        _apply_layer(resolved, self._typography["global"])
        _apply_layer(resolved, self._typography["types"].get(canonical))
        self._cache[canonical] = resolved
        return copy.deepcopy(resolved)

    def resolve_all(self) -> Dict[str, Dict[str, Any]]:
        return {kind: self.resolve(kind) for kind in OVERLAY_TYPES}

    def resolve_global(self) -> Dict[str, Any]:
        resolved = theme_typography(self._theme)
        _apply_layer(resolved, self._typography["global"])
        return resolved


def resolve_all(config_snapshot: Mapping[str, Any] | None) -> Dict[str, Dict[str, Any]]:
    return TypographyResolver(config_snapshot).resolve_all()

