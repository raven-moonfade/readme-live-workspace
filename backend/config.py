# -*- coding: utf-8 -*-
"""配置读写：v3 schema、版本迁移、legacy sidecar 与内存兼容视图。

磁盘上的 ``config.json`` 只保存 schema-v3 结构。v1/v2 独有或尚未进入规范
结构（朗读、过滤、MOCK、旧浮窗行为与 ``sessdata_enc``）保存在同目录
``config.legacy.json``，避免破坏 ``additionalProperties:false`` 的严格契约。
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
import threading
from typing import Any, Dict, List, Mapping, Tuple

from . import secrets_win
from .motion import (
    MOTION_CHOICES,
    MOTION_FIELDS,
    MOTION_INT_RANGES,
    MOTION_SCHEMA_VERSION,
    default_motion,
    motion_from_legacy,
    normalize_motion,
)
from .typography import (
    TYPOGRAPHY_FIELDS,
    TYPOGRAPHY_SCHEMA_VERSION,
    TypographyResolver,
    default_typography,
    normalize_typography,
    theme_typography,
    typography_from_legacy,
)
from .fonts import family_error, is_installed
from .styles import STYLE_FIELDS, THEME_PRESETS, StyleResolver, is_copied_theme_global

logger = logging.getLogger("danmaku_tts.config")

SCHEMA_VERSION = 3
APPEARANCE_SCHEMA_VERSION = 1
OVERLAY_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter", "like", "social")
PIN_LANES = ("gift", "sc", "guard", "danmaku", "enter", "like", "social")
APPEARANCE_PRESETS = ("broadcast", "cobalt")
APPEARANCE_THEME_MODES = ("light", "dark", "system")
APPEARANCE_PATTERN_TYPES = ("none", "dots")
APPEARANCE_FONTS = ("broadcast", "system", "humanist")

_LEGACY_FONT_FAMILIES = frozenset(
    ("Microsoft YaHei UI", "Source Han Sans SC", "PingFang SC", "SimHei", "SimSun", "Arial")
)

_COLOR_FIELDS = ("text_color", "name_color", "bg_color", "outline_color", "badge_color")
_STYLE_COLOR_FIELDS = frozenset(_COLOR_FIELDS)
_STYLE_BOOL_FIELDS = frozenset(("outline", "shadow"))
_STYLE_INT_RANGES = {
    "font_size": (12, 48),
    "bg_opacity": (10, 100),
    "opacity": (10, 100),
    "outline_width": (0, 6),
}

_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_LEGACY_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_PCT_RE = re.compile(r"^\s*([+-]?)(\d+(?:\.\d+)?)\s*%\s*$")
_HZ_RE = re.compile(r"^\s*([+-]?)(\d+(?:\.\d+)?)\s*hz\s*$", re.IGNORECASE)
_KEEP = object()
_MIGRATION_ERROR = "MigrationError"
WRITE_FAILED = "config: 写入配置失败"

_READ_BOOL_KEYS = (
    "danmaku", "gift", "super_chat", "guard", "enter", "like", "social", "include_user",
)
_TEMPLATE_KEYS = ("danmaku", "gift", "super_chat", "guard", "enter", "like", "social")
_MOCK_INT_RANGES = {"interval_ms": (200, 60000), "per_tick": (1, 20)}
_MOCK_TYPE_KEYS = ("danmaku", "gift", "super_chat", "guard", "enter", "like", "social")

_OVERLAY_BOOL_KEYS = (
    "enabled",
    "show_name",
    "outline",
    "shadow",
    "click_through",
    "always_on_top",
    "show_avatar",
    "gift_pin",
)
_OVERLAY_INT_RANGES = {
    "x": (-20000, 20000),
    "y": (-20000, 20000),
    "width": (240, 3840),
    "height": (120, 2160),
    "font_size": (10, 96),
    "outline_width": (0, 6),
    "name_max_len": (1, 10 ** 9),
    "text_max_len": (1, 10 ** 9),
    "max_lines": (0, 30),
    "dwell_ms": (0, 120000),
    "gap": (0, 40),
    "gift_pin_duration_ms": (0, 600000),
    "gift_pin_max": (0, 6),
    "gift_pin_min_price": (0, 1000000),
}
_OVERLAY_FLOAT_RANGES = {
    "line_height": (1.0, 2.5),
    "bg_opacity": (0.0, 1.0),
    "opacity": (0.0, 1.0),
    "scale": (0.5, 2.0),
}
_OVERLAY_CHOICES = {
    "align": ("left", "center", "right"),
    "animation": ("none", "fade", "slide"),
    "theme": ("classic", "shortvideo", "minimal", "highcontrast"),
    "template_id": ("bubble", "compact", "focus"),
    "gift_pin_position": ("top", "bottom"),
}
_OVERLAY_COLOR_KEYS = ("color", "name_color", "outline_color", "bg_color", "badge_color")
_OVERLAY_KEYS = tuple(
    dict.fromkeys(
        (
            *_OVERLAY_BOOL_KEYS,
            *_OVERLAY_INT_RANGES.keys(),
            *_OVERLAY_FLOAT_RANGES.keys(),
            "font_family",
            "name_sep",
            "types",
            *_OVERLAY_CHOICES.keys(),
            *_OVERLAY_COLOR_KEYS,
            "gift_pin_min_price",
        )
    )
)

DEFAULT_LEGACY_OVERLAY: Dict[str, Any] = {
    "enabled": False,
    "x": 60,
    "y": 120,
    "width": 520,
    "height": 620,
    "scale": 1.0,
    "font_family": "Microsoft YaHei UI",
    "font_size": 22,
    "font_weight": 600,
    "line_height": 1.55,
    "color": "#FFFFFF",
    "name_color": "#8FE3FF",
    "name_sep": "：",
    "show_name": True,
    "name_max_len": 12,
    "text_max_len": 70,
    "outline": True,
    "outline_color": "#000000",
    "outline_width": 2,
    "shadow": True,
    "bg_color": "#000000",
    "bg_opacity": 0.22,
    "opacity": 1.0,
    "align": "left",
    "max_lines": 8,
    "animation": "slide",
    "dwell_ms": 12000,
    "gap": 8,
    "types": {
        "danmaku": True,
        "gift": True,
        "super_chat": True,
        "guard": True,
        "enter": False,
        "like": True,
        "social": True,
    },
    "click_through": True,
    "always_on_top": True,
    "show_avatar": False,
    "theme": "classic",
    "template_id": "bubble",
    "gift_pin": False,
    "gift_pin_position": "bottom",
    "gift_pin_duration_ms": 15000,
    "gift_pin_max": 3,
    "gift_pin_min_price": 0,
    # 动效只进入 legacy sidecar，不进入 config.json 的严格 schema。
    "motion": default_motion(),
    "typography": default_typography(),
}

DEFAULT_LEGACY_CONFIG: Dict[str, Any] = {
    "room_id": 0,
    "platform": "bilibili",
    "sessdata": "",
    "tts": {
        "enabled": True,
        "voice": "zh-CN-XiaoxiaoNeural",
        "rate": "+0%",
        "pitch": "+0Hz",
        "volume": "+0%",
    },
    "read": {
        "danmaku": True,
        "gift": True,
        "super_chat": True,
        "guard": True,
        "enter": False,
        "like": False,
        "social": True,
        "gift_min_price": 0,
        "include_user": True,
        "templates": {
            "danmaku": "{user}说：{text}",
            "gift": "感谢{user}送出的{gift_name}乘以{num}",
            "super_chat": "{user}的醒目留言：{message}",
            "guard": "感谢{user}开通{guard_name}",
            "enter": "{user}进入直播间",
            "like": "{user}点了赞",
            "social": "{user}{social_action}",
        },
    },
    "filters": {
        "blacklist": [],
        "dedup_seconds": 5,
        "max_len": 80,
        "user_cooldown": 3,
        "global_cooldown": 0.5,
    },
    "queue": {"max_size": 30},
    "mock": {
        "interval_ms": 1500,
        "per_tick": 1,
        "speak": True,
        "speak_version": 2,
        "types": {
            "danmaku": True,
            "gift": False,
            "super_chat": False,
            "guard": False,
            "enter": False,
            "like": False,
            "social": False,
        },
    },
}


def _null_style() -> Dict[str, None]:
    return {field: None for field in STYLE_FIELDS}


DEFAULT_APPEARANCE: Dict[str, Any] = {
    "schema_version": APPEARANCE_SCHEMA_VERSION,
    "preset": "broadcast",
    "custom": False,
    "theme_mode": "dark",
    "accent": "#FF5F3A",
    "pattern": {"type": "none", "spacing_px": 24, "dot_size_px": 1.5},
    "monitor_pattern": True,
    "radius": {"enabled": False, "value_px": 12},
    "font": "broadcast",
}


DEFAULT_CONFIG: Dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    "appearance": copy.deepcopy(DEFAULT_APPEARANCE),
    "overlay": {
        "enabled": False,
        "geometry": {"x": 60, "y": 120, "width": 520, "height": 620, "scale": 1.0},
        "styles": {
            "theme": "classic",
            "global": {},
            "types": {kind: _null_style() for kind in OVERLAY_TYPES},
        },
        "pins": {
            "gift": {
                "enabled": True,
                "position": "top",
                "duration_ms": 8000,
                "max": 3,
                "min_price": 10,
            },
            "sc": {"enabled": True, "position": "top", "duration_ms": 12000, "max": 2},
            "guard": {"enabled": True, "position": "bottom", "duration_ms": 6000, "max": 2},
            "danmaku": {"enabled": False, "position": "bottom", "duration_ms": 8000, "max": 3},
            "enter": {"enabled": False, "position": "bottom", "duration_ms": 6000, "max": 2},
            "like": {"enabled": False, "position": "bottom", "duration_ms": 6000, "max": 2},
            "social": {"enabled": False, "position": "bottom", "duration_ms": 6000, "max": 2},
        },
    },
    "monitor": {
        "font_px": None,
        "mode": "auto",
        "columns": ["time", "type", "user", "content", "value", "status"],
        "geometry": {"width": 1366, "height": 768},
    },
}

_KNOWN_TOP_KEYS = frozenset(
    (
        "schema_version",
        "appearance",
        "overlay",
        "monitor",
        "hotkeys",  # 已移除功能；保留键名只为返回明确拒绝原因
        "styles",
        "pins",
        "room_id",
        "platform",
        "sessdata",
        "tts",
        "read",
        "filters",
        "queue",
        "mock",
    )
)


# --------------------------------------------------------------------- 基础工具
def deep_merge(base: Any, patch: Any) -> Any:
    """返回 base 的深拷贝，并把 patch 深合并进去（dict 递归合并，其余覆盖）。"""
    out = copy.deepcopy(base)
    if not isinstance(patch, dict):
        return out
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _bool(v: Any) -> Any:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("true", "1", "yes", "on"):
            return True
        if s in ("false", "0", "no", "off"):
            return False
    return _KEEP


def _int(v: Any, lo: int = 0, hi: int = 10 ** 12) -> Any:
    if isinstance(v, bool):
        return _KEEP
    if isinstance(v, int):
        n = v
    elif isinstance(v, float) and float(v).is_integer():
        n = int(v)
    elif isinstance(v, str):
        try:
            n = int(float(v.strip()))
        except (TypeError, ValueError):
            return _KEEP
    else:
        return _KEEP
    return n if lo <= n <= hi else _KEEP


def _float(v: Any, lo: float = 0.0, hi: float = 10 ** 9) -> Any:
    if isinstance(v, bool):
        return _KEEP
    if isinstance(v, (int, float)):
        n = float(v)
    elif isinstance(v, str):
        try:
            n = float(v.strip())
        except (TypeError, ValueError):
            return _KEEP
    else:
        return _KEEP
    return n if lo <= n <= hi else _KEEP


def _text(v: Any, max_chars: int = 4096) -> Any:
    if isinstance(v, str):
        return v[:max_chars]
    return _KEEP


def _limited_text(v: Any, max_chars: int) -> Any:
    if isinstance(v, str) and len(v) <= max_chars:
        return v
    return _KEEP


def _color(v: Any) -> Any:
    """旧配置颜色：允许 #RGB / #RRGGBB，并规范成大写六位。"""
    if not isinstance(v, str):
        return _KEEP
    s = v.strip()
    if not _LEGACY_COLOR_RE.match(s):
        return _KEEP
    body = s[1:].upper()
    if len(body) == 3:
        body = "".join(ch * 2 for ch in body)
    return "#" + body


def _strict_color(v: Any) -> Any:
    if not isinstance(v, str):
        return _KEEP
    s = v.strip().upper()
    return s if _COLOR_RE.match(s) else _KEEP


def _signed_value(v: Any, regex: re.Pattern[str], unit: str) -> Any:
    if isinstance(v, bool):
        return _KEEP
    if isinstance(v, (int, float)):
        num = v
    elif isinstance(v, str):
        m = regex.match(v)
        if not m:
            return _KEEP
        num = float(m.group(2))
        if m.group(1) == "-":
            num = -num
    else:
        return _KEEP
    if abs(num) > 1000:
        return _KEEP
    sign = "+" if num >= 0 else "-"
    body = ("%d" % abs(num)) if float(abs(num)).is_integer() else ("%g" % abs(num))
    return "%s%s%s" % (sign, body, unit)


# --------------------------------------------------------------- 规范结构校验
def _validate_style_override(value: Any, path: str, errors: List[str]) -> None:
    if not isinstance(value, dict):
        errors.append("%s: 必须是对象" % path)
        return
    for key, field_value in value.items():
        field_path = "%s.%s" % (path, key)
        if key not in STYLE_FIELDS:
            errors.append("%s: 未声明字段" % field_path)
            continue
        if field_value is None:
            continue
        if key in _STYLE_COLOR_FIELDS:
            if not isinstance(field_value, str) or not _COLOR_RE.match(field_value):
                errors.append("%s: 必须是 #RRGGBB 或 null" % field_path)
        elif key == "font_weight":
            if (
                isinstance(field_value, bool)
                or not isinstance(field_value, int)
                or field_value not in (400, 500, 600, 700, 800)
            ):
                errors.append("%s: 必须是 400/500/600/700/800 或 null" % field_path)
        elif key in _STYLE_BOOL_FIELDS:
            if not isinstance(field_value, bool):
                errors.append("%s: 必须是布尔值或 null" % field_path)
        elif key in _STYLE_INT_RANGES:
            low, high = _STYLE_INT_RANGES[key]
            if isinstance(field_value, bool) or not isinstance(field_value, int):
                errors.append("%s: 必须是整数或 null" % field_path)
            elif not low <= field_value <= high:
                errors.append("%s: 必须在 %d..%d" % (field_path, low, high))


def _validate_geometry(value: Any, path: str, errors: List[str], monitor: bool = False) -> None:
    if not isinstance(value, dict):
        errors.append("%s: 必须是对象" % path)
        return
    allowed = {"x", "y", "width", "height"} if monitor else {"x", "y", "width", "height", "scale"}
    required = {"width", "height"}
    for key in value:
        if key not in allowed:
            errors.append("%s.%s: 未声明字段" % (path, key))
    for key in required:
        if key not in value:
            errors.append("%s.%s: 缺少必填字段" % (path, key))
    ranges = {
        "x": (-10000, 10000),
        "y": (-10000, 10000),
        "width": (720, 10000) if monitor else (200, 3840),
        "height": (480, 10000) if monitor else (200, 2160),
    }
    for key, (low, high) in ranges.items():
        if key not in value:
            continue
        field_value = value[key]
        if isinstance(field_value, bool) or not isinstance(field_value, int):
            errors.append("%s.%s: 必须是整数" % (path, key))
        elif not low <= field_value <= high:
            errors.append("%s.%s: 必须在 %d..%d" % (path, key, low, high))
    if not monitor and "scale" in value:
        scale = value["scale"]
        if isinstance(scale, bool) or not isinstance(scale, (int, float)):
            errors.append("%s.scale: 必须是数字" % path)
        elif not 0.5 <= float(scale) <= 4.0:
            errors.append("%s.scale: 必须在 0.5..4.0" % path)


def _validate_styles(value: Any, path: str, errors: List[str]) -> None:
    if not isinstance(value, dict):
        errors.append("%s: 必须是对象" % path)
        return
    for key in value:
        if key not in ("theme", "global", "types"):
            errors.append("%s.%s: 未声明字段" % (path, key))
    theme = value.get("theme")
    if not isinstance(theme, str) or theme not in THEME_PRESETS:
        errors.append("%s.theme: 枚举非法" % path)
    if "global" in value:
        _validate_style_override(value["global"], path + ".global", errors)
    types = value.get("types")
    if not isinstance(types, dict):
        errors.append("%s.types: 必须是对象" % path)
        return
    for kind in types:
        if kind not in OVERLAY_TYPES:
            errors.append("%s.types.%s: 未声明类型" % (path, kind))
    for kind in OVERLAY_TYPES:
        if kind not in types:
            errors.append("%s.types.%s: 缺少类型" % (path, kind))
        else:
            _validate_style_override(types[kind], "%s.types.%s" % (path, kind), errors)


def _validate_pin(value: Any, path: str, gift: bool, errors: List[str]) -> None:
    if not isinstance(value, dict):
        errors.append("%s: 必须是对象" % path)
        return
    allowed = {"enabled", "position", "duration_ms", "max"}
    if gift:
        allowed.add("min_price")
    for key in value:
        if key not in allowed:
            errors.append("%s.%s: 未声明字段" % (path, key))
    for key in ("enabled", "position", "duration_ms", "max"):
        if key not in value:
            errors.append("%s.%s: 缺少必填字段" % (path, key))
    if gift and "min_price" not in value:
        errors.append("%s.min_price: 缺少必填字段" % path)
    if "enabled" in value and not isinstance(value["enabled"], bool):
        errors.append("%s.enabled: 必须是布尔值" % path)
    if "position" in value and value["position"] not in ("top", "bottom"):
        errors.append("%s.position: 枚举非法" % path)
    for key, low, high in (("duration_ms", 0, 30000), ("max", 0, 6)):
        if key not in value:
            continue
        number = value[key]
        if isinstance(number, bool) or not isinstance(number, int):
            errors.append("%s.%s: 必须是整数" % (path, key))
        elif not low <= number <= high:
            errors.append("%s.%s: 必须在 %d..%d" % (path, key, low, high))
    if gift and "min_price" in value:
        price = value["min_price"]
        if isinstance(price, bool) or not isinstance(price, (int, float)):
            errors.append("%s.min_price: 必须是数字" % path)
        elif not 0 <= float(price) <= 100000:
            errors.append("%s.min_price: 必须在 0..100000" % path)


def _validate_pins(value: Any, path: str, errors: List[str]) -> None:
    if not isinstance(value, dict):
        errors.append("%s: 必须是对象" % path)
        return
    for key in value:
        if key not in PIN_LANES:
            errors.append("%s.%s: 未声明字段" % (path, key))
    for lane in PIN_LANES:
        if lane not in value and lane in ("gift", "sc", "guard"):
            errors.append("%s.%s: 缺少必填字段" % (path, lane))
        elif lane in value:
            _validate_pin(value[lane], "%s.%s" % (path, lane), lane == "gift", errors)


def _validate_motion_override(value: Any, path: str, errors: List[str], global_spec: bool) -> None:
    if not isinstance(value, dict):
        errors.append("%s: 必须是对象" % path)
        return
    for key, field_value in value.items():
        field_path = "%s.%s" % (path, key)
        if key == "schema_version" and global_spec:
            if field_value != MOTION_SCHEMA_VERSION:
                errors.append("%s: 必须为 %d" % (field_path, MOTION_SCHEMA_VERSION))
            continue
        if key not in MOTION_FIELDS:
            errors.append("%s: 未声明字段" % field_path)
            continue
        if field_value is None:
            if global_spec:
                errors.append("%s: global 不允许 null" % field_path)
            continue
        if key in MOTION_CHOICES:
            if not isinstance(field_value, str) or field_value not in MOTION_CHOICES[key]:
                errors.append("%s: 枚举非法" % field_path)
        elif key in MOTION_INT_RANGES:
            low, high = MOTION_INT_RANGES[key]
            if isinstance(field_value, bool) or not isinstance(field_value, int):
                errors.append("%s: 必须是整数" % field_path)
            elif not low <= field_value <= high:
                errors.append("%s: 必须在 %d..%d" % (field_path, low, high))


def _validate_motion(value: Any, path: str, errors: List[str]) -> None:
    if not isinstance(value, dict):
        errors.append("%s: 必须是对象" % path)
        return
    for key in value:
        if key not in ("schema_version", "global", "types"):
            errors.append("%s.%s: 未声明字段" % (path, key))
    if "schema_version" in value and value["schema_version"] != MOTION_SCHEMA_VERSION:
        errors.append("%s.schema_version: 必须为 %d" % (path, MOTION_SCHEMA_VERSION))
    if "global" in value:
        _validate_motion_override(value["global"], path + ".global", errors, True)
    types = value.get("types")
    if types is not None:
        if not isinstance(types, dict):
            errors.append("%s.types: 必须是对象" % path)
            return
        for kind in types:
            if kind not in OVERLAY_TYPES:
                errors.append("%s.types.%s: 未声明类型" % (path, kind))
        for kind in OVERLAY_TYPES:
            if kind in types:
                _validate_motion_override(types[kind], "%s.types.%s" % (path, kind), errors, False)


def _validate_monitor(value: Any, path: str, errors: List[str]) -> None:
    if not isinstance(value, dict):
        errors.append("%s: 必须是对象" % path)
        return
    required = ("font_px", "mode", "columns", "geometry")
    allowed = required + ("ui_size",)
    for key in value:
        if key not in allowed:
            errors.append("%s.%s: 未声明字段" % (path, key))
    for key in required:
        if key not in value:
            errors.append("%s.%s: 缺少必填字段" % (path, key))
    if "font_px" in value:
        font_px = value["font_px"]
        if font_px is not None and (
            isinstance(font_px, bool) or not isinstance(font_px, int) or font_px not in (13, 15, 17, 19, 20, 25, 30, 40, 50)
        ):
            errors.append("%s.font_px: 必须是 13/15/17/19/20/25/30/40/50 或 null" % path)
    if "ui_size" in value and value["ui_size"] not in ("small", "medium", "large", "xlarge"):
        errors.append("%s.ui_size: 枚举非法" % path)
    if "mode" in value and value["mode"] not in ("auto", "single_line", "two_line"):
        errors.append("%s.mode: 枚举非法" % path)
    if "columns" in value:
        columns = value["columns"]
        valid_columns = ("time", "type", "user", "content", "value", "status")
        if not isinstance(columns, list):
            errors.append("%s.columns: 必须是数组" % path)
        elif not 1 <= len(columns) <= 6:
            errors.append("%s.columns: 数量必须在 1..6" % path)
        elif any(not isinstance(item, str) or item not in valid_columns for item in columns):
            errors.append("%s.columns: 存在非法枚举" % path)
        elif len(set(columns)) != len(columns):
            errors.append("%s.columns: 不能重复" % path)
    if "geometry" in value:
        _validate_geometry(value["geometry"], path + ".geometry", errors, monitor=True)


def _validate_appearance(value: Any, path: str, errors: List[str]) -> None:
    if not isinstance(value, dict):
        errors.append("%s: 必须是对象" % path)
        return

    required = (
        "schema_version",
        "preset",
        "custom",
        "theme_mode",
        "accent",
        "pattern",
        "radius",
        "font",
    )
    allowed = required + ("monitor_pattern",)
    for key in value:
        if key not in allowed:
            errors.append("%s.%s: 未声明字段" % (path, key))
    for key in required:
        if key not in value:
            errors.append("%s.%s: 缺少必填字段" % (path, key))

    appearance_version = value.get("schema_version")
    if type(appearance_version) is not int or appearance_version != APPEARANCE_SCHEMA_VERSION:
        errors.append("%s.schema_version: 必须为 %d" % (path, APPEARANCE_SCHEMA_VERSION))
    if value.get("preset") not in APPEARANCE_PRESETS:
        errors.append("%s.preset: 枚举非法" % path)
    if not isinstance(value.get("custom"), bool):
        errors.append("%s.custom: 必须是布尔值" % path)
    if value.get("theme_mode") not in APPEARANCE_THEME_MODES:
        errors.append("%s.theme_mode: 枚举非法" % path)
    accent = value.get("accent")
    if not isinstance(accent, str) or not _COLOR_RE.match(accent):
        errors.append("%s.accent: 必须是 #RRGGBB" % path)
    if value.get("font") not in APPEARANCE_FONTS:
        errors.append("%s.font: 枚举非法" % path)
    if "monitor_pattern" in value and not isinstance(value["monitor_pattern"], bool):
        errors.append("%s.monitor_pattern: 必须是布尔值" % path)

    pattern = value.get("pattern")
    if not isinstance(pattern, dict):
        errors.append("%s.pattern: 必须是对象" % path)
    else:
        allowed = ("type", "spacing_px", "dot_size_px")
        for key in pattern:
            if key not in allowed:
                errors.append("%s.pattern.%s: 未声明字段" % (path, key))
        for key in allowed:
            if key not in pattern:
                errors.append("%s.pattern.%s: 缺少必填字段" % (path, key))
        if pattern.get("type") not in APPEARANCE_PATTERN_TYPES:
            errors.append("%s.pattern.type: 枚举非法" % path)
        spacing = pattern.get("spacing_px")
        if isinstance(spacing, bool) or not isinstance(spacing, int) or not 8 <= spacing <= 40:
            errors.append("%s.pattern.spacing_px: 必须是 8..40 的整数" % path)
        dot_size = pattern.get("dot_size_px")
        if (
            isinstance(dot_size, bool)
            or not isinstance(dot_size, (int, float))
            or not 0.5 <= float(dot_size) <= 4.0
            or abs(float(dot_size) * 4 - round(float(dot_size) * 4)) > 1e-9
        ):
            errors.append("%s.pattern.dot_size_px: 必须是 0.5..4.0、步进 0.25 的数字" % path)

    radius = value.get("radius")
    if not isinstance(radius, dict):
        errors.append("%s.radius: 必须是对象" % path)
    else:
        allowed = ("enabled", "value_px")
        for key in radius:
            if key not in allowed:
                errors.append("%s.radius.%s: 未声明字段" % (path, key))
        for key in allowed:
            if key not in radius:
                errors.append("%s.radius.%s: 缺少必填字段" % (path, key))
        if not isinstance(radius.get("enabled"), bool):
            errors.append("%s.radius.enabled: 必须是布尔值" % path)
        radius_px = radius.get("value_px")
        if isinstance(radius_px, bool) or not isinstance(radius_px, int) or not 2 <= radius_px <= 18:
            errors.append("%s.radius.value_px: 必须是 2..18 的整数" % path)


def validate_config(config: Mapping[str, Any]) -> List[str]:
    """返回当前（v3）schema 错误列表；空列表表示通过。"""
    errors: List[str] = []
    if not isinstance(config, Mapping):
        return ["/: 顶层必须是对象"]
    allowed = {"schema_version", "appearance", "overlay", "monitor"}
    for key in config:
        if key not in allowed:
            errors.append("/%s: 未声明字段" % key)
    for key in ("schema_version", "appearance", "overlay", "monitor"):
        if key not in config:
            errors.append("/%s: 缺少必填字段" % key)
    top_version = config.get("schema_version")
    if type(top_version) is not int or top_version != SCHEMA_VERSION:
        errors.append("/schema_version: 必须为 %d" % SCHEMA_VERSION)

    if "appearance" in config:
        _validate_appearance(config["appearance"], "/appearance", errors)

    overlay = config.get("overlay")
    if not isinstance(overlay, dict):
        errors.append("/overlay: 必须是对象")
    else:
        for key in overlay:
            if key not in ("enabled", "geometry", "styles", "pins"):
                errors.append("/overlay/%s: 未声明字段" % key)
        if "enabled" in overlay and not isinstance(overlay["enabled"], bool):
            errors.append("/overlay/enabled: 必须是布尔值")
        if "geometry" in overlay:
            _validate_geometry(overlay["geometry"], "/overlay/geometry", errors)
        for key in ("styles", "pins"):
            if key not in overlay:
                errors.append("/overlay/%s: 缺少必填字段" % key)
        if "styles" in overlay:
            _validate_styles(overlay["styles"], "/overlay/styles", errors)
        if "pins" in overlay:
            _validate_pins(overlay["pins"], "/overlay/pins", errors)

    if "monitor" in config:
        _validate_monitor(config["monitor"], "/monitor", errors)
    return errors


def canonical_config(config: Mapping[str, Any]) -> Dict[str, Any]:
    """从运行时配置中截取严格当前 schema 的顶层字段。"""
    return {
        key: copy.deepcopy(config.get(key))
        for key in ("schema_version", "appearance", "overlay", "monitor")
    }


# --------------------------------------------------------------- 规范结构 patch
def _clean_style_override(src: Any, path: str, rejected: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out
    for key, value in src.items():
        target = "text_color" if key == "color" else key
        field_path = "%s.%s" % (path, key)
        if target not in STYLE_FIELDS or (key == "color" and "text_color" in src):
            rejected.append(field_path)
            continue
        if value is None:
            out[target] = None
            continue
        if target in _STYLE_COLOR_FIELDS:
            cleaned = _strict_color(value)
        elif target == "font_weight":
            cleaned = (
                value
                if isinstance(value, int)
                and not isinstance(value, bool)
                and value in (400, 500, 600, 700, 800)
                else _KEEP
            )
        elif target in _STYLE_BOOL_FIELDS:
            cleaned = value if isinstance(value, bool) else _KEEP
        elif target in _STYLE_INT_RANGES:
            low, high = _STYLE_INT_RANGES[target]
            cleaned = (
                value
                if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high
                else _KEEP
            )
        else:
            cleaned = _KEEP
        if cleaned is _KEEP:
            rejected.append(field_path)
        else:
            out[target] = cleaned
    return out


def _clean_geometry_patch(src: Any, path: str, rejected: List[str], monitor: bool = False) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out
    allowed = {"x", "y", "width", "height"} if monitor else {"x", "y", "width", "height", "scale"}
    ranges = {
        "x": (-10000, 10000),
        "y": (-10000, 10000),
        "width": (720, 10000) if monitor else (200, 3840),
        "height": (480, 10000) if monitor else (200, 2160),
    }
    for key, value in src.items():
        field_path = "%s.%s" % (path, key)
        if key not in allowed:
            rejected.append(field_path)
            continue
        if key in ranges:
            low, high = ranges[key]
            cleaned = (
                value
                if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high
                else _KEEP
            )
        else:
            cleaned = (
                float(value)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and 0.5 <= float(value) <= 4.0
                else _KEEP
            )
        if cleaned is _KEEP:
            rejected.append(field_path)
        else:
            out[key] = cleaned
    return out


def _clean_pin_patch(src: Any, path: str, gift: bool, rejected: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out
    allowed = {"enabled", "position", "duration_ms", "max"}
    if gift:
        allowed.add("min_price")
    for key, value in src.items():
        field_path = "%s.%s" % (path, key)
        if key not in allowed:
            rejected.append(field_path)
            continue
        if key == "enabled":
            cleaned = value if isinstance(value, bool) else _KEEP
        elif key == "position":
            cleaned = value if value in ("top", "bottom") else _KEEP
        elif key == "duration_ms":
            cleaned = (
                value
                if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 30000
                else _KEEP
            )
        elif key == "max":
            cleaned = (
                value
                if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 6
                else _KEEP
            )
        else:
            cleaned = (
                float(value)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= float(value) <= 100000
                else _KEEP
            )
        if cleaned is _KEEP:
            rejected.append(field_path)
        else:
            out[key] = cleaned
    return out


def _clean_pins_patch(src: Any, path: str, rejected: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out
    for lane, value in src.items():
        field_path = "%s.%s" % (path, lane)
        target = "sc" if lane == "super_chat" else lane
        if target not in PIN_LANES:
            rejected.append(field_path)
            continue
        cleaned = _clean_pin_patch(value, field_path, target == "gift", rejected)
        if cleaned:
            out[target] = cleaned
    return out


def _clean_styles_patch(src: Any, path: str, rejected: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out
    for key, value in src.items():
        field_path = "%s.%s" % (path, key)
        if key == "theme":
            if isinstance(value, str) and value in THEME_PRESETS:
                out["theme"] = value
            else:
                rejected.append(field_path)
        elif key == "global":
            cleaned = _clean_style_override(value, field_path, rejected)
            if cleaned:
                out["global"] = cleaned
        elif key == "types":
            if not isinstance(value, dict):
                rejected.append(field_path)
                continue
            types: Dict[str, Any] = {}
            for kind, override in value.items():
                type_path = "%s.%s" % (field_path, kind)
                if kind not in OVERLAY_TYPES:
                    rejected.append(type_path)
                    continue
                cleaned = _clean_style_override(override, type_path, rejected)
                if cleaned:
                    types[kind] = cleaned
                elif override == {}:
                    types[kind] = {}
            if types:
                out["types"] = types
        else:
            rejected.append(field_path)
    return out


def _clean_motion_override(
    src: Any,
    path: str,
    rejected: List[str],
    global_spec: bool,
) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out
    for key, value in src.items():
        field_path = "%s.%s" % (path, key)
        if key == "schema_version" and global_spec:
            if value == MOTION_SCHEMA_VERSION:
                out[key] = value
            else:
                rejected.append(field_path)
            continue
        if key not in MOTION_FIELDS:
            rejected.append(field_path)
            continue
        if value is None:
            if global_spec:
                rejected.append(field_path)
            else:
                out[key] = None
            continue
        if key in MOTION_CHOICES:
            if isinstance(value, str) and value in MOTION_CHOICES[key]:
                out[key] = value
            else:
                rejected.append(field_path)
        elif key in MOTION_INT_RANGES:
            low, high = MOTION_INT_RANGES[key]
            if (
                isinstance(value, int)
                and not isinstance(value, bool)
                and low <= value <= high
            ):
                out[key] = value
            else:
                rejected.append(field_path)
    return out


def _clean_motion_patch(src: Any, path: str, rejected: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out
    if "schema_version" in src:
        if src.get("schema_version") == MOTION_SCHEMA_VERSION:
            out["schema_version"] = MOTION_SCHEMA_VERSION
        else:
            rejected.append(path + ".schema_version")
    if "global" in src:
        cleaned = _clean_motion_override(src["global"], path + ".global", rejected, True)
        if cleaned:
            out["global"] = cleaned
    if "types" in src:
        if not isinstance(src["types"], dict):
            rejected.append(path + ".types")
        else:
            types: Dict[str, Any] = {}
            for kind, override in src["types"].items():
                type_path = "%s.types.%s" % (path, kind)
                if kind not in OVERLAY_TYPES:
                    rejected.append(type_path)
                    continue
                cleaned = _clean_motion_override(override, type_path, rejected, False)
                if cleaned:
                    types[kind] = cleaned
                elif override == {}:
                    types[kind] = {}
            if types:
                out["types"] = types
    for key in src:
        if key not in ("schema_version", "global", "types"):
            rejected.append(path + "." + str(key))
    return out


def _clean_typography_override(
    src: Any,
    path: str,
    rejected: List[str],
    global_spec: bool,
) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out
    for key, value in src.items():
        field_path = "%s.%s" % (path, key)
        if key == "schema_version" and global_spec:
            if value == TYPOGRAPHY_SCHEMA_VERSION:
                out[key] = value
            else:
                rejected.append(field_path)
            continue
        if key not in TYPOGRAPHY_FIELDS:
            rejected.append(field_path)
            continue
        if value is None:
            out[key] = None
            continue
        if key == "font_family":
            if family_error(value) is not None or not is_installed(value):
                rejected.append(field_path)
            else:
                out[key] = normalize_typography({"global": {key: value}})["global"][key]
        elif key == "line_height":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                rejected.append(field_path)
                continue
            number = round(float(value), 2)
            if 1.0 <= number <= 2.5:
                out[key] = number
            else:
                rejected.append(field_path)
        elif key == "letter_spacing":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                rejected.append(field_path)
                continue
            number = round(float(value) * 4.0) / 4.0
            if 0.0 <= number <= 8.0:
                out[key] = number
            else:
                rejected.append(field_path)
    return out


def _clean_typography_patch(src: Any, path: str, rejected: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out
    if "schema_version" in src:
        if src.get("schema_version") == TYPOGRAPHY_SCHEMA_VERSION:
            out["schema_version"] = TYPOGRAPHY_SCHEMA_VERSION
        else:
            rejected.append(path + ".schema_version")
    if "global" in src:
        cleaned = _clean_typography_override(src["global"], path + ".global", rejected, True)
        if cleaned:
            out["global"] = cleaned
    if "types" in src:
        if not isinstance(src["types"], dict):
            rejected.append(path + ".types")
        else:
            types: Dict[str, Any] = {}
            for kind, override in src["types"].items():
                type_path = "%s.types.%s" % (path, kind)
                if kind not in OVERLAY_TYPES:
                    rejected.append(type_path)
                    continue
                cleaned = _clean_typography_override(override, type_path, rejected, False)
                if cleaned:
                    types[kind] = cleaned
                elif override == {}:
                    types[kind] = {}
            if types:
                out["types"] = types
    for key in src:
        if key not in ("schema_version", "global", "types"):
            rejected.append(path + "." + str(key))
    return out


def _clean_appearance_patch(
    src: Any,
    path: str,
    rejected: List[str],
    require_full: bool = False,
) -> Dict[str, Any]:
    """清洗 appearance；patch 模式允许局部字段，保存接口要求完整对象。"""
    out: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append(path)
        return out

    required = (
        "schema_version",
        "preset",
        "custom",
        "theme_mode",
        "accent",
        "pattern",
        "radius",
        "font",
    )
    allowed = required + ("monitor_pattern",)
    for key in src:
        if key not in allowed:
            rejected.append("%s.%s" % (path, key))
    if require_full:
        for key in required:
            if key not in src:
                rejected.append("%s.%s" % (path, key))

    if "schema_version" in src:
        value = src["schema_version"]
        if type(value) is int and value == APPEARANCE_SCHEMA_VERSION:
            out["schema_version"] = value
        else:
            rejected.append(path + ".schema_version")
    if "preset" in src:
        value = src["preset"]
        if isinstance(value, str) and value in APPEARANCE_PRESETS:
            out["preset"] = value
        else:
            rejected.append(path + ".preset")
    if "custom" in src:
        value = src["custom"]
        if isinstance(value, bool):
            out["custom"] = value
        else:
            rejected.append(path + ".custom")
    if "theme_mode" in src:
        value = src["theme_mode"]
        if isinstance(value, str) and value in APPEARANCE_THEME_MODES:
            out["theme_mode"] = value
        else:
            rejected.append(path + ".theme_mode")
    if "accent" in src:
        value = _strict_color(src["accent"])
        if value is _KEEP:
            rejected.append(path + ".accent")
        else:
            out["accent"] = value
    if "font" in src:
        value = src["font"]
        if isinstance(value, str) and value in APPEARANCE_FONTS:
            out["font"] = value
        else:
            rejected.append(path + ".font")
    if "monitor_pattern" in src:
        value = src["monitor_pattern"]
        if isinstance(value, bool):
            out["monitor_pattern"] = value
        else:
            rejected.append(path + ".monitor_pattern")

    if "pattern" in src:
        pattern_src = src["pattern"]
        if not isinstance(pattern_src, dict):
            rejected.append(path + ".pattern")
        else:
            pattern: Dict[str, Any] = {}
            allowed = ("type", "spacing_px", "dot_size_px")
            for key in pattern_src:
                if key not in allowed:
                    rejected.append("%s.pattern.%s" % (path, key))
            if require_full:
                for key in allowed:
                    if key not in pattern_src:
                        rejected.append("%s.pattern.%s" % (path, key))
            if "type" in pattern_src:
                value = pattern_src["type"]
                if isinstance(value, str) and value in APPEARANCE_PATTERN_TYPES:
                    pattern["type"] = value
                else:
                    rejected.append(path + ".pattern.type")
            if "spacing_px" in pattern_src:
                value = pattern_src["spacing_px"]
                if isinstance(value, int) and not isinstance(value, bool) and 8 <= value <= 40:
                    pattern["spacing_px"] = value
                else:
                    rejected.append(path + ".pattern.spacing_px")
            if "dot_size_px" in pattern_src:
                value = _float(pattern_src["dot_size_px"], 0.5, 4.0)
                if value is _KEEP:
                    rejected.append(path + ".pattern.dot_size_px")
                else:
                    pattern["dot_size_px"] = round(value * 4) / 4
            if pattern or require_full:
                out["pattern"] = pattern

    if "radius" in src:
        radius_src = src["radius"]
        if not isinstance(radius_src, dict):
            rejected.append(path + ".radius")
        else:
            radius: Dict[str, Any] = {}
            allowed = ("enabled", "value_px")
            for key in radius_src:
                if key not in allowed:
                    rejected.append("%s.radius.%s" % (path, key))
            if require_full:
                for key in allowed:
                    if key not in radius_src:
                        rejected.append("%s.radius.%s" % (path, key))
            if "enabled" in radius_src:
                value = radius_src["enabled"]
                if isinstance(value, bool):
                    radius["enabled"] = value
                else:
                    rejected.append(path + ".radius.enabled")
            if "value_px" in radius_src:
                value = radius_src["value_px"]
                if isinstance(value, int) and not isinstance(value, bool) and 2 <= value <= 18:
                    radius["value_px"] = value
                else:
                    rejected.append(path + ".radius.value_px")
            if radius or require_full:
                out["radius"] = radius

    return out


def _percent_patch(value: Any) -> Any:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return _KEEP
    number = float(value)
    if 0.0 <= number <= 1.0:
        number *= 100.0
    number = int(round(number))
    return number if 10 <= number <= 100 else _KEEP


def _put_nested(target: Dict[str, Any], section: str, lane: str, values: Dict[str, Any]) -> None:
    if not values:
        return
    node = target.setdefault(section, {})
    if lane:
        node.setdefault(lane, {}).update(values)
    else:
        node.update(values)


def _map_flat_style(
    key: str,
    value: Any,
    global_style: Dict[str, Any],
) -> None:
    target = "text_color" if key == "color" else key
    if target not in STYLE_FIELDS:
        return
    if target in _STYLE_COLOR_FIELDS:
        cleaned = _strict_color(value)
    elif target in ("bg_opacity", "opacity"):
        cleaned = _percent_patch(value)
    elif target == "font_size":
        cleaned = value if isinstance(value, int) and not isinstance(value, bool) and 12 <= value <= 48 else _KEEP
    elif target == "font_weight":
        cleaned = (
            value
            if isinstance(value, int)
            and not isinstance(value, bool)
            and value in (400, 500, 600, 700, 800)
            else _KEEP
        )
    elif target == "outline_width":
        cleaned = value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 6 else _KEEP
    elif target in _STYLE_BOOL_FIELDS:
        cleaned = value if isinstance(value, bool) else _KEEP
    else:
        cleaned = _KEEP
    if cleaned is not _KEEP:
        global_style[target] = cleaned


def _clean_legacy_overlay_patch(src: Dict[str, Any], rejected: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    has_legacy_animation = "animation" in src
    has_legacy_typography = "font_family" in src or "line_height" in src
    for key in _OVERLAY_BOOL_KEYS:
        if key in src:
            cleaned = _bool(src[key])
            if cleaned is _KEEP:
                rejected.append("overlay." + key)
            else:
                out[key] = cleaned
    for key, (low, high) in _OVERLAY_INT_RANGES.items():
        if key in src:
            cleaned = _int(src[key], low, high)
            if cleaned is _KEEP:
                rejected.append("overlay." + key)
            else:
                out[key] = cleaned
    for key, (low, high) in _OVERLAY_FLOAT_RANGES.items():
        if key in src:
            cleaned = _float(src[key], low, high)
            if cleaned is _KEEP:
                rejected.append("overlay." + key)
            else:
                out[key] = cleaned
    if "font_family" in src:
        cleaned = _limited_text(src["font_family"], 120)
        if cleaned is _KEEP:
            rejected.append("overlay.font_family")
        else:
            out["font_family"] = cleaned
    if "font_weight" in src:
        cleaned = _int(src["font_weight"], 300, 900)
        if cleaned is _KEEP or cleaned not in (300, 400, 500, 600, 700, 800, 900):
            rejected.append("overlay.font_weight")
        else:
            out["font_weight"] = cleaned
    if "name_sep" in src:
        cleaned = _limited_text(src["name_sep"], 4)
        if cleaned is _KEEP:
            rejected.append("overlay.name_sep")
        else:
            out["name_sep"] = cleaned
    for key in _OVERLAY_COLOR_KEYS:
        if key in src:
            cleaned = _color(src[key])
            if cleaned is _KEEP:
                rejected.append("overlay." + key)
            else:
                out[key] = cleaned
    for key, choices in _OVERLAY_CHOICES.items():
        if key in src:
            value = src[key]
            if not isinstance(value, str) or value not in choices:
                rejected.append("overlay." + key)
            else:
                out[key] = value
    # motion 只写 legacy sidecar。旧设置页会回传 animation；此时同包的
    # motion / resolved_motion 是只读投影，必须忽略，不能覆盖新工作台。
    if "motion" in src:
        if has_legacy_animation:
            pass
        else:
            cleaned = _clean_motion_patch(src["motion"], "overlay.motion", rejected)
            if cleaned:
                out["motion"] = cleaned
    if "resolved_motion" in src:
        # 纯只读投影；无论来源都忽略。
        pass
    if "resolved" in src:
        # get_overlay_config 的样式投影；旧页面回传时忽略。
        pass
    if "typography" in src:
        if has_legacy_typography:
            pass
        else:
            cleaned = _clean_typography_patch(src["typography"], "overlay.typography", rejected)
            if cleaned:
                out["typography"] = cleaned
    if "resolved_typography" in src:
        # 纯只读投影；无论来源都忽略。
        pass
    if "types" in src:
        types_src = src["types"]
        if not isinstance(types_src, dict):
            rejected.append("overlay.types")
        else:
            types: Dict[str, bool] = {}
            for key in OVERLAY_TYPES:
                if key in types_src:
                    value = types_src[key]
                    if isinstance(value, bool):
                        types[key] = value
                    else:
                        rejected.append("overlay.types." + key)
            for key in types_src:
                if key not in OVERLAY_TYPES:
                    rejected.append("overlay.types." + str(key))
            if types:
                out["types"] = types
    for key in src:
        if key not in _OVERLAY_KEYS and key not in (
            "geometry",
            "styles",
            "pins",
            "motion",
            "resolved_motion",
            "resolved",
            "typography",
            "resolved_typography",
        ):
            rejected.append("overlay." + str(key))
    return out


def _process_overlay_patch(src: Any, rejected: List[str]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    canonical: Dict[str, Any] = {}
    if not isinstance(src, dict):
        rejected.append("overlay")
        return canonical, {}
    legacy = _clean_legacy_overlay_patch(src, rejected)

    if "enabled" in src:
        value = src["enabled"]
        if not isinstance(value, bool):
            rejected.append("overlay.enabled")
        else:
            canonical["enabled"] = value
    if "geometry" in src:
        geometry = _clean_geometry_patch(src["geometry"], "overlay.geometry", rejected)
        if geometry:
            canonical["geometry"] = geometry
    if "styles" in src:
        styles = _clean_styles_patch(src["styles"], "overlay.styles", rejected)
        if styles:
            canonical["styles"] = styles
    if "pins" in src:
        pins = _clean_pins_patch(src["pins"], "overlay.pins", rejected)
        if pins:
            canonical["pins"] = pins

    # 旧扁平字段同时投影到 v2，便于现有调用方渐进迁移。
    geometry_flat: Dict[str, Any] = {}
    for key in ("x", "y", "width", "height", "scale"):
        if key not in src or key not in legacy:
            continue
        value = src[key]
        if key in ("x", "y"):
            ranges = (-10000, 10000)
        elif key == "width":
            ranges = (200, 3840)
        elif key == "height":
            ranges = (200, 2160)
        else:
            ranges = (0.5, 4.0)
        if key == "scale":
            if isinstance(value, (int, float)) and not isinstance(value, bool) and ranges[0] <= float(value) <= ranges[1]:
                geometry_flat[key] = float(value)
        elif isinstance(value, int) and not isinstance(value, bool) and ranges[0] <= value <= ranges[1]:
            geometry_flat[key] = value
    if geometry_flat:
        canonical.setdefault("geometry", {}).update(geometry_flat)

    if "theme" in legacy:
        canonical.setdefault("styles", {})["theme"] = legacy["theme"]
    global_style: Dict[str, Any] = {}
    for key in ("font_size", "font_weight", "color", "name_color", "bg_color", "bg_opacity", "opacity",
                "outline", "outline_color", "outline_width", "shadow", "badge_color"):
        if key in legacy:
            _map_flat_style(key, legacy[key], global_style)
    if global_style:
        canonical.setdefault("styles", {}).setdefault("global", {}).update(global_style)

    if "gift_pin" in legacy or "gift_pin_position" in legacy or "gift_pin_duration_ms" in legacy \
            or "gift_pin_max" in legacy or "gift_pin_min_price" in legacy:
        gift: Dict[str, Any] = {}
        if "gift_pin" in legacy:
            gift["enabled"] = legacy["gift_pin"]
        if "gift_pin_position" in legacy and legacy["gift_pin_position"] in ("top", "bottom"):
            gift["position"] = legacy["gift_pin_position"]
        if "gift_pin_duration_ms" in legacy and 0 <= legacy["gift_pin_duration_ms"] <= 30000:
            gift["duration_ms"] = legacy["gift_pin_duration_ms"]
        if "gift_pin_max" in legacy and 0 <= legacy["gift_pin_max"] <= 6:
            gift["max"] = legacy["gift_pin_max"]
        if "gift_pin_min_price" in legacy and 0 <= legacy["gift_pin_min_price"] <= 100000:
            gift["min_price"] = legacy["gift_pin_min_price"]
        if gift:
            canonical.setdefault("pins", {}).setdefault("gift", {}).update(gift)
    return canonical, legacy


def _clean_legacy_top_patch(patch: Dict[str, Any], rejected: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if "room_id" in patch:
        value = _int(patch["room_id"], 0, 10 ** 12)
        if value is _KEEP:
            rejected.append("room_id")
        else:
            out["room_id"] = value
    if "platform" in patch:
        value = str(patch["platform"] or "").strip().lower()
        if value not in ("bilibili", "douyin"):
            rejected.append("platform")
        else:
            out["platform"] = value
    if "sessdata" in patch:
        value = _text(patch["sessdata"], 512)
        if value is _KEEP:
            rejected.append("sessdata")
        else:
            out["sessdata"] = value

    src = patch.get("tts")
    if isinstance(src, dict):
        tts: Dict[str, Any] = {}
        if "enabled" in src:
            value = _bool(src["enabled"])
            if value is _KEEP:
                rejected.append("tts.enabled")
            else:
                tts["enabled"] = value
        if "voice" in src:
            value = _text(src["voice"], 128)
            if value is _KEEP or not value.strip():
                rejected.append("tts.voice")
            else:
                tts["voice"] = value.strip()
        for key, unit in (("rate", "%"), ("volume", "%"), ("pitch", "Hz")):
            if key in src:
                regex = _HZ_RE if unit == "Hz" else _PCT_RE
                value = _signed_value(src[key], regex, unit)
                if value is _KEEP:
                    rejected.append("tts." + key)
                else:
                    tts[key] = value
        if tts:
            out["tts"] = tts
    elif "tts" in patch:
        rejected.append("tts")

    src = patch.get("read")
    if isinstance(src, dict):
        read: Dict[str, Any] = {}
        for key in _READ_BOOL_KEYS:
            if key in src:
                value = _bool(src[key])
                if value is _KEEP:
                    rejected.append("read." + key)
                else:
                    read[key] = value
        if "gift_min_price" in src:
            value = _int(src["gift_min_price"], 0, 10 ** 9)
            if value is _KEEP:
                rejected.append("read.gift_min_price")
            else:
                read["gift_min_price"] = value
        tpl_src = src.get("templates")
        if isinstance(tpl_src, dict):
            templates: Dict[str, Any] = {}
            for key in _TEMPLATE_KEYS:
                if key in tpl_src:
                    value = _text(tpl_src[key], 512)
                    if value is _KEEP:
                        rejected.append("read.templates." + key)
                    else:
                        templates[key] = value
            if templates:
                read["templates"] = templates
        if read:
            out["read"] = read
    elif "read" in patch:
        rejected.append("read")

    src = patch.get("filters")
    if isinstance(src, dict):
        filters: Dict[str, Any] = {}
        if "blacklist" in src:
            value = src["blacklist"]
            if isinstance(value, str):
                value = [value]
            if isinstance(value, (list, tuple)):
                items: List[str] = []
                for item in value:
                    text = _text(item, 256)
                    if text is _KEEP:
                        rejected.append("filters.blacklist")
                        break
                    text = text.strip()
                    if text:
                        items.append(text)
                else:
                    filters["blacklist"] = items
            else:
                rejected.append("filters.blacklist")
        for key, low, high in (("dedup_seconds", 0.0, 3600.0), ("user_cooldown", 0.0, 3600.0),
                               ("global_cooldown", 0.0, 3600.0)):
            if key in src:
                value = _float(src[key], low, high)
                if value is _KEEP:
                    rejected.append("filters." + key)
                else:
                    filters[key] = value
        if "max_len" in src:
            value = _int(src["max_len"], 1, 1000)
            if value is _KEEP:
                rejected.append("filters.max_len")
            else:
                filters["max_len"] = value
        if filters:
            out["filters"] = filters
    elif "filters" in patch:
        rejected.append("filters")

    src = patch.get("queue")
    if isinstance(src, dict):
        if "max_size" in src:
            value = _int(src["max_size"], 1, 10000)
            if value is _KEEP:
                rejected.append("queue.max_size")
            else:
                out["queue"] = {"max_size": value}
    elif "queue" in patch:
        rejected.append("queue")

    src = patch.get("mock")
    if isinstance(src, dict):
        mock_cfg: Dict[str, Any] = {}
        for key, (low, high) in _MOCK_INT_RANGES.items():
            if key in src:
                value = _int(src[key], low, high)
                if value is _KEEP:
                    rejected.append("mock." + key)
                else:
                    mock_cfg[key] = value
        if "speak" in src:
            value = _bool(src["speak"])
            if value is _KEEP:
                rejected.append("mock.speak")
            else:
                mock_cfg["speak"] = value
        if "types" in src:
            types_src = src["types"]
            if not isinstance(types_src, dict):
                rejected.append("mock.types")
            else:
                types_cfg: Dict[str, bool] = {}
                for key in _MOCK_TYPE_KEYS:
                    if key in types_src:
                        value = types_src[key]
                        if isinstance(value, bool):
                            types_cfg[key] = value
                        else:
                            rejected.append("mock.types." + key)
                for key in types_src:
                    if key not in _MOCK_TYPE_KEYS:
                        rejected.append("mock.types." + str(key))
                if types_cfg:
                    mock_cfg["types"] = types_cfg
        for key in src:
            if key not in ("interval_ms", "per_tick", "speak", "types"):
                rejected.append("mock." + str(key))
        if mock_cfg:
            out["mock"] = mock_cfg
    elif "mock" in patch:
        rejected.append("mock")
    return out


def _clean_patch_parts(
    patch: Dict[str, Any], rejected: List[str]
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    canonical: Dict[str, Any] = {}
    if not isinstance(patch, dict):
        return canonical, {}, {}

    if "appearance" in patch:
        # 外观必须走 update_appearance()/set_appearance()，保证整体校验与原子保存。
        rejected.append("appearance: 请使用外观专用保存接口")

    overlay_src: Dict[str, Any] = {}
    if "styles" in patch:
        overlay_src["styles"] = patch["styles"]
    if "pins" in patch:
        overlay_src["pins"] = patch["pins"]
    if "overlay" in patch:
        if isinstance(patch["overlay"], dict):
            overlay_src = deep_merge(overlay_src, patch["overlay"])
        else:
            rejected.append("overlay")
    overlay_canonical, legacy_overlay = _process_overlay_patch(overlay_src, rejected)
    if overlay_canonical:
        canonical["overlay"] = overlay_canonical

    if "monitor" in patch:
        src = patch["monitor"]
        if not isinstance(src, dict):
            rejected.append("monitor")
        else:
            monitor: Dict[str, Any] = {}
            for key, value in src.items():
                path = "monitor." + key
                if key == "font_px":
                    cleaned = (
                        None
                        if value is None
                        else value
                        if isinstance(value, int) and not isinstance(value, bool) and value in (13, 15, 17, 19, 20, 25, 30, 40, 50)
                        else _KEEP
                    )
                elif key == "ui_size":
                    cleaned = value if value in ("small", "medium", "large", "xlarge") else _KEEP
                elif key == "mode":
                    cleaned = value if value in ("auto", "single_line", "two_line") else _KEEP
                elif key == "columns":
                    if (
                        isinstance(value, list)
                        and 1 <= len(value) <= 6
                        and all(isinstance(item, str) for item in value)
                        and all(item in ("time", "type", "user", "content", "value", "status") for item in value)
                        and len(set(value)) == len(value)
                    ):
                        cleaned = list(value)
                    else:
                        cleaned = _KEEP
                elif key == "geometry":
                    cleaned = _clean_geometry_patch(value, path, rejected, monitor=True)
                    if not cleaned:
                        continue
                else:
                    rejected.append(path)
                    continue
                if cleaned is _KEEP:
                    rejected.append(path)
                else:
                    monitor[key] = cleaned
            if monitor:
                canonical["monitor"] = monitor

    if "hotkeys" in patch:
        rejected.append("hotkeys: 快捷键系统已移除")

    if "schema_version" in patch:
        rejected.append("schema_version")

    legacy_top = _clean_legacy_top_patch(patch, rejected)
    for key in patch:
        if key not in _KNOWN_TOP_KEYS:
            rejected.append(str(key))
    return canonical, legacy_top, legacy_overlay


def _clean_patch(patch: Dict[str, Any], rejected: List[str]) -> Dict[str, Any]:
    canonical, _legacy_top, _legacy_overlay = _clean_patch_parts(patch, rejected)
    return canonical


# --------------------------------------------------------------------- 迁移
class ConfigMigrationError(RuntimeError):
    """迁移失败：调用方必须保留原文件并进入只读安全模式。"""


def _legacy_percent(value: Any, fallback: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    number = float(value)
    if 0.0 <= number <= 1.0:
        number *= 100.0
    return max(10, min(100, int(round(number))))


def _nearest_weight(value: Any, fallback: int) -> int | None:
    allowed = (400, 500, 600, 700, 800)
    if isinstance(value, int) and not isinstance(value, bool):
        if value in allowed:
            return value
        return min(allowed, key=lambda item: abs(item - value))
    return fallback


def _migrate_global_style(overlay: Dict[str, Any], theme: str) -> Dict[str, Any]:
    preset = THEME_PRESETS.get(theme, THEME_PRESETS["classic"])
    nested = None
    styles = overlay.get("styles")
    if isinstance(styles, dict) and isinstance(styles.get("global"), dict):
        nested = styles["global"]

    old_keys = {
        "font_size": "font_size",
        "font_weight": "font_weight",
        "text_color": "color",
        "name_color": "name_color",
        "bg_color": "bg_color",
        "bg_opacity": "bg_opacity",
        "opacity": "opacity",
        "outline": "outline",
        "outline_color": "outline_color",
        "outline_width": "outline_width",
        "shadow": "shadow",
        "badge_color": "badge_color",
    }
    result: Dict[str, Any] = {}
    for field in STYLE_FIELDS:
        if nested is not None and field in nested:
            raw = nested[field]
            if raw is None:
                result[field] = None
                continue
        else:
            old_key = old_keys[field]
            raw = overlay.get(old_key, preset.get(field))
            if old_key not in overlay and field == "badge_color":
                result[field] = None
                continue

        if field in _STYLE_COLOR_FIELDS:
            cleaned = _strict_color(raw)
            result[field] = cleaned if cleaned is not _KEEP else preset.get(field)
        elif field in ("bg_opacity", "opacity"):
            result[field] = _legacy_percent(raw, int(preset.get(field, 100)))
        elif field == "font_size":
            cleaned = _int(raw, 12, 48)
            result[field] = cleaned if cleaned is not _KEEP else int(preset["font_size"])
        elif field == "font_weight":
            if isinstance(raw, int) and not isinstance(raw, bool) and raw == preset.get("font_weight") \
                    and raw not in (400, 500, 600, 700):
                result[field] = None
            else:
                result[field] = _nearest_weight(raw, int(preset["font_weight"]))
        elif field == "outline_width":
            cleaned = _int(raw, 0, 6)
            result[field] = cleaned if cleaned is not _KEEP else int(preset["outline_width"])
        elif field in _STYLE_BOOL_FIELDS:
            result[field] = raw if isinstance(raw, bool) else bool(preset[field])
        else:
            result[field] = preset.get(field)
    return result


def _migrate_geometry(overlay: Dict[str, Any]) -> Dict[str, Any]:
    nested = overlay.get("geometry")
    if isinstance(nested, dict):
        source = deep_merge(
            {"x": 60, "y": 120, "width": 520, "height": 620, "scale": 1.0},
            nested,
        )
    else:
        source = {
            "x": overlay.get("x", 60),
            "y": overlay.get("y", 120),
            "width": overlay.get("width", 520),
            "height": overlay.get("height", 620),
            "scale": overlay.get("scale", 1.0),
        }
    x = _int(source.get("x", 60), -10000, 10000)
    y = _int(source.get("y", 120), -10000, 10000)
    width = _int(source.get("width", 520), 200, 3840)
    height = _int(source.get("height", 620), 200, 2160)
    scale = _float(source.get("scale", 1.0), 0.5, 4.0)
    return {
        "x": x if x is not _KEEP else 60,
        "y": y if y is not _KEEP else 120,
        "width": width if width is not _KEEP else 520,
        "height": height if height is not _KEEP else 620,
        "scale": scale if scale is not _KEEP else 1.0,
    }


def _migrate_pins(overlay: Dict[str, Any]) -> Dict[str, Any]:
    pins = copy.deepcopy(DEFAULT_CONFIG["overlay"]["pins"])
    nested = overlay.get("pins")
    if isinstance(nested, dict):
        pins = deep_merge(pins, nested)

    gift = pins["gift"]
    if "gift_pin" in overlay:
        gift["enabled"] = bool(overlay.get("gift_pin"))
    if overlay.get("gift_pin_position") in ("top", "bottom"):
        gift["position"] = overlay["gift_pin_position"]
    duration = _int(overlay.get("gift_pin_duration_ms", gift["duration_ms"]), 0, 30000)
    gift["duration_ms"] = duration if duration is not _KEEP else gift["duration_ms"]
    maximum = _int(overlay.get("gift_pin_max", gift["max"]), 0, 6)
    gift["max"] = maximum if maximum is not _KEEP else gift["max"]
    min_price = _float(overlay.get("gift_pin_min_price", gift["min_price"]), 0, 100000)
    if min_price is not _KEEP:
        gift["min_price"] = min_price
    pins["gift"] = gift
    return pins


def _migrate_monitor(raw: Dict[str, Any]) -> Dict[str, Any]:
    source = raw.get("monitor")
    if not isinstance(source, dict):
        return copy.deepcopy(DEFAULT_CONFIG["monitor"])
    merged = deep_merge(DEFAULT_CONFIG["monitor"], source)
    # 保留严格结构，非法值留给 validate_config 报错并触发回滚。
    return merged


def _migrate_v1(raw: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    if not isinstance(raw, dict):
        raise ConfigMigrationError("配置顶层不是对象")
    overlay = raw.get("overlay", {})
    if not isinstance(overlay, dict):
        raise ConfigMigrationError("overlay 不是对象")

    theme = overlay.get("theme", "classic")
    styles_node = overlay.get("styles")
    if isinstance(styles_node, dict) and isinstance(styles_node.get("theme"), str):
        theme = styles_node["theme"]
    if theme not in THEME_PRESETS:
        theme = "classic"

    migrated_types: Dict[str, Any] = {kind: _null_style() for kind in OVERLAY_TYPES}
    if isinstance(styles_node, dict) and isinstance(styles_node.get("types"), dict):
        for kind, override in styles_node["types"].items():
            if kind in OVERLAY_TYPES and isinstance(override, dict):
                migrated_types[kind] = copy.deepcopy(override)

    current: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "appearance": copy.deepcopy(DEFAULT_APPEARANCE),
        "overlay": {
            "enabled": bool(overlay.get("enabled", False)),
            "geometry": _migrate_geometry(overlay),
            "styles": {
                "theme": theme,
                "global": _migrate_global_style(overlay, theme),
                "types": migrated_types,
            },
            "pins": _migrate_pins(overlay),
        },
        "monitor": _migrate_monitor(raw),
    }

    legacy = copy.deepcopy(raw)
    legacy.pop("schema_version", None)
    legacy.pop("monitor", None)
    legacy.pop("hotkeys", None)
    legacy["overlay"] = copy.deepcopy(overlay)
    legacy["sessdata"] = ""
    enc = str(raw.get("sessdata_enc") or "")
    if enc:
        legacy["sessdata_enc"] = enc
    elif raw.get("sessdata"):
        legacy["sessdata_enc"] = secrets_win.protect(str(raw.get("sessdata")))
    else:
        legacy["sessdata_enc"] = ""
    return current, legacy


def _migrate_v2(raw: Dict[str, Any]) -> Dict[str, Any]:
    """v2 -> v3：仅新增 appearance，原有四个规范段逐字段保留。"""
    if not isinstance(raw, dict):
        raise ConfigMigrationError("配置顶层不是对象")
    return {
        "schema_version": SCHEMA_VERSION,
        "appearance": copy.deepcopy(DEFAULT_APPEARANCE),
        "overlay": copy.deepcopy(raw.get("overlay")),
        "monitor": copy.deepcopy(raw.get("monitor")),
    }


def _migration_needed(raw: Dict[str, Any]) -> bool:
    return raw.get("schema_version") != SCHEMA_VERSION


# --------------------------------------------------------------------- ConfigStore
class ConfigStore:
    """线程安全的 v3 配置读写器；同时维护 legacy 运行时视图。"""

    def __init__(self, base_dir: str):
        base = os.path.abspath(base_dir)
        self.path = os.path.join(base, "config.json")
        self.legacy_path = os.path.join(base, "config.legacy.json")
        self.backup_path = os.path.join(base, "config.v1.bak")
        self.v2_backup_path = os.path.join(base, "config.v2.bak")
        self.legacy_v1_backup_path = os.path.join(base, "config.legacy.v1.bak")
        self.legacy_v2_backup_path = os.path.join(base, "config.legacy.v2.bak")
        self.legacy_backup_path = os.path.join(base, "config.legacy.bak")
        self.unknown_backup_path = os.path.join(base, "config.unknown.bak")
        self.cleanup_backup_path = os.path.join(base, "config.cleanup.bak")
        self.transaction_path = os.path.join(base, "config.save.txn")
        self._lock = threading.RLock()
        self._data: Dict[str, Any] = deep_merge(DEFAULT_LEGACY_CONFIG, DEFAULT_CONFIG)
        self._legacy_doc: Dict[str, Any] = {}
        self._legacy_overlay: Dict[str, Any] = copy.deepcopy(DEFAULT_LEGACY_OVERLAY)
        self._sessdata_token_original = ""
        self._sessdata_plain_original = ""
        self._credential_decrypt_failed = False
        self._read_only = False
        self._migration_status: Dict[str, Any] = {
            "from": None,
            "to": SCHEMA_VERSION,
            "state": "idle",
            "backup_path": None,
            "error": None,
        }
        self.load()

    @property
    def is_read_only(self) -> bool:
        return self._read_only

    def migration_status(self) -> Dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._migration_status)

    def get_sessdata_enc(self) -> str:
        with self._lock:
            return self._effective_sessdata_token_locked()

    def credential_status(self) -> Dict[str, Any]:
        """返回凭证加密状态，不暴露 token 或明文。"""
        with self._lock:
            tokens = []
            sess_token = self._effective_sessdata_token_locked()
            if sess_token:
                tokens.append(("sessdata", sess_token))
            cookie_token = str(
                self._legacy_doc.get("douyin_cookie_enc")
                or self._data.get("douyin_cookie_enc")
                or ""
            )
            if cookie_token:
                tokens.append(("douyin_cookie", cookie_token))
            stored_tokens = []
            if self._sessdata_token_original:
                stored_tokens.append(("sessdata", self._sessdata_token_original))
            elif sess_token:
                stored_tokens.append(("sessdata", sess_token))
            if cookie_token:
                stored_tokens.append(("douyin_cookie", cookie_token))
            decrypt_failed = bool(self._credential_decrypt_failed)
            if not decrypt_failed:
                for _name, token in tokens:
                    if secrets_win.is_encoded_token(token):
                        _plain, failed = secrets_win.unprotect_ex(token)
                        decrypt_failed = decrypt_failed or failed
            plaintext_fallback = any(
                secrets_win.is_plaintext_fallback_token(token) or
                secrets_win.is_unprefixed_plaintext_token(token)
                for _name, token in stored_tokens
            )
            storage = secrets_win.storage_status()
            if not storage["dpapi_available"]:
                plaintext_fallback = True
            if decrypt_failed:
                state = "decrypt_failed"
                message = (
                    "登录凭证无法解密。已保持只读，不会清空原密文或覆盖配置文件；"
                    "请重新登录或从配置备份恢复。"
                )
            elif plaintext_fallback:
                state = "plaintext_fallback"
                message = (
                    "系统安全存储不可用，登录凭证以可逆编码保存在本机。"
                    "请勿分享配置文件；在 Windows 用户账户下重新登录可恢复系统加密。"
                )
            elif self._read_only:
                state = "read_only"
                message = "配置处于只读安全模式，登录凭证不会写入或覆盖。"
            else:
                state = "ok"
                message = ""
            return {
                "state": state,
                "warning": bool(message),
                "message": message,
                "dpapi_available": bool(storage["dpapi_available"]),
                "plaintext_fallback": bool(plaintext_fallback),
                "decrypt_failed": bool(decrypt_failed),
                "read_only": bool(self._read_only),
                "token_count": len(tokens),
                "error": bool(storage.get("last_error")),
            }

    # ------------------------------------------------------------------ IO
    @staticmethod
    def _atomic_write_text(path: str, text: str) -> None:
        tmp = path + ".tmp"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except Exception:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            raise

    @classmethod
    def _atomic_write_bytes(cls, path: str, data: bytes) -> None:
        tmp = path + ".tmp"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            with open(tmp, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except Exception:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            raise

    @staticmethod
    def _dump_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, indent=2) + "\n"

    def _read_legacy_sidecar(self) -> Tuple[Dict[str, Any], str]:
        """读取 legacy sidecar；存在但损坏时返回错误，调用方必须 fail closed。"""
        if not os.path.isfile(self.legacy_path):
            return {}, ""
        try:
            with open(self.legacy_path, "r", encoding="utf-8-sig") as handle:
                loaded = json.load(handle)
            if not isinstance(loaded, dict):
                return {}, "config.legacy.json 顶层不是对象"
            return loaded, ""
        except Exception as exc:  # noqa: BLE001
            logger.warning("读取 config.legacy.json 失败：%s", exc)
            return {}, str(exc)

    def _recover_pending_transaction(self) -> bool:
        """Recover a two-file save that was interrupted between replacements."""
        if not os.path.isfile(self.transaction_path):
            return False
        try:
            with open(self.transaction_path, "r", encoding="utf-8-sig") as handle:
                payload = json.load(handle)
            if not isinstance(payload, dict) or payload.get("version") != 1:
                raise ValueError("未知的配置事务格式")
            config_text = payload.get("config")
            legacy_text = payload.get("legacy")
            if not isinstance(config_text, str) or not isinstance(legacy_text, str):
                raise ValueError("配置事务缺少文件内容")
            if not isinstance(json.loads(config_text), dict):
                raise ValueError("事务中的 config.json 不是对象")
            if not isinstance(json.loads(legacy_text), dict):
                raise ValueError("事务中的 legacy sidecar 不是对象")
            self._atomic_write_text(self.legacy_path, legacy_text)
            self._atomic_write_text(self.path, config_text)
            os.remove(self.transaction_path)
            logger.warning("已恢复上次中断的配置双文件写入")
            return True
        except Exception as exc:  # noqa: BLE001
            logger.error("配置事务恢复失败，保持只读：%s", exc)
            self._read_only = True
            return False

    @staticmethod
    def _secret_decrypt_failure(raw: Dict[str, Any], legacy: Dict[str, Any]) -> bool:
        tokens = [
            str((raw or {}).get("sessdata_enc") or ""),
            str((raw or {}).get("douyin_cookie_enc") or ""),
            str((legacy or {}).get("sessdata_enc") or ""),
            str((legacy or {}).get("douyin_cookie_enc") or ""),
        ]
        for token in tokens:
            if not token:
                continue
            if secrets_win.is_encoded_token(token):
                _plain, failed = secrets_win.unprotect_ex(token)
                if failed:
                    return True
        return False

    def _legacy_backup_path_for_version(self, version: Any) -> str:
        if version == 2:
            return self.legacy_v2_backup_path
        if version in (None, 1):
            return self.legacy_v1_backup_path
        return self.legacy_backup_path

    def _set_secret(self, token: str, plain_fallback: str = "") -> None:
        token = str(token or "")
        if token:
            plain, failed = secrets_win.unprotect_ex(token)
        else:
            plain = str(plain_fallback or "")
            failed = False
        self._sessdata_token_original = token
        self._sessdata_plain_original = plain
        self._data["sessdata"] = plain
        self._credential_decrypt_failed = bool(failed)

    def get_douyin_cookie(self) -> str:
        """读取抖音登录 Cookie；sidecar 中只保存 DPAPI 密文。"""
        with self._lock:
            token = str(self._legacy_doc.get("douyin_cookie_enc") or "")
            if not token:
                token = str(self._data.get("douyin_cookie_enc") or "")
        return secrets_win.unprotect(token)

    def set_douyin_cookie(self, cookie: str) -> bool:
        """写入/清除抖音 Cookie；写盘失败时回滚内存。"""
        token = secrets_win.protect(str(cookie or ""))
        with self._lock:
            old_legacy = copy.deepcopy(self._legacy_doc)
            if token:
                self._legacy_doc["douyin_cookie_enc"] = token
            else:
                self._legacy_doc.pop("douyin_cookie_enc", None)
            if not self._save_locked():
                self._legacy_doc = old_legacy
                return False
        return True

    def _effective_sessdata_token_locked(self) -> str:
        current = str(self._data.get("sessdata") or "")
        if self._sessdata_token_original and current == self._sessdata_plain_original:
            if secrets_win.is_encoded_token(self._sessdata_token_original):
                return self._sessdata_token_original
            return secrets_win.protect(current)
        if not current:
            return ""
        return secrets_win.protect(current)

    def _load_common(
        self,
        canonical: Dict[str, Any],
        legacy_doc: Dict[str, Any],
        plain_fallback: str = "",
    ) -> None:
        self._legacy_doc = copy.deepcopy(legacy_doc) if isinstance(legacy_doc, dict) else {}
        mock_doc = self._legacy_doc.get("mock")
        if isinstance(mock_doc, dict):
            try:
                speak_version = int(mock_doc.get("speak_version") or 1)
            except (TypeError, ValueError):
                speak_version = 1
            if speak_version < 2:
                # v2：自动模拟默认进入真实朗读，只迁移一次。
                mock_doc = copy.deepcopy(mock_doc)
                mock_doc["speak"] = True
                mock_doc["speak_version"] = 2
                self._legacy_doc["mock"] = mock_doc
        overlay = self._legacy_doc.get("overlay")
        self._legacy_overlay = deep_merge(
            DEFAULT_LEGACY_OVERLAY,
            overlay if isinstance(overlay, dict) else {},
        )
        # 旧配置没有 motion 时，用 sidecar 的 animation 生成一次 seed。
        raw_motion = overlay.get("motion") if isinstance(overlay, dict) else None
        if isinstance(raw_motion, dict) and isinstance(raw_motion.get("global"), dict):
            self._legacy_overlay["motion"] = normalize_motion(raw_motion)
        else:
            self._legacy_overlay["motion"] = motion_from_legacy(
                overlay.get("animation") if isinstance(overlay, dict) else None
            )
        raw_typography = overlay.get("typography") if isinstance(overlay, dict) else None
        if isinstance(raw_typography, dict) and isinstance(raw_typography.get("global"), dict):
            self._legacy_overlay["typography"] = normalize_typography(raw_typography)
        else:
            theme = "classic"
            canonical_overlay = canonical.get("overlay") if isinstance(canonical, dict) else None
            canonical_styles = (
                canonical_overlay.get("styles")
                if isinstance(canonical_overlay, dict) and isinstance(canonical_overlay.get("styles"), dict)
                else {}
            )
            legacy_theme = (
                self._legacy_overlay.get("theme")
                if isinstance(self._legacy_overlay, dict)
                else None
            )
            theme = canonical_styles.get("theme") or legacy_theme or "classic"
            if theme not in THEME_PRESETS:
                theme = "classic"
            self._legacy_overlay["typography"] = typography_from_legacy(
                self._legacy_overlay,
                theme,
            )
        data = deep_merge(DEFAULT_LEGACY_CONFIG, DEFAULT_CONFIG)
        data = deep_merge(data, canonical_config(canonical))
        for key, value in self._legacy_doc.items():
            if key in (
                "overlay",
                "sessdata",
                "sessdata_enc",
                "douyin_cookie_enc",
                "schema_version",
                "appearance",
                "monitor",
                "hotkeys",
            ):
                continue
            data[key] = copy.deepcopy(value)
        self._data = data
        token = str(self._legacy_doc.get("sessdata_enc") or "")
        if not token:
            token = str(canonical.get("sessdata_enc") or "")
        self._set_secret(token, plain_fallback)

    def _strip_copied_global_runtime(self) -> None:
        """Hide a full legacy theme snapshot from the in-memory view only."""
        try:
            overlay = self._data.get("overlay") if isinstance(self._data.get("overlay"), dict) else {}
            styles = overlay.get("styles") if isinstance(overlay.get("styles"), dict) else {}
            if is_copied_theme_global(styles.get("global")):
                styles["global"] = {}
        except Exception:
            logger.debug("清理运行时全局样式失败", exc_info=True)

    def _backup_path_for_version(self, version: Any) -> str:
        if version == 2:
            return self.v2_backup_path
        if version in (None, 1):
            return self.backup_path
        return self.unknown_backup_path

    @staticmethod
    def _read_bytes_if_exists(path: str):
        if not os.path.isfile(path):
            return None
        with open(path, "rb") as handle:
            return handle.read()

    def _restore_after_failed_migration(
        self,
        raw_bytes: bytes,
        legacy_bytes,
        migration_created_legacy: bool,
    ) -> None:
        try:
            self._atomic_write_bytes(self.path, raw_bytes)
            if legacy_bytes is not None:
                self._atomic_write_bytes(self.legacy_path, legacy_bytes)
            elif migration_created_legacy and os.path.isfile(self.legacy_path):
                os.remove(self.legacy_path)
        except Exception as exc:  # noqa: BLE001
            logger.error("恢复迁移前配置失败：%s", exc)

    @staticmethod
    def _fallback_view(raw: Dict[str, Any], version: Any) -> Dict[str, Any]:
        """迁移失败时只提供可安全运行的内存视图，不写回磁盘。"""
        if version in (None, 1):
            return _legacy_view_as_v2(raw)
        if version == 2:
            try:
                candidate = _migrate_v2(raw)
                if not validate_config(candidate):
                    return candidate
            except Exception:  # noqa: BLE001
                pass
        return copy.deepcopy(DEFAULT_CONFIG)

    def _cleanup_removed_current_fields(self, raw: Dict[str, Any]) -> None:
        """清理当前 v3 中已移除的字段；凭证只迁入 sidecar，不写回主配置。"""
        removable = ("hotkeys", "sessdata", "sessdata_enc", "douyin_cookie_enc")
        if not any(key in raw for key in removable):
            return
        try:
            sanitized = copy.deepcopy(raw)
            for key in ("sessdata", "sessdata_enc", "douyin_cookie_enc"):
                sanitized.pop(key, None)
            backup = (json.dumps(sanitized, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            self._atomic_write_bytes(self.cleanup_backup_path, backup)
            if not self._save_locked():
                raise RuntimeError("清理后配置写入失败")
            logger.info(
                "已清理 config.json 中已移除字段，备份：%s",
                self.cleanup_backup_path,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("清理 config.json 旧字段失败，保留原文件：%s", exc)

    def load(self) -> Dict[str, Any]:
        """读取配置；旧版本先备份、迁移、校验，全部成功后才原子替换。"""
        with self._lock:
            self._recover_pending_transaction()
            if not os.path.isfile(self.path):
                legacy_doc, legacy_error = self._read_legacy_sidecar()
                if legacy_doc:
                    plain_raw = str(legacy_doc.get("sessdata") or "")
                    try:
                        migrated, migrated_legacy = _migrate_v1(legacy_doc)
                        errors = validate_config(migrated)
                        if errors:
                            raise ConfigMigrationError("; ".join(errors[:8]))
                        self._load_common(migrated, migrated_legacy, plain_raw)
                        self._read_only = False
                        self._migration_status = {
                            "from": None,
                            "to": SCHEMA_VERSION,
                            "state": "recovered_legacy",
                            "backup_path": None,
                            "error": None,
                        }
                        if not self._save_current_only_locked():
                            self._read_only = True
                        else:
                            self._strip_copied_global_runtime()
                        return self.snapshot()
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("主配置缺失且 legacy sidecar 恢复失败，保持只读：%s", exc)
                        self._data = deep_merge(DEFAULT_LEGACY_CONFIG, DEFAULT_CONFIG)
                        self._legacy_doc = {}
                        self._legacy_overlay = copy.deepcopy(DEFAULT_LEGACY_OVERLAY)
                        self._set_secret("", "")
                        self._read_only = True
                        self._migration_status = {
                            "from": None,
                            "to": SCHEMA_VERSION,
                            "state": "failed",
                            "backup_path": None,
                            "error": "主配置缺失，legacy sidecar 恢复失败：%s" % exc,
                        }
                        return self.snapshot()
                self._data = deep_merge(DEFAULT_LEGACY_CONFIG, DEFAULT_CONFIG)
                self._legacy_doc = {}
                self._legacy_overlay = copy.deepcopy(DEFAULT_LEGACY_OVERLAY)
                self._set_secret("", "")
                self._read_only = False
                self._migration_status = {
                    "from": None,
                    "to": SCHEMA_VERSION,
                    "state": "defaults",
                    "backup_path": None,
                    "error": None,
                }
                self._save_locked()
                return self.snapshot()

            try:
                with open(self.path, "rb") as handle:
                    raw_bytes = handle.read()
                raw = json.loads(raw_bytes.decode("utf-8-sig"))
                if not isinstance(raw, dict):
                    raise ValueError("config.json 顶层不是对象")
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取 config.json 失败，进入只读默认配置：%s", exc)
                self._data = deep_merge(DEFAULT_LEGACY_CONFIG, DEFAULT_CONFIG)
                self._legacy_doc = {}
                self._legacy_overlay = copy.deepcopy(DEFAULT_LEGACY_OVERLAY)
                self._set_secret("", "")
                self._read_only = True
                self._migration_status = {
                    "from": None,
                    "to": SCHEMA_VERSION,
                    "state": "failed",
                    "backup_path": None,
                    "error": str(exc),
                }
                return self.snapshot()

            enc_raw = str(raw.get("sessdata_enc") or "")
            plain_raw = str(raw.get("sessdata") or "")
            raw_version = raw.get("schema_version", 1)
            if type(raw_version) is not int or raw_version < 1:
                backup_path = self.unknown_backup_path
                try:
                    self._atomic_write_bytes(backup_path, raw_bytes)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("写入非法版本备份失败：%s", exc)
                legacy_doc, legacy_error = self._read_legacy_sidecar()
                self._load_common(copy.deepcopy(DEFAULT_CONFIG), legacy_doc, plain_raw)
                self._read_only = True
                self._migration_status = {
                    "from": raw_version,
                    "to": SCHEMA_VERSION,
                    "state": "failed",
                    "backup_path": backup_path,
                    "error": "schema_version 必须是正整数；sidecar=%s"
                    % (legacy_error or "ok"),
                }
                return self.snapshot()

            from_version = raw_version
            try:
                legacy_bytes = self._read_bytes_if_exists(self.legacy_path)
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取 legacy sidecar 失败，进入只读安全模式：%s", exc)
                self._load_common(
                    self._fallback_view(raw, from_version),
                    raw if from_version == 1 else {},
                    plain_raw,
                )
                self._read_only = True
                self._migration_status = {
                    "from": from_version,
                    "to": SCHEMA_VERSION,
                    "state": "failed",
                    "backup_path": None,
                    "error": "无法读取 config.legacy.json：%s" % exc,
                }
                return self.snapshot()
            legacy_doc, legacy_error = self._read_legacy_sidecar()
            if legacy_error:
                logger.warning("legacy sidecar 损坏，进入只读安全模式：%s", legacy_error)
                if legacy_bytes is not None:
                    try:
                        self._atomic_write_bytes(self.legacy_backup_path, legacy_bytes)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("备份损坏 sidecar 失败：%s", exc)
                self._load_common(copy.deepcopy(DEFAULT_CONFIG), {}, plain_raw)
                self._read_only = True
                self._migration_status = {
                    "from": from_version,
                    "to": SCHEMA_VERSION,
                    "state": "failed",
                    "backup_path": self.legacy_backup_path if legacy_bytes is not None else None,
                    "error": "config.legacy.json 无法解析：%s" % legacy_error,
                }
                return self.snapshot()

            fallback_legacy = raw if from_version == 1 else legacy_doc

            if self._secret_decrypt_failure(raw, legacy_doc):
                logger.warning(
                    "登录凭证无法解密，保持原配置只读，不执行迁移或覆盖写盘",
                )
                self._load_common(
                    self._fallback_view(raw, from_version),
                    fallback_legacy,
                    plain_raw,
                )
                self._read_only = True
                self._credential_decrypt_failed = True
                self._migration_status = {
                    "from": from_version,
                    "to": SCHEMA_VERSION,
                    "state": "failed",
                    "backup_path": None,
                    "error": "登录凭证无法解密；为避免覆盖原密文，配置保持只读。",
                }
                return self.snapshot()

            if _migration_needed(raw):
                backup_path = self._backup_path_for_version(from_version)
                try:
                    self._atomic_write_bytes(backup_path, raw_bytes)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("写入迁移备份失败，拒绝迁移：%s", exc)
                    self._load_common(
                        self._fallback_view(raw, from_version),
                        fallback_legacy,
                        plain_raw,
                    )
                    self._read_only = True
                    self._migration_status = {
                        "from": from_version,
                        "to": SCHEMA_VERSION,
                        "state": "failed",
                        "backup_path": backup_path,
                        "error": str(exc),
                    }
                    return self.snapshot()

                if legacy_bytes is not None:
                    legacy_backup_path = self._legacy_backup_path_for_version(from_version)
                    try:
                        self._atomic_write_bytes(legacy_backup_path, legacy_bytes)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("写入成对 legacy 备份失败：%s", exc)
                        self._load_common(
                            self._fallback_view(raw, from_version),
                            fallback_legacy,
                            plain_raw,
                        )
                        self._read_only = True
                        self._migration_status = {
                            "from": from_version,
                            "to": SCHEMA_VERSION,
                            "state": "failed",
                            "backup_path": backup_path,
                            "error": "legacy sidecar 备份失败：%s" % exc,
                        }
                        return self.snapshot()

                try:
                    if from_version == 1:
                        migrated, migrated_legacy = _migrate_v1(raw)
                    elif from_version == 2:
                        migrated = _migrate_v2(raw)
                        migrated_legacy = legacy_doc
                    else:
                        raise ConfigMigrationError(
                            "不支持从 schema %s 自动迁移到 %s" % (from_version, SCHEMA_VERSION)
                        )
                    errors = validate_config(migrated)
                    if errors:
                        raise ConfigMigrationError("; ".join(errors[:8]))
                    self._load_common(migrated, migrated_legacy, plain_raw)
                    if not self._save_locked():
                        raise ConfigMigrationError("迁移结果写盘失败")
                    self._strip_copied_global_runtime()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "config schema %s -> %s 迁移失败，已保留旧结构：%s",
                        from_version,
                        SCHEMA_VERSION,
                        exc,
                    )
                    self._restore_after_failed_migration(
                        raw_bytes,
                        legacy_bytes,
                        legacy_bytes is None,
                    )
                    self._load_common(
                        self._fallback_view(raw, from_version),
                        fallback_legacy,
                        plain_raw,
                    )
                    self._read_only = True
                    self._migration_status = {
                        "from": from_version,
                        "to": SCHEMA_VERSION,
                        "state": "failed",
                        "backup_path": backup_path,
                        "error": str(exc),
                    }
                    return self.snapshot()

                self._read_only = False
                self._migration_status = {
                    "from": from_version,
                    "to": SCHEMA_VERSION,
                    "state": "ok",
                    "backup_path": backup_path,
                    "error": None,
                }
                return self.snapshot()

            current = canonical_config(raw)
            validation_target = copy.deepcopy(raw)
            # 凭证由 legacy sidecar 管理，不属于规范 schema；其余额外键仍严格拒绝。
            validation_target.pop("sessdata_enc", None)
            validation_target.pop("sessdata", None)
            # 旧 v3 配置可能仍带已移除的 hotkeys；读取时忽略，成功后由清理逻辑重写。
            validation_target.pop("hotkeys", None)
            errors = validate_config(validation_target)
            if errors:
                logger.warning(
                    "config.json 不符合当前 schema（只读加载）：%s",
                    "; ".join(errors[:8]),
                )
                self._load_common(copy.deepcopy(DEFAULT_CONFIG), legacy_doc, plain_raw)
                if enc_raw and not str(legacy_doc.get("sessdata_enc") or ""):
                    self._set_secret(enc_raw, plain_raw)
                self._read_only = True
                self._migration_status = {
                    "from": raw.get("schema_version"),
                    "to": SCHEMA_VERSION,
                    "state": "failed",
                    "backup_path": None,
                    "error": "; ".join(errors[:8]),
                }
            else:
                self._load_common(current, legacy_doc, plain_raw)
                if enc_raw and not str(legacy_doc.get("sessdata_enc") or ""):
                    self._set_secret(enc_raw, plain_raw)
                self._strip_copied_global_runtime()
                self._read_only = False
                self._migration_status = {
                    "from": raw.get("schema_version"),
                    "to": SCHEMA_VERSION,
                    "state": "ok",
                    "backup_path": None,
                    "error": None,
                }
                self._cleanup_removed_current_fields(raw)
            return self.snapshot()

    def save(self) -> None:
        with self._lock:
            self._save_locked()

    def _save_current_only_locked(self) -> bool:
        """Write only canonical config.json while preserving an existing sidecar."""
        if self._read_only:
            return False
        current = canonical_config(self._data)
        errors = validate_config(current)
        if errors:
            logger.warning("拒绝写入非法当前 schema 配置：%s", "; ".join(errors[:8]))
            return False
        try:
            self._atomic_write_text(self.path, self._dump_json(current))
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入恢复后的主配置失败：%s", exc)
            return False

    def _save_locked(self) -> bool:
        if self._read_only:
            logger.warning("配置处于只读安全模式，拒绝写盘")
            return False
        config_before = None
        legacy_before = None
        config_snapshot_taken = False
        legacy_snapshot_taken = False
        transaction_written = False
        try:
            current = canonical_config(self._data)
            errors = validate_config(current)
            if errors:
                logger.warning("拒绝写入非法当前 schema 配置：%s", "; ".join(errors[:8]))
                return False
            legacy_payload = deep_merge(DEFAULT_LEGACY_CONFIG, self._legacy_doc)
            legacy_payload.pop("schema_version", None)
            legacy_payload.pop("appearance", None)
            legacy_payload.pop("monitor", None)
            legacy_payload.pop("hotkeys", None)
            legacy_overlay_payload = self.overlay_v1()
            # gap has no canonical-schema counterpart. Persist the unscaled
            # value; overlay_v1() applies geometry.scale only at read time.
            try:
                raw_gap = max(
                    0,
                    min(48, int(round(float(self._legacy_overlay.get(
                        "gap", DEFAULT_LEGACY_OVERLAY["gap"]
                    ))))),
                )
            except (TypeError, ValueError):
                raw_gap = int(DEFAULT_LEGACY_OVERLAY["gap"])
            legacy_overlay_payload["gap"] = raw_gap
            legacy_payload["overlay"] = legacy_overlay_payload
            legacy_payload["sessdata"] = ""
            legacy_payload["sessdata_enc"] = self._effective_sessdata_token_locked()
            config_text = self._dump_json(current)
            legacy_text = self._dump_json(legacy_payload)

            config_before = self._read_bytes_if_exists(self.path)
            config_snapshot_taken = True
            legacy_before = self._read_bytes_if_exists(self.legacy_path)
            legacy_snapshot_taken = True
            self._atomic_write_text(
                self.transaction_path,
                self._dump_json({
                    "version": 1,
                    "config": config_text,
                    "legacy": legacy_text,
                }),
            )
            transaction_written = True
            self._atomic_write_text(self.legacy_path, legacy_text)
            self._atomic_write_text(self.path, config_text)
            try:
                os.remove(self.transaction_path)
            except OSError as exc:
                logger.warning("配置事务标记清理失败，下次启动将重新校验：%s", exc)
            self._sessdata_token_original = str(legacy_payload["sessdata_enc"])
            self._sessdata_plain_original = str(self._data.get("sessdata") or "")
            self._credential_decrypt_failed = False
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入配置失败：%s", exc)
            snapshots = (
                (self.legacy_path, legacy_before, legacy_snapshot_taken),
                (self.path, config_before, config_snapshot_taken),
            )
            for target, before, taken in snapshots:
                if not taken:
                    continue
                try:
                    if before is None:
                        if os.path.isfile(target):
                            os.remove(target)
                    else:
                        self._atomic_write_bytes(target, before)
                except Exception as restore_exc:  # noqa: BLE001
                    logger.error("恢复 %s 失败：%s", target, restore_exc)
            if transaction_written:
                try:
                    os.remove(self.transaction_path)
                except OSError as cleanup_exc:
                    self._read_only = True
                    logger.error("配置事务标记清理失败，进入只读：%s", cleanup_exc)
            return False

    # ------------------------------------------------------------- 访问接口
    def snapshot(self) -> Dict[str, Any]:
        """返回当前 schema + legacy 运行时字段的深拷贝；sessdata 永远为空。"""
        with self._lock:
            data = copy.deepcopy(self._data)
            data["sessdata"] = ""
            data.pop("douyin_cookie_enc", None)
            return data

    def project_v1(self) -> Dict[str, Any]:
        """只读生成旧版投影，绝不写回规范配置。"""
        with self._lock:
            result = deep_merge(DEFAULT_LEGACY_CONFIG, self._legacy_doc)
            result.pop("schema_version", None)
            result.pop("appearance", None)
            result.pop("monitor", None)
            result.pop("hotkeys", None)
            result["overlay"] = self.overlay_v1()
            result["sessdata"] = ""
            result.pop("douyin_cookie_enc", None)
            # 主界面只需要账号状态，不需要任何凭证 token。
            result.pop("sessdata_enc", None)
            return result

    def overlay_v1(self) -> Dict[str, Any]:
        """把 v2 styles/pins/geometry 投影成旧 Qt 浮窗能消费的扁平结构。"""
        with self._lock:
            result = deep_merge(DEFAULT_LEGACY_OVERLAY, self._legacy_overlay)
            motion = normalize_motion(result.get("motion"))
            result["motion"] = motion
            enter_anim = str(motion["global"].get("enter_anim", "slide"))
            result["animation"] = enter_anim if enter_anim in ("none", "fade", "slide") else "fade"
            overlay = self._data.get("overlay") if isinstance(self._data.get("overlay"), dict) else {}
            geometry = overlay.get("geometry") if isinstance(overlay.get("geometry"), dict) else {}
            for key in ("x", "y", "width", "height", "scale"):
                if key in geometry:
                    result[key] = geometry[key]
            try:
                content_scale = max(0.5, min(4.0, float(geometry.get("scale", 1.0))))
            except (TypeError, ValueError):
                content_scale = 1.0
            if abs(content_scale - 1.0) > 0.001:
                result["gap"] = max(0, min(48, int(round(float(result.get("gap", 8)) * content_scale))))
            if "enabled" in overlay:
                result["enabled"] = overlay["enabled"]

            styles = overlay.get("styles") if isinstance(overlay.get("styles"), dict) else {}
            if styles.get("theme") in THEME_PRESETS:
                result["theme"] = styles["theme"]
            preset = THEME_PRESETS.get(result.get("theme"), THEME_PRESETS["classic"])
            if result.get("line_height") == DEFAULT_LEGACY_OVERLAY["line_height"]:
                result["line_height"] = preset.get("line_height", result.get("line_height"))
            if result.get("font_family") == DEFAULT_LEGACY_OVERLAY["font_family"]:
                result["font_family"] = preset.get("font_family", result.get("font_family"))
            typography = normalize_typography(result.get("typography"))
            result["typography"] = typography
            try:
                effective_typography = TypographyResolver(result).resolve_global()
                result["font_family"] = effective_typography["font_family"]
                result["line_height"] = effective_typography["line_height"]
            except Exception:  # noqa: BLE001
                logger.debug("生成 legacy 排版投影失败，保留旧值", exc_info=True)
            try:
                resolved = StyleResolver(self._data).resolve("danmaku")
                result.update(
                    {
                        "font_size": resolved["font_size"],
                        "font_weight": resolved["font_weight"],
                        "color": resolved["text_color"],
                        "name_color": resolved["name_color"],
                        "bg_color": resolved["bg_color"],
                        "bg_opacity": round(float(resolved["bg_opacity"]) / 100.0, 2),
                        "opacity": round(float(resolved["opacity"]) / 100.0, 2),
                        "outline": resolved["outline"],
                        "outline_color": resolved["outline_color"],
                        "outline_width": resolved["outline_width"],
                        "shadow": resolved["shadow"],
                        "badge_color": resolved["badge_color"],
                    }
                )
            except Exception:  # noqa: BLE001
                logger.debug("生成 legacy 样式投影失败，保留旧值", exc_info=True)

            pins = overlay.get("pins") if isinstance(overlay.get("pins"), dict) else {}
            gift = pins.get("gift") if isinstance(pins.get("gift"), dict) else {}
            mapping = (
                ("enabled", "gift_pin"),
                ("position", "gift_pin_position"),
                ("duration_ms", "gift_pin_duration_ms"),
                ("max", "gift_pin_max"),
                ("min_price", "gift_pin_min_price"),
            )
            for pin_key, flat_key in mapping:
                if pin_key in gift:
                    result[flat_key] = gift[pin_key]
            return result

    def get_appearance(self) -> Dict[str, Any]:
        value = self.get("appearance", default=None)
        return copy.deepcopy(value) if isinstance(value, dict) else copy.deepcopy(DEFAULT_APPEARANCE)

    def update(self, patch: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
        """应用严格清洗后的局部更新并落盘，返回 (最新快照, rejected)。"""
        rejected: List[str] = []
        with self._lock:
            canonical_patch, legacy_patch, legacy_overlay_patch = _clean_patch_parts(
                patch if isinstance(patch, dict) else {}, rejected
            )
            if isinstance(legacy_overlay_patch.get("motion"), dict) and "animation" in legacy_overlay_patch:
                # 旧页面来源优先：animation 是显式编辑信号，忽略同包的 motion。
                legacy_overlay_patch.pop("motion", None)
            if "animation" in legacy_overlay_patch:
                current_animation = self.overlay_v1().get("animation")
                next_animation = legacy_overlay_patch.get("animation")
                if next_animation != current_animation:
                    legacy_overlay_patch["motion"] = {
                        "global": {"enter_anim": next_animation}
                    }
            if "font_family" in legacy_overlay_patch or "line_height" in legacy_overlay_patch:
                current = self.overlay_v1()
                theme = current.get("theme") if current.get("theme") in THEME_PRESETS else "classic"
                theme_typo = theme_typography(theme)
                if "font_family" in legacy_overlay_patch:
                    next_family = legacy_overlay_patch.get("font_family")
                    current_family = current.get("font_family")
                    if (
                        current_family in _LEGACY_FONT_FAMILIES
                        and next_family != current_family
                    ):
                        legacy_overlay_patch.setdefault("typography", {}).setdefault(
                            "global", {}
                        )["font_family"] = (
                            None if next_family == theme_typo["font_family"] else next_family
                        )
                if "line_height" in legacy_overlay_patch:
                    next_line = legacy_overlay_patch.get("line_height")
                    current_line = current.get("line_height")
                    if next_line != current_line:
                        legacy_overlay_patch.setdefault("typography", {}).setdefault(
                            "global", {}
                        )["line_height"] = (
                            None if next_line == theme_typo["line_height"] else next_line
                        )
            if not canonical_patch and not legacy_patch and not legacy_overlay_patch:
                return self.snapshot(), rejected

            old_data = self._data
            old_legacy = self._legacy_doc
            old_overlay = self._legacy_overlay
            new_data = deep_merge(self._data, canonical_patch)
            new_data = deep_merge(new_data, legacy_patch)
            errors = validate_config(canonical_config(new_data))
            if errors:
                rejected.extend(errors)
                self._data = old_data
                self._legacy_doc = old_legacy
                self._legacy_overlay = old_overlay
                return self.snapshot(), rejected

            self._data = new_data
            if legacy_patch:
                self._legacy_doc = deep_merge(self._legacy_doc, legacy_patch)
            if legacy_overlay_patch:
                self._legacy_overlay = deep_merge(self._legacy_overlay, legacy_overlay_patch)
                self._legacy_doc["overlay"] = copy.deepcopy(self._legacy_overlay)
            if not self._save_locked():
                self._data = old_data
                self._legacy_doc = old_legacy
                self._legacy_overlay = old_overlay
                rejected.append(WRITE_FAILED)
            return self.snapshot(), rejected

    def update_appearance(self, appearance: Any) -> Tuple[Dict[str, Any], List[str]]:
        """整体替换 appearance；任一字段非法时保持原配置不变。"""
        rejected: List[str] = []
        with self._lock:
            cleaned = _clean_appearance_patch(
                appearance,
                "appearance",
                rejected,
                require_full=True,
            )
            if rejected:
                return self.snapshot(), rejected

            old_data = self._data
            new_data = deep_merge(self._data, {"appearance": cleaned})
            errors = validate_config(canonical_config(new_data))
            if errors:
                rejected.extend(errors)
                return self.snapshot(), rejected

            self._data = new_data
            if not self._save_locked():
                self._data = old_data
                rejected.append("appearance: 写入配置失败")
                return self.snapshot(), rejected
            return self.snapshot(), rejected

    def get(self, *keys: str, default: Any = None) -> Any:
        with self._lock:
            if not keys:
                return self.snapshot()
            node: Any = self._data
            for key in keys:
                if not isinstance(node, dict):
                    return default
                if key not in node and key == "color" and "text_color" in node:
                    key = "text_color"
                if key not in node and key == "super_chat" and "sc" in node:
                    key = "sc"
                if key not in node:
                    return default
                node = node[key]
            return copy.deepcopy(node)


def _legacy_view_as_v2(raw: Dict[str, Any]) -> Dict[str, Any]:
    """迁移失败时只为内存运行构造一个尽量完整的 v2 视图。"""
    try:
        candidate, _legacy = _migrate_v1(raw)
        return deep_merge(DEFAULT_CONFIG, candidate)
    except Exception:
        return copy.deepcopy(DEFAULT_CONFIG)
