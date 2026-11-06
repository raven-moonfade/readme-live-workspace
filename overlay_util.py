# -*- coding: utf-8 -*-
"""Neutral constants and value helpers shared by overlay modules."""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any

from PySide6.QtGui import QColor

TYPE_COLORS: dict[str, str] = {
    "danmaku": "#4aa8ff",
    "gift": "#f5c867",
    "super_chat": "#ff6f91",
    "guard": "#a98bff",
    "enter": "#53d6c5",
    "like": "#ff8fb1",
    "social": "#7ddcff",
}
TYPE_NAMES = {
    "danmaku": "弹幕",
    "gift": "礼物",
    "super_chat": "醒目留言",
    "guard": "上舰",
    "enter": "入场",
    "like": "点赞",
    "social": "关注",
}
LANE_LABELS = {
    "gift": "礼物",
    "sc": "醒目留言",
    "guard": "舰长",
    "danmaku": "弹幕",
    "enter": "入场",
    "like": "点赞",
    "social": "关注",
}


def str_value(value: Any, fallback: str = "", limit: int = 1000) -> str:
    text = str(value if value is not None else fallback)
    return text[: max(0, int(limit))]


def positive_int(value: Any, fallback: int = 1) -> int:
    try:
        number = int(float(value))
        return max(1, number)
    except (TypeError, ValueError, OverflowError):
        return fallback


def qcolor(value: Any, fallback: str = "#ffffff") -> QColor:
    color = QColor(str(value or ""))
    if not color.isValid():
        color = QColor(fallback)
    return color


def with_alpha(color: QColor, alpha: float) -> QColor:
    result = QColor(color)
    result.setAlphaF(max(0.0, min(1.0, float(alpha))))
    return result


def clip_codepoints(text: str, limit: int, ellipsis: bool = False) -> str:
    if limit <= 0:
        return ""
    chars = list(str(text or ""))
    if len(chars) <= limit:
        return "".join(chars)
    return "".join(chars[:limit]) + ("…" if ellipsis else "")


def first_glyph(text: str) -> str:
    chars = list((text or "").strip())
    return chars[0] if chars else "观"


def format_price(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return "0"
    if not math.isfinite(number) or number < 0:
        return "0"
    if abs(number - round(number)) < 0.001:
        return str(int(round(number)))
    return ("%.2f" % number).rstrip("0").rstrip(".")


def guard_title(meta: dict[str, Any]) -> str:
    name = str_value(meta.get("guard_name"), "", 100).strip()
    if name:
        return name
    try:
        level = int(meta.get("guard_level") or 0)
    except (TypeError, ValueError):
        level = 0
    return {1: "总督", 2: "提督", 3: "舰长"}.get(level, "大航海")


def parse_badge_bg(value: str) -> QColor:
    match = re.match(
        r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)"
        r"(?:\s*,\s*([\d.]+))?\s*\)",
        str(value),
        re.IGNORECASE,
    )
    if match:
        red = int(float(match.group(1)))
        green = int(float(match.group(2)))
        blue = int(float(match.group(3)))
        alpha = float(match.group(4)) if match.group(4) is not None else 1.0
        return QColor(red, green, blue, int(max(0.0, min(1.0, alpha)) * 255))
    color = QColor(str(value))
    if not color.isValid():
        color = QColor(8, 12, 19, 148)
    return color


def readable_on_dark(value: Any) -> str:
    """Return an accent color that stays visible on a dark badge surface."""
    color = qcolor(value, "#8FE3FF")
    luminance = (
        color.redF() * 0.299 +
        color.greenF() * 0.587 +
        color.blueF() * 0.114
    )
    return "#F7FAFF" if luminance < 0.35 else color.name()


def avatar_colors(user: str, uid: Any) -> tuple[QColor, QColor]:
    key = str(uid) + "|" + str(user)
    try:
        hue = int(hashlib.sha1(key.encode("utf-8")).hexdigest()[:8], 16) % 360
    except Exception:
        hue = abs(hash(key)) % 360
    return QColor.fromHsl(hue, 158, 128), QColor.fromHsl((hue + 42) % 360, 175, 88)
