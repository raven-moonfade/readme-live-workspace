# -*- coding: utf-8 -*-
"""Qt-free lane planning fallback for the overlay."""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

PIN_LANES = ("gift", "sc", "guard")
LANE_PRIORITY = ("sc", "gift", "guard")
LANE_EVICTION_ORDER = ("guard", "gift", "sc")


def lane_height(heights: Sequence[float], gap: float) -> float:
    if not heights:
        return 0.0
    return sum(float(value) for value in heights) + float(gap) * max(0, len(heights) - 1)


def lane_totals(
    heights: Mapping[str, float],
    positions: Mapping[str, str],
) -> tuple[float, float, float]:
    top = sum(
        float(heights.get(lane, 0.0))
        for lane in PIN_LANES
        if positions.get(lane, "top") == "top"
    )
    bottom = sum(
        float(heights.get(lane, 0.0))
        for lane in PIN_LANES
        if positions.get(lane, "top") == "bottom"
    )
    return top, bottom, top + bottom


def next_fixed_eviction(counts: Mapping[str, int]) -> tuple[str, str] | None:
    """Return (action, lane) without mutating any window state."""
    for lane in LANE_EVICTION_ORDER:
        if int(counts.get(lane, 0)) > 1:
            return ("trim", lane)
    for lane in LANE_EVICTION_ORDER:
        if int(counts.get(lane, 0)) > 0:
            return ("clear", lane)
    return None


def next_scroll_action(
    count: int,
    total_height: float,
    available_height: float,
    latest_line_limit: int,
    max_lines: int,
) -> str:
    """Return none / drop_oldest / compress_latest / drop_latest."""
    if count <= 0:
        return "none"
    if count > max_lines:
        return "drop_oldest"
    if total_height <= available_height + 0.5:
        return "none"
    if count > 1:
        return "drop_oldest"
    if latest_line_limit > 1:
        return "compress_latest"
    return "drop_latest"


def _local_plan_lanes(
    window_height: int | float,
    pins: dict[str, Any],
    items: dict[str, list[dict[str, Any]]],
    font_size: float = 22,
    item_px_by_lane: dict[str, int] | None = None,
    item_heights_by_lane: dict[str, list[float]] | None = None,
) -> dict[str, Any]:
    """backend.lanes 不可用时的最小等价计划；预算仍由 _relayout 再兜底。"""
    height = max(0, int(window_height))
    try:
        item_px = int(math.ceil(float(font_size) * 1.35)) + 2 * 8 + 2
    except (TypeError, ValueError, OverflowError):
        item_px = 48
    if item_px_by_lane:
        item_px = max(item_px, max(int(value) for value in item_px_by_lane.values()))
    item_px = max(1, item_px)
    gap = 8
    visible: dict[str, list[dict[str, Any]]] = {}
    lane_heights: dict[str, int] = {}
    positions: dict[str, str] = {}
    for lane in PIN_LANES:
        policy = pins.get(lane) if isinstance(pins.get(lane), dict) else {}
        enabled = bool(policy.get("enabled"))
        try:
            maximum = max(0, min(6, int(policy.get("max", 0))))
        except (TypeError, ValueError):
            maximum = 0
        entries = list(items.get(lane, []))
        shown = entries[-maximum:] if enabled and maximum > 0 else []
        visible[lane] = shown
        heights = []
        for value in (item_heights_by_lane or {}).get(lane, []):
            try:
                height = float(value)
            except (TypeError, ValueError, OverflowError):
                continue
            if math.isfinite(height) and height > 0:
                heights.append(height)
        if heights and len(heights) >= len(shown):
            heights = heights[-len(shown):] if shown else []
        elif heights:
            heights = [float(item_px)] * (len(shown) - len(heights)) + heights
        else:
            heights = [float(item_px)] * len(shown)
        lane_heights[lane] = lane_height(heights, gap) if shown else 0
        position = str(policy.get("position", "top"))
        positions[lane] = position if position in ("top", "bottom") else "top"
    top_height = sum(
        lane_heights[lane] for lane in PIN_LANES if positions[lane] == "top"
    )
    bottom_height = sum(
        lane_heights[lane] for lane in PIN_LANES if positions[lane] == "bottom"
    )
    fixed_height = top_height + bottom_height
    return {
        "top_height": top_height,
        "bottom_height": bottom_height,
        "scroll_height": max(0, height - fixed_height),
        "visible": visible,
        "evicted": [],
        "fixed_height": fixed_height,
        "budget": int(min(height * 0.5, fixed_height)),
        "lane_cap": height * 0.4,
        "scroll_min": height * 0.4,
        "gap_px": gap,
        "item_px": item_px,
        "lane_rows": {lane: len(visible[lane]) for lane in PIN_LANES},
        "lane_heights": lane_heights,
    }
