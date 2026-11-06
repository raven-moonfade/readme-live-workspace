# -*- coding: utf-8 -*-
"""Shared Qt data structures for the overlay renderer.

This module is deliberately dependency-light: it only imports PySide6 types and
contains no configuration, IPC, or rendering logic. Keeping the structures here
lets motion/typography/layout/render modules share types without importing the
overlay window.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from PySide6.QtCore import QRectF, QTimer
from PySide6.QtGui import QColor, QFont, QPainterPath, QPixmap


@dataclass
class _TextCluster:
    text: str
    font: QFont
    color: QColor
    width: float


@dataclass
class _VisualSegment:
    path: QPainterPath
    color: QColor
    fallback_text: str = ""
    fallback_font: Optional[QFont] = None
    fallback_x: float = 0.0
    fallback_baseline: float = 0.0


@dataclass
class _VisualLine:
    baseline: float
    width: float
    segments: list[_VisualSegment] = field(default_factory=list)
    shadow_segments: list[_VisualSegment] = field(default_factory=list)


@dataclass
class _BadgeVisual:
    rect: QRectF
    text: str
    font: QFont
    text_color: QColor
    bg_color: QColor
    border_color: QColor
    radius: float
    strong: bool = False


@dataclass
class _BubbleVisual:
    width: float
    height: float
    radius: float
    pad_left: float
    pad_right: float
    pad_top: float
    pad_bottom: float
    accent_width: float
    avatar_rect: Optional[QRectF]
    avatar_text: str
    avatar_color_a: QColor
    avatar_color_b: QColor
    badges: list[_BadgeVisual]
    lines: list[_VisualLine]
    line_height: float
    header_height: float
    text_left: float
    text_top: float
    bg_color: QColor
    border_color: QColor
    accent_color: QColor
    type_name: str
    theme: str
    font_size: float = 22.0
    pinned: bool = False
    outline: bool = True
    outline_color: QColor = field(default_factory=lambda: QColor("#000000"))
    outline_width: float = 2.0
    shadow: bool = True
    opacity: float = 1.0
    pixmap: Optional[QPixmap] = None
    pixmap_pad: float = 12.0


@dataclass
class _Message:
    seq: str
    kind: str
    user: str
    uid: Any
    text: str
    meta: dict[str, Any]
    created: float
    arrived_at: float = 0.0
    visual: Optional[_BubbleVisual] = None
    visual_key: Any = None
    y: Optional[float] = None
    target_y: float = 0.0
    entering: bool = True
    enter_started: float = 0.0
    enter_motion: Optional[dict[str, Any]] = None
    leaving: bool = False
    leave_started: float = 0.0
    leave_from: float = 1.0
    exit_motion: Optional[dict[str, Any]] = None
    exiting_region: str = ""
    dwell_timer: Optional[QTimer] = None
    pinned: bool = False
    lane: str = ""
    pin_key: str = ""
    pin_price: float = 0.0
    pin_count: int = 1
    pinned_at: float = 0.0
    expires_at: float = 0.0
    pin_timer: Optional[QTimer] = None
    line_limit: int = 3
    suppress_draw: bool = False
