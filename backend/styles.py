# -*- coding: utf-8 -*-
"""v2 浮窗样式解析。

解析顺序固定为：内置 token -> 主题预设 -> styles.global -> styles.types[kind]。
所有解析都是纯内存操作，不读取文件、不依赖 Qt。
"""

from __future__ import annotations

import copy
import re
from typing import Any, Dict, Mapping

OVERLAY_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter", "like", "social", "fansclub")

STYLE_FIELDS = (
    "font_size",
    "font_weight",
    "text_color",
    "name_color",
    "bg_color",
    "bg_opacity",
    "opacity",
    "outline",
    "outline_color",
    "outline_width",
    "shadow",
    "badge_color",
)

_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

TYPE_BADGE_COLORS: Dict[str, str] = {
    "danmaku": "#4AA8FF",
    "gift": "#F5C867",
    "super_chat": "#FF6F91",
    "guard": "#A98BFF",
    "enter": "#53D6C5",
    "like": "#FF9DB8",
    "social": "#7DDCFF",
    "fansclub": "#FFC46B",
}

# 与现有 overlay_qt.py 的经典主题保持一致。百分比字段使用 10..100 的整数。
STYLE_DEFAULTS: Dict[str, Any] = {
    "font_size": 22,
    "font_weight": 600,
    "text_color": "#FFFFFF",
    "name_color": "#8FE3FF",
    "bg_color": "#000000",
    "bg_opacity": 22,
    "opacity": 100,
    "outline": True,
    "outline_color": "#000000",
    "outline_width": 2,
    "shadow": True,
    "badge_color": "#8FE3FF",
}

THEME_PRESETS: Dict[str, Dict[str, Any]] = {
    "classic": {key: value for key, value in STYLE_DEFAULTS.items() if key != "badge_color"},
    "shortvideo": {
        "font_size": 30,
        "font_weight": 800,
        "font_family": "Microsoft YaHei UI",
        "line_height": 1.45,
        "text_color": "#FFFFFF",
        "name_color": "#FFD86B",
        "bg_color": "#000000",
        "bg_opacity": 36,
        "opacity": 100,
        "outline": True,
        "outline_color": "#000000",
        "outline_width": 3,
        "shadow": True,
    },
    "minimal": {
        "font_size": 20,
        "font_weight": 400,
        "font_family": "Source Han Sans SC",
        "line_height": 1.6,
        "text_color": "#F2F5FA",
        "name_color": "#A8C7FA",
        "bg_color": "#000000",
        "bg_opacity": 10,
        "opacity": 96,
        "outline": False,
        "outline_color": "#000000",
        "outline_width": 0,
        "shadow": False,
    },
    "highcontrast": {
        "font_size": 24,
        "font_weight": 700,
        "font_family": "SimHei",
        "line_height": 1.5,
        "text_color": "#FFFFFF",
        "name_color": "#00E5FF",
        "bg_color": "#000000",
        "bg_opacity": 85,
        "opacity": 100,
        "outline": True,
        "outline_color": "#000000",
        "outline_width": 2,
        "shadow": True,
    },
}
THEME_PRESETS["classic"].update({"font_family": "Microsoft YaHei UI", "line_height": 1.55})


def _color(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip().upper()
    return value if _HEX_RE.match(value) else None


def _percent(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if 0.0 <= number <= 1.0:
        number *= 100.0
    number = int(round(number))
    return max(10, min(100, number))


def _number(value: Any, low: int, high: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return max(low, min(high, value))


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _normalize_field(name: str, value: Any) -> Any:
    if name == "text_color" or name == "name_color" or name == "bg_color" or name == "outline_color" or name == "badge_color":
        return _color(value)
    if name == "bg_opacity" or name == "opacity":
        return _percent(value)
    if name == "font_size":
        return _number(value, 12, 48)
    if name == "font_weight":
        return (
            value
            if isinstance(value, int)
            and not isinstance(value, bool)
            and value in (300, 400, 500, 600, 700, 800, 900)
            else None
        )
    if name == "outline_width":
        return _number(value, 0, 6)
    if name == "outline" or name == "shadow":
        return _bool(value)
    return None


def _apply_layer(target: Dict[str, Any], source: Any) -> None:
    """只应用非 null 的已知字段；null/缺省都表示继承上一层。"""
    if not isinstance(source, Mapping):
        return
    for name in STYLE_FIELDS:
        value = source.get(name)
        if name == "text_color" and value is None:
            # 兼容任务书中使用的 color 别名。
            value = source.get("color")
        if value is None:
            continue
        normalized = _normalize_field(name, value)
        if normalized is not None:
            target[name] = normalized


def is_copied_theme_global(global_style: Any) -> bool:
    """Detect a full effective theme snapshot written by the old v1 migration.

    The migration used to copy every flattened effective field into
    ``styles.global``. Such a layer is not a user override: it shadows the
    selected theme. A partial global layer remains a real override.
    """
    if not isinstance(global_style, Mapping):
        return False
    fields = tuple(name for name in STYLE_FIELDS if name != "badge_color")
    present = 0
    for name in fields:
        value = global_style.get(name)
        if value is None and name == "text_color":
            value = global_style.get("color")
        if value is not None:
            present += 1
    if present < len(fields):
        return False

    normalized = dict(STYLE_DEFAULTS)
    _apply_layer(normalized, global_style)
    for preset in THEME_PRESETS.values():
        if all(normalized[name] == preset.get(name) for name in fields):
            return True
    return False


def _extract_styles(config_snapshot: Any) -> Dict[str, Any]:
    source = config_snapshot if isinstance(config_snapshot, Mapping) else {}
    if isinstance(source.get("config"), Mapping):
        source = source["config"]
    if isinstance(source.get("overlay"), Mapping):
        source = source["overlay"]
    styles = source.get("styles") if isinstance(source, Mapping) else None
    if isinstance(styles, Mapping):
        return copy.deepcopy(dict(styles))
    # 也允许直接传入 styles 对象。
    if isinstance(source, Mapping) and ("theme" in source or "types" in source or "global" in source):
        return copy.deepcopy(dict(source))
    return {}


def _extract_scale(config_snapshot: Any) -> float:
    source = config_snapshot if isinstance(config_snapshot, Mapping) else {}
    if isinstance(source.get("config"), Mapping):
        source = source["config"]
    if isinstance(source.get("overlay"), Mapping):
        source = source["overlay"]
    geometry = source.get("geometry") if isinstance(source, Mapping) else None
    raw = geometry.get("scale") if isinstance(geometry, Mapping) else source.get("scale", 1.0)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = 1.0
    return max(0.5, min(4.0, value))


class StyleResolver:
    """把配置快照解析成五类最终样式，结果按类型缓存。"""

    def __init__(self, config_snapshot: Mapping[str, Any] | None):
        styles = _extract_styles(config_snapshot)
        self._scale = _extract_scale(config_snapshot)
        theme = styles.get("theme", "classic")
        self._theme = theme if isinstance(theme, str) and theme in THEME_PRESETS else "classic"
        self._global = styles.get("global") if isinstance(styles.get("global"), Mapping) else {}
        if is_copied_theme_global(self._global):
            self._global = {}
        types = styles.get("types") if isinstance(styles.get("types"), Mapping) else {}
        self._types = types
        self._cache: Dict[str, Dict[str, Any]] = {}

    @staticmethod
    def _canonical_kind(kind: str) -> str:
        if kind == "sc":
            return "super_chat"
        if kind in OVERLAY_TYPES:
            return kind
        raise ValueError("unknown overlay type: %s" % kind)

    def _resolve(self, kind: str) -> Dict[str, Any]:
        base = dict(STYLE_DEFAULTS)
        base["badge_color"] = TYPE_BADGE_COLORS[kind]
        _apply_layer(base, THEME_PRESETS[self._theme])
        _apply_layer(base, self._global)
        type_override = self._types.get(kind)
        _apply_layer(base, type_override)

        result = {"color": base["text_color"]}
        for name in STYLE_FIELDS:
            result[name] = base[name]
        if abs(self._scale - 1.0) > 0.001:
            result["font_size"] = max(12, min(96, int(round(result["font_size"] * self._scale))))
            result["outline_width"] = max(
                0, min(6, int(round(result["outline_width"] * self._scale)))
            )
        # 同时暴露 schema 字段名，避免调用方再维护第二套映射。
        result["text_color"] = base["text_color"]
        return result

    def resolve(self, kind: str) -> Dict[str, Any]:
        canonical = self._canonical_kind(kind)
        cached = self._cache.get(canonical)
        if cached is None:
            cached = self._resolve(canonical)
            self._cache[canonical] = cached
        return copy.deepcopy(cached)

    def resolve_all(self) -> Dict[str, Dict[str, Any]]:
        return {kind: self.resolve(kind) for kind in OVERLAY_TYPES}


def resolve_all(config_snapshot: Mapping[str, Any] | None) -> Dict[str, Dict[str, Any]]:
    """便捷函数；需要重复解析同一快照时优先复用 StyleResolver 实例。"""
    return StyleResolver(config_snapshot).resolve_all()
