# -*- coding: utf-8 -*-
"""历史场次对比的纯领域校验与投影。"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional


MAX_COMPARE_BASELINES = 3


def normalize_id(value: Any, *, max_length: int = 256) -> Optional[str]:
    """规范化场次 id；空值、非字符串化和超长值返回 None。"""
    text = str(value or "").strip()
    if not text or len(text) > max_length:
        return None
    return text


def finite_epoch(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def comparison_scope(session: Any) -> Optional[Dict[str, str]]:
    """从场次行提取唯一允许的对比范围；不合法时返回 None。"""
    if not session:
        return None
    try:
        platform = str(session["platform"] or "").strip()
        room_key = str(session["room_key"] or "").strip()
    except (KeyError, TypeError):
        return None
    if not platform or not room_key or len(room_key) > 256:
        return None
    return {"platform": platform, "room_key": room_key}


def validate_session(session: Any, role: str) -> Optional[Dict[str, str]]:
    """校验 target / baseline，返回结构化错误或 None。"""
    prefix = str(role or "session")
    if not session:
        return {
            "error_code": prefix + "_not_found",
            "error": "当前场次不存在" if prefix == "target" else "基准场次不存在",
        }
    try:
        ended_at = session["ended_at"]
    except (KeyError, TypeError):
        return {
            "error_code": prefix + "_incomplete",
            "error": "场次缺少结束时间",
        }
    if ended_at is None:
        return {
            "error_code": prefix + "_active",
            "error": "当前场次尚未结束" if prefix == "target" else "基准场次尚未结束",
        }
    if comparison_scope(session) is None:
        return {
            "error_code": prefix + "_incomplete",
            "error": "场次缺少平台或房间标识",
        }
    try:
        started = finite_epoch(session["started_at"])
    except (KeyError, TypeError):
        started = None
    ended = finite_epoch(ended_at)
    if started is None or ended is None or ended < started:
        return {
            "error_code": prefix + "_invalid_time",
            "error": "场次起止时间异常",
        }
    return None


def compare_scope_error(target: Any, baseline: Any) -> Optional[Dict[str, Any]]:
    """校验两边 scope 完全一致，返回可读的 mismatch details。"""
    target_scope = comparison_scope(target)
    baseline_scope = comparison_scope(baseline)
    if target_scope is None or baseline_scope is None:
        return {
            "error_code": "scope_mismatch",
            "error": "场次缺少可比较的房间范围",
            "details": {"mismatch": ["platform", "room_key"]},
        }
    mismatch = []
    if target_scope["platform"] != baseline_scope["platform"]:
        mismatch.append("platform")
    if target_scope["room_key"] != baseline_scope["room_key"]:
        mismatch.append("room_key")
    if not mismatch:
        return None
    return {
        "error_code": "scope_mismatch",
        "error": "只能对比同平台、同房间的场次",
        "details": {
            "mismatch": mismatch,
            "target": {
                "id": target.get("id"),
                "platform": target_scope["platform"],
                "room_key": target_scope["room_key"],
            },
            "baseline": {
                "id": baseline.get("id"),
                "platform": baseline_scope["platform"],
                "room_key": baseline_scope["room_key"],
            },
        },
    }


def relation(target_started_at: float, candidate_started_at: float) -> str:
    if candidate_started_at < target_started_at:
        return "earlier"
    if candidate_started_at > target_started_at:
        return "later"
    return "same_start"


def intervals_overlap(left: Any, right: Any) -> bool:
    """半开区间 [started, ended) 的对称重叠判断。"""
    try:
        left_start = float(left["started_at"])
        left_end = float(left["ended_at"])
        right_start = float(right["started_at"])
        right_end = float(right["ended_at"])
    except (KeyError, TypeError, ValueError):
        return False
    return left_start < right_end and right_start < left_end


def candidate_summary(row: Any, target_started_at: float) -> Dict[str, Any]:
    """把候选行裁剪为轻量摘要，不包含类型或分钟桶。"""
    started = float(row["started_at"])
    ended = float(row["ended_at"])
    keys = set(row.keys()) if hasattr(row, "keys") else set(row)
    filtered = int(row["real_filtered"] or 0) if "real_filtered" in keys else 0
    dropped_total = int(row["real_dropped"] or 0)
    dropped_known = "real_filtered" in keys and row["real_filtered"] is not None
    dropped = max(0, dropped_total - filtered) if dropped_known else dropped_total
    return {
        "id": str(row["id"]),
        "platform": str(row["platform"] or ""),
        "room_key": str(row["room_key"] or ""),
        "room_title": str(row["room_title"] or ""),
        "started_at": started,
        "ended_at": ended,
        "end_reason": row["end_reason"],
        "last_event_at": row["last_event_at"],
        "real_received": int(row["real_received"] or 0),
        "real_spoken": int(row["real_spoken"] or 0),
        "real_dropped": dropped,
        "real_dropped_total": dropped_total,
        "real_filtered": filtered,
        "real_dropped_known": dropped_known,
        "mock_received": int(row["mock_received"] or 0),
        "mock_spoken": int(row["mock_spoken"] or 0),
        "mock_dropped": int(row["mock_dropped"] or 0),
        "unique_users": int(row["unique_users"] or 0),
        "gift_cny": float(row["gift_cny"] or 0),
        "gift_silver": int(row["gift_silver"] or 0),
        "gift_unknown": int(row["gift_unknown"] or 0),
        "super_chat_cny": float(row["super_chat_cny"] or 0),
        "relation": relation(target_started_at, started),
        "distance_seconds": abs(started - target_started_at),
    }
