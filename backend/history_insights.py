# -*- coding: utf-8 -*-
"""历史场次事实型复盘：同房间基线、名次与记录内峰值。"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional


DEFINITIONS_VERSION = 1
LOOKBACK_N = 20
WINDOW_DAYS = 365
MIN_MEDIAN_N = 8
MIN_IQR_N = 12
MIN_PEAK_COHORT_N = 12
PEAK_WINDOW_MIN = 5
MAX_SESSION_SECONDS = 7 * 86400
_FUTURE_TOLERANCE_SECONDS = 300

_INCOMPLETE_REASONS = {"stale", "interrupted", "connect_failed"}
_KNOWN_REASONS = {"finished", "manual_disconnect", "shutdown", "replaced"}


def finite_epoch(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def session_duration(session: Any) -> float:
    started = finite_epoch(session.get("started_at") if isinstance(session, dict) else session["started_at"])
    ended = finite_epoch(session.get("ended_at") if isinstance(session, dict) else session["ended_at"])
    if started is None or ended is None:
        return 0.0
    return max(0.0, ended - started)


def _field(session: Any, key: str, default: Any = None) -> Any:
    try:
        return session[key]
    except (KeyError, TypeError):
        return default


def target_flags(session: Any, as_of: Optional[float] = None) -> List[str]:
    flags: List[str] = []
    started = finite_epoch(_field(session, "started_at"))
    ended = finite_epoch(_field(session, "ended_at"))
    received = int(_field(session, "real_received", 0) or 0)
    reason = str(_field(session, "end_reason", "") or "").strip()
    if (started is None or ended is None or started <= 0 or ended <= started or
            started >= 1000000000000 or ended >= 1000000000000 or
            ended - started > MAX_SESSION_SECONDS or
            (as_of is not None and (
                started > float(as_of) + _FUTURE_TOLERANCE_SECONDS or
                ended > float(as_of) + _FUTURE_TOLERANCE_SECONDS
            ))):
        flags.append("target_invalid_time")
    if session_duration(session) < 600 or received < 20:
        flags.append("target_short")
    if reason in _INCOMPLETE_REASONS or reason not in _KNOWN_REASONS:
        flags.append("target_incomplete")
    if int(_field(session, "mock_received", 0) or 0) + int(
        _field(session, "mock_spoken", 0) or 0
    ) + int(_field(session, "mock_dropped", 0) or 0) > 0:
        flags.append("target_mock_mixed")
    spoken = int(_field(session, "real_spoken", 0) or 0)
    dropped = int(_field(session, "real_dropped", 0) or 0)
    if spoken + dropped > received:
        flags.append("target_spoken_drop_overlap")
    return flags


def target_qualified(session: Any, as_of: Optional[float] = None) -> bool:
    flags = set(target_flags(session, as_of=as_of))
    return not ({"target_invalid_time", "target_short", "target_incomplete"} & flags)


def _minutes_map(minutes: Iterable[Any]) -> Dict[int, int]:
    values: Dict[int, int] = {}
    for item in minutes or []:
        try:
            minute = int(item.get("minute"))
            count = int(item.get("count"))
        except (AttributeError, TypeError, ValueError):
            return {}
        if minute < 0 or count < 0:
            return {}
        values[minute] = values.get(minute, 0) + count
    return values


def peak_stats(
    session: Any,
    minutes: Iterable[Any],
    *,
    window_min: int = PEAK_WINDOW_MIN,
    as_of: Optional[float] = None,
) -> Dict[str, Any]:
    """计算会话内滚动窗口峰值；分钟数据不完整时返回不可用。"""
    started = finite_epoch(_field(session, "started_at"))
    ended = finite_epoch(_field(session, "ended_at"))
    received = int(_field(session, "real_received", 0) or 0)
    if (started is None or ended is None or ended <= started or
            started >= 1000000000000 or ended >= 1000000000000 or
            (as_of is not None and (
                started > float(as_of) + _FUTURE_TOLERANCE_SECONDS or
                ended > float(as_of) + _FUTURE_TOLERANCE_SECONDS
            ))):
        return {"available": False, "reason": "invalid_time", "minute_complete": False}
    if ended - started > MAX_SESSION_SECONDS:
        return {"available": False, "reason": "duration_too_long", "minute_complete": False}
    start_minute = int(started // 60)
    end_minute = max(start_minute + 1, int(math.ceil(ended / 60.0)))
    duration_minutes = end_minute - start_minute
    minute_map = _minutes_map(minutes)
    total = sum(minute_map.values())
    in_range = all(start_minute <= minute < end_minute for minute in minute_map)
    complete = bool(minute_map) and total == received and in_range
    if not complete:
        return {
            "available": False,
            "reason": "minute_incomplete",
            "minute_complete": False,
            "minute_total": total,
        }
    if ended - started < window_min * 60 or duration_minutes < window_min:
        return {
            "available": False,
            "reason": "short_duration",
            "minute_complete": True,
            "minute_total": total,
        }
    best_offset = 0
    best_count = -1
    for offset in range(0, duration_minutes - window_min + 1):
        count = sum(
            minute_map.get(start_minute + offset + index, 0)
            for index in range(window_min)
        )
        if count > best_count:
            best_count = count
            best_offset = offset
    window_start_epoch = float((start_minute + best_offset) * 60)
    window_end_epoch = window_start_epoch + window_min * 60
    start_local = datetime.fromtimestamp(window_start_epoch)
    end_local = datetime.fromtimestamp(window_end_epoch)
    return {
        "available": True,
        "reason": None,
        "minute_complete": True,
        "minute_total": total,
        "count": int(max(0, best_count)),
        "offset_start_min": int(best_offset),
        "offset_end_min": int(best_offset + window_min),
        "window_start_epoch": window_start_epoch,
        "window_end_epoch": window_end_epoch,
        "start_local": start_local.strftime("%H:%M"),
        "end_local": end_local.strftime("%H:%M"),
        "hour": int(start_local.hour),
        "day": start_local.strftime("%Y-%m-%d"),
        "end_day": end_local.strftime("%Y-%m-%d"),
        "crosses_day": start_local.date() != end_local.date(),
    }


def session_metrics(session: Any, peak: Dict[str, Any]) -> Dict[str, Any]:
    duration = session_duration(session)
    received = int(_field(session, "real_received", 0) or 0)
    spoken = int(_field(session, "real_spoken", 0) or 0)
    dropped = int(_field(session, "real_dropped", 0) or 0)
    hours = duration / 3600.0
    return {
        "duration_seconds": duration,
        "real_received": received,
        "real_spoken": spoken,
        "real_dropped": dropped,
        "received_per_hour": round(received / hours, 6) if hours > 0 else None,
        "spoken_rate": (spoken / received) if received > 0 else None,
        "drop_rate": (dropped / received) if received > 0 else None,
        "peak_5m": peak.get("count") if peak.get("available") else None,
        "minute_complete": bool(peak.get("minute_complete")),
    }


def overlap(left_start: float, left_end: float, right_start: float, right_end: float) -> bool:
    return left_start < right_end and right_start < left_end


def metric_cohort(
    target: Any,
    candidates: Iterable[Any],
    minutes_by_id: Dict[str, Iterable[Any]],
) -> Dict[str, Any]:
    target_start = finite_epoch(_field(target, "started_at")) or 0.0
    target_end = finite_epoch(_field(target, "ended_at")) or target_start
    accepted: List[Dict[str, Any]] = []
    excluded = {"invalid": 0, "incomplete": 0, "short": 0, "overlap": 0}
    mock_sessions = 0
    replaced_sessions = 0
    for session in list(candidates or [])[:LOOKBACK_N]:
        started = finite_epoch(_field(session, "started_at"))
        ended = finite_epoch(_field(session, "ended_at"))
        if (started is None or ended is None or started <= 0 or ended <= started):
            excluded["invalid"] += 1
            continue
        if ended - started > MAX_SESSION_SECONDS or ended >= 1000000000000:
            excluded["invalid"] += 1
            continue
        reason = str(_field(session, "end_reason", "") or "").strip()
        if reason in _INCOMPLETE_REASONS or reason not in _KNOWN_REASONS:
            excluded["incomplete"] += 1
            continue
        if ended - started < 600 or int(_field(session, "real_received", 0) or 0) < 20:
            excluded["short"] += 1
            continue
        if overlap(started, ended, target_start, target_end) or any(
            overlap(started, ended, item["started_at"], item["ended_at"])
            for item in accepted
        ):
            excluded["overlap"] += 1
            continue
        peak = peak_stats(session, minutes_by_id.get(str(_field(session, "id", "")), []))
        metrics = session_metrics(session, peak)
        mock_count = sum(int(_field(session, key, 0) or 0) for key in (
            "mock_received", "mock_spoken", "mock_dropped"
        ))
        if mock_count > 0:
            mock_sessions += 1
        if reason == "replaced":
            replaced_sessions += 1
        accepted.append({
            "id": str(_field(session, "id", "")),
            "started_at": started,
            "ended_at": ended,
            "end_reason": reason,
            "metrics": metrics,
            "peak": peak,
            "mock_events": mock_count,
        })
    peak_valid = [item for item in accepted if item["peak"].get("minute_complete")]
    return {
        "accepted": accepted,
        "excluded": excluded,
        "mock_sessions": mock_sessions,
        "replaced_sessions": replaced_sessions,
        "valid_count": len(accepted),
        "peak_valid_count": len(peak_valid),
        "earliest": min((item["started_at"] for item in accepted), default=None),
        "latest": max((item["started_at"] for item in accepted), default=None),
    }


def quantile(values: Iterable[float], q: float) -> Optional[float]:
    ordered = sorted(float(value) for value in values if value is not None)
    if not ordered:
        return None
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * max(0.0, min(1.0, q))
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    ratio = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * ratio


def rank_stats(values: Iterable[float], current: Optional[float]) -> Dict[str, Any]:
    if current is None:
        return {
            "n": 0,
            "higher_count": 0,
            "tied_count": 0,
            "lower_count": 0,
        }
    clean = [float(value) for value in values if value is not None]
    higher = sum(1 for value in clean if value > current and not math.isclose(value, current, rel_tol=1e-12, abs_tol=1e-12))
    tied = sum(1 for value in clean if math.isclose(value, current, rel_tol=1e-12, abs_tol=1e-12))
    lower = len(clean) - higher - tied
    return {
        "n": len(clean),
        "higher_count": higher,
        "tied_count": tied,
        "lower_count": lower,
    }


def build_insights(
    target: Any,
    candidates: Iterable[Any],
    minutes_by_id: Dict[str, Iterable[Any]],
    *,
    as_of: float,
    timezone_name: str,
    utc_offset_seconds: int,
) -> Dict[str, Any]:
    candidate_list = list(candidates or [])
    target_quality_flags = target_flags(target, as_of=as_of)
    target_peak = peak_stats(
        target,
        minutes_by_id.get(str(_field(target, "id", "")), []),
        as_of=as_of,
    )
    target_metric_values = session_metrics(target, target_peak)
    cohort = metric_cohort(target, candidate_list, minutes_by_id)
    accepted = cohort["accepted"]
    valid_values = [
        item["metrics"]["received_per_hour"]
        for item in accepted
        if item["metrics"]["received_per_hour"] is not None
    ]
    qualified = target_qualified(target, as_of=as_of)
    reason = None
    insights_available = False
    if not qualified:
        reason = "target_unqualified"
    elif cohort["valid_count"] < MIN_MEDIAN_N:
        reason = "insufficient_sample"
    else:
        insights_available = True

    current_rate = target_metric_values["received_per_hour"]
    rank = rank_stats(valid_values, current_rate)
    metric = {
        "key": "received_per_hour",
        "domain": "rate_per_hour",
        "available": bool(insights_available and current_rate is not None),
        "reason": None if insights_available and current_rate is not None else reason,
        "current": current_rate,
        "sample_count": len(valid_values),
        "median": quantile(valid_values, 0.5) if insights_available else None,
        "p25": quantile(valid_values, 0.25) if insights_available and len(valid_values) >= MIN_IQR_N else None,
        "p75": quantile(valid_values, 0.75) if insights_available and len(valid_values) >= MIN_IQR_N else None,
        **rank,
    }

    peak_hours: Dict[int, int] = {}
    for item in accepted:
        peak = item["peak"]
        if peak.get("minute_complete") and peak.get("available"):
            hour = int(peak["hour"])
            peak_hours[hour] = peak_hours.get(hour, 0) + 1
    cohort_hours = [
        {"hour": hour, "count": count}
        for hour, count in sorted(peak_hours.items(), key=lambda item: (-item[1], item[0]))
    ]

    quality_flags: List[str] = []
    quality_flags.extend(target_quality_flags)
    if not target_peak.get("minute_complete"):
        quality_flags.append("target_minute_incomplete")
    if cohort["mock_sessions"]:
        quality_flags.append("cohort_mock_mixed")
    if cohort["replaced_sessions"]:
        quality_flags.append("cohort_replaced_sessions")
    if 8 <= cohort["valid_count"] < LOOKBACK_N:
        quality_flags.append("cohort_limited")
    if any(cohort["excluded"].values()):
        quality_flags.append("cohort_excluded")
    return {
        "ok": True,
        "available": True,
        "api_version": 1,
        "definitions_version": DEFINITIONS_VERSION,
        "as_of": float(as_of),
        "timezone": timezone_name,
        "utc_offset_seconds": int(utc_offset_seconds),
        "insights_available": insights_available,
        "reason": reason,
        "scope": {
            "platform": str(_field(target, "platform", "") or ""),
            "room_key": str(_field(target, "room_key", "") or ""),
        },
        "target": {
            "id": str(_field(target, "id", "")),
            "room_title": str(_field(target, "room_title", "") or ""),
            "started_at": _field(target, "started_at"),
            "ended_at": _field(target, "ended_at"),
            "end_reason": _field(target, "end_reason"),
            "real_received": int(_field(target, "real_received", 0) or 0),
            "real_spoken": int(_field(target, "real_spoken", 0) or 0),
            "real_dropped": int(_field(target, "real_dropped", 0) or 0),
        },
        "target_quality": {
            "qualified": qualified,
            "flags": target_quality_flags,
            "minute_complete": bool(target_peak.get("minute_complete")),
        },
        "target_metrics": {
            "received_per_hour": target_metric_values["received_per_hour"],
            "spoken_rate": target_metric_values["spoken_rate"],
            "drop_rate": target_metric_values["drop_rate"],
            "duration_seconds": target_metric_values["duration_seconds"],
        },
        "window": {
            "lookback_n": LOOKBACK_N,
            "window_days": WINDOW_DAYS,
            "relative_to": "target_started_at",
        },
        "metric_cohort": {
            "candidate_count": min(len(candidate_list), LOOKBACK_N),
            "valid_count": cohort["valid_count"],
            "excluded": cohort["excluded"],
            "mock_sessions": cohort["mock_sessions"],
            "replaced_sessions": cohort["replaced_sessions"],
            "limited": 8 <= cohort["valid_count"] < LOOKBACK_N,
            "iqr_available": cohort["valid_count"] >= MIN_IQR_N,
            "earliest": cohort["earliest"],
            "latest": cohort["latest"],
            "minimum_sample": MIN_MEDIAN_N,
            "minimum_iqr_sample": MIN_IQR_N,
        },
        "metrics": [metric],
        "target_facts": {
            "spoken_rate": target_metric_values["spoken_rate"],
            "drop_rate": target_metric_values["drop_rate"],
            "note": "开始朗读率和丢弃率受当时读取配置影响，仅展示本场事实",
        },
        "peak": {
            "available": bool(target_peak.get("available")),
            "reason": target_peak.get("reason"),
            "minute_complete": bool(target_peak.get("minute_complete")),
            "window_min": PEAK_WINDOW_MIN,
            "count": target_peak.get("count"),
            "offset_start_min": target_peak.get("offset_start_min"),
            "offset_end_min": target_peak.get("offset_end_min"),
            "start_local": target_peak.get("start_local"),
            "end_local": target_peak.get("end_local"),
            "hour": target_peak.get("hour"),
            "day": target_peak.get("day"),
            "end_day": target_peak.get("end_day"),
            "crosses_day": bool(target_peak.get("crosses_day")),
        },
        "peak_cohort": {
            "valid_count": cohort["peak_valid_count"],
            "sample_threshold": MIN_PEAK_COHORT_N,
            "available": cohort["peak_valid_count"] >= MIN_PEAK_COHORT_N,
            "hours": cohort_hours if cohort["peak_valid_count"] >= MIN_PEAK_COHORT_N else [],
            "total_samples": cohort["peak_valid_count"],
        },
        "quality": {
            "flags": quality_flags,
        },
        "stale": False,
    }
