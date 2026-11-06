# -*- coding: utf-8 -*-
"""固定 pin lane 的纯函数预算与淘汰计算。

实现 DECISION-v2.md §6 / lane-policy.md：
- 固定区预算 = min(窗口高 50%, 各 lane 需求和)
- 单 lane <= 窗口高 40%
- 滚动区 >= 窗口高 40%
- 固定区不足时先压缩间距 8 -> 6 -> 4，再按 guard -> gift -> sc 淘汰最旧项

条目列表约定为“旧 -> 新”；可见项保留尾部（最新贴近边缘）。
"""

from __future__ import annotations

import copy
import math
from collections.abc import Mapping, Sequence
from typing import Any, Dict, List

LANES = ("gift", "sc", "guard")
PRIORITY = ("sc", "gift", "guard")
EVICTION_ORDER = ("guard", "gift", "sc")
GAP_CANDIDATES = (8, 6, 4)
DEFAULT_POSITIONS = {"sc": "top", "gift": "top", "guard": "bottom"}


def item_px_for_font(font_size: float) -> int:
    """lane-policy 的唯一单行高度公式。"""
    try:
        font = float(font_size)
    except (TypeError, ValueError):
        font = 22.0
    if not math.isfinite(font) or font <= 0:
        font = 22.0
    return int(math.ceil(font * 1.35)) + 2 * 8 + 2


def _lane_config(pins: Mapping[str, Any], lane: str) -> Dict[str, Any]:
    raw: Any = None
    if isinstance(pins, Mapping):
        raw = pins.get(lane)
        if raw is None and lane == "sc":
            raw = pins.get("super_chat")
    if not isinstance(raw, Mapping):
        raw = {}
    try:
        maximum = int(raw.get("max", 0))
    except (TypeError, ValueError):
        maximum = 0
    maximum = max(0, min(6, maximum))
    position = raw.get("position", DEFAULT_POSITIONS[lane])
    if position not in ("top", "bottom"):
        position = DEFAULT_POSITIONS[lane]
    return {
        "enabled": bool(raw.get("enabled", False)),
        "max": maximum,
        "position": position,
    }


def _group_items(items: Any) -> Dict[str, List[Any]]:
    grouped: Dict[str, List[Any]] = {lane: [] for lane in LANES}
    if isinstance(items, Mapping):
        for lane in LANES:
            source = items.get(lane)
            if source is None and lane == "sc":
                source = items.get("super_chat")
            if isinstance(source, Sequence) and not isinstance(source, (str, bytes, bytearray)):
                grouped[lane] = list(source)
        return grouped
    if isinstance(items, Sequence) and not isinstance(items, (str, bytes, bytearray)):
        for item in items:
            kind = item.get("type") if isinstance(item, Mapping) else None
            if kind in grouped:
                grouped[kind].append(item)
            elif kind == "super_chat":
                grouped["sc"].append(item)
    return grouped


def _entry_id(item: Any, lane: str, index: int) -> str:
    if isinstance(item, Mapping):
        for key in ("id", "message_id", "seq"):
            value = item.get(key)
            if value is not None:
                return str(value)
    return "%s:%d" % (lane, index)


def _demand(rows: Mapping[str, int], gap: int, item_px_by_lane: Mapping[str, int]) -> int:
    total = 0
    for lane in LANES:
        count = max(0, int(rows.get(lane, 0)))
        if count:
            item_px = int(item_px_by_lane.get(lane, 1))
            total += count * item_px + (count - 1) * gap
    return total


def _exact_heights(
    item_heights_by_lane: Mapping[str, Sequence[float]] | None,
    grouped: Mapping[str, Sequence[Any]],
    item_px_by_lane: Mapping[str, int],
) -> Dict[str, List[float]]:
    """把逐条高度对齐到“旧 -> 新”条目；缺失项用该 lane 的估算行高补齐。"""
    result: Dict[str, List[float]] = {}
    if not isinstance(item_heights_by_lane, Mapping):
        return result
    for lane in LANES:
        raw = item_heights_by_lane.get(lane)
        if raw is None and lane == "sc":
            raw = item_heights_by_lane.get("super_chat")
        if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes, bytearray)):
            continue
        heights: List[float] = []
        for value in raw:
            try:
                height = float(value)
            except (TypeError, ValueError, OverflowError):
                height = 0.0
            if not math.isfinite(height) or height <= 0:
                height = 0.0
            heights.append(height)
        if not heights:
            continue
        count = len(grouped.get(lane, []))
        fallback = float(item_px_by_lane.get(lane, 1))
        heights = [height if height > 0 else fallback for height in heights]
        if count <= 0:
            result[lane] = []
        elif len(heights) >= count:
            result[lane] = heights[-count:]
        else:
            result[lane] = [fallback] * (count - len(heights)) + heights
    return result


def _lane_demand(
    lane: str,
    count: int,
    gap: int,
    item_px_by_lane: Mapping[str, int],
    exact_heights: Mapping[str, Sequence[float]],
) -> float:
    count = max(0, int(count))
    if count <= 0:
        return 0.0
    heights = exact_heights.get(lane)
    if not heights:
        return count * float(item_px_by_lane.get(lane, 1)) + (count - 1) * gap
    selected = list(heights[-count:])
    return sum(selected) + (len(selected) - 1) * gap


def _demand_exact(
    rows: Mapping[str, int],
    gap: int,
    item_px_by_lane: Mapping[str, int],
    exact_heights: Mapping[str, Sequence[float]],
) -> float:
    return sum(
        _lane_demand(lane, int(rows.get(lane, 0)), gap, item_px_by_lane, exact_heights)
        for lane in LANES
    )


def _cap_rows_exact(
    lane: str,
    base_rows: int,
    lane_cap: float,
    gap: int,
    item_px_by_lane: Mapping[str, int],
    exact_heights: Mapping[str, Sequence[float]],
) -> int:
    for count in range(max(0, int(base_rows)), 0, -1):
        if _lane_demand(lane, count, gap, item_px_by_lane, exact_heights) <= lane_cap + 0.001:
            return count
    return 0


def _choose_candidate(
    base_rows: Mapping[str, int],
    budget: int | float,
    lane_cap: float,
    item_px_by_lane: Mapping[str, int],
    exact_heights: Mapping[str, Sequence[float]] | None = None,
) -> Dict[str, Any]:
    candidates: List[Dict[str, Any]] = []
    exact_heights = exact_heights or {}
    for gap_index, gap in enumerate(GAP_CANDIDATES):
        rows = {}
        for lane in LANES:
            if lane in exact_heights:
                cap_rows = _cap_rows_exact(
                    lane,
                    int(base_rows.get(lane, 0)),
                    lane_cap,
                    gap,
                    item_px_by_lane,
                    exact_heights,
                )
            else:
                item_px = int(item_px_by_lane.get(lane, 1))
                cap_rows = int(math.floor((lane_cap + gap) / float(item_px + gap)))
            rows[lane] = max(0, min(int(base_rows.get(lane, 0)), cap_rows))
        evictions = sum(max(0, int(base_rows.get(lane, 0)) - rows[lane]) for lane in LANES)
        used = (
            _demand_exact(rows, gap, item_px_by_lane, exact_heights)
            if exact_heights
            else _demand(rows, gap, item_px_by_lane)
        )

        # 先保留每条启用 lane 至少 1 行，削低优先级的“多余行”。
        while used > budget:
            lane = next((name for name in EVICTION_ORDER if rows[name] > 1), None)
            if lane is None:
                break
            rows[lane] -= 1
            evictions += 1
            used = (
                _demand_exact(rows, gap, item_px_by_lane, exact_heights)
                if exact_heights
                else _demand(rows, gap, item_px_by_lane)
            )

        # 仍超预算才整条抑制。
        while used > budget:
            lane = next((name for name in EVICTION_ORDER if rows[name] > 0), None)
            if lane is None:
                break
            evictions += rows[lane]
            rows[lane] = 0
            used = (
                _demand_exact(rows, gap, item_px_by_lane, exact_heights)
                if exact_heights
                else _demand(rows, gap, item_px_by_lane)
            )

        candidates.append(
            {
                "gap": gap,
                "gap_index": gap_index,
                "rows": rows,
                "used": used,
                "evictions": evictions,
            }
        )

    # 淘汰最少 > 压缩最少 > 更充分使用预算
    return min(candidates, key=lambda candidate: (
        candidate["evictions"],
        candidate["gap_index"],
        -candidate["used"],
    ))


def plan_lanes(
    window_height: int | float,
    pins: Mapping[str, Any],
    items: Mapping[str, Sequence[Any]] | Sequence[Any] | None = None,
    *,
    font_size: float = 22,
    item_px: int | None = None,
    item_px_by_lane: Mapping[str, int] | None = None,
    item_heights_by_lane: Mapping[str, Sequence[float]] | None = None,
) -> Dict[str, Any]:
    """返回固定 lane 的高度、可见条目与淘汰 id。"""
    try:
        height = int(window_height)
    except (TypeError, ValueError):
        height = 0
    height = max(0, height)
    default_item_height = int(item_px) if item_px is not None else item_px_for_font(font_size)
    default_item_height = max(1, default_item_height)
    per_lane = {
        lane: max(
            1,
            int(item_px_by_lane.get(lane, default_item_height))
            if isinstance(item_px_by_lane, Mapping)
            else default_item_height,
        )
        for lane in LANES
    }

    configs = {lane: _lane_config(pins, lane) for lane in LANES}
    grouped = _group_items(items)
    exact_heights = _exact_heights(item_heights_by_lane, grouped, per_lane)
    base_rows = {
        lane: (
            min(configs[lane]["max"], len(grouped[lane]))
            if configs[lane]["enabled"]
            else 0
        )
        for lane in LANES
    }
    raw_demand = (
        _demand_exact(base_rows, GAP_CANDIDATES[0], per_lane, exact_heights)
        if exact_heights
        else _demand(base_rows, GAP_CANDIDATES[0], per_lane)
    )
    fixed_budget_cap = height * 0.5
    budget_value = min(fixed_budget_cap, raw_demand)
    # 逐条高度是浮点像素，不能先截断再比较，否则单条 94.2px 会因 94px 预算
    # 被误判为超限并整条抑制。
    budget = budget_value if exact_heights else int(budget_value)
    lane_cap = height * 0.4
    scroll_min = height * 0.4

    candidate = _choose_candidate(base_rows, budget, lane_cap, per_lane, exact_heights)
    gap = int(candidate["gap"])
    allocated_rows: Dict[str, int] = dict(candidate["rows"])
    capacity_heights = {
        lane: (
            _lane_demand(lane, allocated_rows[lane], gap, per_lane, exact_heights)
            if allocated_rows[lane] > 0
            else 0
        )
        for lane in LANES
    }

    visible: Dict[str, List[Any]] = {lane: [] for lane in LANES}
    evicted: List[str] = []
    for lane in EVICTION_ORDER:
        entries = grouped[lane]
        limit = allocated_rows[lane] if configs[lane]["enabled"] else 0
        if limit > 0:
            visible[lane] = [copy.deepcopy(item) for item in entries[-limit:]]
        removed_count = max(0, len(entries) - len(visible[lane]))
        for index, entry in enumerate(entries[:removed_count]):
            evicted.append(_entry_id(entry, lane, index))

    # 输出高度按实际可见行计算；没有条目的 lane 不占空高度。
    actual_rows = {lane: len(visible[lane]) for lane in LANES}
    lane_heights = {
        lane: (
            _lane_demand(lane, actual_rows[lane], gap, per_lane, exact_heights)
            if actual_rows[lane] > 0
            else 0
        )
        for lane in LANES
    }
    top_height = sum(lane_heights[lane] for lane in LANES if configs[lane]["position"] == "top")
    bottom_height = sum(lane_heights[lane] for lane in LANES if configs[lane]["position"] == "bottom")
    fixed_height = top_height + bottom_height
    scroll_height = max(0, height - fixed_height)

    # 预算算法本身已保证；这里再做一次硬断言式收敛，避免浮点/边界配置破坏下限。
    if exact_heights and scroll_height < scroll_min and fixed_height:
        for lane in EVICTION_ORDER:
            while visible[lane]:
                actual_rows = {name: len(visible[name]) for name in LANES}
                lane_heights = {
                    name: (
                        _lane_demand(name, actual_rows[name], gap, per_lane, exact_heights)
                        if actual_rows[name] > 0
                        else 0
                    )
                    for name in LANES
                }
                top_height = sum(
                    lane_heights[name]
                    for name in LANES
                    if configs[name]["position"] == "top"
                )
                bottom_height = sum(
                    lane_heights[name]
                    for name in LANES
                    if configs[name]["position"] == "bottom"
                )
                fixed_height = top_height + bottom_height
                scroll_height = max(0, height - fixed_height)
                if scroll_height >= scroll_min - 0.001:
                    break
                removed = visible[lane].pop(0)
                evicted.append(_entry_id(removed, lane, len(visible[lane])))
        actual_rows = {lane: len(visible[lane]) for lane in LANES}
        lane_heights = {
            lane: (
                _lane_demand(lane, actual_rows[lane], gap, per_lane, exact_heights)
                if actual_rows[lane] > 0
                else 0
            )
            for lane in LANES
        }
        top_height = sum(
            lane_heights[lane] for lane in LANES if configs[lane]["position"] == "top"
        )
        bottom_height = sum(
            lane_heights[lane] for lane in LANES if configs[lane]["position"] == "bottom"
        )
        fixed_height = top_height + bottom_height
        scroll_height = max(0, height - fixed_height)
    elif scroll_height < scroll_min and fixed_height:
        overflow = int(math.ceil(scroll_min - scroll_height))
        for lane in EVICTION_ORDER:
            while visible[lane] and overflow > 0:
                removed = visible[lane].pop(0)
                evicted.append(_entry_id(removed, lane, len(visible[lane])))
                overflow -= per_lane[lane] + (gap if visible[lane] else 0)
        actual_rows = {lane: len(visible[lane]) for lane in LANES}
        lane_heights = {
            lane: (
                actual_rows[lane] * per_lane[lane] + (actual_rows[lane] - 1) * gap
                if actual_rows[lane] > 0
                else 0
            )
            for lane in LANES
        }
        top_height = sum(lane_heights[lane] for lane in LANES if configs[lane]["position"] == "top")
        bottom_height = sum(lane_heights[lane] for lane in LANES if configs[lane]["position"] == "bottom")
        fixed_height = top_height + bottom_height
        scroll_height = max(0, height - fixed_height)

    return {
        "top_height": top_height,
        "bottom_height": bottom_height,
        "scroll_height": scroll_height,
        "evicted": evicted,
        "visible": visible,
        "fixed_height": fixed_height,
        "budget": budget,
        "lane_cap": lane_cap,
        "scroll_min": scroll_min,
        "gap_px": gap,
        "item_px": max(per_lane.values()) if per_lane else default_item_height,
        "item_px_by_lane": per_lane,
        "lane_rows": actual_rows,
        "capacity_rows": allocated_rows,
        "lane_heights": lane_heights,
        "capacity_heights": capacity_heights,
    }


class LanePlanner:
    """可复用的预算器；分辨率或字号变化时重新创建即可。"""

    def __init__(
        self,
        font_size: float = 22,
        item_px: int | None = None,
        item_px_by_lane: Mapping[str, int] | None = None,
        item_heights_by_lane: Mapping[str, Sequence[float]] | None = None,
    ):
        self.font_size = font_size
        self.item_px = item_px
        self.item_px_by_lane = dict(item_px_by_lane) if item_px_by_lane else None
        self.item_heights_by_lane = (
            {lane: list(heights) for lane, heights in item_heights_by_lane.items()}
            if item_heights_by_lane
            else None
        )

    def plan(
        self,
        window_height: int | float,
        pins: Mapping[str, Any],
        items: Mapping[str, Sequence[Any]] | Sequence[Any] | None = None,
    ) -> Dict[str, Any]:
        return plan_lanes(
            window_height,
            pins,
            items,
            font_size=self.font_size,
            item_px=self.item_px,
            item_px_by_lane=self.item_px_by_lane,
            item_heights_by_lane=self.item_heights_by_lane,
        )


# 更直观的别名，便于 UI/预览代码按语义调用。
compute_lanes = plan_lanes
layout_lanes = plan_lanes
