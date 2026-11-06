# -*- coding: utf-8 -*-
"""服务端重算后的分析报告投影与 CSV 渲染。

报告只包含本机聚合数据，不读取消息正文、用户名或原始 UID。
趋势、对比、复盘共用 report_schema_version，但与单场导出的 schema v2 分离。
"""

from __future__ import annotations

import csv
import io
import json
import math
from typing import Any, Dict, Iterable, List, Optional

from .platforms import (
    money_comparable as platform_money_comparable,
    platform_profile,
)


REPORT_SCHEMA_VERSION = 2
TREND_BUCKET_SCHEMA_VERSION = 4
COMPARE_MULTI_SCHEMA_VERSION = 2
DEFINITIONS_VERSION = 1

TYPE_META = (
    ("danmaku", "弹幕"),
    ("gift", "礼物"),
    ("super_chat", "SC"),
    ("guard", "舰长"),
    ("enter", "入场"),
)

COMPARE_METRIC_DEFINITIONS = (
    ("duration_seconds", "时长", "秒", "秒"),
    ("received", "收到", "条", "条"),
    ("spoken", "开始朗读", "条", "条"),
    ("dropped", "丢弃", "条", "条"),
    ("received_per_hour", "收到 / 小时", "条/时", "条/时"),
    ("spoken_per_hour", "开始朗读 / 小时", "条/时", "条/时"),
    ("spoken_rate", "开始朗读率", "比例", "比例"),
    ("drop_rate", "丢弃率", "比例", "比例"),
    ("unique_users", "UID 去重", "人", "人"),
    ("unique_users_per_hour", "互动 UID / 小时", "人/时", "人/时"),
    ("peak_5m", "峰值 5 分钟", "条", "条"),
)


def _money_labels(platform: Any) -> Dict[str, Any]:
    profile = platform_profile(platform)
    return {
        "gift": "礼物价值" if profile.gift_value_unit == "diamond" else "礼物（本机字段）",
        "sc": "SC / 舰长" if not profile.supports_super_chat else "SC（本机字段）",
        "note": profile.money_note or "该平台金额口径未接入",
        "gift_value_unit": profile.gift_value_unit,
        "supports_super_chat": profile.supports_super_chat,
        "supports_guard": profile.supports_guard,
    }

_TREND_BUCKET_KEYS = (
    "day",
    "day_start",
    "hour",
    "hour_start",
    "hour_end",
    "bucket_key",
    "bucket_label",
    "bucket_start",
    "bucket_end",
    "iso_week",
    "week_start",
    "week_end",
    "week_start_date",
    "week_last_date",
    "week_label",
    "partial",
    "effective_start",
    "effective_end",
    "sessions",
    "sessions_with_data",
    "empty_sessions",
    "real_received",
    "real_spoken",
    "real_dropped",
    "duration_seconds",
    "spoken_rate",
    "drop_rate",
    "unique_users_sum",
    "unique_users_max",
    "gift_cny",
    "gift_silver",
    "gift_unknown",
    "super_chat_cny",
    "mock_received",
    "mock_spoken",
    "mock_dropped",
    "short_sessions",
    "incomplete_sessions",
    "replaced_sessions",
    "unknown_end_sessions",
    "inconsistent_sessions",
    "mock_sessions",
    "has_data",
    "real_dropped_total",
    "real_filtered",
    "real_dropped_known",
    "legacy_dropped_sessions",
    "mock_filtered",
)

_INCOMPLETE_REASONS = {"stale", "interrupted", "connect_failed"}
_KNOWN_REASONS = {
    "",
    "finished",
    "manual_disconnect",
    "shutdown",
    "connect_failed",
    "replaced",
    "stale",
    "interrupted",
}


def _number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if number == number and abs(number) != float("inf") else default


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _rate(part: Any, total: Any) -> Optional[float]:
    total_value = _number(total)
    if total_value <= 0:
        return None
    return _number(part) / total_value


def _per_hour(count: Any, duration_seconds: Any) -> Optional[float]:
    duration = _number(duration_seconds)
    if duration <= 0:
        return None
    return _number(count) / (duration / 3600.0)


def _duration(session: Any) -> float:
    if not isinstance(session, dict):
        return 0.0
    return max(0.0, _number(session.get("ended_at")) - _number(session.get("started_at")))


def _type_total(session: Any) -> int:
    if not isinstance(session, dict):
        return 0
    types = session.get("types")
    if not isinstance(types, dict):
        return 0
    return sum(_int(types.get(key)) for key, _label in TYPE_META)


def _minutes_total(session: Any) -> int:
    if not isinstance(session, dict):
        return 0
    minutes = session.get("minutes")
    if not isinstance(minutes, list):
        return 0
    return sum(_int(item.get("count")) for item in minutes if isinstance(item, dict))


def _peak_five_minute(session: Any) -> Optional[int]:
    """返回完整 5 分钟滚动窗口的峰值；短场或没有分钟数据时不可用。"""
    if not isinstance(session, dict):
        return None
    minutes = session.get("minutes")
    if not isinstance(minutes, list) or not minutes:
        return None
    started = _number(session.get("started_at"))
    ended = _number(session.get("ended_at") or session.get("started_at"))
    if started <= 0 or ended <= started:
        return None
    if ended - started < 300:
        return None
    start_minute = int(started // 60)
    end_minute = max(start_minute + 1, int(math.ceil(ended / 60.0)))
    duration_minutes = end_minute - start_minute
    if duration_minutes < 5:
        return None
    values: Dict[int, int] = {}
    for item in minutes:
        if not isinstance(item, dict):
            continue
        values[_int(item.get("minute"))] = _int(item.get("count"))
    peak = max(
        sum(values.get(start_minute + offset + index, 0) for index in range(5))
        for offset in range(0, duration_minutes - 4)
    )
    return int(max(0, peak))


def _session_metrics(session: Any) -> Dict[str, Any]:
    duration = _duration(session)
    received = _int(session.get("real_received")) if isinstance(session, dict) else 0
    spoken = _int(session.get("real_spoken")) if isinstance(session, dict) else 0
    dropped = _int(session.get("real_dropped")) if isinstance(session, dict) else 0
    users = _int(session.get("unique_users")) if isinstance(session, dict) else 0
    return {
        "duration_seconds": round(duration, 3),
        "received": received,
        "spoken": spoken,
        "dropped": dropped,
        "unique_users": users,
        "received_per_hour": _per_hour(received, duration),
        "spoken_per_hour": _per_hour(spoken, duration),
        "unique_users_per_hour": _per_hour(users, duration),
        "spoken_rate": _rate(spoken, received),
        "drop_rate": _rate(dropped, received),
        "peak_5m": _peak_five_minute(session),
        "type_total": _type_total(session),
        "minutes_total": _minutes_total(session),
    }


def _delta(current: Any, baseline: Any) -> Optional[float]:
    if current is None or baseline is None:
        return None
    return _number(current) - _number(baseline)


def _session_snapshot(session: Any) -> Dict[str, Any]:
    """只保留聚合字段；即使未来 session 对象扩张，也不会把敏感原文带进报告。"""
    if not isinstance(session, dict):
        return {}
    return {
        "id": str(session.get("id") or ""),
        "platform": str(session.get("platform") or ""),
        "room_id": _int(session.get("room_id")),
        "room_key": str(session.get("room_key") or ""),
        "room_title": str(session.get("room_title") or ""),
        "started_at": session.get("started_at"),
        "ended_at": session.get("ended_at"),
        "end_reason": session.get("end_reason"),
        "last_event_at": session.get("last_event_at"),
        "real_received": _int(session.get("real_received")),
        "real_spoken": _int(session.get("real_spoken")),
        "real_dropped": _int(session.get("real_dropped")),
        "real_dropped_total": _int(session.get("real_dropped_total", session.get("real_dropped"))),
        "real_filtered": _int(session.get("real_filtered")),
        "real_dropped_known": bool(session.get("real_dropped_known", False)),
        "mock_received": _int(session.get("mock_received")),
        "mock_spoken": _int(session.get("mock_spoken")),
        "mock_dropped": _int(session.get("mock_dropped")),
        "unique_users": _int(session.get("unique_users")),
        "gift_cny": _number(session.get("gift_cny")),
        "gift_silver": _int(session.get("gift_silver")),
        "gift_unknown": _int(session.get("gift_unknown")),
        "super_chat_cny": _number(session.get("super_chat_cny")),
        "types": dict(session.get("types") or {}) if isinstance(session.get("types"), dict) else {},
        "minutes": [
            {"minute": _int(item.get("minute")), "count": _int(item.get("count"))}
            for item in (session.get("minutes") or [])
            if isinstance(item, dict)
        ],
    }


def _health_warnings(result: Dict[str, Any]) -> List[Dict[str, str]]:
    warnings: List[Dict[str, str]] = []
    health = result.get("data_health") if isinstance(result.get("data_health"), dict) else {}
    if _int(health.get("dropped_ops")) > 0:
        warnings.append({
            "code": "write_dropped",
            "message": "历史写入队列存在丢弃操作，报告可能缺少部分场次。",
        })
    if _int(health.get("failed_ops")) > 0:
        warnings.append({
            "code": "write_failed",
            "message": "历史写入存在失败操作，报告可能缺少部分场次。",
        })
    if _int(health.get("pending_writes")) > 0:
        warnings.append({
            "code": "pending_writes",
            "message": "生成报告时仍有历史写入待落盘。",
        })
    return warnings


def _append_warning(warnings: List[Dict[str, str]], code: str, message: str) -> None:
    if not any(item.get("code") == code for item in warnings):
        warnings.append({"code": code, "message": message})


def _base_report(
    kind: str,
    exported_at: int,
    *,
    api_version: Any = 1,
    warnings: Optional[Iterable[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    return {
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "kind": kind,
        "exported_at": int(exported_at),
        "generated_from": "server_recomputed_history",
        "source_api_version": api_version,
        "privacy": "aggregate_only_no_message_bodies_or_user_identifiers",
        "warnings": list(warnings or []),
    }


def build_trend_report(result: Dict[str, Any], exported_at: int) -> Dict[str, Any]:
    warnings = _health_warnings(result)
    if result.get("stale"):
        _append_warning(warnings, "data_stale", "历史写入尚未完成，报告不应作为最终数据使用。")
    money = dict(result.get("money") or {}) if isinstance(result.get("money"), dict) else {}
    if money.get("comparable") is False:
        _append_warning(
            warnings,
            "money_not_comparable",
            str(money.get("note") or "当前平台金额口径不可比较，金额字段不写入汇总。"),
        )
        for key in ("gift_cny", "gift_silver", "gift_unknown", "super_chat_cny"):
            money[key] = None
    coverage = result.get("coverage") if isinstance(result.get("coverage"), dict) else {}
    if coverage.get("partial"):
        _append_warning(warnings, "partial_coverage", "本机历史覆盖不完整，范围起点之前的数据未被采集。")
    quality = result.get("quality") if isinstance(result.get("quality"), dict) else {}
    if quality.get("low_sample"):
        _append_warning(warnings, "low_sample", "匹配场次少于 20 场，趋势只作本机记录参考。")
    if result.get("granularity") in ("hour", "week"):
        range_data = result.get("range") if isinstance(result.get("range"), dict) else {}
        if range_data.get("first_bucket_partial") or range_data.get("last_bucket_partial"):
            _append_warning(
                warnings,
                "partial_bucket",
                "首尾小时只覆盖部分查询范围。"
                if result.get("granularity") == "hour"
                else "首尾周只覆盖部分查询日期。",
            )
        counts = result.get("counts") if isinstance(result.get("counts"), dict) else {}
        if int(counts.get("non_empty_buckets") or 0) < 4:
            _append_warning(
                warnings,
                "low_bucket_sample",
                "非空小时少于 4 个，小时趋势只作记录参考。"
                if result.get("granularity") == "hour"
                else "非空周少于 4 个，周趋势只作记录参考。",
            )

    totals = dict(result.get("totals") or {})
    if money.get("comparable") is False:
        for key in ("gift_cny", "gift_silver", "gift_unknown", "super_chat_cny"):
            totals[key] = None
    buckets = []
    for bucket in result.get("buckets") or []:
        if not isinstance(bucket, dict):
            continue
        item = {
            key: bucket[key]
            for key in _TREND_BUCKET_KEYS
            if key in bucket
        }
        if money.get("comparable") is False:
            for key in ("gift_cny", "gift_silver", "gift_unknown", "super_chat_cny"):
                item[key] = None
        buckets.append(item)

    report = _base_report(
        "trend",
        exported_at,
        api_version=result.get("api_version"),
        warnings=warnings,
    )
    report.update({
        "granularity": result.get("granularity") or "day",
        "trend_bucket_schema_version": TREND_BUCKET_SCHEMA_VERSION,
        "hour_basis": result.get("hour_basis"),
        "week_basis": result.get("week_basis"),
        "scope": result.get("scope"),
        "filters": result.get("filters") or {},
        "range": result.get("range") or {},
        "counts": result.get("counts") or {},
        "totals": totals,
        "money": money,
        "quality": quality,
        "coverage": coverage,
        "data_health": result.get("data_health") or {},
        "as_of": result.get("as_of"),
        "timezone": result.get("timezone"),
        "utc_offset_seconds": result.get("utc_offset_seconds"),
        "buckets": buckets,
    })
    return report


def _compare_flags(current: Dict[str, Any], baseline: Dict[str, Any],
                   current_metrics: Dict[str, Any], baseline_metrics: Dict[str, Any]) -> List[str]:
    flags: List[str] = []
    if current_metrics["duration_seconds"] < 600 or current_metrics["received"] < 20:
        flags.append("当前场样本偏短")
    if baseline_metrics["duration_seconds"] < 600 or baseline_metrics["received"] < 20:
        flags.append("基准场样本偏短")
    current_duration = current_metrics["duration_seconds"]
    baseline_duration = baseline_metrics["duration_seconds"]
    if current_duration > 0 and baseline_duration > 0:
        if max(current_duration, baseline_duration) / min(current_duration, baseline_duration) > 2:
            flags.append("时长差异大")
    if (str(current.get("end_reason") or "") in _INCOMPLETE_REASONS or
            str(baseline.get("end_reason") or "") in _INCOMPLETE_REASONS):
        flags.append("对比数据可能不完整")
    if str(current.get("end_reason") or "") not in _KNOWN_REASONS:
        flags.append("当前场结束方式未知")
    if str(baseline.get("end_reason") or "") not in _KNOWN_REASONS:
        flags.append("基准场结束方式未知")
    if _int(current.get("mock_received")) > 0:
        flags.append("当前场模拟已排除 %d 条" % _int(current.get("mock_received")))
    if _int(baseline.get("mock_received")) > 0:
        flags.append("基准场模拟已排除 %d 条" % _int(baseline.get("mock_received")))
    if current_metrics["received"] == 0 or baseline_metrics["received"] == 0:
        flags.append("没有真实消息样本")
    if (current_metrics["type_total"] != current_metrics["received"] or
            baseline_metrics["type_total"] != baseline_metrics["received"]):
        flags.append("类型样本不完整")
    if (current_metrics["minutes_total"] != current_metrics["type_total"] or
            baseline_metrics["minutes_total"] != baseline_metrics["type_total"]):
        flags.append("节奏样本不完整")
    current_start = _number(current.get("started_at"))
    current_end = _number(current.get("ended_at"))
    baseline_start = _number(baseline.get("started_at"))
    baseline_end = _number(baseline.get("ended_at"))
    if baseline_start > current_start:
        flags.append("基准场晚于当前记录")
    if current_start < baseline_end and baseline_start < current_end:
        flags.append("两场时间重叠")
    return flags


def _compare_metric_rows(
    current_metrics: Dict[str, Any],
    baseline_metrics: Dict[str, Any],
) -> List[Dict[str, Any]]:
    rows = []
    for key, label, unit, _delta_unit in COMPARE_METRIC_DEFINITIONS:
        rows.append({
            "section": "节奏与响应",
            "metric_key": key,
            "label": label,
            "current": current_metrics.get(key),
            "baseline": baseline_metrics.get(key),
            "delta": _delta(current_metrics.get(key), baseline_metrics.get(key)),
            "unit": unit,
        })
    return rows


def build_compare_report(result: Dict[str, Any], exported_at: int) -> Dict[str, Any]:
    current = _session_snapshot(result.get("target"))
    baseline = _session_snapshot(result.get("baseline"))
    current_metrics = _session_metrics(current)
    baseline_metrics = _session_metrics(baseline)
    flags = _compare_flags(current, baseline, current_metrics, baseline_metrics)
    warnings = _health_warnings(result)
    if result.get("stale"):
        _append_warning(warnings, "data_stale", "历史写入尚未完成，报告不应作为最终数据使用。")

    money_comparable = (
        platform_money_comparable(current.get("platform")) and
        platform_money_comparable(baseline.get("platform"))
    )
    money_labels = _money_labels(current.get("platform"))
    money_note = "" if money_comparable else money_labels["note"]
    if not money_comparable:
        _append_warning(warnings, "money_not_comparable", money_note)

    metrics = _compare_metric_rows(current_metrics, baseline_metrics)
    current_types = current.get("types") if isinstance(current.get("types"), dict) else {}
    baseline_types = baseline.get("types") if isinstance(baseline.get("types"), dict) else {}
    type_rows = []
    for key, label in TYPE_META:
        current_share = (
            _int(current_types.get(key)) / current_metrics["type_total"]
            if current_metrics["type_total"] else None
        )
        baseline_share = (
            _int(baseline_types.get(key)) / baseline_metrics["type_total"]
            if baseline_metrics["type_total"] else None
        )
        type_rows.append({
            "section": "类型结构",
            "metric_key": key,
            "label": label,
            "current": current_share,
            "baseline": baseline_share,
            "delta": _delta(current_share, baseline_share),
            "unit": "比例",
        })

    money_rows = []
    for key, label in (
        ("gift_cny", money_labels["gift"]),
        ("gift_silver", "银瓜子"),
        ("gift_unknown", "瓜子"),
        ("super_chat_cny", money_labels["sc"]),
    ):
        money_rows.append({
            "section": "金额与状态",
            "metric_key": key,
            "label": label,
            "current": _number(current.get(key)) if money_comparable else None,
            "baseline": _number(baseline.get(key)) if money_comparable else None,
            "delta": _delta(current.get(key), baseline.get(key)) if money_comparable else None,
            "unit": "CNY" if key in ("gift_cny", "super_chat_cny") else "个",
            "note": "" if money_comparable else money_note,
        })

    report = _base_report(
        "compare",
        exported_at,
        api_version=result.get("api_version"),
        warnings=warnings,
    )
    report.update({
        "scope": result.get("scope"),
        "target": current,
        "baseline": baseline,
        "current_metrics": current_metrics,
        "baseline_metrics": baseline_metrics,
        "metrics": metrics,
        "types": type_rows,
        "money": {
            "comparable": money_comparable,
            "note": money_note,
            "gift_value_unit": money_labels["gift_value_unit"],
            "supports_super_chat": money_labels["supports_super_chat"],
            "supports_guard": money_labels["supports_guard"],
            "rows": money_rows,
        },
        "quality_flags": flags,
        "data_health": result.get("data_health") or {},
        "as_of": result.get("as_of"),
    })
    return report


def _multi_quality_flags(
    session: Dict[str, Any],
    metrics: Dict[str, Any],
    *,
    current: bool,
    current_duration: Optional[float] = None,
) -> List[Dict[str, Any]]:
    flags: List[Dict[str, Any]] = []

    def add(code: str, message: str, count: Optional[int] = None) -> None:
        item: Dict[str, Any] = {"code": code, "message": message}
        if count is not None:
            item["count"] = count
        flags.append(item)

    if metrics["duration_seconds"] < 600 or metrics["received"] < 20:
        add("short_sample", "样本偏短")
    reason = str(session.get("end_reason") or "")
    if reason in _INCOMPLETE_REASONS:
        add("incomplete_session", "结束不完整")
    elif reason not in _KNOWN_REASONS:
        add("unknown_end_reason", "结束方式未知")
    mock_received = _int(session.get("mock_received"))
    if mock_received > 0:
        add(
            "mock_excluded",
            "模拟已排除 %d 条" % mock_received,
            mock_received,
        )
    if metrics["received"] == 0:
        add("no_real_messages", "没有真实消息样本")
    else:
        if metrics["type_total"] != metrics["received"]:
            add("type_sample_incomplete", "类型样本不完整")
        if metrics["minutes_total"] != metrics["type_total"]:
            add("rhythm_sample_incomplete", "节奏样本不完整")
    if not current and current_duration is not None:
        duration = metrics["duration_seconds"]
        if current_duration > 0 and duration > 0:
            if max(current_duration, duration) / min(current_duration, duration) > 2:
                add("duration_skew_vs_current", "与当前时长差异超过 2 倍")
    return flags


def _multi_series_key(index: int) -> str:
    return "current" if index == 0 else "b%d" % index


def _multi_series_label(index: int) -> str:
    return "当前记录" if index == 0 else "B%d" % index


def _multi_metric_rows(
    current_metrics: Dict[str, Any],
    baselines: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for key, label, unit, delta_unit in COMPARE_METRIC_DEFINITIONS:
        values = {"current": current_metrics.get(key)}
        deltas: Dict[str, Any] = {}
        for item in baselines:
            series_key = item["key"]
            values[series_key] = item["metrics"].get(key)
            deltas[series_key] = _delta(current_metrics.get(key), item["metrics"].get(key))
        rows.append({
            "section": "rhythm",
            "section_label": "节奏与响应",
            "metric_key": key,
            "label": label,
            "unit": unit,
            "delta_unit": delta_unit,
            "values": values,
            "deltas_vs_current": deltas,
        })
    return rows


def _multi_type_block(
    target: Dict[str, Any],
    current_metrics: Dict[str, Any],
    baselines: List[Dict[str, Any]],
) -> Dict[str, Any]:
    target_types = target.get("types") if isinstance(target.get("types"), dict) else {}
    target_total = current_metrics["type_total"]
    rows: List[Dict[str, Any]] = []
    for type_key, label in TYPE_META:
        counts = {"current": _int(target_types.get(type_key))}
        shares = {
            "current": (
                _int(target_types.get(type_key)) / target_total
                if target_total else None
            )
        }
        for item in baselines:
            session = item["session"]
            types = session.get("types") if isinstance(session.get("types"), dict) else {}
            total = item["metrics"]["type_total"]
            series_key = item["key"]
            counts[series_key] = _int(types.get(type_key))
            shares[series_key] = (
                _int(types.get(type_key)) / total if total else None
            )
        rows.append({
            "type_key": type_key,
            "label": label,
            "counts": counts,
            "shares": shares,
        })
    unrecognized = {
        "current": max(0, current_metrics["received"] - target_total),
    }
    for item in baselines:
        unrecognized[item["key"]] = max(
            0, item["metrics"]["received"] - item["metrics"]["type_total"]
        )
    return {
        "definition": "share_of_recognized_type_total",
        "rows": rows,
        "unrecognized": unrecognized,
    }


def _multi_money_block(
    target: Dict[str, Any],
    baselines: List[Dict[str, Any]],
    comparable: bool,
) -> Dict[str, Any]:
    labels = _money_labels(target.get("platform"))
    note = "" if comparable else labels["note"]
    rows: List[Dict[str, Any]] = []
    for field, label, unit in (
        ("gift_cny", labels["gift"], "CNY"),
        ("gift_silver", "银瓜子", "个"),
        ("gift_unknown", "瓜子", "个"),
        ("super_chat_cny", labels["sc"], "CNY"),
    ):
        values = {"current": _number(target.get(field)) if comparable else None}
        for item in baselines:
            values[item["key"]] = (
                _number(item["session"].get(field)) if comparable else None
            )
        rows.append({
            "field": field,
            "label": label,
            "unit": unit,
            "values": values,
            "note": "" if comparable else note,
        })
    return {
        "comparable": comparable,
        "currency": "CNY",
        "note": note or "本机字段，不代表平台营收；不跨币种相加",
        "gift_value_unit": labels["gift_value_unit"],
        "supports_super_chat": labels["supports_super_chat"],
        "supports_guard": labels["supports_guard"],
        "rows": rows,
    }


def _multi_overlap_block(result: Dict[str, Any]) -> Dict[str, Any]:
    def token(value: Any) -> tuple:
        text = str(value or "")
        if text == "当前":
            return "current", "当前记录"
        if text.startswith("B") and text[1:].isdigit():
            return "b" + text[1:], text
        return text.lower() or "unknown", text or "未知"

    pairs: List[Dict[str, Any]] = []
    for pair in result.get("overlap_pairs") or []:
        if not isinstance(pair, dict):
            continue
        left_key, left_label = token(pair.get("left"))
        right_key, right_label = token(pair.get("right"))
        if left_label == "当前记录":
            message = right_label + " 与当前场重叠"
        elif right_label == "当前记录":
            message = left_label + " 与当前场重叠"
        else:
            message = left_label + " 与 " + right_label + " 重叠"
        pairs.append({
            "left_key": left_key,
            "left_label": left_label,
            "right_key": right_key,
            "right_label": right_label,
            "message": message,
        })
    return {
        "definition": "half_open_interval",
        "pairs": pairs,
    }


def build_multi_compare_report(result: Dict[str, Any], exported_at: int) -> Dict[str, Any]:
    target = _session_snapshot(result.get("target"))
    current_metrics = _session_metrics(target)
    current_flags = _multi_quality_flags(
        target,
        current_metrics,
        current=True,
    )
    baselines: List[Dict[str, Any]] = []
    for index, item in enumerate(result.get("baselines") or [], 1):
        if not isinstance(item, dict):
            continue
        session = _session_snapshot(item.get("session"))
        metrics = _session_metrics(session)
        series_key = _multi_series_key(index)
        baselines.append({
            "index": index,
            "key": series_key,
            "label": _multi_series_label(index),
            "id": str(item.get("id") or session.get("id") or ""),
            "relation": item.get("relation"),
            "distance_seconds": item.get("distance_seconds"),
            "overlaps_target": bool(item.get("overlaps_target")),
            "overlaps_baselines": [
                (
                    str(value).lower()
                    if str(value).startswith("B")
                    else ("b" + str(value) if str(value).isdigit() else str(value))
                )
                for value in (item.get("overlaps_baselines") or [])
            ],
            "session": session,
            "metrics": metrics,
            "quality_flags": _multi_quality_flags(
                session,
                metrics,
                current=False,
                current_duration=current_metrics["duration_seconds"],
            ),
        })

    money_comparable = (
        platform_money_comparable(target.get("platform")) and
        all(
            platform_money_comparable(item["session"].get("platform"))
            for item in baselines
        )
    )
    overlap = _multi_overlap_block(result)
    types_block = _multi_type_block(target, current_metrics, baselines)
    money_block = _multi_money_block(target, baselines, money_comparable)
    quality_flag_count = len(current_flags) + sum(
        len(item["quality_flags"]) for item in baselines
    )

    warnings = _health_warnings(result)
    if result.get("stale"):
        _append_warning(
            warnings,
            "data_stale",
            "历史写入尚未完成，报告不应作为最终数据使用。",
        )
    if not money_comparable:
        _append_warning(
            warnings,
            "money_not_comparable",
            money_block["note"],
        )
    if overlap["pairs"]:
        _append_warning(
            warnings,
            "overlap_detected",
            "存在 %d 组时间重叠；重叠只标记，不拒绝导出。" % len(overlap["pairs"]),
        )
    if quality_flag_count:
        _append_warning(
            warnings,
            "sample_quality",
            "部分场次存在样本质量标记，报告保留逐场标记。",
        )

    series = [{
        "key": "current",
        "label": "当前记录",
        "role": "target",
        "index": 0,
        "session_id": target.get("id"),
    }] + [{
        "key": item["key"],
        "label": item["label"],
        "role": "baseline",
        "index": item["index"],
        "session_id": item["id"],
    } for item in baselines]

    quality_labels = ["当前: " + flag["message"] for flag in current_flags]
    for item in baselines:
        quality_labels.extend(
            item["label"] + ": " + flag["message"]
            for flag in item["quality_flags"]
        )

    report = _base_report(
        "compare_multi",
        exported_at,
        api_version=result.get("api_version"),
        warnings=warnings,
    )
    report.update({
        "compare_multi_schema_version": COMPARE_MULTI_SCHEMA_VERSION,
        "definitions_version": DEFINITIONS_VERSION,
        "scope": result.get("scope"),
        "ordering": "requested",
        "baseline_count": len(baselines),
        "max_baselines": result.get("max_baselines"),
        "series": series,
        "target": target,
        "current_metrics": current_metrics,
        "baselines": baselines,
        "quality_flags": quality_labels,
        "metrics": {
            "definitions_version": DEFINITIONS_VERSION,
            "rows": _multi_metric_rows(current_metrics, baselines),
        },
        "types": types_block,
        "money": money_block,
        "overlap": overlap,
        "quality": {
            "summary": {
                "flag_count": quality_flag_count,
                "subjects_with_flags": (
                    (1 if current_flags else 0) +
                    sum(1 for item in baselines if item["quality_flags"])
                ),
            },
            "target": {
                "series_key": "current",
                "flags": current_flags,
            },
            "baselines": [{
                "series_key": item["key"],
                "index": item["index"],
                "flags": item["quality_flags"],
            } for item in baselines],
        },
        "data_health": result.get("data_health") or {},
        "as_of": result.get("as_of"),
    })
    return report


def build_insights_report(result: Dict[str, Any], exported_at: int) -> Dict[str, Any]:
    warnings = _health_warnings(result)
    quality = dict(result.get("quality") or {}) if isinstance(result.get("quality"), dict) else {}
    quality.pop("last_write_error", None)
    if quality.get("degraded"):
        _append_warning(warnings, "degraded", "本次复盘运行存在历史写入缺口，结论只作参考。")
    if not result.get("insights_available"):
        reason = str(result.get("reason") or "insufficient_sample")
        _append_warning(warnings, "insights_unavailable", "当前样本不足或目标不合格，报告不包含同房间名次。")
        if reason == "insufficient_sample":
            _append_warning(warnings, "insufficient_sample", "有效同房间样本少于 8 场。")
        elif reason == "target_unqualified":
            _append_warning(warnings, "target_unqualified", "当前场未达到复盘基线门槛。")

    report = _base_report(
        "insights",
        exported_at,
        api_version=result.get("api_version"),
        warnings=warnings,
    )
    report.update({
        "definitions_version": result.get("definitions_version"),
        "as_of": result.get("as_of"),
        "timezone": result.get("timezone"),
        "utc_offset_seconds": result.get("utc_offset_seconds"),
        "insights_available": bool(result.get("insights_available")),
        "reason": result.get("reason"),
        "scope": result.get("scope") or {},
        "target": result.get("target") or {},
        "target_quality": result.get("target_quality") or {},
        "target_metrics": result.get("target_metrics") or {},
        "target_facts": result.get("target_facts") or {},
        "window": result.get("window") or {},
        "metric_cohort": result.get("metric_cohort") or {},
        "metrics": result.get("metrics") or [],
        "peak": result.get("peak") or {},
        "peak_cohort": result.get("peak_cohort") or {},
        "quality": quality,
        "data_health": result.get("data_health") or {},
    })
    return report


def _csv_text(columns: List[str], rows: Iterable[Dict[str, Any]]) -> str:
    def safe(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        if value and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
            return "'" + value
        return value

    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow([safe(row.get(column, "")) for column in columns])
    return buffer.getvalue()


def _meta_values(report: Dict[str, Any]) -> Dict[str, Any]:
    warnings = report.get("warnings") or []
    return {
        "report_schema_version": report.get("report_schema_version"),
        "compare_multi_schema_version": report.get("compare_multi_schema_version"),
        "report_kind": report.get("kind"),
        "exported_at": report.get("exported_at"),
        "definitions_version": report.get("definitions_version"),
        "quality_flag_count": report.get("quality", {}).get("summary", {}).get("flag_count")
        if isinstance(report.get("quality"), dict) else None,
        "overlap_pair_count": len(
            (report.get("overlap") or {}).get("pairs") or []
        ) if isinstance(report.get("overlap"), dict) else None,
        "warning_codes": ",".join(
            str(item.get("code") or "") for item in warnings if isinstance(item, dict)
        ),
        "quality_flags": "；".join(report.get("quality_flags") or []),
    }


def render_csv(report: Dict[str, Any]) -> str:
    kind = str(report.get("kind") or "")
    meta = _meta_values(report)
    if kind == "trend":
        scope = report.get("scope") if isinstance(report.get("scope"), dict) else {}
        money = report.get("money") if isinstance(report.get("money"), dict) else {}
        coverage = report.get("coverage") if isinstance(report.get("coverage"), dict) else {}
        columns = [
            "report_schema_version", "report_kind", "exported_at", "warning_codes",
            "scope_platform", "scope_room_key", "scope_room_title",
            "timezone", "utc_offset_seconds",
            "money_comparable", "coverage_partial",
            "day", "day_start", "sessions", "sessions_with_data", "empty_sessions",
            "real_received", "real_spoken", "real_dropped", "duration_seconds",
            "received_per_hour", "spoken_rate", "drop_rate",
            "unique_users_sum", "unique_users_max", "gift_cny", "gift_silver",
            "gift_unknown", "super_chat_cny", "mock_received", "mock_spoken",
            "mock_dropped", "short_sessions", "incomplete_sessions", "replaced_sessions",
            "unknown_end_sessions", "inconsistent_sessions", "mock_sessions", "has_data",
            "granularity", "trend_bucket_schema_version",
            "hour", "hour_start", "hour_end",
            "bucket_key", "bucket_label", "iso_week", "week_start", "week_end",
            "week_start_date", "week_last_date", "week_label", "partial_bucket",
            "effective_start", "effective_end",
        ]
        rows = []
        for bucket in report.get("buckets") or []:
            if not isinstance(bucket, dict):
                continue
            duration = _number(bucket.get("duration_seconds"))
            received = _int(bucket.get("real_received"))
            row = dict(meta)
            row.update({
                "scope_platform": scope.get("platform"),
                "scope_room_key": scope.get("room_key"),
                "scope_room_title": scope.get("room_title"),
                "timezone": report.get("timezone"),
                "utc_offset_seconds": report.get("utc_offset_seconds"),
                "money_comparable": bool(money.get("comparable")),
                "coverage_partial": bool(coverage.get("partial")),
                "day": bucket.get("day"),
                "day_start": bucket.get("day_start"),
                "sessions": bucket.get("sessions"),
                "sessions_with_data": bucket.get("sessions_with_data"),
                "empty_sessions": bucket.get("empty_sessions"),
                "real_received": received,
                "real_spoken": bucket.get("real_spoken"),
                "real_dropped": bucket.get("real_dropped"),
                "duration_seconds": duration,
                "received_per_hour": _per_hour(received, duration),
                "spoken_rate": _rate(bucket.get("real_spoken"), received),
                "drop_rate": _rate(bucket.get("real_dropped"), received),
                "unique_users_sum": bucket.get("unique_users_sum"),
                "unique_users_max": bucket.get("unique_users_max"),
                "gift_cny": bucket.get("gift_cny") if money.get("comparable") else "",
                "gift_silver": bucket.get("gift_silver") if money.get("comparable") else "",
                "gift_unknown": bucket.get("gift_unknown") if money.get("comparable") else "",
                "super_chat_cny": bucket.get("super_chat_cny") if money.get("comparable") else "",
                "mock_received": bucket.get("mock_received"),
                "mock_spoken": bucket.get("mock_spoken"),
                "mock_dropped": bucket.get("mock_dropped"),
                "short_sessions": bucket.get("short_sessions"),
                "incomplete_sessions": bucket.get("incomplete_sessions"),
                "replaced_sessions": bucket.get("replaced_sessions"),
                "unknown_end_sessions": bucket.get("unknown_end_sessions"),
                "inconsistent_sessions": bucket.get("inconsistent_sessions"),
                "mock_sessions": bucket.get("mock_sessions"),
                "has_data": bool(bucket.get("has_data")),
                "granularity": report.get("granularity") or "day",
                "trend_bucket_schema_version": report.get("trend_bucket_schema_version"),
                "hour": bucket.get("hour"),
                "hour_start": bucket.get("hour_start"),
                "hour_end": bucket.get("hour_end"),
                "bucket_key": bucket.get("bucket_key"),
                "bucket_label": bucket.get("bucket_label"),
                "iso_week": bucket.get("iso_week"),
                "week_start": bucket.get("week_start"),
                "week_end": bucket.get("week_end"),
                "week_start_date": bucket.get("week_start_date"),
                "week_last_date": bucket.get("week_last_date"),
                "week_label": bucket.get("week_label"),
                "partial_bucket": bool(bucket.get("partial")),
                "effective_start": bucket.get("effective_start"),
                "effective_end": bucket.get("effective_end"),
            })
            rows.append(row)
        return _csv_text(columns, rows)

    if kind == "compare":
        scope = report.get("scope") if isinstance(report.get("scope"), dict) else {}
        columns = [
            "report_schema_version", "report_kind", "exported_at", "warning_codes",
            "quality_flags", "scope_platform", "scope_room_key",
            "target_id", "baseline_id", "target_started_at", "baseline_started_at",
            "section", "metric_key", "label",
            "current", "baseline", "delta", "unit", "note",
        ]
        target = report.get("target") if isinstance(report.get("target"), dict) else {}
        baseline = report.get("baseline") if isinstance(report.get("baseline"), dict) else {}
        money = report.get("money") if isinstance(report.get("money"), dict) else {}
        rows = []
        for item in list(report.get("metrics") or []) + list(report.get("types") or []) + list(money.get("rows") or []):
            if not isinstance(item, dict):
                continue
            row = dict(meta)
            row.update({
                "scope_platform": scope.get("platform"),
                "scope_room_key": scope.get("room_key"),
                "target_id": target.get("id"),
                "baseline_id": baseline.get("id"),
                "target_started_at": target.get("started_at"),
                "baseline_started_at": baseline.get("started_at"),
                "section": item.get("section"),
                "metric_key": item.get("metric_key"),
                "label": item.get("label"),
                "current": item.get("current"),
                "baseline": item.get("baseline"),
                "delta": item.get("delta"),
                "unit": item.get("unit"),
                "note": item.get("note", ""),
            })
            rows.append(row)
        return _csv_text(columns, rows)

    if kind == "compare_multi":
        scope = report.get("scope") if isinstance(report.get("scope"), dict) else {}
        target = report.get("target") if isinstance(report.get("target"), dict) else {}
        baselines = [
            item for item in (report.get("baselines") or [])
            if isinstance(item, dict)
        ]
        series = [
            item for item in (report.get("series") or [])
            if isinstance(item, dict)
        ]
        by_key = {str(item.get("key") or ""): item for item in series}
        baseline_by_key = {str(item.get("key") or ""): item for item in baselines}
        money = report.get("money") if isinstance(report.get("money"), dict) else {}
        overlap = report.get("overlap") if isinstance(report.get("overlap"), dict) else {}
        health = report.get("data_health") if isinstance(report.get("data_health"), dict) else {}
        meta = _meta_values(report)
        meta.update({
            "scope_platform": scope.get("platform"),
            "scope_room_key": scope.get("room_key"),
            "scope_room_title": scope.get("room_title") or target.get("room_title"),
            "target_id": target.get("id"),
            "target_started_at": target.get("started_at"),
            "baseline_count": report.get("baseline_count"),
            "max_baselines": report.get("max_baselines"),
            "ordering": report.get("ordering"),
            "baseline_ids": ";".join(str(item.get("id") or "") for item in baselines),
            "money_comparable": "TRUE" if money.get("comparable") else "FALSE",
            "data_health_flushed": "TRUE" if health.get("flushed") else "FALSE",
            "data_health_pending_writes": _int(health.get("pending_writes")),
            "data_health_dropped_ops": _int(health.get("dropped_ops")),
            "data_health_failed_ops": _int(health.get("failed_ops")),
        })
        columns = [
            "report_schema_version", "compare_multi_schema_version", "report_kind",
            "definitions_version", "exported_at", "warning_codes", "quality_flag_count",
            "overlap_pair_count", "scope_platform", "scope_room_key", "scope_room_title",
            "target_id", "target_started_at", "baseline_count", "max_baselines",
            "ordering", "baseline_ids", "money_comparable",
            "data_health_flushed", "data_health_pending_writes",
            "data_health_dropped_ops", "data_health_failed_ops",
            "series_key", "series_label", "series_role", "series_index", "is_current",
            "session_id", "session_started_at", "session_ended_at",
            "session_duration_seconds", "session_end_reason", "relation",
            "distance_seconds", "overlaps_target", "overlaps_baselines",
            "section", "section_label", "metric_key", "metric_label",
            "value", "value_text", "unit", "delta_vs_current", "delta_unit",
            "note", "related_key", "related_label",
        ]
        rows = []

        def base_row(series_key: str, related_key: str = "",
                     related_label: str = "") -> Dict[str, Any]:
            series_item = by_key.get(series_key) or {}
            baseline_item = baseline_by_key.get(series_key) or {}
            session = (
                target if series_key == "current"
                else baseline_item.get("session") or {}
            )
            if not isinstance(session, dict):
                session = {}
            row = dict(meta)
            row.update({
                "series_key": series_key,
                "series_label": series_item.get("label") or (
                    "当前记录" if series_key == "current" else series_key.upper()
                ),
                "series_role": series_item.get("role") or (
                    "target" if series_key == "current" else "baseline"
                ),
                "series_index": series_item.get("index"),
                "is_current": "TRUE" if series_key == "current" else "FALSE",
                "session_id": session.get("id"),
                "session_started_at": session.get("started_at"),
                "session_ended_at": session.get("ended_at"),
                "session_duration_seconds": round(_duration(session), 3),
                "session_end_reason": session.get("end_reason"),
                "relation": baseline_item.get("relation") or "",
                "distance_seconds": baseline_item.get("distance_seconds"),
                "overlaps_target": (
                    "" if series_key == "current"
                    else ("TRUE" if baseline_item.get("overlaps_target") else "FALSE")
                ),
                "overlaps_baselines": ";".join(
                    str(value) for value in (baseline_item.get("overlaps_baselines") or [])
                ),
                "related_key": related_key,
                "related_label": related_label,
            })
            return row

        def add_row(
            section: str,
            section_label: str,
            metric_key: str,
            metric_label: str,
            series_key: str,
            value: Any,
            value_text: str = "",
            unit: str = "",
            delta: Any = "",
            delta_unit: str = "",
            note: str = "",
            related_key: str = "",
            related_label: str = "",
        ) -> None:
            row = base_row(series_key, related_key, related_label)
            row.update({
                "section": section,
                "section_label": section_label,
                "metric_key": metric_key,
                "metric_label": metric_label,
                "value": value,
                "value_text": value_text,
                "unit": unit,
                "delta_vs_current": delta,
                "delta_unit": delta_unit,
                "note": note,
            })
            rows.append(row)

        metric_block = report.get("metrics") if isinstance(report.get("metrics"), dict) else {}
        for item in metric_block.get("rows") or []:
            if not isinstance(item, dict):
                continue
            values = item.get("values") if isinstance(item.get("values"), dict) else {}
            deltas = item.get("deltas_vs_current") if isinstance(
                item.get("deltas_vs_current"), dict
            ) else {}
            for series_item in series:
                series_key = str(series_item.get("key") or "")
                if not series_key:
                    continue
                add_row(
                    "rhythm",
                    "节奏与响应",
                    str(item.get("metric_key") or ""),
                    str(item.get("label") or ""),
                    series_key,
                    values.get(series_key),
                    unit=str(item.get("unit") or ""),
                    delta=deltas.get(series_key, "") if series_key != "current" else "",
                    delta_unit=str(item.get("delta_unit") or "") if series_key != "current" else "",
                    note=str(item.get("note") or ""),
                )

        type_block = report.get("types") if isinstance(report.get("types"), dict) else {}
        type_rows = type_block.get("rows") if isinstance(type_block.get("rows"), list) else []
        for item in type_rows:
            if not isinstance(item, dict):
                continue
            type_key = str(item.get("type_key") or "")
            label = str(item.get("label") or "")
            counts = item.get("counts") if isinstance(item.get("counts"), dict) else {}
            shares = item.get("shares") if isinstance(item.get("shares"), dict) else {}
            for series_item in series:
                series_key = str(series_item.get("key") or "")
                if not series_key:
                    continue
                current_share = shares.get("current")
                share_delta = (
                    _delta(current_share, shares.get(series_key))
                    if series_key != "current" else ""
                )
                add_row(
                    "types", "类型结构", type_key + "_count",
                    label + "数", series_key, counts.get(series_key),
                    unit="条",
                )
                add_row(
                    "types", "类型结构", type_key + "_share",
                    label + "占比", series_key, shares.get(series_key),
                    unit="比例",
                    delta=share_delta,
                    delta_unit="比例" if series_key != "current" else "",
                )
        unrecognized = type_block.get("unrecognized") if isinstance(
            type_block.get("unrecognized"), dict
        ) else {}
        for series_item in series:
            series_key = str(series_item.get("key") or "")
            if series_key:
                add_row(
                    "types", "类型结构", "unrecognized_count",
                    "未识别类型数", series_key, unrecognized.get(series_key),
                    unit="条",
                )

        for item in money.get("rows") or []:
            if not isinstance(item, dict):
                continue
            values = item.get("values") if isinstance(item.get("values"), dict) else {}
            for series_item in series:
                series_key = str(series_item.get("key") or "")
                if not series_key:
                    continue
                add_row(
                    "money", "金额与状态", str(item.get("field") or ""),
                    str(item.get("label") or ""), series_key,
                    values.get(series_key), unit=str(item.get("unit") or ""),
                    note=str(item.get("note") or ""),
                )

        quality = report.get("quality") if isinstance(report.get("quality"), dict) else {}
        target_quality = quality.get("target") if isinstance(
            quality.get("target"), dict
        ) else {}
        for flag in target_quality.get("flags") or []:
            if not isinstance(flag, dict):
                continue
            add_row(
                "quality", "样本质量", "quality_" + str(flag.get("code") or ""),
                str(flag.get("message") or ""), "current", "",
                value_text=str(flag.get("message") or ""),
                note=("count=%s" % flag.get("count"))
                if flag.get("count") is not None else "",
            )
        for item in quality.get("baselines") or []:
            if not isinstance(item, dict):
                continue
            series_key = str(item.get("series_key") or "")
            for flag in item.get("flags") or []:
                if not isinstance(flag, dict):
                    continue
                add_row(
                    "quality", "样本质量", "quality_" + str(flag.get("code") or ""),
                    str(flag.get("message") or ""), series_key, "",
                    value_text=str(flag.get("message") or ""),
                    note=("count=%s" % flag.get("count"))
                    if flag.get("count") is not None else "",
                    related_key="current"
                    if flag.get("code") == "duration_skew_vs_current" else "",
                    related_label="当前记录"
                    if flag.get("code") == "duration_skew_vs_current" else "",
                )

        for pair in overlap.get("pairs") or []:
            if not isinstance(pair, dict):
                continue
            add_row(
                "overlap", "时间重叠", "overlap", "时间重叠",
                str(pair.get("left_key") or ""), "",
                value_text=str(pair.get("message") or ""), note=str(pair.get("message") or ""),
                related_key=str(pair.get("right_key") or ""),
                related_label=str(pair.get("right_label") or ""),
            )
        return _csv_text(columns, rows)

    if kind == "insights":
        columns = [
            "report_schema_version", "report_kind", "exported_at", "warning_codes",
            "definitions_version",
            "section", "metric_key", "label", "value", "unit", "note",
        ]
        target = report.get("target") if isinstance(report.get("target"), dict) else {}
        metrics = report.get("metrics") or []
        first_metric = metrics[0] if metrics and isinstance(metrics[0], dict) else {}
        target_metrics = report.get("target_metrics") if isinstance(report.get("target_metrics"), dict) else {}
        target_facts = report.get("target_facts") if isinstance(report.get("target_facts"), dict) else {}
        target_quality = report.get("target_quality") if isinstance(report.get("target_quality"), dict) else {}
        cohort = report.get("metric_cohort") if isinstance(report.get("metric_cohort"), dict) else {}
        peak = report.get("peak") if isinstance(report.get("peak"), dict) else {}
        peak_cohort = report.get("peak_cohort") if isinstance(report.get("peak_cohort"), dict) else {}
        quality = report.get("quality") if isinstance(report.get("quality"), dict) else {}
        rows = []

        def add(section: str, key: str, label: str, value: Any,
                unit: str = "", note: str = "") -> None:
            row = dict(meta)
            row.update({
                "section": section,
                "metric_key": key,
                "label": label,
                "value": value,
                "unit": unit,
                "note": note,
            })
            rows.append(row)

        add("目标", "target_id", "场次 ID", target.get("id"))
        add("目标", "room_title", "直播间", target.get("room_title"))
        add("目标", "started_at", "开始时间", target.get("started_at"), "epoch")
        add("目标", "ended_at", "结束时间", target.get("ended_at"), "epoch")
        add("目标", "duration_seconds", "时长", target_metrics.get("duration_seconds"), "秒")
        add("目标", "received_per_hour", "收到 / 小时", target_metrics.get("received_per_hour"), "条/时")
        add("目标", "spoken_rate", "开始朗读率", target_metrics.get("spoken_rate"), "比例",
            str(target_facts.get("note") or "受当时读取配置影响，仅本场事实"))
        add("目标", "drop_rate", "丢弃率", target_metrics.get("drop_rate"), "比例",
            str(target_facts.get("note") or "受当时读取配置影响，仅本场事实"))
        add("目标", "target_qualified", "目标是否合格", target_quality.get("qualified"), "布尔")
        add("目标", "target_minute_complete", "目标分钟数据完整", target_quality.get("minute_complete"), "布尔")
        for flag in target_quality.get("flags") or []:
            add("目标", "target_flag_" + str(flag), "目标质量标记", flag)
        add("位置", "insights_available", "是否可排名", report.get("insights_available"), "布尔", str(report.get("reason") or ""))
        metric_list = [item for item in metrics if isinstance(item, dict)]
        if not metric_list:
            metric_list = [first_metric] if first_metric else []
        for metric in metric_list:
            metric_key = str(metric.get("key") or "metric")
            prefix = "metric_" + metric_key + "_"
            for key, label, unit in (
                ("current", "当前值", "同指标"),
                ("median", "同房间中位数", "同指标"),
                ("p25", "P25", "同指标"),
                ("p75", "P75", "同指标"),
                ("higher_count", "高于本场场次", "场"),
                ("tied_count", "持平场次", "场"),
                ("lower_count", "低于本场场次", "场"),
                ("sample_count", "有效样本", "场"),
            ):
                add("位置", prefix + key, label, metric.get(key), unit)
        for key, label in (
            ("candidate_count", "候选场次"),
            ("valid_count", "有效场次"),
            ("mock_sessions", "含模拟场次"),
            ("replaced_sessions", "切换场次"),
            ("candidate_scan_count", "扫描候选"),
            ("candidate_limit", "候选上限"),
            ("limited", "样本有限"),
        ):
            add("基线", key, label, cohort.get(key), "场")
        add("基线", "earliest", "最早候选", cohort.get("earliest"), "epoch")
        add("基线", "latest", "最晚候选", cohort.get("latest"), "epoch")
        excluded = cohort.get("excluded") if isinstance(cohort.get("excluded"), dict) else {}
        for key, label in (
            ("invalid", "非法排除"),
            ("incomplete", "不完整排除"),
            ("short", "短场排除"),
            ("overlap", "重叠排除"),
        ):
            add("基线", "excluded_" + key, label, excluded.get(key), "场")
        add("峰值", "peak_available", "峰值可计算", peak.get("available"), "布尔")
        add("峰值", "peak_reason", "峰值不可用原因", peak.get("reason") or "")
        add("峰值", "peak_count", "5 分钟峰值", peak.get("count"), "条")
        add("峰值", "peak_start_local", "峰值开始", peak.get("start_local"))
        add("峰值", "peak_end_local", "峰值结束", peak.get("end_local"))
        add("峰值", "peak_day", "峰值开始日期", peak.get("day"))
        add("峰值", "peak_end_day", "峰值结束日期", peak.get("end_day"))
        add("峰值", "peak_minute_complete", "峰值分钟完整", peak.get("minute_complete"), "布尔")
        add("峰值", "peak_hour", "峰值小时", peak.get("hour"), "点")
        add("峰值", "peak_crosses_day", "跨午夜", peak.get("crosses_day"), "布尔")
        add("峰值时段", "peak_cohort_valid", "完整峰值样本", peak_cohort.get("valid_count"), "场")
        add("峰值时段", "peak_cohort_available", "时段分布可用", peak_cohort.get("available"), "布尔")
        for item in peak_cohort.get("hours") or []:
            if isinstance(item, dict):
                add("峰值时段", "hour_%s" % item.get("hour"), "%s 点档" % item.get("hour"),
                    item.get("count"), "场")
        for flag in quality.get("flags") or []:
            add("质量", "flag_" + str(flag), "质量标记", flag)
        return _csv_text(columns, rows)

    raise ValueError("unsupported report kind: %s" % kind)


def render_json(report: Dict[str, Any]) -> str:
    return json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
