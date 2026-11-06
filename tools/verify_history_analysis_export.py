#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证趋势、单基准对比、复盘的服务端分析报告导出。"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.sessions import SessionStore  # noqa: E402

PASS = 0
FAIL = 0


def check(condition: bool, label: str, detail: object = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + repr(detail)) if detail != "" else ""))
    else:
        FAIL += 1
        print("FAIL  %s%s" % (label, ("  " + repr(detail)) if detail != "" else ""))


def seed(
    store: SessionStore,
    session_id: str,
    started: float,
    received: int,
    *,
    duration: int = 3600,
    platform: str = "bilibili",
    room_key: str = "room:777",
    room_id: int = 777,
    title: str = "",
    reason: str = "finished",
) -> None:
    store.start_session(
        session_id,
        room_id,
        title or session_id,
        started_at=started,
        platform=platform,
        room_key=room_key,
    )
    for index in range(received):
        store.record_message(
            session_id,
            "danmaku",
            started + (10 + index % 5) * 60 + 5,
            "viewer-%d" % (index % 7 + 1),
            {},
        )
    store.bump_session(session_id, "real", "spoken", int(received * 0.8))
    store.bump_session(session_id, "real", "dropped", int(received * 0.2))
    store.finish_session(session_id, ended_at=started + duration, reason=reason)


def read_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def read_csv(path: str) -> tuple[list[str], list[dict[str, str]]]:
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def main() -> int:
    with tempfile.TemporaryDirectory(
        prefix="mutai-analysis-export-",
        ignore_cleanup_errors=True,
    ) as tmp:
        store = SessionStore(str(Path(tmp) / "data" / "history.sqlite3"))
        base = datetime(2026, 1, 1, 20, 0, 0)
        for index, received in enumerate(range(20, 100, 10)):
            seed(
                store,
                "prior-%02d" % index,
                (base + timedelta(days=index)).timestamp(),
                received,
            )
        target_start = (base + timedelta(days=9)).timestamp()
        seed(store, "target", target_start, 120, title="夜航电台")
        seed(
            store,
            "dy-target",
            (base + timedelta(days=10)).timestamp(),
            60,
            platform="douyin",
            room_key="dy:42",
            room_id=42,
            title="=抖音演示",
        )
        seed(
            store,
            "dy-baseline",
            (base + timedelta(days=11)).timestamp(),
            40,
            platform="douyin",
            room_key="dy:42",
            room_id=42,
            title="抖音基线",
        )
        store.flush(3.0)

        out = str(Path(tmp) / "exports")
        trend_json = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=12)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            fmt="json",
            output_dir=out,
        )
        check(trend_json.get("ok") is True, "趋势 JSON 导出成功", trend_json)
        check(trend_json.get("report_schema_version") == 2, "趋势使用独立报告 schema", trend_json)
        trend_report = read_json(trend_json["path"])
        check(trend_report.get("kind") == "trend", "趋势报告 kind 正确")
        check(
            trend_report.get("report_schema_version") == 2 and
            trend_report.get("privacy") == "aggregate_only_no_message_bodies_or_user_identifiers",
            "趋势报告带 schema 与隐私声明",
        )
        check(len(trend_report.get("buckets") or []) >= 1, "趋势报告包含日桶")
        check(trend_report.get("scope", {}).get("room_key") == "room:777", "趋势报告固定单房间")
        check(
            "viewer-" not in json.dumps(trend_report, ensure_ascii=False) and
            "username" not in json.dumps(trend_report, ensure_ascii=False).lower(),
            "趋势报告不含用户标识",
        )

        trend_csv = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=12)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            fmt="csv",
            output_dir=out,
        )
        check(trend_csv.get("ok") is True, "趋势 CSV 导出成功", trend_csv)
        trend_columns, trend_rows = read_csv(trend_csv["path"])
        check("report_schema_version" in trend_columns and "warning_codes" in trend_columns,
              "趋势 CSV 带报告元数据")
        day_prefix = [
            "report_schema_version", "report_kind", "exported_at", "warning_codes",
            "scope_platform", "scope_room_key", "scope_room_title",
            "timezone", "utc_offset_seconds", "money_comparable", "coverage_partial",
            "day", "day_start", "sessions", "sessions_with_data", "empty_sessions",
            "real_received", "real_spoken", "real_dropped", "duration_seconds",
            "received_per_hour", "spoken_rate", "drop_rate",
            "unique_users_sum", "unique_users_max", "gift_cny", "gift_silver",
            "gift_unknown", "super_chat_cny", "mock_received", "mock_spoken",
            "mock_dropped", "short_sessions", "incomplete_sessions", "replaced_sessions",
            "unknown_end_sessions", "inconsistent_sessions", "mock_sessions", "has_data",
        ]
        check(trend_columns[:len(day_prefix)] == day_prefix,
              "日趋势 CSV 旧列顺序保持", trend_columns)
        check(len(trend_rows) >= 1 and trend_rows[0].get("report_kind") == "trend",
              "趋势 CSV 有数据行", trend_rows[:1])
        check(
            all("viewer-" not in str(value) for row in trend_rows for value in row.values()),
            "趋势 CSV 不含用户标识",
        )

        week_json = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=12)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            granularity="week",
            fmt="json",
            output_dir=out,
        )
        check(week_json.get("ok") is True, "周趋势 JSON 导出成功", week_json)
        week_report = read_json(week_json["path"])
        check(week_report.get("granularity") == "week" and
              week_report.get("trend_bucket_schema_version") == 4,
              "周趋势报告带粒度与桶 schema 版本")
        check(any(bucket.get("iso_week") for bucket in week_report.get("buckets") or []),
              "周趋势报告包含 ISO 周")
        check(any(item.get("code") == "low_bucket_sample"
                  for item in week_report.get("warnings") or []),
              "周趋势低样本写入提示")
        check(any(item.get("code") == "partial_bucket"
                  for item in week_report.get("warnings") or []),
              "周趋势首尾不完整周写入提示")
        week_text = json.dumps(week_report, ensure_ascii=False)
        check("viewer-" not in week_text and "username" not in week_text.lower() and
              "uid" not in week_text.lower(),
              "周趋势报告不含用户标识")

        week_csv = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=12)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            granularity="week",
            fmt="csv",
            output_dir=out,
        )
        check(week_csv.get("ok") is True, "周趋势 CSV 导出成功")
        week_columns, week_rows = read_csv(week_csv["path"])
        check("iso_week" in week_columns and "week_label" in week_columns and
              "partial_bucket" in week_columns,
              "周趋势 CSV 追加周字段")
        check(bool(week_rows) and week_rows[0].get("granularity") == "week" and
              week_rows[0].get("day") == "" and
              bool(week_rows[0].get("iso_week")),
              "周趋势 CSV 不伪造 day 字段", week_rows[:1])

        hour_json = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=2)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            granularity="hour",
            fmt="json",
            output_dir=out,
        )
        check(hour_json.get("ok") is True, "小时趋势 JSON 导出成功", hour_json)
        hour_report = read_json(hour_json["path"])
        check(hour_report.get("granularity") == "hour" and
              hour_report.get("trend_bucket_schema_version") == 4 and
              hour_report.get("hour_basis", {}).get("max_hours") == 168,
              "小时趋势报告带粒度、桶 schema 与上限")
        check(any(bucket.get("hour") for bucket in hour_report.get("buckets") or []),
              "小时趋势报告包含小时标签")
        hour_csv = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=2)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            granularity="hour",
            fmt="csv",
            output_dir=out,
        )
        check(hour_csv.get("ok") is True, "小时趋势 CSV 导出成功")
        hour_columns, hour_rows = read_csv(hour_csv["path"])
        check("hour" in hour_columns and "hour_start" in hour_columns and
              "hour_end" in hour_columns,
              "小时趋势 CSV 包含小时字段")
        check(bool(hour_rows) and hour_rows[0].get("granularity") == "hour" and
              hour_rows[0].get("day") == "" and
              bool(hour_rows[0].get("hour")),
              "小时趋势 CSV 不伪造 day 字段", hour_rows[:1])

        compare_json = store.export_compare_report("target", "prior-07", fmt="json", output_dir=out)
        check(compare_json.get("ok") is True, "对比 JSON 导出成功", compare_json)
        compare_report = read_json(compare_json["path"])
        check(compare_report.get("kind") == "compare", "对比报告 kind 正确")
        check(compare_report.get("target", {}).get("id") == "target", "对比报告目标正确")
        check(compare_report.get("baseline", {}).get("id") == "prior-07", "对比报告基准正确")
        check(len(compare_report.get("metrics") or []) >= 10, "对比报告包含核心指标")
        check(any(row.get("metric_key") == "received" for row in compare_report.get("metrics") or []),
              "对比报告包含收到指标")
        check(compare_report.get("money", {}).get("comparable") is True, "B站对比金额可比")

        compare_csv = store.export_compare_report("target", "prior-07", fmt="csv", output_dir=out)
        check(compare_csv.get("ok") is True, "对比 CSV 导出成功", compare_csv)
        compare_columns, compare_rows = read_csv(compare_csv["path"])
        check({"section", "metric_key", "current", "baseline", "delta"} <= set(compare_columns),
              "对比 CSV 列完整")
        check(any(row.get("metric_key") == "received" for row in compare_rows),
              "对比 CSV 包含收到指标")

        insights_json = store.export_insights_report("target", fmt="json", output_dir=out)
        check(insights_json.get("ok") is True, "复盘 JSON 导出成功", insights_json)
        insights_report = read_json(insights_json["path"])
        check(insights_report.get("kind") == "insights", "复盘报告 kind 正确")
        check(insights_report.get("insights_available") is True, "复盘报告可用")
        check(insights_report.get("target", {}).get("id") == "target", "复盘报告目标正确")
        check(insights_report.get("metric_cohort", {}).get("valid_count") == 8,
              "复盘报告保留有效样本数")
        check(insights_report.get("definitions_version") == 1, "复盘报告带定义版本")

        insights_csv = store.export_insights_report("target", fmt="csv", output_dir=out)
        check(insights_csv.get("ok") is True, "复盘 CSV 导出成功", insights_csv)
        insights_columns, insights_rows = read_csv(insights_csv["path"])
        check({"section", "metric_key", "label", "value"} <= set(insights_columns),
              "复盘 CSV 列完整")
        check(any(row.get("metric_key") == "received_per_hour" for row in insights_rows),
              "复盘 CSV 包含收到/小时")
        check(any(row.get("metric_key") == "peak_count" for row in insights_rows),
              "复盘 CSV 包含峰值")

        douyin = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=13)).timestamp(),
            platform="douyin",
            room_key="dy:42",
            fmt="json",
            output_dir=out,
        )
        check(douyin.get("ok") is True, "抖音趋势报告可降级导出", douyin)
        douyin_report = read_json(douyin["path"])
        check(douyin_report.get("money", {}).get("comparable") is False,
              "跨平台金额明确标注不可比")
        check(douyin_report.get("totals", {}).get("gift_cny") is None,
              "不可比金额不写入汇总")
        check(any(item.get("code") == "money_not_comparable"
                  for item in douyin_report.get("warnings") or []),
              "不可比金额写入质量提示")
        check(any(item.get("code") == "money_not_comparable" and
                  "钻石" in str(item.get("message") or "")
                  for item in douyin_report.get("warnings") or []),
              "抖音趋势提示包含钻石口径",
              douyin_report.get("warnings"))

        douyin_csv = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=13)).timestamp(),
            platform="douyin",
            room_key="dy:42",
            fmt="csv",
            output_dir=out,
        )
        check(douyin_csv.get("ok") is True, "抖音趋势 CSV 可导出")
        _, douyin_rows = read_csv(douyin_csv["path"])
        check(bool(douyin_rows) and douyin_rows[0].get("money_comparable") == "False",
              "抖音 CSV 明确标注金额不可比")

        douyin_compare = store.export_compare_report(
            "dy-target", "dy-baseline", fmt="json", output_dir=out
        )
        check(douyin_compare.get("ok") is True, "抖音对比报告可降级导出", douyin_compare)
        douyin_compare_report = read_json(douyin_compare["path"])
        check(douyin_compare_report.get("money", {}).get("comparable") is False,
              "抖音对比金额明确标注不可比")
        check("钻石" in str(douyin_compare_report.get("money", {}).get("note") or "") and
              "SC/舰长" in str(douyin_compare_report.get("money", {}).get("note") or ""),
              "抖音对比报告说明钻石与 SC/舰长边界",
              douyin_compare_report.get("money"))
        check(douyin_compare_report.get("money", {}).get("gift_value_unit") == "diamond" and
              douyin_compare_report.get("money", {}).get("supports_super_chat") is False,
              "抖音对比报告暴露平台能力")
        check(all(row.get("current") is None
                  for row in douyin_compare_report.get("money", {}).get("rows") or []),
              "不可比对比金额不写入报告数值")

        sparse_insights = store.export_insights_report(
            "dy-target", fmt="json", output_dir=out
        )
        check(sparse_insights.get("ok") is True, "样本不足复盘仍可导出降级报告", sparse_insights)
        sparse_report = read_json(sparse_insights["path"])
        check(sparse_report.get("insights_available") is False and
              sparse_report.get("reason") == "insufficient_sample",
              "降级复盘保留不可排名原因")
        check(any(item.get("code") == "insights_unavailable"
                  for item in sparse_report.get("warnings") or []),
              "降级复盘写入质量提示")

        bad_fmt = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=12)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            fmt="txt",
            output_dir=out,
        )
        check(bad_fmt.get("ok") is False and "JSON" in str(bad_fmt.get("error")),
              "拒绝未知报告格式", bad_fmt)

        empty = store.export_trend_report(
            (base + timedelta(days=30)).timestamp(),
            (base + timedelta(days=31)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            fmt="json",
            output_dir=out,
        )
        check(empty.get("ok") is False and empty.get("error_code") in ("no_data", "scope_not_found"),
              "无数据趋势 fail-closed", empty)

        original_flush = store.flush
        store.flush = lambda timeout=None: False  # type: ignore[assignment]
        stale = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=12)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            fmt="json",
            output_dir=out,
        )
        store.flush = original_flush  # type: ignore[assignment]
        check(stale.get("ok") is False and stale.get("error_code") == "data_stale",
              "写入未落盘时 fail-closed", stale)

        store.flush = lambda timeout=None: False  # type: ignore[assignment]
        stale_compare = store.export_compare_report(
            "target", "prior-07", fmt="json", output_dir=out
        )
        stale_insights = store.export_insights_report(
            "target", fmt="csv", output_dir=out
        )
        store.flush = original_flush  # type: ignore[assignment]
        check(stale_compare.get("ok") is False and
              stale_compare.get("error_code") == "data_stale",
              "对比写入未落盘时 fail-closed", stale_compare)
        check(stale_insights.get("ok") is False and
              stale_insights.get("error_code") == "data_stale",
              "复盘写入未落盘时 fail-closed", stale_insights)

        # 直接验证 CSV 公式注入防护：把标题伪装成公式，不能出现在可执行首列。
        fake = {
            "report_schema_version": 1,
            "kind": "compare",
            "exported_at": int(time.time()),
            "warnings": [],
            "scope": {"platform": "bilibili", "room_key": "=cmd"},
            "target": {"id": "target"},
            "baseline": {"id": "baseline"},
            "metrics": [{
                "section": "x",
                "metric_key": "x",
                "label": "x",
                "current": 1,
                "baseline": 0,
                "delta": 1,
                "unit": "",
            }],
            "types": [],
            "money": {"comparable": True, "rows": []},
            "quality_flags": ["=formula"],
        }
        from backend.history_report import render_csv
        text = render_csv(fake)
        check("'=cmd" in text or "\"'=cmd\"" in text or ",'=cmd" in text,
              "报告 CSV 公式注入被转义", text[:200])

        from backend.history_report import (
            build_insights_report,
            build_trend_report,
            render_json,
        )

        fake_trend = {
            "ok": True,
            "api_version": 1,
            "as_of": time.time(),
            "timezone": "中国标准时间",
            "utc_offset_seconds": 28800,
            "scope": {"platform": "douyin", "room_key": "dy:42", "room_title": "抖音"},
            "filters": {"query": "", "platform": "douyin", "room_key": "dy:42"},
            "range": {"started_from": 1, "started_to": 2, "days": 1},
            "counts": {},
            "totals": {"gift_cny": 12.5, "gift_silver": 3, "gift_unknown": 4, "super_chat_cny": 5},
            "money": {"comparable": False, "gift_cny": 12.5, "gift_silver": 3,
                      "gift_unknown": 4, "super_chat_cny": 5},
            "quality": {},
            "coverage": {},
            "buckets": [{"sessions": 1, "gift_cny": 12.5, "gift_silver": 3,
                         "gift_unknown": 4, "super_chat_cny": 5}],
            "data_health": {"flushed": True, "pending_writes": 0,
                            "dropped_ops": 0, "failed_ops": 0},
        }
        sanitized = build_trend_report(fake_trend, 1)
        check(
            sanitized["money"]["gift_cny"] is None and
            sanitized["buckets"][0]["gift_cny"] is None and
            sanitized["buckets"][0]["super_chat_cny"] is None,
            "不可比金额在 JSON 报告与日桶中同时抑制",
            {
                "money": sanitized["money"],
                "bucket": sanitized["buckets"][0],
            },
        )

        fake_insights = {
            "ok": True,
            "api_version": 1,
            "definitions_version": 7,
            "insights_available": True,
            "target": {"id": "t", "room_title": "测试"},
            "target_metrics": {"duration_seconds": 3600},
            "target_facts": {"note": "配置相关"},
            "target_quality": {"flags": []},
            "metric_cohort": {"excluded": {}},
            "metrics": [{"key": "received_per_hour", "current": 10, "median": 9}],
            "peak": {"available": True},
            "peak_cohort": {"hours": []},
            "quality": {"flags": [], "last_write_error": "C:/secret/path"},
        }
        insight_report = build_insights_report(fake_insights, 1)
        insight_csv = render_csv(insight_report)
        check("definitions_version" in insight_csv.splitlines()[0] and
              "7" in insight_csv,
              "复盘 CSV 带定义版本")
        check("C:/secret/path" not in render_json(insight_report),
              "复盘报告不泄露本机写入错误路径")
        try:
            render_json({"bad": float("nan")})
            nan_rejected = False
        except ValueError:
            nan_rejected = True
        check(nan_rejected, "JSON 导出拒绝 NaN")

        first_path = trend_json["path"]
        second_path = store.export_trend_report(
            (base - timedelta(days=1)).timestamp(),
            (base + timedelta(days=12)).timestamp(),
            platform="bilibili",
            room_key="room:777",
            fmt="json",
            output_dir=out,
        ).get("path")
        check(first_path != second_path, "同秒分析报告文件名不冲突", [first_path, second_path])

        store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
