# -*- coding: utf-8 -*-
"""历史日/周趋势聚合，不依赖前端分页结果。"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional


_KNOWN_END_REASONS = {
    "finished",
    "manual_disconnect",
    "shutdown",
    "connect_failed",
    "replaced",
    "stale",
    "interrupted",
}

TREND_GRANULARITIES = ("hour", "day", "week")
TREND_MAX_DAYS = 366
TREND_MAX_HOURS = 168
TREND_MAX_SECONDS_FAST = 367 * 86400
TREND_MAX_HOUR_SECONDS_FAST = (TREND_MAX_HOURS + 2) * 3600
_GRANULARITIES = set(TREND_GRANULARITIES)
_SUM_STAT_KEYS = (
    "sessions",
    "sessions_with_data",
    "empty_sessions",
    "real_received",
    "real_spoken",
    "real_dropped",
    "real_dropped_total",
    "real_filtered",
    "legacy_dropped_sessions",
    "unique_users_sum",
    "gift_cny",
    "gift_silver",
    "gift_unknown",
    "super_chat_cny",
    "mock_received",
    "mock_spoken",
    "mock_dropped",
    "mock_filtered",
    "short_sessions",
    "incomplete_sessions",
    "replaced_sessions",
    "unknown_end_sessions",
    "inconsistent_sessions",
    "mock_sessions",
)


def _rate(part: int, total: int) -> Optional[float]:
    return (float(part) / float(total)) if total > 0 else None


def _day_label(epoch: float) -> str:
    return datetime.fromtimestamp(float(epoch)).strftime("%Y-%m-%d")


def _hour_start(epoch: float) -> float:
    value = datetime.fromtimestamp(float(epoch))
    return value.replace(minute=0, second=0, microsecond=0).timestamp()


def _next_hour(hour_start: float) -> float:
    value = datetime.fromtimestamp(float(hour_start))
    return (value + timedelta(hours=1)).timestamp()


def _hour_label(epoch: float) -> str:
    return datetime.fromtimestamp(float(epoch)).strftime("%Y-%m-%d %H:00")


def _hour_range(started_from: float, started_to: float) -> List[float]:
    if started_to <= started_from:
        return []
    cursor = _hour_start(started_from)
    end = _hour_start(float(started_to) - 0.001)
    hours: List[float] = []
    while cursor <= end:
        hours.append(cursor)
        cursor = _next_hour(cursor)
    return hours


def hour_bucket_count(started_from: float, started_to: float) -> int:
    """返回本地自然小时桶数量；非法时间范围返回 -1。"""
    if started_to <= started_from:
        return 0
    if started_to - started_from > TREND_MAX_HOUR_SECONDS_FAST:
        return TREND_MAX_HOURS + 1
    try:
        first = _hour_start(started_from)
        last = _hour_start(float(started_to) - 0.001)
    except (OverflowError, OSError, ValueError):
        return -1
    return int(round((last - first) / 3600.0)) + 1


def _day_range(started_from: float, started_to: float) -> List[float]:
    if started_to <= started_from:
        return []
    first = datetime.fromtimestamp(float(started_from))
    last = datetime.fromtimestamp(float(started_to) - 0.001)
    cursor = datetime(first.year, first.month, first.day)
    end = datetime(last.year, last.month, last.day)
    days: List[float] = []
    while cursor <= end:
        days.append(cursor.timestamp())
        cursor = datetime.fromordinal(cursor.toordinal() + 1)
    return days


def day_bucket_count(started_from: float, started_to: float) -> int:
    """返回本地自然日桶数量；非法时间范围返回 -1，不逐日构造。"""
    if started_to <= started_from:
        return 0
    try:
        first = datetime.fromtimestamp(float(started_from))
        last = datetime.fromtimestamp(float(started_to) - 0.001)
    except (OverflowError, OSError, ValueError):
        return -1
    return (last.date() - first.date()).days + 1


def _next_day(day_start: float) -> float:
    value = datetime.fromtimestamp(float(day_start))
    return (datetime(value.year, value.month, value.day) + timedelta(days=1)).timestamp()


def _week_start(epoch: float) -> float:
    """返回 epoch 所属本地自然周的周一 00:00。"""
    value = datetime.fromtimestamp(float(epoch))
    day = datetime(value.year, value.month, value.day)
    return (day - timedelta(days=day.weekday())).timestamp()


def _week_end(week_start: float) -> float:
    value = datetime.fromtimestamp(float(week_start))
    return (datetime(value.year, value.month, value.day) + timedelta(days=7)).timestamp()


def _iso_week_label(week_start: float) -> str:
    value = datetime.fromtimestamp(float(week_start))
    iso = value.isocalendar()
    return "%04d-W%02d" % (iso.year, iso.week)


def _empty_stats() -> Dict[str, Any]:
    return {
        "sessions": 0,
        "sessions_with_data": 0,
        "empty_sessions": 0,
        "real_received": 0,
        "real_spoken": 0,
        "real_dropped": 0,
        "real_dropped_total": 0,
        "real_filtered": 0,
        "legacy_dropped_sessions": 0,
        "real_dropped_known": False,
        "duration_seconds": 0.0,
        "spoken_rate": None,
        "drop_rate": None,
        "unique_users_sum": 0,
        "unique_users_max": 0,
        "gift_cny": 0.0,
        "gift_silver": 0,
        "gift_unknown": 0,
        "super_chat_cny": 0.0,
        "mock_received": 0,
        "mock_spoken": 0,
        "mock_dropped": 0,
        "mock_filtered": 0,
        "short_sessions": 0,
        "incomplete_sessions": 0,
        "replaced_sessions": 0,
        "unknown_end_sessions": 0,
        "inconsistent_sessions": 0,
        "mock_sessions": 0,
        "has_data": False,
    }


def _merge_stats(items: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    merged = _empty_stats()
    for item in items:
        for key in _SUM_STAT_KEYS:
            merged[key] += item.get(key, 0) or 0
        merged["duration_seconds"] += float(item.get("duration_seconds") or 0)
        merged["unique_users_max"] = max(
            int(merged["unique_users_max"]),
            int(item.get("unique_users_max") or 0),
        )
    merged["duration_seconds"] = round(float(merged["duration_seconds"]), 1)
    merged["gift_cny"] = round(float(merged["gift_cny"]), 2)
    merged["super_chat_cny"] = round(float(merged["super_chat_cny"]), 2)
    merged["spoken_rate"] = _rate(merged["real_spoken"], merged["real_received"])
    merged["drop_rate"] = _rate(merged["real_dropped"], merged["real_received"])
    merged["real_dropped_known"] = int(merged["legacy_dropped_sessions"]) == 0
    merged["has_data"] = int(merged["real_received"]) > 0
    return merged


def _decorate_day(day_start: float, rows: Iterable[Any],
                  started_from: float, started_to: float) -> Dict[str, Any]:
    item = _empty_stats()
    row = next(iter(rows), None)
    if row is not None:
        item = _bucket_from_row(row, day_start)
    end = _next_day(day_start)
    effective_end = min(end, float(started_to))
    item.update({
        "day": _day_label(day_start),
        "day_start": float(day_start),
        "bucket_key": item.get("day", _day_label(day_start)),
        "bucket_label": item.get("day", _day_label(day_start)),
        "bucket_start": float(day_start),
        "bucket_end": end,
        "effective_start": max(float(day_start), float(started_from)),
        "effective_end": effective_end,
        "partial": float(day_start) < float(started_from) or end > float(started_to),
    })
    return item


def _decorate_hour(hour_start: float, rows: Iterable[Any],
                   started_from: float, started_to: float) -> Dict[str, Any]:
    item = _empty_stats()
    row = next(iter(rows), None)
    if row is not None:
        item = _stats_from_row(row)
    end = _next_hour(hour_start)
    label = _hour_label(hour_start)
    item.update({
        "hour": label,
        "hour_start": float(hour_start),
        "hour_end": end,
        "bucket_key": label,
        "bucket_label": label,
        "bucket_start": float(hour_start),
        "bucket_end": end,
        "effective_start": max(float(hour_start), float(started_from)),
        "effective_end": min(end, float(started_to)),
        "partial": float(hour_start) < float(started_from) or end > float(started_to),
    })
    return item


def _decorate_week(week_start: float, day_buckets: Iterable[Dict[str, Any]],
                   started_from: float, started_to: float) -> Dict[str, Any]:
    item = _merge_stats(day_buckets)
    week_end = _week_end(week_start)
    start_value = datetime.fromtimestamp(float(week_start))
    last_value = start_value + timedelta(days=6)
    effective_start = max(float(week_start), float(started_from))
    effective_end = min(week_end, float(started_to))
    item.update({
        "bucket_key": _iso_week_label(week_start),
        "bucket_label": _iso_week_label(week_start),
        "bucket_start": float(week_start),
        "bucket_end": week_end,
        "iso_week": _iso_week_label(week_start),
        "week_start": float(week_start),
        "week_end": week_end,
        "week_start_date": start_value.strftime("%Y-%m-%d"),
        "week_last_date": last_value.strftime("%Y-%m-%d"),
        "week_label": "%s ~ %s" % (
            start_value.strftime("%Y-%m-%d"),
            last_value.strftime("%Y-%m-%d"),
        ),
        "effective_start": effective_start,
        "effective_end": effective_end,
        "partial": effective_start > float(week_start) or effective_end < week_end,
    })
    return item


def _stats_from_row(row: Any) -> Dict[str, Any]:
    received = int(row["real_received"] or 0)
    spoken = int(row["real_spoken"] or 0)
    dropped = int(row["real_dropped"] or 0)
    dropped_total = int(row["real_dropped_total"] or 0)
    filtered = int(row["real_filtered"] or 0)
    legacy_dropped = int(row["legacy_dropped_sessions"] or 0)
    return {
        "sessions": int(row["sessions"] or 0),
        "sessions_with_data": int(row["sessions_with_data"] or 0),
        "empty_sessions": int(row["empty_sessions"] or 0),
        "real_received": received,
        "real_spoken": spoken,
        "real_dropped": dropped,
        "real_dropped_total": dropped_total,
        "real_filtered": filtered,
        "legacy_dropped_sessions": legacy_dropped,
        "real_dropped_known": legacy_dropped == 0,
        "duration_seconds": float(row["duration_seconds"] or 0),
        "spoken_rate": _rate(spoken, received),
        "drop_rate": _rate(dropped, received),
        "unique_users_sum": int(row["unique_users_sum"] or 0),
        "unique_users_max": int(row["unique_users_max"] or 0),
        "gift_cny": float(row["gift_cny"] or 0),
        "gift_silver": int(row["gift_silver"] or 0),
        "gift_unknown": int(row["gift_unknown"] or 0),
        "super_chat_cny": float(row["super_chat_cny"] or 0),
        "mock_received": int(row["mock_received"] or 0),
        "mock_spoken": int(row["mock_spoken"] or 0),
        "mock_dropped": int(row["mock_dropped"] or 0),
        "mock_filtered": int(row["mock_filtered"] or 0),
        "short_sessions": int(row["short_sessions"] or 0),
        "incomplete_sessions": int(row["incomplete_sessions"] or 0),
        "replaced_sessions": int(row["replaced_sessions"] or 0),
        "unknown_end_sessions": int(row["unknown_end_sessions"] or 0),
        "inconsistent_sessions": int(row["inconsistent_sessions"] or 0),
        "mock_sessions": int(row["mock_sessions"] or 0),
        "has_data": received > 0,
    }


def _bucket_from_row(row: Any, day_start: float) -> Dict[str, Any]:
    item = _stats_from_row(row)
    item.update({
        "day": _day_label(day_start),
        "day_start": day_start,
    })
    return item


def build_trend(
    conn: Any,
    where_sql: str,
    params: Iterable[Any],
    started_from: float,
    started_to: float,
    *,
    granularity: str = "day",
    max_buckets: int = TREND_MAX_DAYS,
    scope_where_sql: Optional[str] = None,
    scope_params: Optional[Iterable[Any]] = None,
) -> Dict[str, Any]:
    """使用同一过滤条件聚合小时/日/周桶；调用方负责事务、校验和错误映射。"""
    requested = str(granularity or "day").lower()
    if requested not in _GRANULARITIES:
        return {
            "ok": False,
            "available": True,
            "error_code": "unsupported_granularity",
            "error": "趋势仅支持按小时、日或周聚合",
        }
    if started_to <= started_from:
        return {"ok": False, "error_code": "invalid_range", "error": "开始时间必须早于结束时间"}
    hour_mode = requested == "hour"
    if hour_mode:
        if started_to - started_from > TREND_MAX_HOUR_SECONDS_FAST:
            return {
                "ok": False,
                "error_code": "range_too_large",
                "error": "小时趋势最多支持 7 天",
            }
        bucket_count = hour_bucket_count(started_from, started_to)
        if bucket_count < 0:
            return {"ok": False, "error_code": "invalid_range", "error": "趋势时间超出支持范围"}
        if bucket_count > TREND_MAX_HOURS:
            return {
                "ok": False,
                "error_code": "range_too_large",
                "error": "小时趋势最多支持 7 天",
            }
        bucket_starts = _hour_range(started_from, started_to)
        day_count = day_bucket_count(started_from, started_to)
        bucket_limit = TREND_MAX_HOURS
        group_expr = "strftime('%Y-%m-%d %H:00', started_at, 'unixepoch', 'localtime')"
    else:
        # 先做宽松的绝对秒数护栏，再以本地自然日桶数为主判断，避免 DST 日期多出的
        # 一小时被误判为超范围。
        if started_to - started_from > TREND_MAX_SECONDS_FAST:
            return {"ok": False, "error_code": "range_too_large", "error": "趋势范围超过 366 天"}
        bucket_count = day_bucket_count(started_from, started_to)
        if bucket_count < 0:
            return {"ok": False, "error_code": "invalid_range", "error": "趋势时间超出支持范围"}
        if bucket_count > max_buckets:
            return {"ok": False, "error_code": "range_too_large", "error": "趋势范围超过 366 天"}
        bucket_starts = _day_range(started_from, started_to)
        day_count = len(bucket_starts)
        bucket_limit = max_buckets
        group_expr = "date(started_at, 'unixepoch', 'localtime')"

    where_params = tuple(params)
    rows = conn.execute(
        """
        SELECT
            {bucket_expr} AS bucket_key,
            COUNT(*) AS sessions,
            SUM(CASE WHEN real_received > 0 THEN 1 ELSE 0 END) AS sessions_with_data,
            SUM(CASE WHEN real_received = 0 THEN 1 ELSE 0 END) AS empty_sessions,
            COALESCE(SUM(real_received), 0) AS real_received,
            COALESCE(SUM(real_spoken), 0) AS real_spoken,
            COALESCE(SUM(CASE
                WHEN real_filtered IS NULL THEN real_dropped
                ELSE MAX(real_dropped - real_filtered, 0)
            END), 0) AS real_dropped,
            COALESCE(SUM(real_dropped), 0) AS real_dropped_total,
            COALESCE(SUM(real_filtered), 0) AS real_filtered,
            SUM(CASE WHEN real_filtered IS NULL AND real_dropped > 0 THEN 1 ELSE 0 END)
                AS legacy_dropped_sessions,
            COALESCE(SUM(CASE WHEN ended_at > started_at THEN ended_at - started_at ELSE 0 END), 0) AS duration_seconds,
            COALESCE(SUM(unique_users), 0) AS unique_users_sum,
            COALESCE(MAX(unique_users), 0) AS unique_users_max,
            COALESCE(SUM(gift_cny), 0) AS gift_cny,
            COALESCE(SUM(gift_silver), 0) AS gift_silver,
            COALESCE(SUM(gift_unknown), 0) AS gift_unknown,
            COALESCE(SUM(super_chat_cny), 0) AS super_chat_cny,
            COALESCE(SUM(mock_received), 0) AS mock_received,
            COALESCE(SUM(mock_spoken), 0) AS mock_spoken,
            COALESCE(SUM(CASE
                WHEN mock_filtered IS NULL THEN mock_dropped
                ELSE MAX(mock_dropped - mock_filtered, 0)
            END), 0) AS mock_dropped,
            COALESCE(SUM(mock_filtered), 0) AS mock_filtered,
            SUM(CASE WHEN ended_at - started_at < 600 OR real_received < 20 THEN 1 ELSE 0 END) AS short_sessions,
            SUM(CASE WHEN end_reason IN ('stale', 'connect_failed', 'interrupted') THEN 1 ELSE 0 END) AS incomplete_sessions,
            SUM(CASE WHEN end_reason = 'replaced' THEN 1 ELSE 0 END) AS replaced_sessions,
            SUM(CASE WHEN end_reason IS NULL OR end_reason NOT IN
                ('finished', 'manual_disconnect', 'shutdown', 'connect_failed', 'replaced', 'stale', 'interrupted')
                THEN 1 ELSE 0 END) AS unknown_end_sessions,
            SUM(CASE WHEN real_spoken + CASE
                WHEN real_filtered IS NULL THEN real_dropped
                ELSE MAX(real_dropped - real_filtered, 0)
            END > real_received THEN 1 ELSE 0 END)
                AS inconsistent_sessions,
            SUM(CASE WHEN mock_received + mock_spoken + mock_dropped > 0 THEN 1 ELSE 0 END) AS mock_sessions
          FROM sessions
         WHERE {where}
         GROUP BY bucket_key
         ORDER BY bucket_key
        """.format(
            bucket_expr=group_expr,
            where=where_sql,
        ),
        where_params,
    ).fetchall()
    by_bucket = {str(row["bucket_key"]): row for row in rows}
    native_buckets = []
    for bucket_start in bucket_starts:
        label = _hour_label(bucket_start) if hour_mode else _day_label(bucket_start)
        row = by_bucket.get(label)
        decorate = _decorate_hour if hour_mode else _decorate_day
        native_buckets.append(
            decorate(
                bucket_start,
                [] if row is None else [row],
                started_from,
                started_to,
            )
        )
    if requested == "week":
        week_groups: Dict[float, List[Dict[str, Any]]] = {}
        week_order: List[float] = []
        for bucket in native_buckets:
            week_start = _week_start(bucket["day_start"])
            if week_start not in week_groups:
                week_groups[week_start] = []
                week_order.append(week_start)
            week_groups[week_start].append(bucket)
        buckets = [
            _decorate_week(week_start, week_groups[week_start], started_from, started_to)
            for week_start in week_order
        ]
    else:
        buckets = native_buckets

    matched = sum(int(bucket["sessions"]) for bucket in buckets)
    totals = {
        "real_received": sum(int(bucket["real_received"]) for bucket in buckets),
        "real_spoken": sum(int(bucket["real_spoken"]) for bucket in buckets),
        "real_dropped": sum(int(bucket["real_dropped"]) for bucket in buckets),
        "real_dropped_total": sum(int(bucket["real_dropped_total"]) for bucket in buckets),
        "real_filtered": sum(int(bucket["real_filtered"]) for bucket in buckets),
        "legacy_dropped_sessions": sum(int(bucket["legacy_dropped_sessions"]) for bucket in buckets),
        "duration_seconds": round(sum(float(bucket["duration_seconds"]) for bucket in buckets), 1),
        "unique_users_sum": sum(int(bucket["unique_users_sum"]) for bucket in buckets),
        "unique_users_max": max((int(bucket["unique_users_max"]) for bucket in buckets), default=0),
        "gift_cny": round(sum(float(bucket["gift_cny"]) for bucket in buckets), 2),
        "gift_silver": sum(int(bucket["gift_silver"]) for bucket in buckets),
        "gift_unknown": sum(int(bucket["gift_unknown"]) for bucket in buckets),
        "super_chat_cny": round(sum(float(bucket["super_chat_cny"]) for bucket in buckets), 2),
        "mock_received": sum(int(bucket["mock_received"]) for bucket in buckets),
        "mock_spoken": sum(int(bucket["mock_spoken"]) for bucket in buckets),
        "mock_dropped": sum(int(bucket["mock_dropped"]) for bucket in buckets),
        "mock_filtered": sum(int(bucket["mock_filtered"]) for bucket in buckets),
    }
    totals["spoken_rate"] = _rate(totals["real_spoken"], totals["real_received"])
    totals["drop_rate"] = _rate(totals["real_dropped"], totals["real_received"])
    totals["real_dropped_known"] = int(totals["legacy_dropped_sessions"]) == 0
    scope_where = scope_where_sql or where_sql
    scope_where_params = tuple(scope_params) if scope_params is not None else where_params
    active_sessions = int(conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE ({scope}) AND ended_at IS NULL".format(
            scope=scope_where
        ),
        scope_where_params,
    ).fetchone()[0])
    all_sessions = int(conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE ended_at IS NOT NULL"
    ).fetchone()[0])
    coverage_row = conn.execute(
        """
        SELECT MIN(started_at) AS first_at, MAX(ended_at) AS last_at
          FROM sessions
         WHERE {where}
        """.format(where=where_sql),
        where_params,
    ).fetchone()
    data_starts_at = float(coverage_row["first_at"]) if coverage_row["first_at"] is not None else None
    data_ends_at = float(coverage_row["last_at"]) if coverage_row["last_at"] is not None else None
    platform_count = int(conn.execute(
        "SELECT COUNT(DISTINCT platform) FROM sessions WHERE {where}".format(where=where_sql),
        where_params,
    ).fetchone()[0])
    quality = {
        "short_sessions": sum(int(bucket["short_sessions"]) for bucket in buckets),
        "incomplete_sessions": sum(int(bucket["incomplete_sessions"]) for bucket in buckets),
        "replaced_sessions": sum(int(bucket["replaced_sessions"]) for bucket in buckets),
        "unknown_end_sessions": sum(int(bucket["unknown_end_sessions"]) for bucket in buckets),
        "inconsistent_sessions": sum(int(bucket["inconsistent_sessions"]) for bucket in buckets),
        "mock_sessions": sum(int(bucket["mock_sessions"]) for bucket in buckets),
        "low_sample": matched < 20,
    }
    now = datetime.now().astimezone()
    offset = int(now.utcoffset().total_seconds()) if now.utcoffset() is not None else 0
    range_data = {
        "started_from": float(started_from),
        "started_to": float(started_to),
        "days": int(day_count),
        "bucket_count": len(buckets),
        "first_bucket_partial": bool(buckets and buckets[0].get("partial")),
        "last_bucket_partial": bool(buckets and buckets[-1].get("partial")),
    }
    if hour_mode:
        range_data["hours"] = len(bucket_starts)
    return {
        "ok": True,
        "available": True,
        "api_version": 1,
        "as_of": time.time(),
        "granularity": requested,
        "date_basis": "started_at",
        "timezone": time.tzname[0],
        "utc_offset_seconds": offset,
        "range": range_data,
        "counts": {
            "matched_sessions": matched,
            "all_sessions": all_sessions,
            "sessions_with_data": sum(int(bucket["sessions_with_data"]) for bucket in buckets),
            "empty_sessions": sum(int(bucket["empty_sessions"]) for bucket in buckets),
            "active_sessions": active_sessions,
            "platform_count": platform_count,
            "bucket_count": len(buckets),
            "non_empty_buckets": sum(1 for bucket in buckets if bucket.get("sessions")),
            "empty_buckets": sum(1 for bucket in buckets if not bucket.get("sessions")),
            "partial_buckets": sum(1 for bucket in buckets if bucket.get("partial")),
        },
        "totals": totals,
        "buckets": buckets,
        "quality": quality,
        "coverage": {
            "data_starts_at": data_starts_at,
            "data_ends_at": data_ends_at,
            "partial": data_starts_at is not None and data_starts_at > started_from + 60,
        },
        "money": {
            "comparable": platform_count <= 1,
            "note": "本机聚合字段，不代表平台营收或跨币种换算",
            "gift_cny": totals["gift_cny"] if platform_count <= 1 else None,
            "gift_silver": totals["gift_silver"] if platform_count <= 1 else None,
            "gift_unknown": totals["gift_unknown"] if platform_count <= 1 else None,
            "super_chat_cny": totals["super_chat_cny"] if platform_count <= 1 else None,
        },
        "truncated": False,
        "max_buckets": bucket_limit,
        "hour_basis": {
            "boundary": "local_civil",
            "end_exclusive": True,
            "max_hours": TREND_MAX_HOURS,
        } if hour_mode else None,
        "week_basis": {
            "start_weekday": "monday",
            "label": "iso8601",
            "boundary": "local_civil",
            "end_exclusive": True,
        } if requested == "week" else None,
    }
