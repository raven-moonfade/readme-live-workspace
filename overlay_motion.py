# -*- coding: utf-8 -*-
"""Motion normalization and sampling helpers for the overlay."""

from __future__ import annotations

import logging
from typing import Any

try:
    from backend.motion import (
        MOTION_DEFAULTS,
        MotionResolver,
        OVERLAY_TYPES,
    )
except Exception:  # pragma: no cover - only for minimal runtime environments
    MOTION_DEFAULTS = {
        "enter_anim": "slide",
        "enter_ms": 220,
        "enter_dir": "right",
        "enter_distance": 0,
        "enter_scale": 90,
        "enter_opacity": 0,
        "exit_anim": "fade",
        "exit_ms": 180,
        "exit_dir": "up",
        "exit_distance": 4,
        "exit_scale": 96,
        "exit_opacity": 0,
    }
    MotionResolver = None  # type: ignore[assignment]
    OVERLAY_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter")


LOG = logging.getLogger("overlay_qt")


def _ease_out_cubic(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1.0 - (1.0 - t) ** 3


def _ease_in_cubic(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * t


def _fallback_motion(source: dict[str, Any]) -> dict[str, dict[str, Any]]:
    base = dict(MOTION_DEFAULTS)
    motion = source.get("motion") if isinstance(source.get("motion"), dict) else {}
    global_src = motion.get("global") if isinstance(motion.get("global"), dict) else {}
    for key in MOTION_DEFAULTS:
        if key in global_src:
            base[key] = global_src[key]
    result: dict[str, dict[str, Any]] = {}
    for kind in OVERLAY_TYPES:
        spec = dict(base)
        override = ((motion.get("types") or {}).get(kind) if isinstance(motion.get("types"), dict) else None)
        if isinstance(override, dict):
            for key in MOTION_DEFAULTS:
                if override.get(key) is not None:
                    spec[key] = override[key]
        result[kind] = spec
    return result


def _normalize_motions(source: dict[str, Any]) -> dict[str, dict[str, Any]]:
    resolved = source.get("resolved_motion")
    if isinstance(resolved, dict) and any(isinstance(resolved.get(kind), dict) for kind in OVERLAY_TYPES):
        fallback = _fallback_motion(source)
        result: dict[str, dict[str, Any]] = {}
        for kind in OVERLAY_TYPES:
            spec = dict(fallback.get(kind) or MOTION_DEFAULTS)
            raw = resolved.get(kind) or {}
            for key in MOTION_DEFAULTS:
                if raw.get(key) is not None:
                    spec[key] = raw[key]
            result[kind] = spec
        return result
    if MotionResolver is not None:
        try:
            return MotionResolver(source).resolve_all()
        except Exception:
            LOG.debug("动效解析失败，退回本地默认", exc_info=True)
    return _fallback_motion(source)
