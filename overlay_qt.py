#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ReadMe · Qt 透明浮窗进程。

主程序通过 127.0.0.1 TCP 提供配置和增量消息。本进程只负责渲染、交互和
几何持久化，不直接依赖后端模块。使用 PySide6 的逐像素透明窗口，解决
WebView2 在 Windows 上无法真正透明的问题。
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import logging
import math
import os
import queue
import re
import select
import socket
import sys
import threading
import time
import traceback
from collections import deque
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

def _read_ipc_token() -> str:
    """从 stdin 读取主程序下发的一次性令牌（2 秒超时）。

    令牌不写盘、不进命令行、不进环境变量；手动运行（无 stdin 管道）时回退为空。
    """
    token = ""
    try:
        stream = getattr(sys, "stdin", None)
        if stream is not None and not stream.isatty():
            box: dict[str, str] = {}

            def _reader() -> None:
                try:
                    box["t"] = stream.readline()
                except Exception:
                    pass

            th = threading.Thread(target=_reader, name="ipc-token", daemon=True)
            th.start()
            th.join(2.0)
            token = (box.get("t") or "").strip()
    except Exception:
        token = ""
    return token or os.environ.get("DM_OVERLAY_TOKEN", "")


IPC_TOKEN = _read_ipc_token()

from PySide6.QtCore import (
    QPoint,
    QPointF,
    QRectF,
    QSize,
    Qt,
    QThread,
    QTimer,
    Signal,
    qInstallMessageHandler,
)
from PySide6.QtGui import (
    QColor,
    QFont,
    QGuiApplication,
    QIcon,
    QMouseEvent,
    QPainter,
    QPen,
    QResizeEvent,
)
from PySide6.QtNetwork import QLocalServer
from PySide6.QtWidgets import QApplication, QWidget

from overlay_motion import (
    _ease_in_cubic,
    _ease_out_cubic,
    _fallback_motion,
    _normalize_motions,
)
from overlay_layout import (
    LANE_PRIORITY,
    PIN_LANES,
    _local_plan_lanes,
    lane_height as _lane_height_for,
    lane_totals as _lane_totals,
    next_fixed_eviction as _next_fixed_eviction,
    next_scroll_action as _next_scroll_action,
)
from overlay_render import (
    KindRender,
    RenderContext,
    build_bubble_pixmap as build_bubble_pixmap_render,
    build_visual,
    display_parts,
    header_badges,
    message_x as message_x_render,
    paint_avatar,
    paint_badges,
    paint_bubble_background,
    paint_text,
    visual_key,
)
from overlay_typography import (
    _FontResolver,
    _RichTextBuilder,
    _fallback_typography,
    _normalize_typographies,
    _typography_fingerprint,
)
from overlay_util import (
    LANE_LABELS,
    TYPE_COLORS,
    TYPE_NAMES,
    avatar_colors,
    guard_title,
    parse_badge_bg,
)
from overlay_types import (
    _BadgeVisual,
    _BubbleVisual,
    _Message,
    _TextCluster,
    _VisualLine,
    _VisualSegment,
)

try:
    # 纯函数布局器；导入 backend 包会顺带初始化服务模块，失败时退回本地等价逻辑。
    from backend.lanes import plan_lanes as _backend_plan_lanes
except Exception:  # pragma: no cover - 仅在极简运行环境触发
    _backend_plan_lanes = None

try:
    from backend.motion import (
        MOTION_DEFAULTS,
        MotionResolver,
        all_none as _motion_all_none,
        motion_from_legacy,
        normalize_motion,
        reduced_motion_spec,
        sample_enter,
        sample_exit,
    )
except Exception:  # pragma: no cover - 仅在极简运行环境触发
    MOTION_DEFAULTS = {
        "enter_anim": "slide", "enter_ms": 220, "enter_dir": "right",
        "enter_distance": 0, "enter_scale": 90, "enter_opacity": 0,
        "exit_anim": "fade", "exit_ms": 180, "exit_dir": "up",
        "exit_distance": 4, "exit_scale": 96, "exit_opacity": 0,
    }
    MotionResolver = None  # type: ignore[assignment]
    _motion_all_none = None  # type: ignore[assignment]
    motion_from_legacy = None  # type: ignore[assignment]
    normalize_motion = None  # type: ignore[assignment]
    reduced_motion_spec = None  # type: ignore[assignment]
    sample_enter = None  # type: ignore[assignment]
    sample_exit = None  # type: ignore[assignment]

try:
    from backend.density import DensityMeter
except Exception:  # pragma: no cover - 仅在极简运行环境触发
    DensityMeter = None  # type: ignore[assignment]

try:
    from backend.frame_budget import FrameBudget
except Exception:  # pragma: no cover - 仅在极简运行环境触发
    FrameBudget = None  # type: ignore[assignment]

try:
    from backend.typography import (
        TYPOGRAPHY_FIELDS,
        normalize_typography,
    )
except Exception:  # pragma: no cover - 仅在极简运行环境触发
    TYPOGRAPHY_FIELDS = ("font_family", "line_height", "letter_spacing")
    normalize_typography = None  # type: ignore[assignment]


LOG = logging.getLogger("overlay_qt")

APP_TITLE = "ReadMe 浮窗"
CONFIG_POLL_MS = 1200
ITEMS_POLL_MS = 250
SCROLL_GIFT_MERGE_SECONDS = 10.0
RECONNECT_SECONDS = 1.0
OUTRO_MS = 180
ENTER_MS = 220
ANIM_FRAME_MS = 16
MAX_EXITING = 12
MAX_PIN_FADING = 6
GEOMETRY_THROTTLE_MS = 300


def _system_reduced_motion() -> bool:
    override = str(os.environ.get("DM_REDUCED_MOTION") or "").strip().lower()
    if override in ("0", "false", "off", "no"):
        return False
    if override in ("1", "true", "on", "yes"):
        return True
    try:
        enabled = ctypes.c_int(1)
        ok = ctypes.windll.user32.SystemParametersInfoW(
            0x1042, 0, ctypes.byref(enabled), 0
        )
        if ok:
            return not bool(enabled.value)
    except Exception:
        pass
    return False

OVERLAY_TYPES = (
    "danmaku", "gift", "super_chat", "guard", "enter", "like", "social", "fansclub",
)
LANE_TYPES = {
    "gift": "gift",
    "sc": "super_chat",
    "guard": "guard",
    "danmaku": "danmaku",
    "enter": "enter",
    "like": "like",
    "social": "social",
    "fansclub": "fansclub",
}
STYLE_KEYS = (
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
TYPOGRAPHY_KEYS = TYPOGRAPHY_FIELDS
DEFAULT_PINS: dict[str, dict[str, Any]] = {
    "gift": {
        "enabled": False,
        "position": "bottom",
        "duration_ms": 15000,
        "max": 3,
        "min_price": 0,
    },
    "sc": {
        "enabled": False,
        "position": "top",
        "duration_ms": 12000,
        "max": 2,
    },
    "guard": {
        "enabled": False,
        "position": "bottom",
        "duration_ms": 6000,
        "max": 2,
    },
    "danmaku": {
        "enabled": False,
        "position": "bottom",
        "duration_ms": 8000,
        "max": 0,
    },
    "enter": {
        "enabled": False,
        "position": "bottom",
        "duration_ms": 6000,
        "max": 0,
    },
    "like": {
        "enabled": False,
        "position": "bottom",
        "duration_ms": 6000,
        "max": 2,
    },
    "social": {
        "enabled": False,
        "position": "bottom",
        "duration_ms": 6000,
        "max": 2,
    },
    "fansclub": {
        "enabled": False,
        "position": "bottom",
        "duration_ms": 6000,
        "max": 2,
    },
}

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "x": 60,
    "y": 120,
    "width": 520,
    "height": 620,
    "font_family": "Microsoft YaHei UI",
    "font_size": 22,
    "font_weight": 600,
    "line_height": 1.55,
    "color": "#ffffff",
    "name_color": "#8fe3ff",
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
    "motion": {
        "schema_version": 1,
        "global": dict(MOTION_DEFAULTS),
        "types": {kind: {} for kind in OVERLAY_TYPES},
    },
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
        "fansclub": True,
    },
    "click_through": True,
    "always_on_top": True,
    "show_avatar": False,
    "theme": "classic",
    "gift_pin": False,
    "gift_pin_position": "bottom",
    "gift_pin_duration_ms": 15000,
    "gift_pin_max": 3,
    "gift_pin_min_price": 0,
}

THEME_PRESETS: dict[str, dict[str, Any]] = {
    "classic": {},
    "shortvideo": {
        "font_size": 30,
        "font_weight": 800,
        "line_height": 1.45,
        "color": "#ffffff",
        "name_color": "#ffd86b",
        "outline": True,
        "outline_color": "#000000",
        "outline_width": 3,
        "shadow": True,
        "bg_color": "#000000",
        "bg_opacity": 0.36,
    },
    "minimal": {
        "font_size": 20,
        "font_weight": 400,
        "line_height": 1.6,
        "color": "#f2f5fa",
        "name_color": "#a8c7fa",
        "outline": False,
        "outline_color": "#000000",
        "outline_width": 0,
        "shadow": False,
        "bg_color": "#000000",
        "bg_opacity": 0.10,
    },
    "highcontrast": {
        "font_size": 24,
        "font_weight": 700,
        "line_height": 1.5,
        "color": "#ffffff",
        "name_color": "#00e5ff",
        "outline": True,
        "outline_color": "#000000",
        "outline_width": 2,
        "shadow": True,
        "bg_color": "#000000",
        "bg_opacity": 0.85,
    },
}

THEME_FIELDS = (
    "font_size",
    "font_weight",
    "line_height",
    "color",
    "name_color",
    "outline",
    "outline_color",
    "outline_width",
    "shadow",
    "bg_color",
    "bg_opacity",
)

# 经典主题不再另存一份参数，以基础默认配置为唯一来源。
THEME_PRESETS["classic"] = {
    field_name: DEFAULT_CONFIG[field_name] for field_name in THEME_FIELDS
}

_SPACE_RE = re.compile(r"\s+")


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------


def _clamp(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        number = float(value)
        if not math.isfinite(number):
            return fallback
        return max(low, min(high, number))
    except (TypeError, ValueError, OverflowError):
        return fallback


def _int(value: Any, low: int, high: int, fallback: int) -> int:
    return int(round(_clamp(value, low, high, fallback)))


def _bool(value: Any, fallback: bool) -> bool:
    if value is None:
        return fallback
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off", ""):
        return False
    return fallback


def _str(value: Any, fallback: str = "", limit: int = 1000) -> str:
    if value is None:
        return fallback
    text = str(value)
    if not text and fallback:
        return fallback
    return text[:limit]


def _canonical_color(value: Any, fallback: str) -> str:
    try:
        color = QColor(str(value or "").strip())
        if color.isValid():
            return color.name(QColor.HexRgb).lower()
    except Exception:
        pass
    try:
        color = QColor(fallback)
        if color.isValid():
            return color.name(QColor.HexRgb).lower()
    except Exception:
        pass
    return "#ffffff"


def _positive_int(value: Any, fallback: int = 1) -> int:
    try:
        number = int(float(value))
        return max(1, number)
    except (TypeError, ValueError, OverflowError):
        return fallback


def _format_price(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return "0"
    if not math.isfinite(number) or number < 0:
        return "0"
    if abs(number - round(number)) < 0.001:
        return str(int(round(number)))
    return ("%.2f" % number).rstrip("0").rstrip(".")


def _float_value(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
        if math.isfinite(number):
            return number
    except (TypeError, ValueError, OverflowError):
        pass
    return fallback


def _unit_opacity(value: Any, fallback: float) -> float:
    """把 0..1 或 0..100 的透明度统一成 0..1。"""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return fallback
    if not math.isfinite(number):
        return fallback
    if number > 1.0:
        number /= 100.0
    return max(0.0, min(1.0, number))


def _style_base(source: dict[str, Any], kind: str) -> dict[str, Any]:
    """从 v1 扁平字段构造某一类型的兜底样式。"""
    weight = _int(source.get("font_weight"), 300, 900, int(DEFAULT_CONFIG["font_weight"]))
    allowed_weights = (300, 400, 500, 600, 700, 800, 900)
    if weight not in allowed_weights:
        weight = min(allowed_weights, key=lambda item: abs(item - weight))
    badge_fallback = (
        _canonical_color(source.get("badge_color"), TYPE_COLORS[kind])
        if kind == "danmaku"
        else TYPE_COLORS[kind]
    )
    return {
        "font_size": _int(source.get("font_size"), 10, 96, int(DEFAULT_CONFIG["font_size"])),
        "font_weight": weight,
        "text_color": _canonical_color(source.get("color"), DEFAULT_CONFIG["color"]),
        "name_color": _canonical_color(source.get("name_color"), DEFAULT_CONFIG["name_color"]),
        "bg_color": _canonical_color(source.get("bg_color"), DEFAULT_CONFIG["bg_color"]),
        "bg_opacity": _unit_opacity(source.get("bg_opacity"), float(DEFAULT_CONFIG["bg_opacity"])),
        "opacity": _unit_opacity(source.get("opacity"), float(DEFAULT_CONFIG["opacity"])),
        "outline": _bool(source.get("outline"), bool(DEFAULT_CONFIG["outline"])),
        "outline_color": _canonical_color(
            source.get("outline_color"), DEFAULT_CONFIG["outline_color"]
        ),
        "outline_width": _clamp(
            source.get("outline_width"), 0.0, 6.0, float(DEFAULT_CONFIG["outline_width"])
        ),
        "shadow": _bool(source.get("shadow"), bool(DEFAULT_CONFIG["shadow"])),
        "badge_color": badge_fallback,
    }


def _normalize_style(kind: str, raw: Any, base: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    if not isinstance(raw, dict):
        return result

    text_color = raw.get("text_color")
    if text_color is None:
        text_color = raw.get("color")
    if text_color is not None:
        result["text_color"] = _canonical_color(text_color, str(base["text_color"]))
    if raw.get("name_color") is not None:
        result["name_color"] = _canonical_color(raw.get("name_color"), str(base["name_color"]))
    if raw.get("bg_color") is not None:
        result["bg_color"] = _canonical_color(raw.get("bg_color"), str(base["bg_color"]))
    if raw.get("bg_opacity") is not None:
        result["bg_opacity"] = _unit_opacity(raw.get("bg_opacity"), float(base["bg_opacity"]))
    if raw.get("opacity") is not None:
        result["opacity"] = _unit_opacity(raw.get("opacity"), float(base["opacity"]))
    if raw.get("outline") is not None:
        result["outline"] = _bool(raw.get("outline"), bool(base["outline"]))
    if raw.get("outline_color") is not None:
        result["outline_color"] = _canonical_color(
            raw.get("outline_color"), str(base["outline_color"])
        )
    if raw.get("outline_width") is not None:
        result["outline_width"] = _clamp(
            raw.get("outline_width"), 0.0, 6.0, float(base["outline_width"])
        )
    if raw.get("shadow") is not None:
        result["shadow"] = _bool(raw.get("shadow"), bool(base["shadow"]))
    if raw.get("badge_color") is not None:
        result["badge_color"] = _canonical_color(
            raw.get("badge_color"), str(base["badge_color"])
        )
    if raw.get("font_size") is not None:
        result["font_size"] = _int(
            raw.get("font_size"), 10, 96, int(base["font_size"])
        )
    if raw.get("font_weight") is not None:
        weight = _int(
            raw.get("font_weight"), 300, 900, int(base["font_weight"])
        )
        allowed_weights = (300, 400, 500, 600, 700, 800, 900)
        if weight not in allowed_weights:
            weight = min(allowed_weights, key=lambda item: abs(item - weight))
        result["font_weight"] = weight
    # 类型名只用于调试；不影响绘制。
    result["kind"] = kind
    return result


def _normalize_resolved(source: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = source.get("resolved")
    if not isinstance(raw, dict) or not raw:
        return {}
    resolved: dict[str, dict[str, Any]] = {}
    for kind in OVERLAY_TYPES:
        resolved[kind] = _normalize_style(kind, raw.get(kind), _style_base(source, kind))
    return resolved


def _fallback_styles(source: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        kind: _normalize_style(kind, None, _style_base(source, kind))
        for kind in OVERLAY_TYPES
    }


def _style_fingerprint(style: dict[str, Any]) -> str:
    return repr(tuple((key, style.get(key)) for key in STYLE_KEYS))


def _flat_gift_pin(source: dict[str, Any]) -> dict[str, Any]:
    position = str(
        source.get("gift_pin_position", DEFAULT_PINS["gift"]["position"])
    ).strip().lower()
    if position not in ("top", "bottom"):
        position = str(DEFAULT_PINS["gift"]["position"])
    return {
        "enabled": _bool(source.get("gift_pin"), bool(DEFAULT_PINS["gift"]["enabled"])),
        "position": position,
        "duration_ms": _int(
            source.get("gift_pin_duration_ms"),
            500,
            600000,
            int(DEFAULT_PINS["gift"]["duration_ms"]),
        ),
        "max": _int(
            source.get("gift_pin_max"),
            0,
            6,
            int(DEFAULT_PINS["gift"]["max"]),
        ),
        "min_price": max(
            0.0,
            _float_value(
                source.get("gift_pin_min_price"),
                float(DEFAULT_PINS["gift"]["min_price"]),
            ),
        ),
    }


def _normalize_lane_pin(
    lane: str, raw: Any, fallback: dict[str, Any]
) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    position = str(source.get("position", fallback["position"])).strip().lower()
    if position not in ("top", "bottom"):
        position = str(fallback["position"])
    result: dict[str, Any] = {
        "enabled": _bool(source.get("enabled"), bool(fallback["enabled"])),
        "position": position,
        "duration_ms": _int(
            source.get("duration_ms"),
            500,
            600000,
            int(fallback["duration_ms"]),
        ),
        "max": _int(source.get("max"), 0, 6, int(fallback["max"])),
    }
    if lane in ("danmaku", "enter"):
        # 这两类不提供同屏条数设置，按“不限”处理（仍受固定区预算约束）。
        result["max"] = 0
    if lane == "gift":
        result["min_price"] = max(
            0.0,
            _float_value(
                source.get("min_price", fallback.get("min_price", 0.0)),
                float(fallback.get("min_price", 0.0)),
            ),
        )
    return result


def _normalize_lane_pins(source: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_pins = source.get("pins")
    pins: dict[str, dict[str, Any]] = {}
    if isinstance(raw_pins, dict):
        for lane in PIN_LANES:
            raw = raw_pins.get(lane)
            if raw is None and lane == "sc":
                raw = raw_pins.get("super_chat")
            fallback = (
                _flat_gift_pin(source) if lane == "gift" else dict(DEFAULT_PINS[lane])
            )
            pins[lane] = _normalize_lane_pin(lane, raw, fallback)
        return pins

    # v1 兼容：只迁移旧的礼物答谢区，SC/舰长默认关闭。
    pins["gift"] = _normalize_lane_pin("gift", _flat_gift_pin(source), DEFAULT_PINS["gift"])
    pins["sc"] = dict(DEFAULT_PINS["sc"])
    pins["guard"] = dict(DEFAULT_PINS["guard"])
    return pins


def _unwrap_overlay(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            return {}
    if not isinstance(value, dict):
        return {}
    if isinstance(value.get("overlay"), dict):
        return value["overlay"]
    cfg = value.get("config")
    if isinstance(cfg, dict) and isinstance(cfg.get("overlay"), dict):
        return cfg["overlay"]
    return value


def normalize_config(value: Any) -> dict[str, Any]:
    source = _unwrap_overlay(value)
    source = source if isinstance(source, dict) else {}

    raw_types = source.get("types") if isinstance(source.get("types"), dict) else {}
    types = {
        kind: _bool(raw_types.get(kind), bool(DEFAULT_CONFIG["types"][kind]))
        for kind in OVERLAY_TYPES
    }

    theme = str(source.get("theme", DEFAULT_CONFIG["theme"])).strip().lower()
    if theme not in THEME_PRESETS:
        theme = "classic"
    align = str(source.get("align", DEFAULT_CONFIG["align"])).strip().lower()
    if align not in ("left", "center", "right"):
        align = "left"
    animation = str(source.get("animation", DEFAULT_CONFIG["animation"])).strip().lower()
    if animation not in ("none", "fade", "slide"):
        animation = "slide"
    pin_position = str(
        source.get("gift_pin_position", DEFAULT_CONFIG["gift_pin_position"])
    ).strip().lower()
    if pin_position not in ("top", "bottom"):
        pin_position = "bottom"
    weight = _int(source.get("font_weight"), 300, 900, int(DEFAULT_CONFIG["font_weight"]))
    allowed_weights = (300, 400, 500, 600, 700, 800, 900)
    if weight not in allowed_weights:
        weight = min(allowed_weights, key=lambda item: abs(item - weight))

    return {
        "enabled": _bool(source.get("enabled"), bool(DEFAULT_CONFIG["enabled"])),
        "x": _int(source.get("x"), -20000, 20000, int(DEFAULT_CONFIG["x"])),
        "y": _int(source.get("y"), -20000, 20000, int(DEFAULT_CONFIG["y"])),
        "width": _int(source.get("width"), 240, 3840, int(DEFAULT_CONFIG["width"])),
        "height": _int(source.get("height"), 120, 2160, int(DEFAULT_CONFIG["height"])),
        "font_family": _str(source.get("font_family"), DEFAULT_CONFIG["font_family"], 200).strip()
        or DEFAULT_CONFIG["font_family"],
        "font_size": _int(source.get("font_size"), 10, 96, int(DEFAULT_CONFIG["font_size"])),
        "font_weight": weight,
        "line_height": _clamp(source.get("line_height"), 1.0, 2.5, float(DEFAULT_CONFIG["line_height"])),
        "color": _canonical_color(source.get("color"), DEFAULT_CONFIG["color"]),
        "name_color": _canonical_color(source.get("name_color"), DEFAULT_CONFIG["name_color"]),
        "name_sep": _str(source.get("name_sep"), DEFAULT_CONFIG["name_sep"], 8),
        "show_name": _bool(source.get("show_name"), bool(DEFAULT_CONFIG["show_name"])),
        "name_max_len": _int(source.get("name_max_len"), 1, 1000, int(DEFAULT_CONFIG["name_max_len"])),
        "text_max_len": _int(source.get("text_max_len"), 1, 10000, int(DEFAULT_CONFIG["text_max_len"])),
        "outline": _bool(source.get("outline"), bool(DEFAULT_CONFIG["outline"])),
        "outline_color": _canonical_color(source.get("outline_color"), DEFAULT_CONFIG["outline_color"]),
        "outline_width": _clamp(source.get("outline_width"), 0.0, 6.0, float(DEFAULT_CONFIG["outline_width"])),
        "shadow": _bool(source.get("shadow"), bool(DEFAULT_CONFIG["shadow"])),
        "bg_color": _canonical_color(source.get("bg_color"), DEFAULT_CONFIG["bg_color"]),
        "bg_opacity": _clamp(source.get("bg_opacity"), 0.0, 1.0, float(DEFAULT_CONFIG["bg_opacity"])),
        "opacity": _clamp(source.get("opacity"), 0.0, 1.0, float(DEFAULT_CONFIG["opacity"])),
        "align": align,
        "max_lines": _int(source.get("max_lines"), 1, 30, int(DEFAULT_CONFIG["max_lines"])),
        "animation": animation,
        "dwell_ms": _int(source.get("dwell_ms"), 0, 3600000, int(DEFAULT_CONFIG["dwell_ms"])),
        "gap": _int(source.get("gap"), 0, 48, int(DEFAULT_CONFIG["gap"])),
        "types": types,
        "click_through": _bool(source.get("click_through"), bool(DEFAULT_CONFIG["click_through"])),
        "always_on_top": _bool(source.get("always_on_top"), bool(DEFAULT_CONFIG["always_on_top"])),
        "show_avatar": _bool(source.get("show_avatar"), bool(DEFAULT_CONFIG["show_avatar"])),
        "theme": theme,
        "badge_color": _canonical_color(source.get("badge_color"), TYPE_COLORS["danmaku"]),
        "gift_pin": _bool(source.get("gift_pin"), bool(DEFAULT_CONFIG["gift_pin"])),
        "gift_pin_position": pin_position,
        "gift_pin_duration_ms": _int(
            source.get("gift_pin_duration_ms"),
            2000,
            600000,
            int(DEFAULT_CONFIG["gift_pin_duration_ms"]),
        ),
        "gift_pin_max": _int(
            source.get("gift_pin_max"),
            1,
            6,
            int(DEFAULT_CONFIG["gift_pin_max"]),
        ),
        "gift_pin_min_price": _int(
            source.get("gift_pin_min_price"),
            0,
            1000000,
            int(DEFAULT_CONFIG["gift_pin_min_price"]),
        ),
        # v2 扩展：后端已解析的五类样式与三条固定 lane 规则。
        "pins": _normalize_lane_pins(source),
        "resolved": _normalize_resolved(source),
        "motion": normalize_motion(
            source.get("motion")
            if isinstance(source.get("motion"), dict)
            else (motion_from_legacy(source.get("animation")) if motion_from_legacy else None)
        )
        if normalize_motion
        else {"global": dict(MOTION_DEFAULTS), "types": {kind: {} for kind in OVERLAY_TYPES}},
        "resolved_motion": _normalize_motions(source),
        "typography": normalize_typography(
            source.get("typography")
            if isinstance(source.get("typography"), dict)
            else {"global": {}, "types": {}}
        )
        if normalize_typography
        else {"global": {}, "types": {}},
        "resolved_typography": _normalize_typographies(source),
    }


def _declared_explicit_fields(value: Any) -> set[str]:
    source = value if isinstance(value, dict) else {}
    fields: set[str] = set()
    for key in ("_explicit", "theme_overrides", "_theme_overrides"):
        candidate = source.get(key)
        if isinstance(candidate, list):
            fields.update(str(item) for item in candidate if item in THEME_FIELDS)
        elif isinstance(candidate, dict):
            fields.update(
                str(field_name)
                for field_name, enabled in candidate.items()
                if field_name in THEME_FIELDS and enabled
            )
    return fields


def resolve_effective(raw: dict[str, Any], explicit: set[str], preset: dict[str, Any]) -> dict[str, Any]:
    effective = dict(raw)
    for field_name in THEME_FIELDS:
        if field_name in preset and field_name not in explicit:
            effective[field_name] = preset[field_name]
    return effective


# ---------------------------------------------------------------------------
# IPC 客户端
# ---------------------------------------------------------------------------


@dataclass
class _Request:
    op: str
    payload: dict[str, Any] = field(default_factory=dict)


class IpcWorker(QThread):
    """独立线程中的长连接 IPC。只启动一个线程，断线由自身重连。"""

    config_received = Signal(object)
    items_received = Signal(object)
    geometry_saved = Signal(object)
    connection_changed = Signal(bool)

    def __init__(self, host: str, port: int, parent=None):
        super().__init__(parent)
        self.host = host
        self.port = port
        self._cond = threading.Condition()
        self._requests: deque[_Request] = deque()
        self._stopping = False
        self._sock: Optional[socket.socket] = None
        self._last_connect_error_log = 0.0
        try:
            self._wake_r, self._wake_w = socket.socketpair()
            self._wake_r.setblocking(False)
            self._wake_w.setblocking(False)
        except Exception:
            self._wake_r = None
            self._wake_w = None

    def submit(self, op: str, payload: Optional[dict[str, Any]] = None) -> None:
        if self._stopping:
            return
        payload = payload or {}
        with self._cond:
            # 轮询请求只保留最新一份，避免断线时堆出无意义的积压。
            for existing in self._requests:
                if existing.op == op:
                    if op in ("items", "geometry", "click_through", "config"):
                        existing.payload = dict(payload)
                        self._cond.notify_all()
                        self._wake()
                        return
            if len(self._requests) >= 64:
                # 丢弃最旧的配置/消息轮询，但尽量保留几何持久化。
                for index, existing in enumerate(self._requests):
                    if existing.op in ("config", "items"):
                        del self._requests[index]
                        break
            self._requests.append(_Request(op, dict(payload)))
            self._cond.notify_all()
            self._wake()

    def request_config(self) -> None:
        self.submit("config")

    def request_items(self, cursor: int) -> None:
        self.submit("items", {"cursor": int(cursor)})

    def request_geometry(self, geometry: dict[str, int]) -> None:
        self.submit("geometry", dict(geometry))

    def request_click_through(self, value: bool) -> None:
        self.submit("click_through", {"value": bool(value)})

    def stop(self) -> None:
        self._stopping = True
        with self._cond:
            self._cond.notify_all()
        self._wake()
        sock = self._sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass
        if self._wake_w is not None:
            try:
                self._wake_w.close()
            except Exception:
                pass
        if self._wake_r is not None:
            try:
                self._wake_r.close()
            except Exception:
                pass

    def _wake(self) -> None:
        if self._wake_w is None:
            return
        try:
            self._wake_w.send(b"x")
        except (BlockingIOError, OSError):
            pass

    def _pop_request_nowait(self) -> Optional[_Request]:
        with self._cond:
            if self._requests:
                return self._requests.popleft()
        return None

    def _requeue_request(self, request: _Request) -> None:
        with self._cond:
            # 几何请求在断线后值得重试；轮询类请求会由定时器重新生成。
            if request.op in ("geometry", "click_through"):
                self._requests.appendleft(request)

    def _log_connect_error(self, exc: BaseException) -> None:
        now = time.monotonic()
        if now - self._last_connect_error_log >= 10.0:
            self._last_connect_error_log = now
            LOG.warning("浮窗 IPC 连接失败，1 秒后重试：%r", exc)

    def run(self) -> None:
        while not self._stopping:
            sock: Optional[socket.socket] = None
            try:
                sock = socket.create_connection((self.host, self.port), timeout=1.2)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                sock.setblocking(False)
                self._sock = sock
                LOG.info("已连接浮窗 IPC：%s:%s", self.host, self.port)
                self.connection_changed.emit(True)
                self._serve_connection(sock)
            except Exception as exc:
                self._log_connect_error(exc)
            finally:
                if self._sock is sock:
                    self._sock = None
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:
                        pass
                self.connection_changed.emit(False)
            if self._stopping:
                break
            deadline = time.monotonic() + RECONNECT_SECONDS
            while not self._stopping and time.monotonic() < deadline:
                time.sleep(0.05)

    def _serve_connection(self, sock: socket.socket) -> None:
        buffer = bytearray()
        inflight: Optional[_Request] = None
        inflight_started = 0.0

        while not self._stopping:
            if inflight is None:
                request = self._pop_request_nowait()
                if request is not None:
                    line = (
                        json.dumps(
                            {"op": request.op, **request.payload, "token": IPC_TOKEN},
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        + "\n"
                    ).encode("utf-8")
                    try:
                        sock.setblocking(True)
                        sock.settimeout(1.5)
                        sock.sendall(line)
                        sock.setblocking(False)
                    except (OSError, socket.timeout):
                        self._requeue_request(request)
                        raise
                    inflight = request
                    inflight_started = time.monotonic()

            watch = [sock]
            if self._wake_r is not None:
                watch.append(self._wake_r)
            try:
                readable, _, _ = select.select(watch, [], [], 0.5 if inflight else 1.0)
            except (OSError, ValueError):
                raise

            if self._wake_r is not None and self._wake_r in readable:
                try:
                    while self._wake_r.recv(256):
                        pass
                except (BlockingIOError, OSError):
                    pass

            if sock not in readable:
                if inflight is not None and time.monotonic() - inflight_started > 3.0:
                    LOG.warning("IPC 请求 %s 超时，重连", inflight.op)
                    raise TimeoutError("ipc request timeout")
                continue

            try:
                chunk = sock.recv(65536)
            except BlockingIOError:
                continue
            except OSError:
                raise
            if not chunk:
                self._requeue_request(inflight) if inflight is not None else None
                LOG.info("浮窗 IPC 连接已断开")
                return
            buffer.extend(chunk)
            if len(buffer) > 2 * 1024 * 1024:
                LOG.warning("IPC 响应超过 2 MiB，断开重连")
                raise ValueError("ipc response too large")

            while b"\n" in buffer:
                raw_line, _, rest = buffer.partition(b"\n")
                buffer = bytearray(rest)
                if not raw_line.strip():
                    continue
                try:
                    response = json.loads(raw_line.decode("utf-8"))
                except Exception as exc:
                    LOG.warning("忽略坏 IPC 响应：%r", exc)
                    inflight = None
                    continue
                current = inflight
                inflight = None
                if current is None:
                    LOG.warning("收到无对应请求的 IPC 响应，已忽略")
                    continue
                self._dispatch_response(current, response)

    def _dispatch_response(self, request: _Request, response: Any) -> None:
        if not isinstance(response, dict):
            LOG.warning("IPC 响应不是对象：%r", type(response).__name__)
            return
        if response.get("ok") is False:
            LOG.warning("IPC %s 返回失败：%s", request.op, response.get("error"))
            return
        if request.op == "config":
            self.config_received.emit(response.get("config", {}))
        elif request.op == "items":
            self.items_received.emit(response)
        elif request.op == "geometry":
            self.geometry_saved.emit(response.get("saved", {}))
        elif request.op == "click_through":
            LOG.info("IPC 已接受 click_through=%s", response.get("click_through"))


# ---------------------------------------------------------------------------
# 绘制布局
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 主窗口
# ---------------------------------------------------------------------------


class OverlayWindow(QWidget):
    def __init__(
        self,
        base_dir: Path,
        ipc: IpcWorker,
        single_instance: Optional["SingleInstance"] = None,
    ):
        super().__init__(None)
        self.base_dir = Path(base_dir)
        self.ipc = ipc
        self.single_instance = single_instance

        self._raw: Optional[dict[str, Any]] = None
        self._explicit: set[str] = set()
        self._effective: dict[str, Any] = dict(DEFAULT_CONFIG)
        self._font_resolver = _FontResolver(str(DEFAULT_CONFIG["font_family"]))
        self._rich = _RichTextBuilder(self._font_resolver)
        self._styles: dict[str, dict[str, Any]] = _fallback_styles(self._effective)
        self._base_styles: dict[str, dict[str, Any]] = self._styles
        self._typographies: dict[str, dict[str, Any]] = _fallback_typography(self._effective)
        self._motions: dict[str, dict[str, Any]] = _fallback_motion(self._effective)
        self._reduced_motion = _system_reduced_motion()
        self._density = DensityMeter() if DensityMeter is not None else None
        self._font_resolvers: dict[str, _FontResolver] = {
            kind: _FontResolver(str(self._typographies[kind].get("font_family", "")))
            for kind in OVERLAY_TYPES
        }
        self._rich_by_kind: dict[str, _RichTextBuilder] = {
            kind: _RichTextBuilder(self._font_resolvers[kind]) for kind in OVERLAY_TYPES
        }
        self._style_fp: dict[str, str] = {
            kind: _style_fingerprint(style) for kind, style in self._styles.items()
        }
        self._typography_fp: dict[str, str] = {
            kind: _typography_fingerprint(typography)
            for kind, typography in self._typographies.items()
        }
        self._messages: list[_Message] = []
        self._exiting: list[_Message] = []
        self._pin_fading: list[_Message] = []
        self._pins: dict[str, list[_Message]] = {lane: [] for lane in PIN_LANES}
        self._gift_merge_ledger: dict[str, tuple[float, int]] = {}
        self._plan: Optional[dict[str, Any]] = None
        self._scroll_visible_ids: set[str] = set()
        self._lane_visible_ids: set[str] = set()
        self._scroll_clip_rect = QRectF(0, 0, 0, 0)
        self._last_pin_layout_sig: Any = None
        self._seen: set[str] = set()
        self._seen_order: deque[str] = deque()
        self._cursor = 0
        self._config_ok = False
        self._fallback_used = False
        self._enabled = False
        self._always_on_top = True
        self._click_through = True
        self._hover = False
        self._interaction: Optional[str] = None
        self._interaction_start_point = QPoint()
        self._interaction_start_geom = None
        self._geometry_hold_until = 0.0
        self._last_geometry_sent = 0.0
        self._geometry_timer = QTimer(self)
        self._geometry_timer.setSingleShot(True)
        self._geometry_timer.timeout.connect(self._flush_geometry)
        self._anim_timer = QTimer(self)
        self._anim_timer.setInterval(ANIM_FRAME_MS)
        self._anim_timer.timeout.connect(self._animation_tick)
        self._last_anim_tick = time.perf_counter()
        self._frame_budget = FrameBudget() if FrameBudget is not None else None
        self._lane_timer = QTimer(self)
        self._lane_timer.setInterval(50)
        self._lane_timer.timeout.connect(self._lane_tick)
        self._last_lane_tick = time.perf_counter()
        self._paint_durations: deque[float] = deque(maxlen=400)
        self._stats_timer = QTimer(self)
        self._stats_timer.setInterval(5000)
        self._stats_timer.timeout.connect(self._log_paint_stats)
        self._shutdown_started = False
        self._paint_failed = False
        self._config_timer = QTimer(self)
        self._config_timer.setInterval(CONFIG_POLL_MS)
        self._config_timer.timeout.connect(self._request_config)
        self._items_timer = QTimer(self)
        self._items_timer.setInterval(ITEMS_POLL_MS)
        self._items_timer.timeout.connect(self._request_items)
        self._fallback_timer = QTimer(self)
        self._fallback_timer.setSingleShot(True)
        self._fallback_timer.timeout.connect(self._load_fallback_config)

        # 不能用 Qt.Tool：带 WS_EX_TOOLWINDOW 的窗口不会出现在 OBS 的窗口捕获列表里。
        # 保留无边框 + 置顶 + 鼠标穿透，改用普通顶层窗口以便直播软件识别。
        self._base_flags = (
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowDoesNotAcceptFocus
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setWindowFlags(self._base_flags | Qt.WindowType.WindowStaysOnTopHint)
        self.setWindowTitle(APP_TITLE)
        app = QApplication.instance()
        if app is not None and not app.windowIcon().isNull():
            self.setWindowIcon(app.windowIcon())
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setAutoFillBackground(False)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setGeometry(
            int(DEFAULT_CONFIG["x"]),
            int(DEFAULT_CONFIG["y"]),
            int(DEFAULT_CONFIG["width"]),
            int(DEFAULT_CONFIG["height"]),
        )

        self.ipc.config_received.connect(self._on_config)
        self.ipc.items_received.connect(self._on_items)
        self.ipc.geometry_saved.connect(self._on_geometry_saved)
        self.ipc.connection_changed.connect(self._on_connection_changed)

    # -------------------------------------------------------------- 启动/退出
    def start(self) -> None:
        self._config_timer.start()
        self._items_timer.start()
        self._lane_timer.start()
        self._last_lane_tick = time.perf_counter()
        if os.environ.get("DM_OVERLAY_STATS") == "1":
            self._stats_timer.start()
        self._fallback_timer.start(2500)
        QTimer.singleShot(0, self._request_config)
        QTimer.singleShot(30, self._request_items)
        LOG.info(
            "浮窗启动：base=%s, geometry=%s, opacity=%s",
            self.base_dir,
            self.geometry().getRect(),
            float(DEFAULT_CONFIG["opacity"]),
        )

    def shutdown(self) -> None:
        self._shutdown_started = True
        self._config_timer.stop()
        self._items_timer.stop()
        self._fallback_timer.stop()
        self._geometry_timer.stop()
        self._anim_timer.stop()
        self._lane_timer.stop()
        self._stats_timer.stop()
        self._clear_messages()
        self._ipc_safe_stop()

    def closeEvent(self, event) -> None:  # noqa: N802
        """A user close (Alt+F4/title bar) must terminate the overlay process."""
        if self._shutdown_started:
            event.accept()
            return
        LOG.info("用户关闭浮窗，退出浮窗进程")
        self.shutdown()
        app = QApplication.instance()
        if app is not None:
            app.quit()
        event.accept()

    def _ipc_safe_stop(self) -> None:
        try:
            self.ipc.stop()
        except Exception:
            LOG.exception("停止 IPC 线程失败")

    # -------------------------------------------------------------- IPC 定时器
    def _request_config(self) -> None:
        self.ipc.request_config()

    def _request_items(self) -> None:
        self.ipc.request_items(self._cursor)

    def _on_connection_changed(self, connected: bool) -> None:
        if connected:
            LOG.info("IPC 已连接，开始增量拉取")
            self._request_config()
            self._request_items()

    def _on_geometry_saved(self, saved: Any) -> None:
        if isinstance(saved, dict) and saved:
            LOG.info("几何已持久化：%s", saved)
            self._geometry_hold_until = max(self._geometry_hold_until, time.monotonic() + 0.9)

    # -------------------------------------------------------------- 配置
    def _on_config(self, value: Any) -> None:
        try:
            self._apply_config(value)
        except Exception:
            LOG.exception("应用浮窗配置失败")

    def _apply_config(self, value: Any) -> None:
        source = _unwrap_overlay(value)
        if not isinstance(source, dict) or not source:
            return
        raw_source = source
        next_raw = normalize_config(raw_source)
        previous_raw = self._raw
        first = previous_raw is None
        if previous_raw is not None and previous_raw != next_raw and self._pin_fading:
            self._pin_fading.clear()

        # 主题只看“字段是否仍是基础默认值”。整个进程只在此处解析一次，
        # 之后渲染层不再做任何主题数值覆盖，避免两套 token 二次叠加。
        fields: set[str] = set()
        declared = _declared_explicit_fields(raw_source)
        for field_name in THEME_FIELDS:
            if field_name in declared:
                fields.add(field_name)
            elif field_name in raw_source:
                if next_raw.get(field_name) != DEFAULT_CONFIG.get(field_name):
                    fields.add(field_name)
        self._explicit = fields

        preset = THEME_PRESETS.get(str(next_raw.get("theme")), THEME_PRESETS["classic"])
        effective = resolve_effective(next_raw, self._explicit, preset)
        # v2：后端已解析的五类样式优先；缺失时完整回退到现有全局样式。
        resolved = next_raw.get("resolved")
        effective["resolved"] = (
            resolved if isinstance(resolved, dict) and resolved else _fallback_styles(effective)
        )
        effective["pins"] = next_raw.get("pins") or _normalize_lane_pins(next_raw)
        previous_effective = self._effective if previous_raw is not None else None
        previous_raw_dict = previous_raw or {}
        old_styles = self._styles
        old_base_styles = getattr(self, "_base_styles", old_styles)
        new_base_styles = effective["resolved"]
        old_typographies = getattr(self, "_typographies", {})
        new_typographies = _normalize_typographies(next_raw)
        new_styles: dict[str, dict[str, Any]] = {}
        for kind in OVERLAY_TYPES:
            merged = dict(new_base_styles.get(kind) or {})
            merged.update(new_typographies.get(kind) or {})
            new_styles[kind] = merged
        new_motions = _normalize_motions(next_raw)
        new_style_fp = {
            kind: _style_fingerprint(style) for kind, style in new_base_styles.items()
        }
        style_changed_kinds = {
            kind
            for kind in OVERLAY_TYPES
            if old_base_styles.get(kind) != new_base_styles.get(kind)
        }
        typography_changed_kinds = {
            kind
            for kind in OVERLAY_TYPES
            if old_typographies.get(kind) != new_typographies.get(kind)
        }
        changed_kinds = style_changed_kinds | typography_changed_kinds
        render_keys = (
            "font_size",
            "font_weight",
            "color",
            "name_color",
            "name_sep",
            "show_name",
            "name_max_len",
            "text_max_len",
            "outline",
            "outline_color",
            "outline_width",
            "shadow",
            "bg_color",
            "bg_opacity",
            "opacity",
            "show_avatar",
            "theme",
            "badge_color",
        )
        layout_keys = render_keys + ("max_lines", "gap", "align")
        global_render_changed = previous_effective is None or any(
            previous_effective.get(key) != effective.get(key) for key in render_keys
        )
        style_changed = global_render_changed or bool(changed_kinds)
        layout_config_changed = previous_effective is None or any(
            previous_effective.get(key) != effective.get(key) for key in layout_keys
        )
        font_family_changed = previous_effective is None or previous_effective.get(
            "font_family"
        ) != effective.get("font_family")
        self._raw = next_raw
        self._effective = effective
        self._base_styles = new_base_styles
        self._styles = new_styles
        self._typographies = new_typographies
        self._motions = new_motions
        self._reduced_motion = _system_reduced_motion()
        if self._density is not None:
            try:
                self._density.emergency_batch = max(1, int(effective.get("max_lines", 8)))
            except (TypeError, ValueError):
                self._density.emergency_batch = 8
            if previous_effective is not None and previous_effective.get("max_lines") != effective.get("max_lines"):
                self._density.reset()
        self._style_fp = new_style_fp
        self._typography_fp = {
            kind: _typography_fingerprint(typography)
            for kind, typography in new_typographies.items()
        }
        for kind in typography_changed_kinds:
            family = str(new_typographies[kind].get("font_family", ""))
            self._font_resolvers[kind] = _FontResolver(family)
            self._rich_by_kind[kind] = _RichTextBuilder(self._font_resolvers[kind])

        geometry_changed = first or any(
            previous_raw_dict.get(key) != next_raw.get(key)
            for key in ("x", "y", "width", "height")
        )
        enabled = bool(effective.get("enabled"))
        was_enabled = self._enabled
        self._enabled = enabled

        if geometry_changed and not self._interaction:
            if time.monotonic() >= self._geometry_hold_until or first:
                self._apply_geometry(next_raw)

        opacity = float(effective.get("opacity", 1.0))
        try:
            self.setWindowOpacity(max(0.0, min(1.0, opacity)))
        except Exception:
            LOG.exception("设置窗口透明度失败")

        always_on_top = bool(effective.get("always_on_top", True))
        if first or always_on_top != self._always_on_top:
            self._always_on_top = always_on_top
            self._apply_window_flags()

        click_through = bool(effective.get("click_through", True))
        if first or click_through != self._click_through:
            self._click_through = click_through
            self._apply_click_through(click_through)

        pin_layout_changed = False
        if enabled and previous_effective is not None:
            pin_layout_changed = self._sync_pinned_config(previous_effective)

        if font_family_changed:
            self._font_resolver = _FontResolver(str(effective.get("font_family", "")))
            self._rich = _RichTextBuilder(self._font_resolver)
        if global_render_changed:
            self._invalidate_visuals(reset_limits=False)
        elif style_changed and changed_kinds:
            self._invalidate_visuals(
                kinds=changed_kinds,
                reset_limits=bool(typography_changed_kinds),
            )

        if enabled:
            if not was_enabled:
                self.show()
                self.raise_()
            else:
                self.show()
            self._apply_click_through(self._click_through)
            if style_changed or layout_config_changed or pin_layout_changed:
                self._relayout(snap_scroll=pin_layout_changed)
            self._prune_types_and_limits()
            self._rearm_dwell_if_changed(previous_effective)
            self.update()
        else:
            self.hide()
            self._hover = False
            self._clear_messages()

        if first:
            LOG.info(
                "收到首份配置：enabled=%s geometry=%s theme=%s font=%.1f max_lines=%s click_through=%s",
                enabled,
                next_raw.get("width"),
                effective.get("theme"),
                float(effective.get("font_size", 0)),
                effective.get("max_lines"),
                click_through,
            )
        if first or (
            previous_effective is not None
            and previous_effective.get("theme") != effective.get("theme")
        ):
            LOG.info(
                "主题有效样式：theme=%s font=%s line=%s bg=%s outline=%s/%s color=%s name=%s weight=%s",
                effective.get("theme"),
                effective.get("font_size"),
                effective.get("line_height"),
                effective.get("bg_opacity"),
                effective.get("outline"),
                effective.get("outline_width"),
                effective.get("color"),
                effective.get("name_color"),
                effective.get("font_weight"),
            )
        self._config_ok = True
        self._fallback_timer.stop()
        self._raw_source = raw_source

    def _apply_geometry(self, raw: dict[str, Any]) -> None:
        requested = (
            int(raw.get("x", self.x())),
            int(raw.get("y", self.y())),
            int(raw.get("width", self.width())),
            int(raw.get("height", self.height())),
        )
        rect = self._clamp_rect_to_screen(requested)
        if self.geometry().getRect() == rect:
            return
        old_width = self.width()
        old_height = self.height()
        self.setGeometry(*rect)
        if self.width() != old_width or self.height() != old_height:
            if self.width() != old_width:
                self._invalidate_visuals()
            self._relayout(snap_scroll=True)
        # 配置里的尺寸超出屏幕时，把夹取后的真实几何回写，避免配置与窗口长期不一致
        if tuple(rect) != tuple(requested):
            self._schedule_geometry_save()

    def _clamp_rect_to_screen(self, rect: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
        """多显示器友好的几何夹取。

        规则：
        1. 尺寸上限取"最大单屏可用尺寸"，允许窗口跨屏摆放；
        2. 只要窗口与**任意**屏幕有 ≥120×80 的可见交集，就保持原位置不动；
        3. 完全看不到（例如落在两块屏之间的空隙）时，夹到**最近**的那块屏幕里。

        旧实现只看"中心点所在屏幕"，在多屏不共边（中间有缝隙）时会回退主屏，
        表现为拖到副屏后浮窗突然消失。
        """
        x, y, width, height = rect
        try:
            from PySide6.QtCore import QPoint, QRect
            from PySide6.QtGui import QGuiApplication

            screens = QGuiApplication.screens()
            if not screens:
                return rect
            max_w = max(s.availableGeometry().width() for s in screens)
            max_h = max(s.availableGeometry().height() for s in screens)
            width = max(240, min(width, max_w))
            height = max(120, min(height, max_h))
            target = QRect(int(x), int(y), int(width), int(height))

            # 选"与窗口交集面积最大"的屏幕；都不相交时选离窗口中心最近的
            best_screen = None
            best_area = -1
            for screen in screens:
                inter = target.intersected(screen.availableGeometry())
                area = max(0, inter.width()) * max(0, inter.height())
                if area > best_area:
                    best_area, best_screen = area, screen

            if best_area <= 0:
                center = QPoint(target.center().x(), target.center().y())

                def _dist2(screen) -> int:
                    avail = screen.availableGeometry()
                    cx = min(max(center.x(), avail.left()), avail.right())
                    cy = min(max(center.y(), avail.top()), avail.bottom())
                    return (center.x() - cx) ** 2 + (center.y() - cy) ** 2

                best_screen = min(screens, key=_dist2)

            avail = best_screen.availableGeometry()
            # 允许最多 40px 露出屏幕边缘（贴边摆放），其余全部收进来
            overhang = 40
            if width > avail.width() + 2 * overhang:
                width = avail.width()
            if height > avail.height() + 2 * overhang:
                height = avail.height()
            min_x = avail.left() - overhang
            max_x = avail.right() + 1 - width + overhang
            if max_x < min_x:
                max_x = min_x
            min_y = avail.top() - overhang
            max_y = avail.bottom() + 1 - height + overhang
            if max_y < min_y:
                max_y = min_y
            x = min(max(int(x), min_x), max_x)
            y = min(max(int(y), min_y), max_y)
        except Exception:
            LOG.exception("夹取浮窗几何失败")
        return (int(x), int(y), int(width), int(height))

    def _load_fallback_config(self) -> None:
        if self._config_ok or self._fallback_used:
            return
        self._fallback_used = True
        path = self.base_dir / "config.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            overlay = data.get("overlay") if isinstance(data, dict) else None
            if isinstance(overlay, dict):
                LOG.warning("IPC 无响应，暂用本地 config.json 启动浮窗")
                self._apply_config(overlay)
                return
        except Exception as exc:
            LOG.warning("读取本地浮窗配置失败：%r", exc)
        LOG.warning("IPC 无响应且无本地配置，继续等待连接")

    def _prune_types_and_limits(self) -> None:
        if not self._effective.get("enabled", True):
            return
        types = self._effective.get("types") or {}
        for message in list(self._messages):
            if not types.get(message.kind, True) and not message.leaving:
                self._start_leave(message)
        max_lines = int(self._effective.get("max_lines", 8))
        if max_lines <= 0:
            return
        active = [message for message in self._messages if not message.leaving]
        if len(active) > max_lines:
            for message in active[: len(active) - max_lines]:
                self._start_leave(message)

    def _rearm_dwell_if_changed(self, previous_effective: Optional[dict[str, Any]]) -> None:
        if previous_effective is None:
            return
        if previous_effective.get("dwell_ms") == self._effective.get("dwell_ms"):
            return
        for message in self._messages:
            if not message.leaving:
                self._arm_dwell(message)

    @property
    def _pinned_messages(self) -> list[_Message]:
        """只读聚合视图；写路径统一走 self._pins。"""
        return [message for lane in PIN_LANES for message in self._pins.get(lane, [])]

    def _style_for(self, kind: str) -> dict[str, Any]:
        style = self._styles.get(kind)
        if isinstance(style, dict):
            return style
        return self._styles.get("danmaku") or _style_base(self._effective, kind)

    def _motion_for(self, kind: str, phase: str) -> dict[str, Any]:
        spec = self._motions.get(kind) or self._motions.get("danmaku") or dict(MOTION_DEFAULTS)
        result = dict(spec)
        if self._reduced_motion and reduced_motion_spec is not None:
            result = reduced_motion_spec(result, phase)
        return result

    def _typography_for(self, kind: str) -> dict[str, Any]:
        typography = self._typographies.get(kind) or self._typographies.get("danmaku")
        if isinstance(typography, dict):
            return typography
        return {"font_family": "Microsoft YaHei UI", "line_height": 1.55, "letter_spacing": 0.0}

    def _font_resolver_for(self, kind: str) -> _FontResolver:
        resolver = self._font_resolvers.get(kind)
        if resolver is not None:
            return resolver
        resolver = _FontResolver(str(self._typography_for(kind).get("font_family", "")))
        self._font_resolvers[kind] = resolver
        return resolver

    def _rich_for(self, kind: str) -> _RichTextBuilder:
        builder = self._rich_by_kind.get(kind)
        if builder is not None:
            return builder
        builder = _RichTextBuilder(self._font_resolver_for(kind))
        self._rich_by_kind[kind] = builder
        return builder

    def _render_context(self) -> RenderContext:
        cfg = self._effective
        kinds = {
            kind: KindRender(
                style=self._style_for(kind),
                typography=self._typography_for(kind),
                style_fp=self._style_fp.get(kind, ""),
                typography_fp=self._typography_fp.get(kind, ""),
                resolver=self._font_resolver_for(kind),
                rich=self._rich_for(kind),
            )
            for kind in OVERLAY_TYPES
        }
        return RenderContext(
            width=float(self.width()),
            dpr=float(self.devicePixelRatioF()),
            theme=str(cfg.get("theme", "classic")),
            align=str(cfg.get("align", "left")),
            show_avatar=bool(cfg.get("show_avatar", False)),
            show_name=bool(cfg.get("show_name", True)),
            name_sep=str(cfg.get("name_sep", "：")),
            name_max_len=int(cfg.get("name_max_len", 12)),
            text_max_len=int(cfg.get("text_max_len", 80)),
            global_font_size=float(cfg.get("font_size", 22)),
            global_font_weight=int(cfg.get("font_weight", 600)),
            kinds=kinds,
            default_resolver=self._font_resolver,
        )

    def _dense_motion_spec(self, spec: dict[str, Any], phase: str) -> dict[str, Any]:
        """高密度运行时副本：保留显式 none，缩短其余动效，不改配置。"""
        result = dict(spec)
        anim_key = "%s_anim" % phase
        ms_key = "%s_ms" % phase
        if result.get(anim_key) == "none":
            return result
        result[anim_key] = "fade"
        try:
            original_ms = int(result.get(ms_key, 0) or 0)
        except (TypeError, ValueError):
            original_ms = 0
        if original_ms <= 0:
            return result
        result[ms_key] = min(original_ms, 80)
        result["%s_distance" % phase] = 0
        result["%s_scale" % phase] = 100
        return result

    def _density_active(self) -> bool:
        return bool(self._density is not None and self._density.dense)

    def _reset_density(self) -> None:
        if self._density is not None:
            self._density.reset()

    def _should_snap_scroll(self) -> bool:
        active = [message for message in self._messages if not message.leaving]
        if not active:
            return False
        for message in active:
            spec = message.enter_motion or self._motion_for(message.kind, "enter")
            if spec.get("enter_anim") != "none" and int(spec.get("enter_ms", 0) or 0) > 0:
                return False
        return True

    def _sync_pinned_config(self, previous_effective: dict[str, Any]) -> bool:
        """按各 lane 的启用/位置/数量修剪现有固定项。"""
        current = self._effective
        types = current.get("types") or {}
        old_pins = previous_effective.get("pins") or {}
        new_pins = current.get("pins") or {}
        layout_changed = False
        pin_changed = old_pins != new_pins

        for lane in PIN_LANES:
            old_policy = old_pins.get(lane) if isinstance(old_pins.get(lane), dict) else {}
            policy = new_pins.get(lane) if isinstance(new_pins.get(lane), dict) else {}
            kind = LANE_TYPES[lane]
            lane_enabled = bool(policy.get("enabled")) and bool(types.get(kind, True))
            max_items = max(0, int(policy.get("max", 0) or 0))
            if not lane_enabled:
                if self._pins.get(lane):
                    self._clear_lane(lane, "配置关闭")
                    layout_changed = True
                continue
            if lane == "gift" and not bool(old_policy.get("enabled")):
                removed = 0
                for message in list(self._messages):
                    if message.kind == "gift" and not message.leaving:
                        self._drop_scroll_now(message)
                        removed += 1
                if removed:
                    layout_changed = True
                    LOG.info("礼物 lane 开启：从滚动区移除 %d 条旧礼物", removed)
            if max_items > 0 and len(self._pins.get(lane, [])) > max_items:
                self._trim_lane(lane, max_items, "上限缩小")
                layout_changed = True
            if old_policy.get("position") != policy.get("position") and self._pins.get(lane):
                layout_changed = True

        if pin_changed:
            LOG.info(
                "lane 配置：gift=%s sc=%s guard=%s danmaku=%s enter=%s like=%s social=%s fansclub=%s counts=%s",
                new_pins.get("gift"),
                new_pins.get("sc"),
                new_pins.get("guard"),
                new_pins.get("danmaku"),
                new_pins.get("enter"),
                new_pins.get("like"),
                new_pins.get("social"),
                new_pins.get("fansclub"),
                {lane: len(self._pins.get(lane, [])) for lane in PIN_LANES},
            )
        if layout_changed:
            self._last_pin_layout_sig = None
        return layout_changed

    def _rebuild_placeholder_styles(self) -> None:
        for message in self._all_render_messages():
            message.visual = None
            message.visual_key = None
        self._relayout()

    def _invalidate_visuals(
        self,
        kinds: Optional[set[str]] = None,
        reset_limits: bool = True,
    ) -> None:
        for message in self._all_render_messages():
            if kinds is not None and message.kind not in kinds:
                continue
            if reset_limits and not message.pinned:
                message.line_limit = 3
                message.suppress_draw = False
            message.visual = None
            message.visual_key = None

    # -------------------------------------------------------------- 消息
    def _normalize_item(self, value: Any) -> Optional[_Message]:
        if not isinstance(value, dict):
            return None
        seq_value = value.get("seq")
        if seq_value is None:
            return None
        seq = str(seq_value)
        kind = str(value.get("type") or "danmaku")
        if kind not in OVERLAY_TYPES:
            kind = "danmaku"
        meta = value.get("meta") if isinstance(value.get("meta"), dict) else {}
        return _Message(
            seq=seq,
            kind=kind,
            user=_str(value.get("user"), "观众", 500).strip() or "观众",
            uid=value.get("uid", 0),
            text=_str(value.get("text"), "", 8000),
            meta=dict(meta),
            created=time.perf_counter(),
            arrived_at=time.perf_counter(),
            enter_started=time.perf_counter(),
            enter_motion=self._motion_for(kind, "enter"),
        )

    def _mark_seen(self, seq: str) -> bool:
        if seq in self._seen:
            return False
        self._seen.add(seq)
        self._seen_order.append(seq)
        while len(self._seen_order) > 2400:
            oldest = self._seen_order.popleft()
            self._seen.discard(oldest)
        return True

    def _gift_name(self, message: _Message) -> str:
        return _str(message.meta.get("gift_name"), "", 300).strip() or "礼物"

    def _lane_for_message(self, message: _Message) -> str:
        for lane, kind in LANE_TYPES.items():
            if message.kind == kind:
                return lane
        return ""

    def _pin_policy(self, lane: str) -> dict[str, Any]:
        pins = self._effective.get("pins") if isinstance(self._effective.get("pins"), dict) else {}
        policy = pins.get(lane) if isinstance(pins.get(lane), dict) else None
        return policy or dict(DEFAULT_PINS.get(lane, {}))

    def _pin_key_for(self, message: _Message) -> str:
        lane = self._lane_for_message(message)
        if lane == "gift":
            return "gift\x1f%s\x1f%s" % (message.user, self._gift_name(message))
        # SC / 舰长按 user+type 合并；有 message_id 时优先使用 id。
        identifier = message.meta.get("message_id") or message.meta.get("id")
        if identifier is None:
            identifier = message.user
        return "%s\x1f%s" % (lane, identifier)

    def _gift_merge_key(self, message: _Message) -> str:
        gift_id = str(message.meta.get("gift_id") or "").strip()
        identity = str(message.uid or "").strip() or message.user
        return "%s\x1f%s" % (identity, gift_id or self._gift_name(message))

    def _merge_gift_count(self, message: _Message) -> int:
        """同一用户 + 同一礼物在窗口内累计数量；气泡消失后仍保留计数。"""
        key = self._gift_merge_key(message)
        now = time.perf_counter()
        cutoff = now - SCROLL_GIFT_MERGE_SECONDS
        for stale in [name for name, (ts, _num) in self._gift_merge_ledger.items() if ts < cutoff]:
            del self._gift_merge_ledger[stale]
        add_num = _positive_int(message.meta.get("num"), 1)
        previous = self._gift_merge_ledger.get(key)
        total = previous[1] + add_num if previous else add_num
        self._gift_merge_ledger[key] = (now, total)
        message.meta["num"] = total
        return total

    def _merge_scroll_gift(self, message: _Message) -> _Message:
        """滚动区礼物合并：累计数量，旧气泡还在时先移除再重新触发。"""
        if message.kind != "gift":
            return message
        key = self._gift_merge_key(message)
        total = self._merge_gift_count(message)
        for existing in list(self._messages):
            if existing.kind != "gift" or existing.leaving or existing.suppress_draw:
                continue
            if self._gift_merge_key(existing) != key:
                continue
            self._drop_scroll_now(existing)
        LOG.info(
            "滚动礼物合并：user=%s gift=%s → 累计 %d",
            message.user,
            self._gift_name(message),
            total,
        )
        return message

    def _pin_clone(self, message: _Message, lane: str) -> _Message:
        now = time.perf_counter()
        clone = _Message(
            seq="pin:%s:%s" % (lane, message.seq),
            kind=message.kind,
            user=message.user,
            uid=message.uid,
            text=message.text,
            meta=dict(message.meta),
            created=now,
            arrived_at=now,
            enter_started=now,
            enter_motion=self._motion_for(message.kind, "enter"),
            pinned=True,
            lane=lane,
            pin_count=1,
        )
        clone.pin_key = self._pin_key_for(clone)
        clone.pin_price = _float_value(clone.meta.get("price"), 0.0)
        if lane == "gift":
            clone.meta["num"] = _positive_int(clone.meta.get("num"), 1)
        return clone

    def _pin_state_text(self) -> str:
        parts: list[str] = []
        for lane in PIN_LANES:
            for message in self._pins.get(lane, []):
                if lane == "gift":
                    parts.append(
                        "%s:%s/%s×%s"
                        % (
                            lane,
                            message.user,
                            self._gift_name(message),
                            _positive_int(message.meta.get("num"), 1),
                        )
                    )
                else:
                    parts.append("%s:%s×%s" % (lane, message.user, message.pin_count))
        return ", ".join(parts) or "<empty>"

    def _arm_pin_timer(self, message: _Message) -> None:
        """固定项 TTL 由 50ms lane tick 统一检查；仅更新到期时间。"""
        if message.leaving:
            return
        policy = self._pin_policy(message.lane)
        try:
            duration = int(policy.get("duration_ms", 15000))
        except (TypeError, ValueError):
            duration = 15000
        now = time.perf_counter()
        message.pinned_at = now
        message.expires_at = None if duration <= 0 else now + max(0.5, duration / 1000.0)
        if not self._lane_timer.isActive():
            self._lane_timer.start()

    def _lane_tick(self) -> None:
        now = time.perf_counter()
        last = self._last_lane_tick or now
        dt = max(0.0, min(0.5, now - last))
        self._last_lane_tick = now
        paused = (not self._enabled) or (not self.isVisible())
        expired: list[_Message] = []
        for lane in PIN_LANES:
            for message in self._pins.get(lane, []):
                if message.leaving:
                    continue
                if message.expires_at is None:
                    continue
                if paused:
                    # 浮窗隐藏/关闭时暂停 TTL，恢复后继续剩余时长。
                    message.expires_at += dt
                elif message.expires_at and now >= message.expires_at:
                    expired.append(message)
        for message in expired:
            self._pin_expired(message)

    def _pin_expired(self, message: _Message) -> None:
        if message.lane and message in self._pins.get(message.lane, []) and not message.leaving:
            LOG.info(
                "lane 到期：lane=%s user=%s，移出并做 ≤120ms 纯淡出",
                message.lane,
                message.user,
            )
            self._start_leave(message, allow_pin_fade=True)

    def _remove_lane_item(
        self, message: _Message, reason: str, relayout: bool = False
    ) -> bool:
        lane = message.lane or self._lane_for_message(message)
        if not lane or message not in self._pins.get(lane, []):
            return False
        if message.pin_timer is not None:
            try:
                message.pin_timer.stop()
                message.pin_timer.deleteLater()
            except Exception:
                pass
            message.pin_timer = None
        self._pins[lane].remove(message)
        self._last_pin_layout_sig = None
        LOG.info(
            "lane 移除：lane=%s reason=%s user=%s，剩余=%d",
            lane,
            reason,
            message.user,
            len(self._pins[lane]),
        )
        if relayout:
            self._relayout(snap_scroll=True)
        return True

    def _trim_lane(self, lane: str, max_items: int, reason: str) -> None:
        items = self._pins.get(lane, [])
        if max_items <= 0:
            return
        while len(items) > max_items:
            self._remove_lane_item(items[0], reason)

    def _clear_lane(self, lane: str, reason: str) -> None:
        items = self._pins.get(lane, [])
        if not items:
            return
        LOG.info("lane 清空：lane=%s reason=%s，原有=%d", lane, reason, len(items))
        for message in list(items):
            if message.pin_timer is not None:
                try:
                    message.pin_timer.stop()
                    message.pin_timer.deleteLater()
                except Exception:
                    pass
                message.pin_timer = None
        items.clear()
        self._last_pin_layout_sig = None

    def _clear_pinned(self, reason: str, lane: Optional[str] = None) -> None:
        lanes = (lane,) if lane in PIN_LANES else PIN_LANES
        for name in lanes:
            self._clear_lane(str(name), reason)

    def _pin_candidate(self, message: _Message) -> str:
        """返回 pin / scroll / drop；固定失败不回退到滚动流。"""
        lane = self._lane_for_message(message)
        if not lane:
            return "scroll"
        if not (self._effective.get("types") or {}).get(message.kind, True):
            return "scroll"
        policy = self._pin_policy(lane)
        if not policy.get("enabled"):
            return "scroll"
        if lane == "gift":
            # 抖音礼物只提供钻石数，人民币 min_price 不适用。
            if str(message.meta.get("coin_type") or "").lower() != "diamond":
                price = _float_value(message.meta.get("price"), 0.0)
                try:
                    min_price = float(policy.get("min_price", 0) or 0)
                except (TypeError, ValueError):
                    min_price = 0.0
                if min_price > 0 and price < min_price:
                    LOG.info(
                        "lane 跳过礼物：user=%s gift=%s price=%s < min_price=%s",
                        message.user,
                        self._gift_name(message),
                        price,
                        min_price,
                    )
                    # 礼物 lane 开启时，低于门槛的礼物不再回流到滚动区。
                    return "drop"
        try:
            maximum = int(policy.get("max", 0) or 0)
        except (TypeError, ValueError):
            maximum = 0
        if maximum < 0:
            return "drop"
        return "pin"

    def _handle_lane_message(self, message: _Message) -> str:
        """把一条消息放入对应固定 lane；返回 pin / scroll / drop。"""
        action = self._pin_candidate(message)
        if action != "pin":
            return action
        lane = self._lane_for_message(message)
        policy = self._pin_policy(lane)
        try:
            maximum = max(0, int(policy.get("max", 0) or 0))
        except (TypeError, ValueError):
            maximum = 0
        price = _float_value(message.meta.get("price"), 0.0)
        merged_num = self._merge_gift_count(message) if lane == "gift" else 0
        key = self._pin_key_for(message)
        for ghost in list(self._pin_fading):
            if ghost.lane == lane and ghost.pin_key == key:
                self._pin_fading.remove(ghost)
                ghost.leaving = False
                break
        existing = next(
            (item for item in self._pins.get(lane, []) if item.pin_key == key),
            None,
        )
        if existing is not None:
            merged_meta = dict(existing.meta)
            merged_meta.update(message.meta)
            if lane == "gift":
                merged_meta["num"] = merged_num
            existing.meta = merged_meta
            existing.text = message.text
            existing.pin_price = max(float(existing.pin_price), price)
            existing.pin_count = int(existing.pin_count) + 1
            existing.visual = None
            existing.visual_key = None
            if existing.leaving:
                existing.leaving = False
                existing.leave_started = 0.0
                existing.entering = False
            # 合并后移到最新，保证新消息贴近 lane 边缘。
            self._pins[lane].remove(existing)
            self._pins[lane].append(existing)
            self._arm_pin_timer(existing)
            self._last_pin_layout_sig = None
            LOG.info(
                "lane 合并：lane=%s user=%s → pin_count=%d num=%s，计时已重置，状态=%s",
                lane,
                existing.user,
                existing.pin_count,
                existing.meta.get("num"),
                self._pin_state_text()
                if lane == "gift"
                else "%s×%d" % (existing.user, existing.pin_count),
            )
            return "pin"

        clone = self._pin_clone(message, lane)
        self._pins[lane].append(clone)
        if maximum > 0:
            self._trim_lane(lane, maximum, "FIFO 超出上限")
        self._arm_pin_timer(clone)
        self._last_pin_layout_sig = None
        LOG.info(
            "lane 新增：lane=%s user=%s num=%s price=%s，count=%d，状态=%s",
            lane,
            clone.user,
            clone.meta.get("num"),
            price,
            len(self._pins[lane]),
            self._pin_state_text(),
        )
        return "pin"

    def _on_items(self, payload: Any) -> None:
        try:
            if not isinstance(payload, dict):
                return
            raw_cursor = payload.get("cursor", self._cursor)
            try:
                new_cursor = int(raw_cursor)
            except (TypeError, ValueError):
                new_cursor = self._cursor
            if new_cursor < self._cursor:
                LOG.info("IPC 游标回退（后端可能重启）：%s -> %s", self._cursor, new_cursor)
                self._seen.clear()
                self._seen_order.clear()
                self._cursor = 0
                self._reset_density()
            items = payload.get("items")
            if not isinstance(items, list):
                items = []
            accepted: list[_Message] = []
            if self._enabled:
                types = self._effective.get("types") or {}
                for raw in items:
                    message = self._normalize_item(raw)
                    if message is None:
                        continue
                    if not self._mark_seen(message.seq):
                        continue
                    if not types.get(message.kind, True):
                        continue
                    accepted.append(message)
            self._cursor = max(self._cursor, new_cursor)
            if accepted:
                self._ingest(accepted)
        except Exception:
            LOG.exception("处理浮窗消息失败")

    def _ingest(self, messages: list[_Message]) -> None:
        if not self._enabled or not messages:
            return
        for message in messages:
            message.enter_motion = message.enter_motion or self._motion_for(message.kind, "enter")
            spec = message.enter_motion or {}
            if spec.get("enter_anim") == "none" or int(spec.get("enter_ms", 0) or 0) <= 0:
                message.entering = False
        pin_layout_changed = False
        scroll_messages: list[_Message] = []
        # 固定 lane 先接收全部候选；PIN/DROP 的消息绝不进入滚动流。
        for message in messages:
            action = self._handle_lane_message(message)
            if action == "pin":
                pin_layout_changed = True
            elif action == "scroll":
                scroll_messages.append(message)
            else:
                LOG.info(
                    "lane 丢弃：type=%s user=%s（固定失败，不回退滚动流）",
                    message.kind,
                    message.user,
                )
        density_changed = False
        if self._density is not None:
            now = time.perf_counter()
            for message in scroll_messages:
                self._density.add(message.arrived_at or now)
            density_changed = self._density.update(now, batch_count=len(scroll_messages))
            if density_changed:
                LOG.info(
                    "高密度保护：mode=%s rate=%.1f/s batch=%d",
                    "on" if self._density.dense else "off",
                    self._density.rate,
                    len(scroll_messages),
                )
        dense = self._density_active()
        if dense:
            for message in scroll_messages:
                base = message.enter_motion or self._motion_for(message.kind, "enter")
                message.enter_motion = self._dense_motion_spec(base, "enter")
                if (
                    message.enter_motion.get("enter_anim") == "none"
                    or int(message.enter_motion.get("enter_ms", 0) or 0) <= 0
                ):
                    message.entering = False
        max_lines = int(self._effective.get("max_lines", 8))
        if max_lines > 0 and len(scroll_messages) > max_lines:
            # 突发一大段消息时只保留最新的一屏，避免大量旧消息排队造成延迟。
            scroll_messages = scroll_messages[-max_lines:]
            for message in list(self._messages):
                if not message.leaving:
                    self._start_leave(message)
        for message in scroll_messages:
            message = self._merge_scroll_gift(message)
            active = [item for item in self._messages if not item.leaving]
            while max_lines > 0 and len(active) >= max_lines:
                oldest = active.pop(0)
                oldest.suppress_draw = True
                self._drop_scroll_now(oldest)
            if message.enter_motion is None:
                message.enter_motion = self._motion_for(message.kind, "enter")
            if (
                message.enter_motion.get("enter_anim") == "none"
                or int(message.enter_motion.get("enter_ms", 0) or 0) <= 0
            ):
                message.entering = False
            self._messages.append(message)
            self._arm_dwell(message)
            active.append(message)
        self._relayout(snap_scroll=pin_layout_changed)
        self._start_animations_if_needed()
        self.update()

    def _pinned_display_parts(self, message: _Message):
        lane = message.lane or self._lane_for_message(message)
        gift_name = self._gift_name(message) if lane == "gift" else ""
        return display_parts(self._render_context(), message, lane, gift_name)

    def _display_parts(self, message: _Message):
        lane = message.lane or self._lane_for_message(message)
        gift_name = self._gift_name(message) if lane == "gift" else ""
        return display_parts(self._render_context(), message, lane, gift_name)

    def _header_badges(
        self, message: _Message, font_size: int, weight: int
    ) -> list[tuple[str, str, str]]:
        """返回 (文字, 背景色, 文字色) 的紧凑类型徽标。"""
        theme = str(self._effective.get("theme", "classic"))
        style = self._style_for(message.kind)
        return header_badges(message, theme, style)

    @staticmethod
    def _guard_title(meta: dict[str, Any]) -> str:
        return guard_title(meta)

    def _visual_key(self, message: _Message) -> str:
        return visual_key(self._render_context(), message)

    def _build_visual(self, message: _Message) -> _BubbleVisual:
        lane = message.lane or self._lane_for_message(message)
        gift_name = self._gift_name(message) if lane == "gift" else ""
        return build_visual(self._render_context(), message, lane, gift_name)

    @staticmethod
    def _parse_badge_bg(value: str) -> QColor:
        return parse_badge_bg(value)

    @staticmethod
    def _avatar_colors(user: str, uid: Any) -> tuple[QColor, QColor]:
        return avatar_colors(user, uid)

    def _ensure_visuals(self) -> None:
        context = self._render_context()
        for message in self._all_render_messages():
            key = visual_key(context, message)
            if message.visual is None or message.visual_key != key:
                lane = message.lane or self._lane_for_message(message)
                gift_name = self._gift_name(message) if lane == "gift" else ""
                message.visual = build_visual(context, message, lane, gift_name)
                message.visual_key = key
                self._build_bubble_pixmap(message.visual)

    def _build_bubble_pixmap(self, visual: _BubbleVisual) -> None:
        """把静态气泡预渲染为透明位图；动画帧只做低成本合成。"""
        try:
            dpr = max(1.0, float(self.devicePixelRatioF()))
            visual.pixmap = build_bubble_pixmap_render(visual, dpr, self._font_resolver)
        except Exception:
            visual.pixmap = None
            LOG.exception("缓存气泡位图失败")

    # -------------------------------------------------------------- 布局
    def _lane_font_size(self) -> float:
        sizes = [
            float(self._style_for(kind).get("font_size", 22))
            for kind in LANE_TYPES.values()
        ]
        sizes.append(float(self._effective.get("font_size", 22)))
        return max(10.0, max(sizes))

    def _lane_item_px_by_lane(self) -> dict[str, int]:
        result: dict[str, int] = {}
        for lane in PIN_LANES:
            items = self._pins.get(lane, [])
            if items:
                heights = [
                    float(message.visual.height)
                    for message in items
                    if message.visual is not None
                ]
                result[lane] = max(1, int(math.ceil(max(heights)))) if heights else 1
            else:
                result[lane] = 1
        return result

    def _lane_item_heights_by_lane(self) -> dict[str, list[float]]:
        result: dict[str, list[float]] = {}
        for lane in PIN_LANES:
            heights = [
                float(message.visual.height)
                for message in self._pins.get(lane, [])
                if message.visual is not None
            ]
            if heights:
                result[lane] = heights
        return result

    def _relayout(self, snap_scroll: bool = False) -> None:
        self._ensure_visuals()
        # 当前活跃消息全部无入场动画时才 snap，避免 30 条/秒持续重绘。
        if self._should_snap_scroll():
            snap_scroll = True
        window_h = max(1.0, float(self.height()))
        top_margin = 12.0
        bottom_margin = 14.0
        scroll_gap = float(self._effective.get("gap", 8))
        pins_cfg = (
            self._effective.get("pins")
            if isinstance(self._effective.get("pins"), dict)
            else _normalize_lane_pins(self._effective)
        )

        lane_items = {
            lane: [
                {"seq": message.seq, "type": message.kind, "user": message.user}
                for message in self._pins.get(lane, [])
            ]
            for lane in PIN_LANES
        }
        planner = _backend_plan_lanes or _local_plan_lanes
        item_px_by_lane = self._lane_item_px_by_lane()
        item_heights_by_lane = self._lane_item_heights_by_lane()
        try:
            plan = planner(
                int(window_h),
                pins_cfg,
                lane_items,
                font_size=self._lane_font_size(),
                item_px_by_lane=item_px_by_lane,
                item_heights_by_lane=item_heights_by_lane,
            )
        except Exception:
            LOG.exception("lane 预算计算失败，退回本地布局")
            plan = _local_plan_lanes(
                int(window_h),
                pins_cfg,
                lane_items,
                font_size=self._lane_font_size(),
                item_px_by_lane=item_px_by_lane,
                item_heights_by_lane=item_heights_by_lane,
            )
        self._plan = plan
        lane_gap = float(plan.get("gap_px", 8))

        # plan 已按 SC > gift > guard 的优先级分配行数；不在 visible 中的最旧项
        # 只从浮窗淘汰，不回退滚动流。
        for lane in PIN_LANES:
            visible = plan.get("visible", {}).get(lane, [])
            visible_ids = {
                str(item.get("seq"))
                for item in visible
                if isinstance(item, dict) and item.get("seq") is not None
            }
            for message in list(self._pins.get(lane, [])):
                if message.seq not in visible_ids:
                    self._remove_lane_item(message, "布局预算淘汰")

        def lane_position(lane: str) -> str:
            policy = self._pin_policy(lane)
            position = str(policy.get("position", "top"))
            return position if position in ("top", "bottom") else "top"

        def lane_height(lane: str) -> float:
            items = self._pins.get(lane, [])
            return _lane_height_for(
                [
                    float(message.visual.height if message.visual else 0.0)
                    for message in items
                ],
                lane_gap,
            )

        def totals() -> tuple[float, float, float]:
            return _lane_totals(
                {lane: lane_height(lane) for lane in PIN_LANES},
                {lane: lane_position(lane) for lane in PIN_LANES},
            )

        lane_cap = min(float(plan.get("lane_cap", window_h * 0.4)), window_h * 0.4)
        fixed_cap = window_h * 0.5
        scroll_min = window_h * 0.4
        scroll_rect_limit = max(0.0, window_h - top_margin - bottom_margin - scroll_min)
        plan_budget = float(plan.get("budget", fixed_cap) or 0.0)
        fixed_budget = min(
            fixed_cap,
            scroll_rect_limit,
            max(0.0, plan_budget),
        )

        # 实际气泡高度可能多于 item_px 估算；再做一次硬预算收敛。
        for lane in PIN_LANES:
            while self._pins.get(lane) and lane_height(lane) > lane_cap + 0.5:
                self._remove_lane_item(self._pins[lane][0], "单 lane 40% 上限")

        def evict_one() -> bool:
            decision = _next_fixed_eviction(
                {lane: len(self._pins.get(lane, [])) for lane in PIN_LANES}
            )
            if decision is None:
                return False
            action, lane = decision
            if action == "trim":
                self._remove_lane_item(self._pins[lane][0], "固定区总预算淘汰")
            else:
                self._clear_lane(lane, "固定区总预算不足，抑制 lane")
            return True

        for _ in range(96):
            _, _, fixed_used = totals()
            scroll_px = window_h - top_margin - bottom_margin - fixed_used
            if fixed_used <= fixed_budget + 0.5 and scroll_px >= scroll_min - 0.5:
                break
            if not evict_one():
                break

        top_used, bottom_used, fixed_used = totals()
        scroll_top = top_margin + top_used
        scroll_bottom = window_h - bottom_margin - bottom_used
        scroll_top = max(top_margin, min(window_h, scroll_top))
        scroll_bottom = max(top_margin, min(window_h - bottom_margin, scroll_bottom))
        if scroll_bottom < scroll_top:
            scroll_bottom = scroll_top
        available_scroll = max(0.0, scroll_bottom - scroll_top)
        self._scroll_clip_rect = QRectF(
            0.0,
            scroll_top,
            float(self.width()),
            available_scroll,
        )

        # 同侧从外到内 SC -> gift -> guard；lane 内最新贴近边缘。
        top_y = top_margin
        for lane in LANE_PRIORITY:
            if lane_position(lane) != "top":
                continue
            items = list(reversed(self._pins.get(lane, [])))
            for index, message in enumerate(items):
                if message.visual is None:
                    continue
                message.target_y = top_y
                if message.y is None or snap_scroll:
                    message.y = top_y
                top_y += message.visual.height
                if index < len(items) - 1:
                    top_y += lane_gap

        bottom_y = window_h - bottom_margin
        for lane in LANE_PRIORITY:
            if lane_position(lane) != "bottom":
                continue
            items = list(reversed(self._pins.get(lane, [])))
            for index, message in enumerate(items):
                if message.visual is None:
                    continue
                bottom_y -= message.visual.height
                message.target_y = bottom_y
                if message.y is None or snap_scroll:
                    message.y = bottom_y
                if index < len(items) - 1:
                    bottom_y -= lane_gap

        # 滚动流只放普通消息；固定项不会进入该列表。
        max_lines = int(self._effective.get("max_lines", 8))
        active = [message for message in self._messages if not message.leaving]
        while active:
            total = sum(
                (message.visual.height if message.visual else 0.0)
                for message in active
            ) + scroll_gap * max(0, len(active) - 1)
            action = _next_scroll_action(
                len(active),
                total,
                available_scroll,
                int(active[0].line_limit),
                max_lines,
            )
            if action == "none":
                break
            if action == "drop_oldest":
                victim = active.pop(0)
                victim.suppress_draw = True
                self._drop_scroll_now(victim)
                continue
            newest = active[0]
            if action == "compress_latest":
                newest.line_limit -= 1
                newest.visual = None
                newest.visual_key = None
                LOG.info(
                    "滚动区高度不足：压缩最新一条为 %d 行（可用高度 %.1f）",
                    newest.line_limit,
                    available_scroll,
                )
                self._ensure_visuals()
                continue
            LOG.warning(
                "滚动区高度不足以完整显示最新一条：%.1f > %.1f，暂不绘制",
                total,
                available_scroll,
            )
            newest.suppress_draw = True
            active = []
            self._drop_scroll_now(newest)
            break

        total = sum(
            (message.visual.height if message.visual else 0.0) for message in active
        ) + scroll_gap * max(0, len(active) - 1)
        for message in active:
            message.suppress_draw = False
        # 滚动内容在可用区域内垂直居中：顶部固定区与底部固定区的留白一致。
        y = scroll_top + max(0.0, (available_scroll - total) / 2.0)
        now = time.perf_counter()
        for message in active:
            if message.visual is None:
                continue
            message.target_y = y
            if message.y is None or snap_scroll:
                message.y = y
            elif abs(message.y - y) < 0.4:
                message.y = y
            y += message.visual.height + scroll_gap
            if message.entering and message.enter_started <= 0:
                message.enter_started = now

        self._scroll_visible_ids = {
            message.seq
            for message in self._messages
            if not message.suppress_draw
        }
        self._lane_visible_ids = {
            message.seq
            for lane in PIN_LANES
            for message in self._pins.get(lane, [])
            if not message.suppress_draw
        }
        self._start_animations_if_needed()
        self._log_lane_layout(
            top_used,
            bottom_used,
            fixed_used,
            scroll_top,
            scroll_bottom,
        )
        self.update()

    def _log_lane_layout(
        self,
        top_used: float,
        bottom_used: float,
        fixed_used: float,
        scroll_top: float,
        scroll_bottom: float,
    ) -> None:
        window_h = max(1.0, float(self.height()))
        lanes = tuple(
            (
                lane,
                str(self._pin_policy(lane).get("position", "top")),
                len(self._pins.get(lane, [])),
                tuple(message.seq for message in self._pins.get(lane, [])),
            )
            for lane in PIN_LANES
        )
        scroll_ids = tuple(
            message.seq
            for message in self._messages
            if not message.suppress_draw
        )
        scroll_count = len(scroll_ids)
        signature = (
            round(top_used, 1),
            round(bottom_used, 1),
            round(fixed_used, 1),
            round(scroll_top, 1),
            round(scroll_bottom, 1),
            scroll_count,
            scroll_ids,
            lanes,
        )
        if signature == self._last_pin_layout_sig:
            return
        self._last_pin_layout_sig = signature
        LOG.info(
            "lane 布局：top=%.1fpx(%.1f%%) bottom=%.1fpx(%.1f%%) "
            "fixed=%.1fpx(%.1f%%) scroll=%.1fpx(%.1f%%) "
            "scroll_items=%d scroll_ids=%s lanes=%s",
            top_used,
            top_used / window_h * 100.0,
            bottom_used,
            bottom_used / window_h * 100.0,
            fixed_used,
            fixed_used / window_h * 100.0,
            max(0.0, scroll_bottom - scroll_top),
            max(0.0, scroll_bottom - scroll_top) / window_h * 100.0,
            scroll_count,
            list(scroll_ids),
            list(lanes),
        )

    # -------------------------------------------------------------- 动画
    def _all_render_messages(self) -> list[_Message]:
        return (
            list(self._messages)
            + list(self._pinned_messages)
            + list(self._exiting)
            + list(self._pin_fading)
        )

    def _start_animations_if_needed(self) -> None:
        if self._anim_timer.isActive():
            return
        needs = False
        for message in self._all_render_messages():
            if message.entering or message.leaving:
                needs = True
                break
            if message.y is not None and abs(message.y - message.target_y) > 0.4:
                needs = True
                break
        if needs:
            self._last_anim_tick = time.perf_counter()
            if self._frame_budget is not None:
                self._anim_timer.setInterval(self._frame_budget.interval_ms)
            self._anim_timer.start()

    def _animation_tick(self) -> None:
        now = time.perf_counter()
        raw_dt = max(0.0, now - self._last_anim_tick)
        dt = max(0.001, min(0.1, raw_dt))
        if self._frame_budget is not None:
            paint_ms = self._paint_durations[-1] * 1000.0 if self._paint_durations else None
            interval = self._frame_budget.observe(raw_dt * 1000.0, paint_ms, now)
            if interval != self._anim_timer.interval():
                self._anim_timer.setInterval(interval)
        self._last_anim_tick = now
        changed = False
        to_remove: list[_Message] = []
        for message in list(self._all_render_messages()):
            if message.entering:
                spec = message.enter_motion or self._motion_for(message.kind, "enter")
                duration = int(spec.get("enter_ms", 0) or 0)
                if spec.get("enter_anim") == "none" or duration <= 0:
                    message.entering = False
                    changed = True
                else:
                    progress = (now - message.enter_started) * 1000.0 / duration
                    if progress >= 1.0:
                        message.entering = False
                    changed = True
            if message.leaving:
                spec = message.exit_motion or self._motion_for(message.kind, "exit")
                duration = int(spec.get("exit_ms", 0) or 0)
                progress = (
                    (now - message.leave_started) * 1000.0 / duration
                    if duration > 0
                    else 1.0
                )
                if spec.get("exit_anim") == "none" or duration <= 0 or progress >= 1.0:
                    to_remove.append(message)
                changed = True
            if message.y is not None and abs(message.y - message.target_y) > 0.25:
                factor = 1.0 - math.exp(-dt * 17.0)
                message.y += (message.target_y - message.y) * factor
                if abs(message.y - message.target_y) <= 0.3:
                    message.y = message.target_y
                changed = True
        removed_active = False
        removed_pin = False
        for message in to_remove:
            if message in self._exiting:
                self._exiting.remove(message)
                changed = True
            if message in self._pin_fading:
                self._pin_fading.remove(message)
                changed = True
            if message in self._messages:
                self._messages.remove(message)
                removed_active = True
                continue
            lane = message.lane or self._lane_for_message(message)
            if lane and message in self._pins.get(lane, []):
                self._pins[lane].remove(message)
                removed_active = True
                removed_pin = True
        for message in self._all_render_messages():
            if message.leaving:
                continue
            if message.entering or abs((message.y or 0.0) - message.target_y) > 0.4:
                changed = True
                break
        if changed:
            self.update()
        if removed_active:
            self._last_pin_layout_sig = None
            self._relayout(snap_scroll=removed_pin)
        need_more = any(
            message.entering or message.leaving or abs((message.y or 0) - message.target_y) > 0.3
            for message in self._all_render_messages()
        )
        if not need_more:
            self._anim_timer.stop()
            if self._frame_budget is not None:
                self._frame_budget.reset()
                self._anim_timer.setInterval(ANIM_FRAME_MS)

    def _arm_dwell(self, message: _Message) -> None:
        if message.dwell_timer is not None:
            try:
                message.dwell_timer.stop()
                message.dwell_timer.deleteLater()
            except Exception:
                pass
            message.dwell_timer = None
        if message.leaving:
            return
        duration = max(0, int(self._effective.get("dwell_ms", 12000)))
        if duration <= 0:
            return
        timer = QTimer(self)
        timer.setSingleShot(True)
        timer.timeout.connect(lambda m=message: self._dwell_expired(m))
        message.dwell_timer = timer
        timer.start(duration)

    def _dwell_expired(self, message: _Message) -> None:
        if message in self._messages and not message.leaving:
            self._start_leave(message)

    def _start_leave(self, message: _Message, allow_pin_fade: bool = False) -> None:
        if message.leaving or (
            message not in self._messages
            and message not in self._pinned_messages
            and message not in self._exiting
        ):
            return
        message.leaving = True
        message.leave_started = time.perf_counter()
        if message.dwell_timer is not None:
            try:
                message.dwell_timer.stop()
                message.dwell_timer.deleteLater()
            except Exception:
                pass
            message.dwell_timer = None
        if message.pin_timer is not None:
            try:
                message.pin_timer.stop()
                message.pin_timer.deleteLater()
            except Exception:
                pass
            message.pin_timer = None
        lane = message.lane or self._lane_for_message(message)
        was_pinned = bool(lane and message in self._pins.get(lane, []))
        if was_pinned:
            self._pins[lane].remove(message)
            self._last_pin_layout_sig = None
            spec = self._motion_for(message.kind, "exit")
            try:
                exit_ms = int(spec.get("exit_ms", 0) or 0)
            except (TypeError, ValueError):
                exit_ms = 0
            if (
                allow_pin_fade
                and not self._reduced_motion
                and spec.get("exit_anim") != "none"
                and exit_ms > 0
            ):
                fade_spec = dict(spec)
                fade_spec["exit_anim"] = "fade"
                fade_spec["exit_ms"] = min(120, exit_ms)
                fade_spec["exit_distance"] = 0
                fade_spec["exit_scale"] = 100
                fade_spec["exit_opacity"] = 0
                message.exit_motion = fade_spec
                message.exiting_region = "pin"
                self._pin_fading.append(message)
                while len(self._pin_fading) > MAX_PIN_FADING:
                    oldest = self._pin_fading.pop(0)
                    oldest.leaving = False
            self._relayout(snap_scroll=True)
            self._start_animations_if_needed()
            self.update()
            return
        if message in self._messages:
            self._messages.remove(message)
        spec = self._motion_for(message.kind, "exit")
        if self._density_active():
            spec = self._dense_motion_spec(spec, "exit")
        message.exit_motion = spec
        if spec.get("exit_anim") == "none" or int(spec.get("exit_ms", 0) or 0) <= 0:
            self._relayout()
            self.update()
            return
        message.exiting_region = "scroll"
        self._exiting.append(message)
        while len(self._exiting) > MAX_EXITING:
            oldest = self._exiting.pop(0)
            oldest.leaving = False
        self._relayout()
        self._start_animations_if_needed()
        self.update()

    def _drop_scroll_now(self, message: _Message) -> None:
        """滚动流溢出项不参与淡出：立即移除，避免 30 条/秒时持续整窗重绘。"""
        if message.dwell_timer is not None:
            try:
                message.dwell_timer.stop()
                message.dwell_timer.deleteLater()
            except Exception:
                pass
            message.dwell_timer = None
        message.suppress_draw = True
        if message in self._messages:
            self._messages.remove(message)

    def _clear_messages(self) -> None:
        for message in self._all_render_messages():
            if message.dwell_timer is not None:
                try:
                    message.dwell_timer.stop()
                    message.dwell_timer.deleteLater()
                except Exception:
                    pass
                message.dwell_timer = None
            if message.pin_timer is not None:
                try:
                    message.pin_timer.stop()
                    message.pin_timer.deleteLater()
                except Exception:
                    pass
                message.pin_timer = None
        self._messages.clear()
        self._exiting.clear()
        self._pin_fading.clear()
        self._reset_density()
        for lane in PIN_LANES:
            self._pins[lane].clear()
        self._scroll_visible_ids.clear()
        self._lane_visible_ids.clear()
        self._plan = None
        self._last_pin_layout_sig = None
        self._scroll_clip_rect = QRectF(0, 0, self.width(), self.height())
        if hasattr(self, "_anim_timer"):
            self._anim_timer.stop()
        if self._frame_budget is not None and hasattr(self, "_anim_timer"):
            self._frame_budget.reset()
            self._anim_timer.setInterval(ANIM_FRAME_MS)
        if hasattr(self, "update"):
            self.update()

    # -------------------------------------------------------------- 透明度/置顶/穿透
    def _apply_window_flags(self) -> None:
        was_visible = self.isVisible()
        flags = self._base_flags
        if self._always_on_top:
            flags |= Qt.WindowType.WindowStaysOnTopHint
        self.setWindowFlags(flags)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        if was_visible:
            self.show()
            self.raise_()
            self._apply_click_through(self._click_through)

    def _apply_click_through(self, enabled: bool) -> None:
        self._click_through = bool(enabled)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, bool(enabled))
        if enabled:
            self._hover = False
            self.unsetCursor()
        else:
            self.setCursor(Qt.CursorShape.OpenHandCursor)
        try:
            hwnd = int(self.winId())
            _set_windows_click_through(hwnd, bool(enabled))
        except Exception:
            LOG.exception("设置 Windows 鼠标穿透样式失败")
        self.update()

    # -------------------------------------------------------------- 几何交互
    def _handle_rect(self) -> QRectF:
        return QRectF(max(0.0, self.width() - 22.0), max(0.0, self.height() - 22.0), 12.0, 12.0)

    def _drag_hint_rect(self) -> QRectF:
        width = min(150.0, max(104.0, self.width() * 0.28))
        return QRectF((self.width() - width) / 2.0, 7.0, width, 23.0)

    def _can_manipulate(self) -> bool:
        return self._enabled and not self._click_through

    def _schedule_geometry_save(self, force: bool = False) -> None:
        now = time.monotonic()
        if force:
            self._geometry_timer.stop()
            self._flush_geometry()
            return
        elapsed = now - self._last_geometry_sent
        remaining = max(0.0, GEOMETRY_THROTTLE_MS / 1000.0 - elapsed)
        if remaining <= 0:
            self._flush_geometry()
        elif not self._geometry_timer.isActive():
            self._geometry_timer.start(int(remaining * 1000))

    def _flush_geometry(self) -> None:
        if not self._config_ok:
            return
        geometry = {
            "x": int(self.x()),
            "y": int(self.y()),
            "width": int(self.width()),
            "height": int(self.height()),
        }
        self._last_geometry_sent = time.monotonic()
        self._geometry_hold_until = max(self._geometry_hold_until, time.monotonic() + 1.4)
        self.ipc.request_geometry(geometry)
        LOG.info("发送几何：%s", geometry)

    def _finish_interaction(self) -> None:
        self._interaction = None
        self._geometry_hold_until = time.monotonic() + 1.5
        self._schedule_geometry_save(force=True)
        self.setCursor(Qt.CursorShape.OpenHandCursor)
        self._relayout()
        self.update()

    def enterEvent(self, event) -> None:  # noqa: N802
        if self._can_manipulate():
            self._hover = True
            self.update()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802
        if self._interaction is None:
            self._hover = False
            self.unsetCursor()
            self.update()
        super().leaveEvent(event)

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if not self._can_manipulate() or event.button() != Qt.MouseButton.LeftButton:
            return
        self._hover = True
        pos = event.position()
        self._interaction_start_point = event.globalPosition().toPoint()
        self._interaction_start_geom = self.geometry()
        if self._handle_rect().contains(pos):
            self._interaction = "resize"
            self.setCursor(Qt.CursorShape.SizeFDiagCursor)
        else:
            self._interaction = "drag"
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
        event.accept()
        self.update()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if not self._can_manipulate():
            return
        if self._interaction is None:
            if self._handle_rect().contains(event.position()):
                self.setCursor(Qt.CursorShape.SizeFDiagCursor)
            else:
                self.setCursor(Qt.CursorShape.OpenHandCursor)
            super().mouseMoveEvent(event)
            return
        point = event.globalPosition().toPoint()
        dx = point.x() - self._interaction_start_point.x()
        dy = point.y() - self._interaction_start_point.y()
        start = self._interaction_start_geom
        if start is None:
            return
        if self._interaction == "drag":
            self.move(start.x() + dx, start.y() + dy)
        else:
            width = max(240, min(3840, start.width() + dx))
            height = max(120, min(2160, start.height() + dy))
            avail = self.screen().availableGeometry() if self.screen() else None
            if avail is not None:
                width = min(width, avail.width())
                height = min(height, avail.height())
            self.resize(width, height)
        self._schedule_geometry_save()
        self.update()
        event.accept()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self._interaction is not None:
            self._finish_interaction()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def resizeEvent(self, event: QResizeEvent) -> None:  # noqa: N802
        super().resizeEvent(event)
        if self._exiting:
            self._exiting.clear()
        if self._pin_fading:
            self._pin_fading.clear()
        if self._messages or self._pinned_messages:
            self._invalidate_visuals()
            self._relayout(snap_scroll=True)
        self.update()

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        QTimer.singleShot(40, lambda: self._apply_click_through(self._click_through))

    # -------------------------------------------------------------- 绘制
    def paintEvent(self, event) -> None:  # noqa: N802
        paint_started = time.perf_counter()
        painter = QPainter(self)
        try:
            painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
            painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
            painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
            painter.fillRect(self.rect(), Qt.GlobalColor.transparent)
            painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
            if not self._enabled:
                return
            # 非穿透模式必须让整个矩形可接收鼠标。Windows 的 layered window
            # 默认按像素 alpha 做命中测试，因此用 alpha=1 的“不可见垫层”保证
            # 空白区域也能触发 hover 提示和拖动；穿透模式完全不会绘制它。
            if not self._click_through:
                painter.fillRect(self.rect(), QColor(0, 0, 0, 1))
            self._ensure_visuals()
            for message in self._pin_fading:
                if message.visual is None or message.suppress_draw:
                    continue
                self._paint_message(painter, message)
            if self._exiting:
                painter.save()
                painter.setClipRect(self._scroll_clip_rect)
                for message in self._exiting:
                    if message.visual is None or message.suppress_draw:
                        continue
                    self._paint_message(painter, message)
                painter.restore()
            painter.save()
            painter.setClipRect(self._scroll_clip_rect)
            for message in self._messages:
                if (
                    message.visual is None
                    or message.suppress_draw
                    or message.seq not in self._scroll_visible_ids
                ):
                    continue
                self._paint_message(painter, message)
            painter.restore()
            for lane in LANE_PRIORITY:
                for message in self._pins.get(lane, []):
                    if (
                        message.visual is None
                        or message.suppress_draw
                        or message.seq not in self._lane_visible_ids
                    ):
                        continue
                    self._paint_message(painter, message)
            if not self._click_through:
                self._paint_controls(painter)
        except Exception:
            if not self._paint_failed:
                self._paint_failed = True
                LOG.exception("浮窗绘制失败")
        finally:
            painter.end()
            self._paint_durations.append(time.perf_counter() - paint_started)

    def _log_paint_stats(self) -> None:
        if not self._paint_durations:
            return
        values = sorted(self._paint_durations)
        count = len(values)
        p50 = values[max(0, int(count * 0.50) - 1)]
        p95 = values[max(0, int(count * 0.95) - 1)]
        LOG.info(
            "paint stats：count=%d p50=%.2fms p95=%.2fms max=%.2fms active=%d entering=%d exiting=%d pin_fading=%d dense=%s rate=%.1f/s interval=%dms",
            count,
            p50 * 1000.0,
            p95 * 1000.0,
            values[-1] * 1000.0,
            len(self._messages) + len(self._pinned_messages),
            sum(1 for message in self._all_render_messages() if message.entering),
            len(self._exiting),
            len(self._pin_fading),
            "on" if self._density_active() else "off",
            float(self._density.rate if self._density is not None else 0.0),
            self._anim_timer.interval(),
        )

    def _message_motion(self, message: _Message, now: float) -> dict[str, float]:
        visual = message.visual
        alpha = float(visual.opacity) if visual is not None else 1.0
        dx = 0.0
        dy = 0.0
        scale = 1.0
        font_size = (
            float(visual.font_size)
            if visual is not None
            else float(self._effective.get("font_size", 22))
        )
        if message.entering:
            spec = message.enter_motion or self._motion_for(message.kind, "enter")
            duration = int(spec.get("enter_ms", 0) or 0)
            progress = (
                max(0.0, min(1.0, (now - message.enter_started) * 1000.0 / duration))
                if duration > 0
                else 1.0
            )
            state = (
                sample_enter(spec, progress, font_size)
                if sample_enter is not None
                else {"dx": 0.0, "dy": 0.0, "scale": 1.0, "opacity": 1.0}
            )
            dx += state["dx"]
            dy += state["dy"]
            scale *= state["scale"]
            alpha *= state["opacity"]
        if message.leaving:
            spec = message.exit_motion or self._motion_for(message.kind, "exit")
            duration = int(spec.get("exit_ms", 0) or 0)
            progress = (
                max(0.0, min(1.0, (now - message.leave_started) * 1000.0 / duration))
                if duration > 0
                else 1.0
            )
            state = (
                sample_exit(spec, progress, font_size)
                if sample_exit is not None
                else {"dx": 0.0, "dy": 0.0, "scale": 1.0, "opacity": 0.0}
            )
            dx += state["dx"]
            dy += state["dy"]
            scale *= state["scale"]
            alpha *= state["opacity"]
        return {
            "dx": dx,
            "dy": dy,
            "scale": max(0.5, min(1.0, scale)),
            "opacity": max(0.0, min(1.0, alpha)),
        }

    def _message_x(self, visual: _BubbleVisual) -> float:
        return message_x_render(
            float(self.width()),
            str(self._effective.get("align", "left")),
            visual,
        )

    def _paint_message(self, painter: QPainter, message: _Message) -> None:
        visual = message.visual
        if visual is None:
            return
        now = time.perf_counter()
        motion = self._message_motion(message, now)
        alpha = motion["opacity"]
        if alpha <= 0.002:
            return
        x = self._message_x(visual) + motion["dx"]
        y = (message.y if message.y is not None else message.target_y) + motion["dy"]
        painter.save()
        painter.setOpacity(alpha)
        scale = motion["scale"]
        if abs(scale - 1.0) > 0.001:
            center_x = x + visual.width / 2.0
            center_y = y + visual.height / 2.0
            painter.translate(center_x, center_y)
            painter.scale(scale, scale)
            painter.translate(-center_x, -center_y)
        if visual.pixmap is not None:
            painter.drawPixmap(
                QPointF(x - visual.pixmap_pad, y - visual.pixmap_pad),
                visual.pixmap,
            )
        else:
            self._paint_bubble_background(painter, visual, x, y)
            self._paint_badges(painter, visual, x, y)
            self._paint_avatar(painter, visual, x, y)
            self._paint_text(painter, visual, x, y)
        painter.restore()

    def _paint_bubble_background(self, painter: QPainter, visual: _BubbleVisual, x: float, y: float) -> None:
        paint_bubble_background(painter, visual, x, y)

    def _paint_badges(self, painter: QPainter, visual: _BubbleVisual, x: float, y: float) -> None:
        paint_badges(painter, visual, x, y)

    def _paint_avatar(self, painter: QPainter, visual: _BubbleVisual, x: float, y: float) -> None:
        paint_avatar(painter, visual, x, y, self._font_resolver)

    def _paint_text(self, painter: QPainter, visual: _BubbleVisual, x: float, y: float) -> None:
        paint_text(painter, visual, x, y)

    def _paint_controls(self, painter: QPainter) -> None:
        # 右下角 10x10 缩放手柄。
        handle = self._handle_rect()
        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setPen(QPen(QColor(255, 255, 255, 115), 1.0))
        painter.setBrush(QColor(7, 11, 17, 135))
        painter.drawRoundedRect(handle, 3.0, 3.0)
        painter.setPen(QPen(QColor(255, 255, 255, 155), 1.1))
        for offset in (2.5, 5.0, 7.5):
            painter.drawLine(
                QPointF(handle.left() + offset, handle.bottom() - 2.0),
                QPointF(handle.right() - 2.0, handle.top() + offset),
            )
        if self._hover or self._interaction is not None:
            hint = self._drag_hint_rect()
            painter.setPen(QPen(QColor(255, 255, 255, 42), 1.0))
            painter.setBrush(QColor(8, 12, 19, 154))
            painter.drawRoundedRect(hint, hint.height() / 2.0, hint.height() / 2.0)
            painter.setPen(QColor(235, 242, 252, 188))
            hint_font = self._font_resolver.get(11, 500)
            painter.setFont(hint_font)
            painter.drawText(hint, Qt.AlignmentFlag.AlignCenter, "拖动浮窗")
            # 顶部小握把
            center = hint.center().x()
            painter.setPen(QPen(QColor(255, 255, 255, 108), 1.0))
            for i in (-3.0, 0.0, 3.0):
                painter.drawPoint(QPointF(center - 34.0 + i, hint.center().y()))
        painter.restore()


# ---------------------------------------------------------------------------
# Windows 原生辅助
# ---------------------------------------------------------------------------


def _set_windows_click_through(hwnd: int, enabled: bool) -> None:
    if os.name != "nt" or not hwnd:
        return
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    get_long = user32.GetWindowLongW
    get_long.argtypes = (ctypes.c_void_p, ctypes.c_int)
    get_long.restype = ctypes.c_long
    set_long = user32.SetWindowLongW
    set_long.argtypes = (ctypes.c_void_p, ctypes.c_int, ctypes.c_long)
    set_long.restype = ctypes.c_long
    gwl_exstyle = -20
    ws_ex_transparent = 0x00000020
    style = int(get_long(hwnd, gwl_exstyle))
    if enabled:
        style |= ws_ex_transparent
    else:
        style &= ~ws_ex_transparent
    set_long(hwnd, gwl_exstyle, style)
    swp_nosize = 0x0001
    swp_nomove = 0x0002
    swp_nozorder = 0x0004
    swp_noactivate = 0x0010
    swp_framechanged = 0x0020
    user32.SetWindowPos(
        hwnd,
        None,
        0,
        0,
        0,
        0,
        swp_nosize
        | swp_nomove
        | swp_nozorder
        | swp_noactivate
        | swp_framechanged,
    )


# ---------------------------------------------------------------------------
# 单实例与日志
# ---------------------------------------------------------------------------


class SingleInstance:
    def __init__(self, base_dir: Path):
        digest = hashlib.sha1(str(base_dir).lower().encode("utf-8")).hexdigest()[:16]
        self.name = "danmaku_tts_overlay_%s" % digest
        self.server = QLocalServer()
        self._acquired = False
        self._mutex_handle = None

    def acquire(self) -> bool:
        if os.name == "nt":
            try:
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                create_mutex = kernel32.CreateMutexW
                create_mutex.argtypes = (ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
                create_mutex.restype = ctypes.c_void_p
                close_handle = kernel32.CloseHandle
                close_handle.argtypes = (ctypes.c_void_p,)
                close_handle.restype = ctypes.c_bool
                mutex_name = "Local\\" + self.name
                ctypes.set_last_error(0)
                handle = create_mutex(None, False, mutex_name)
                last_error = ctypes.get_last_error()
                if not handle:
                    LOG.warning("创建浮窗互斥锁失败：%s", mutex_name)
                    return False
                if last_error == 183:  # ERROR_ALREADY_EXISTS
                    close_handle(handle)
                    LOG.warning("已有浮窗进程在运行（互斥锁已存在），本进程退出")
                    return False
                self._mutex_handle = handle
            except Exception:
                LOG.exception("Windows 单实例互斥锁初始化失败")
                return False
        for _ in range(6):
            if self.server.listen(self.name):
                self._acquired = True
                return True
            time.sleep(0.08)
        if self._mutex_handle is not None:
            # 互斥锁已经足够保证单实例；局部命名管道可能被旧会话占用。
            LOG.warning("QLocalServer 不可用，但互斥锁已获取：%s", self.server.errorString())
            self._acquired = True
            return True
        LOG.warning("浮窗单实例锁不可用：%s（%s）", self.name, self.server.errorString())
        return False

    def close(self) -> None:
        if self._acquired:
            try:
                self.server.close()
                QLocalServer.removeServer(self.name)
            except Exception:
                LOG.exception("释放单实例锁失败")
            self._acquired = False
        if self._mutex_handle is not None:
            try:
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                close_handle = kernel32.CloseHandle
                close_handle.argtypes = (ctypes.c_void_p,)
                close_handle.restype = ctypes.c_bool
                close_handle(self._mutex_handle)
            except Exception:
                LOG.exception("释放浮窗互斥锁失败")
            self._mutex_handle = None


def setup_logging(base_dir: Path) -> None:
    log_dir = base_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / "overlay.log"
    handler = RotatingFileHandler(
        path,
        maxBytes=512 * 1024,
        backupCount=2,
        encoding="utf-8",
    )
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-7s [%(threadName)s] %(name)s:%(lineno)d  %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    logging.captureWarnings(True)
    qt_logger = logging.getLogger("qt")

    def _qt_message(mode, context, message):  # noqa: ANN001
        try:
            text = str(message)
            if mode.name in ("QtFatalMsg", "QtCriticalMsg"):
                qt_logger.error("%s", text)
                if mode.name == "QtFatalMsg":
                    logging.shutdown()
            elif mode.name == "QtWarningMsg":
                qt_logger.warning("%s", text)
            else:
                qt_logger.debug("%s", text)
        except Exception:
            pass

    qInstallMessageHandler(_qt_message)

    def _excepthook(exc_type, exc_value, exc_tb):  # noqa: ANN001
        LOG.critical(
            "未捕获异常：\n%s",
            "".join(traceback.format_exception(exc_type, exc_value, exc_tb)),
        )
        logging.shutdown()

    sys.excepthook = _excepthook

    def _thread_excepthook(args):  # noqa: ANN001
        LOG.critical(
            "线程未捕获异常（%s）：\n%s",
            args.thread.name if args.thread else "?",
            "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback)),
        )

    threading.excepthook = _thread_excepthook
    LOG.info("=" * 64)
    LOG.info(
        "启动 overlay_qt.py | Python=%s | PySide6=%s | qt=%s",
        sys.version.split()[0],
        __import__("PySide6").__version__,
        QGuiApplication.platformName() if QGuiApplication.instance() else "?",
    )


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ReadMe Qt 浮窗")
    parser.add_argument("--port", type=int, required=True, help="主程序 IPC TCP 端口")
    parser.add_argument(
        "--base",
        default=str(Path(__file__).resolve().parent),
        help="项目根目录（日志、config.json）",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    try:
        args = parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    base_dir = Path(args.base).expanduser().resolve()
    try:
        setup_logging(base_dir)
    except Exception:
        # pythonw 无控制台；日志目录都建不出来时只能安静退出。
        return 2

    if not (1 <= int(args.port) <= 65535):
        LOG.error("非法 IPC 端口：%s", args.port)
        return 2

    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv[:1])
    app.setApplicationName(APP_TITLE)
    resource_dir = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    icon_path = resource_dir / "assets" / "app.ico"
    if not icon_path.exists():
        icon_path = base_dir / "assets" / "app.ico"
    if icon_path.is_file():
        app.setWindowIcon(QIcon(str(icon_path)))
    app.setQuitOnLastWindowClosed(False)
    try:
        app.setStyleSheet("")
    except Exception:
        pass

    single = SingleInstance(base_dir)
    if not single.acquire():
        LOG.warning("已有浮窗进程在运行，本进程退出")
        return 0

    worker = IpcWorker("127.0.0.1", int(args.port))
    window: Optional[OverlayWindow] = None
    try:
        window = OverlayWindow(base_dir, worker, single)
        window.start()
        worker.start()
        code = app.exec()
    except Exception:
        LOG.exception("浮窗主循环异常")
        code = 1
    finally:
        LOG.info("浮窗退出")
        if window is not None:
            try:
                window.shutdown()
            except Exception:
                LOG.exception("浮窗清理失败")
        try:
            worker.stop()
            worker.wait(1800)
        except Exception:
            LOG.exception("等待 IPC 线程退出失败")
        single.close()
        logging.shutdown()
    return int(code)


if __name__ == "__main__":
    raise SystemExit(main())
