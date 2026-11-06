#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证事实型复盘：同房间基线、名次、峰值和降级口径。"""

from __future__ import annotations

import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.sessions import SessionStore  # noqa: E402
from backend.history_insights import peak_stats  # noqa: E402

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
    reason: str = "finished",
    platform: str = "bilibili",
    room_key: str = "room:777",
    room_id: int = 777,
    minutes: bool = True,
    minute_offset: int = 10,
) -> None:
    store.start_session(
        session_id, room_id, session_id,
        started_at=started, platform=platform, room_key=room_key,
    )
    if minutes:
        for index in range(received):
            offset = minute_offset + index % 5
            store.record_message(
                session_id, "danmaku",
                started + offset * 60 + 5,
                "u%d" % (index % 7 + 1), {},
            )
    else:
        store.bump_session(session_id, "real", "received", received)
    store.bump_session(session_id, "real", "spoken", int(received * 0.8))
    store.bump_session(session_id, "real", "dropped", int(received * 0.2))
    store.finish_session(session_id, ended_at=started + duration, reason=reason)


def main() -> int:
    short_peak = peak_stats(
        {"started_at": 1000, "ended_at": 1299, "real_received": 20},
        [{"minute": 16, "count": 20}],
    )
    check(short_peak.get("available") is False and
          short_peak.get("reason") == "short_duration" and
          short_peak.get("minute_complete") is True,
          "299 秒场次不伪造完整 5 分钟窗口", short_peak)

    cross_start = datetime(2026, 1, 1, 23, 58, 0).timestamp()
    cross_peak = peak_stats(
        {"started_at": cross_start, "ended_at": cross_start + 900, "real_received": 10},
        [
            {"minute": int(cross_start // 60), "count": 5},
            {"minute": int(cross_start // 60) + 2, "count": 5},
        ],
    )
    check(cross_peak.get("available") and cross_peak.get("crosses_day") is True and
          cross_peak.get("day") != cross_peak.get("end_day"),
          "跨午夜峰值保留日期信息", cross_peak)
    too_long_peak = peak_stats(
        {"started_at": 1000, "ended_at": 1000 + 8 * 86400, "real_received": 20},
        [],
    )
    check(too_long_peak.get("available") is False and
          too_long_peak.get("reason") == "duration_too_long",
          "超长场次跳过峰值计算", too_long_peak)
    huge_peak = peak_stats(
        {"started_at": 1e13, "ended_at": 1e13 + 3600, "real_received": 20},
        [],
    )
    check(huge_peak.get("available") is False and
          huge_peak.get("reason") == "invalid_time",
          "超大 epoch 不进入本地时间转换", huge_peak)

    with tempfile.TemporaryDirectory(prefix="mutai-insights-") as tmp:
        store = SessionStore(str(Path(tmp) / "full" / "history.sqlite3"))
        base = datetime(2026, 1, 1, 20, 0, 0)
        prior_rates = list(range(20, 60, 2))
        for index, received in enumerate(prior_rates):
            seed(
                store,
                "prior-%02d" % index,
                (base + timedelta(days=index)).timestamp(),
                received,
            )
        target_start = (base + timedelta(days=21)).timestamp()
        seed(store, "target", target_start, 100)
        store.flush(3.0)

        result = store.session_insights("target")
        check(result.get("ok") and result.get("insights_available"),
              "复盘主路径可用", result.get("error_code"))
        metric = (result.get("metrics") or [{}])[0]
        cohort = result.get("metric_cohort") or {}
        check(cohort.get("valid_count") == 20, "最近 20 场样本纳入", cohort)
        check(abs(float(metric.get("median") or 0) - 39.0) < 1e-9,
              "收到/小时中位数", metric.get("median"))
        check(abs(float(metric.get("p25") or 0) - 29.5) < 1e-9 and
              abs(float(metric.get("p75") or 0) - 48.5) < 1e-9,
              "P25/P75 线性插值", {"p25": metric.get("p25"), "p75": metric.get("p75")})
        check(metric.get("higher_count") == 0 and
              metric.get("tied_count") == 0 and
              metric.get("lower_count") == 20,
              "名次三种计数", metric)
        peak = result.get("peak") or {}
        check(peak.get("available") and peak.get("count") == 100 and
              peak.get("offset_start_min") == 10,
              "滚动 5 分钟峰值", peak)
        peak_cohort = result.get("peak_cohort") or {}
        check(peak_cohort.get("available") and
              peak_cohort.get("hours", [{}])[0].get("hour") == 20 and
              peak_cohort.get("valid_count") == 20,
              "峰值小时分布", peak_cohort)
        target_facts = result.get("target_facts") or {}
        check(abs(float(target_facts.get("spoken_rate") or 0) - 0.8) < 1e-9,
              "开始朗读率只作为本场事实", target_facts)
        check("requested" not in result and "minutes" not in result,
              "复盘响应不返回原始分钟桶")
        store._dropped_ops = 1
        degraded = store.session_insights("target")
        check((degraded.get("quality") or {}).get("degraded") is True and
              "degraded" in (degraded.get("quality") or {}).get("flags", []),
              "全局写入缺口只降级提示", degraded.get("quality"))
        store.close()

        insufficient = SessionStore(str(Path(tmp) / "small" / "history.sqlite3"))
        for index in range(7):
            seed(
                insufficient,
                "small-%02d" % index,
                (base + timedelta(days=index)).timestamp(),
                30,
            )
        seed(
            insufficient,
            "small-target",
            (base + timedelta(days=8)).timestamp(),
            40,
        )
        insufficient.flush(3.0)
        small_result = insufficient.session_insights("small-target")
        check(small_result.get("ok") and
              small_result.get("insights_available") is False and
              small_result.get("reason") == "insufficient_sample",
              "有效样本不足返回降级", small_result.get("reason"))
        small_metric = (small_result.get("metrics") or [{}])[0]
        check(small_metric.get("available") is False and
              small_metric.get("median") is None,
              "样本不足不伪造中位数")
        small_peak = small_result.get("peak_cohort") or {}
        check(small_peak.get("available") is False,
              "峰值样本不足不生成小时分布")
        insufficient.close()

        exclusions = SessionStore(str(Path(tmp) / "exclude" / "history.sqlite3"))
        for index in range(8):
            seed(
                exclusions,
                "good-%02d" % index,
                (base + timedelta(days=index)).timestamp(),
                30 + index,
            )
        target_excl = (base + timedelta(days=20)).timestamp()
        seed(
            exclusions, "short", (base + timedelta(days=9)).timestamp(), 30,
            duration=300,
        )
        seed(
            exclusions, "incomplete", (base + timedelta(days=10)).timestamp(), 30,
            reason="stale",
        )
        seed(
            exclusions, "unknown-end", (base + timedelta(days=11)).timestamp(), 30,
            reason="mystery",
        )
        seed(
            exclusions, "overlap", target_excl - 1800, 30,
        )
        seed(exclusions, "target-excl", target_excl, 50)
        exclusions.flush(3.0)
        excl_result = exclusions.session_insights("target-excl")
        excl_cohort = excl_result.get("metric_cohort") or {}
        excluded = excl_cohort.get("excluded") or {}
        check(excl_cohort.get("valid_count") == 8,
              "只纳入合格基线", excl_cohort.get("valid_count"))
        check(excluded.get("short") == 1 and
              excluded.get("incomplete") == 2 and
              excluded.get("overlap") == 1,
              "候选排除原因计数", excluded)
        check(excl_result.get("insights_available") and
              (excl_result.get("metrics") or [{}])[0].get("p25") is None,
              "8–11 场不展示四分位区间")
        exclusions.close()

        target_gate = SessionStore(str(Path(tmp) / "gate" / "history.sqlite3"))
        seed(
            target_gate, "short-target",
            base.timestamp(), 10,
        )
        seed(
            target_gate, "incomplete-target",
            (base + timedelta(days=1)).timestamp(), 50,
            reason="connect_failed",
        )
        future_start = time.time() + 86400
        seed(target_gate, "future-target", future_start, 50)
        seed(target_gate, "huge-target", 1e13, 50)
        target_gate.start_session(
            "active-target", 777, "进行中",
            started_at=(base + timedelta(days=2)).timestamp(),
            platform="bilibili", room_key="room:777",
        )
        seed(
            target_gate, "empty-room", base.timestamp(), 50,
            room_key="", room_id=0,
        )
        target_gate.flush(3.0)
        short_target = target_gate.session_insights("short-target")
        check(short_target.get("ok") and
              short_target.get("insights_available") is False and
              short_target.get("reason") == "target_unqualified",
              "短场目标不生成名次")
        incomplete_target = target_gate.session_insights("incomplete-target")
        check(incomplete_target.get("insights_available") is False and
              incomplete_target.get("reason") == "target_unqualified",
              "不完整目标不生成名次")
        future_target = target_gate.session_insights("future-target")
        check(future_target.get("insights_available") is False and
              future_target.get("reason") == "target_unqualified",
              "未来场次不进入复盘名次", future_target.get("target_quality"))
        check((future_target.get("peak") or {}).get("available") is False,
              "未来场次不生成峰值", future_target.get("peak"))
        huge_target = target_gate.session_insights("huge-target")
        check(huge_target.get("ok") and
              huge_target.get("insights_available") is False and
              huge_target.get("reason") == "target_unqualified",
              "超大 epoch 返回结构化降级", huge_target.get("error_code"))
        active_target = target_gate.session_insights("active-target")
        check(active_target.get("error_code") == "target_active",
              "进行中目标 fail-closed", active_target.get("error_code"))
        empty_room = target_gate.session_insights("empty-room")
        check(empty_room.get("error_code") == "target_incomplete",
              "空房间目标 fail-closed", empty_room.get("error_code"))
        missing = target_gate.session_insights("missing")
        check(missing.get("error_code") == "target_not_found",
              "缺失目标 fail-closed", missing.get("error_code"))
        original_flush = target_gate.flush
        target_gate.flush = lambda timeout=3.0: False
        stale = target_gate.session_insights("short-target")
        check(stale.get("error_code") == "data_stale",
              "writer barrier 未完成硬失败", stale.get("error_code"))
        target_gate.flush = original_flush
        target_gate.close()

        no_minutes = SessionStore(str(Path(tmp) / "minutes" / "history.sqlite3"))
        for index in range(8):
            seed(
                no_minutes,
                "nm-prior-%02d" % index,
                (base + timedelta(days=index)).timestamp(),
                30,
            )
        seed(
            no_minutes, "nm-target",
            (base + timedelta(days=9)).timestamp(),
            50, minutes=False,
        )
        no_minutes.flush(3.0)
        nm_result = no_minutes.session_insights("nm-target")
        check(nm_result.get("insights_available"),
              "分钟不完整仍可做 received/hour 位置")
        check((nm_result.get("peak") or {}).get("available") is False and
              (nm_result.get("peak") or {}).get("reason") == "minute_incomplete",
              "目标分钟不完整不计算峰值", nm_result.get("peak"))
        check("target_minute_incomplete" in
              (nm_result.get("quality") or {}).get("flags", []),
              "目标分钟不完整质量标记")
        no_minutes.close()

        hours_store = SessionStore(str(Path(tmp) / "hours" / "history.sqlite3"))
        hour_base = datetime(2026, 2, 1, 0, 0, 0)
        for index in range(20):
            seed(
                hours_store,
                "hour-%02d" % index,
                (hour_base + timedelta(hours=index)).timestamp(),
                30,
            )
        seed(
            hours_store,
            "hours-target",
            (hour_base + timedelta(days=2)).timestamp(),
            50,
        )
        hours_store.flush(3.0)
        hours_result = hours_store.session_insights("hours-target")
        hours = (hours_result.get("peak_cohort") or {}).get("hours") or []
        check(len(hours) == 20 and
              (hours_result.get("peak_cohort") or {}).get("total_samples") == 20,
              "峰值小时返回完整非零分布，不静默截断", hours)
        hours_store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
