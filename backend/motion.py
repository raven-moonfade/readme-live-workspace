# -*- coding: utf-8 -*-
"""直播浮窗动效解析与采样。

动效与外观分离：本模块不读取样式字段，也不依赖 Qt。配置保存在
``config.legacy.json`` 的 ``overlay.motion``，消费端只拿到解析后的
``MotionSpec``。
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Mapping

OVERLAY_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter", "like", "social")
MOTION_SCHEMA_VERSION = 1

MOTION_FIELDS = (
    "enter_anim",
    "enter_ms",
    "enter_dir",
    "enter_distance",
    "enter_scale",
    "enter_opacity",
    "exit_anim",
    "exit_ms",
    "exit_dir",
    "exit_distance",
    "exit_scale",
    "exit_opacity",
)

MOTION_CHOICES: Dict[str, tuple[str, ...]] = {
    "enter_anim": ("none", "fade", "slide", "scale"),
    "exit_anim": ("none", "fade", "slide", "scale"),
    "enter_dir": ("left", "right", "up", "down"),
    "exit_dir": ("left", "right", "up", "down"),
}

MOTION_INT_RANGES: Dict[str, tuple[int, int]] = {
    "enter_ms": (0, 2000),
    "exit_ms": (0, 1000),
    "enter_distance": (0, 160),
    "exit_distance": (0, 160),
    "enter_scale": (50, 100),
    "exit_scale": (50, 100),
    "enter_opacity": (0, 100),
    "exit_opacity": (0, 100),
}

MOTION_DEFAULTS: Dict[str, Any] = {
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

# 方向向量表示“相对最终位置的偏移”：
# - 入场时是起点方向（up = 从上方进入，偏移 -y）
# - 退场时是终点方向（up = 向上离开，偏移 -y）
_DIRECTION_VECTORS: Dict[str, tuple[float, float]] = {
    "left": (-1.0, 0.0),
    "right": (1.0, 0.0),
    "up": (0.0, -1.0),
    "down": (0.0, 1.0),
}


def empty_motion_types() -> Dict[str, Dict[str, Any]]:
    return {kind: {field: None for field in MOTION_FIELDS} for kind in OVERLAY_TYPES}


def default_motion() -> Dict[str, Any]:
    return {
        "schema_version": MOTION_SCHEMA_VERSION,
        "global": dict(MOTION_DEFAULTS),
        "types": empty_motion_types(),
    }


def motion_from_legacy(animation: Any) -> Dict[str, Any]:
    """把旧版扁平 animation 映射成完整 motion seed。"""
    name = str(animation or "").strip().lower()
    if name not in ("none", "fade", "slide"):
        name = "slide"
    result = default_motion()
    result["global"].update(
        {
            "enter_anim": name,
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
    )
    return result


def _canonical_kind(kind: str) -> str:
    if kind == "sc":
        return "super_chat"
    if kind in OVERLAY_TYPES:
        return kind
    raise ValueError("unknown overlay type: %s" % kind)


def _normalize_field(name: str, value: Any) -> Any:
    if value is None:
        return None
    if name in MOTION_CHOICES:
        if isinstance(value, str):
            cleaned = value.strip().lower()
            if cleaned in MOTION_CHOICES[name]:
                return cleaned
        return None
    if name in MOTION_INT_RANGES:
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        low, high = MOTION_INT_RANGES[name]
        return max(low, min(high, value))
    return None


def _apply_layer(target: Dict[str, Any], source: Any) -> None:
    if not isinstance(source, Mapping):
        return
    for name in MOTION_FIELDS:
        if name not in source:
            continue
        value = source.get(name)
        if value is None:
            continue
        cleaned = _normalize_field(name, value)
        if cleaned is not None:
            target[name] = cleaned


def _extract_overlay(source: Any) -> Dict[str, Any]:
    value = source if isinstance(source, Mapping) else {}
    if isinstance(value.get("config"), Mapping):
        value = value["config"]
    if isinstance(value.get("overlay"), Mapping):
        value = value["overlay"]
    return dict(value)


def _extract_motion(source: Any) -> Dict[str, Any]:
    overlay = _extract_overlay(source)
    motion = overlay.get("motion")
    if isinstance(motion, Mapping):
        return copy.deepcopy(dict(motion))
    # 兼容直接传入 motion 对象。
    if isinstance(overlay.get("global"), Mapping) and isinstance(overlay.get("types"), Mapping):
        return copy.deepcopy(overlay)
    return motion_from_legacy(overlay.get("animation"))


def normalize_motion(motion: Any) -> Dict[str, Any]:
    """清洗为完整的 global + 五类 types；非法/缺失字段回退默认值。"""
    source = motion if isinstance(motion, Mapping) else {}
    result = default_motion()
    global_src = source.get("global")
    if isinstance(global_src, Mapping):
        _apply_layer(result["global"], global_src)
    types_src = source.get("types")
    if isinstance(types_src, Mapping):
        for kind in OVERLAY_TYPES:
            override = types_src.get(kind)
            if not isinstance(override, Mapping):
                continue
            for field in MOTION_FIELDS:
                if field not in override:
                    continue
                value = override.get(field)
                if value is None:
                    result["types"][kind][field] = None
                else:
                    cleaned = _normalize_field(field, value)
                    if cleaned is not None:
                        result["types"][kind][field] = cleaned
    return result


class MotionResolver:
    """把配置快照解析成五类最终动效。"""

    def __init__(self, config_snapshot: Mapping[str, Any] | None):
        self._motion = normalize_motion(_extract_motion(config_snapshot))
        self._cache: Dict[str, Dict[str, Any]] = {}

    def resolve(self, kind: str) -> Dict[str, Any]:
        canonical = _canonical_kind(kind)
        cached = self._cache.get(canonical)
        if cached is None:
            resolved = dict(self._motion["global"])
            _apply_layer(resolved, self._motion["types"].get(canonical))
            cached = resolved
            self._cache[canonical] = cached
        return copy.deepcopy(cached)

    def resolve_all(self) -> Dict[str, Dict[str, Any]]:
        return {kind: self.resolve(kind) for kind in OVERLAY_TYPES}


def resolve_all(config_snapshot: Mapping[str, Any] | None) -> Dict[str, Dict[str, Any]]:
    return MotionResolver(config_snapshot).resolve_all()


def _ease_out_cubic(value: float) -> float:
    value = max(0.0, min(1.0, float(value)))
    return 1.0 - (1.0 - value) ** 3


def _ease_in_cubic(value: float) -> float:
    value = max(0.0, min(1.0, float(value)))
    return value ** 3


def _direction(name: Any) -> tuple[float, float]:
    return _DIRECTION_VECTORS.get(str(name), (0.0, 0.0))


def _distance(spec: Mapping[str, Any], phase: str, font_size: float) -> float:
    value = spec.get("%s_distance" % phase, 0)
    try:
        distance = max(0.0, float(value))
    except (TypeError, ValueError):
        distance = 0.0
    if phase == "enter" and distance == 0.0:
        return max(24.0, max(10.0, float(font_size)) * 1.35)
    return distance


def sample_enter(
    spec: Mapping[str, Any],
    progress: float,
    font_size: float = 22.0,
) -> Dict[str, float]:
    """返回入场帧的 dx/dy/scale/opacity。"""
    anim = str(spec.get("enter_anim", "none"))
    duration = int(spec.get("enter_ms", 0) or 0)
    if anim == "none" or duration <= 0 or progress >= 1.0:
        return {"dx": 0.0, "dy": 0.0, "scale": 1.0, "opacity": 1.0}
    eased = _ease_out_cubic(progress)
    start_opacity = max(0.0, min(100.0, float(spec.get("enter_opacity", 0)))) / 100.0
    opacity = start_opacity + (1.0 - start_opacity) * eased
    scale = 1.0
    if anim == "scale":
        start_scale = max(50.0, min(100.0, float(spec.get("enter_scale", 100)))) / 100.0
        scale = start_scale + (1.0 - start_scale) * eased
    dx = 0.0
    dy = 0.0
    if anim == "slide":
        vx, vy = _direction(spec.get("enter_dir", "right"))
        distance = _distance(spec, "enter", font_size)
        dx = vx * distance * (1.0 - eased)
        dy = vy * distance * (1.0 - eased)
    return {"dx": dx, "dy": dy, "scale": scale, "opacity": opacity}


def sample_exit(
    spec: Mapping[str, Any],
    progress: float,
    font_size: float = 22.0,
) -> Dict[str, float]:
    """返回退场帧的 dx/dy/scale/opacity。"""
    anim = str(spec.get("exit_anim", "none"))
    duration = int(spec.get("exit_ms", 0) or 0)
    if anim == "none" or duration <= 0:
        return {"dx": 0.0, "dy": 0.0, "scale": 1.0, "opacity": 0.0 if anim != "none" else 1.0}
    eased = _ease_in_cubic(progress)
    end_opacity = max(0.0, min(100.0, float(spec.get("exit_opacity", 0)))) / 100.0
    opacity = 1.0 - (1.0 - end_opacity) * eased
    scale = 1.0
    if anim == "scale":
        end_scale = max(50.0, min(100.0, float(spec.get("exit_scale", 100)))) / 100.0
        scale = 1.0 + (end_scale - 1.0) * eased
    vx, vy = _direction(spec.get("exit_dir", "up"))
    distance = _distance(spec, "exit", font_size)
    dx = vx * distance * eased
    dy = vy * distance * eased
    return {"dx": dx, "dy": dy, "scale": scale, "opacity": opacity}


def reduced_motion_spec(spec: Mapping[str, Any], phase: str) -> Dict[str, Any]:
    """系统减少动态效果时的安全规格；原本 none 仍保持 none。"""
    result = dict(MOTION_DEFAULTS)
    result.update({key: spec.get(key, result[key]) for key in MOTION_FIELDS})
    anim_key = "%s_anim" % phase
    ms_key = "%s_ms" % phase
    if result.get(anim_key) != "none":
        result[anim_key] = "fade"
        result[ms_key] = min(80, max(0, int(result.get(ms_key, 0) or 0)))
        result["%s_distance" % phase] = 0
        result["%s_scale" % phase] = 100
    return result


def all_none(motions: Mapping[str, Mapping[str, Any]]) -> bool:
    for spec in motions.values():
        if spec.get("enter_anim") != "none" or spec.get("exit_anim") != "none":
            return False
    return True

