#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证历史日趋势聚合的口径、过滤、空桶和质量标记。"""

from __future__ import annotations

import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.history_trend import _iso_week_label, _week_start  # noqa: E402
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


def at(day: datetime, hour: int, minute: int = 0) -> float:
    return (day + timedelta(hours=hour, minutes=minute)).timestamp()


def seed(store: SessionStore, session_id: str, started: float, received: int, spoken: int, dropped: int,
         *, platform: str = "bilibili", room_id: int = 1, room_key: str = "1", title: str = "测试场") -> None:
    store.start_session(
        session_id, room_id, title, started_at=started,
        platform=platform, room_key=room_key,
    )
    store.bump_session(session_id, "real", "received", received)
    store.bump_session(session_id, "real", "spoken", spoken)
    store.bump_session(session_id, "real", "dropped", dropped)
    store.finish_session(session_id, ended_at=started + 3600, reason="manual_disconnect")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-trend-") as tmp:
        store = SessionStore(str(Path(tmp) / "data" / "history.sqlite3"))
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        yesterday = today - timedelta(days=1)
        tomorrow = today + timedelta(days=1)
        seed(store, "today-a", at(today, 10), 100, 80, 20, title="今天 A")
        seed(store, "today-b", at(today, 15), 50, 25, 25, title="今天 B")
        seed(store, "yesterday-a", at(yesterday, 10), 20, 20, 0, title="昨天 A")
        store.start_session("active", 1, "进行中", started_at=time.time() - 60)
        store.flush(3.0)

        result = store.trend_sessions(yesterday.timestamp(), tomorrow.timestamp())
        check(result.get("ok"), "日趋势查询成功", result)
        counts = result.get("counts") or {}
        totals = result.get("totals") or {}
        buckets = result.get("buckets") or []
        check(counts.get("matched_sessions") == 3, "趋势匹配场次数", counts.get("matched_sessions"))
        check(counts.get("active_sessions") == 1, "进行中场次只计数不绘制", counts.get("active_sessions"))
        check(totals.get("real_received") == 170, "趋势收到总量", totals.get("real_received"))
        check(totals.get("real_spoken") == 125, "趋势开始朗读总量", totals.get("real_spoken"))
        check(totals.get("real_dropped") == 45, "趋势丢弃总量", totals.get("real_dropped"))
        check(abs(float(totals.get("duration_seconds") or 0) - 10800.0) < 1e-6,
              "趋势总时长按场次实际起止计算", totals.get("duration_seconds"))
        check(abs(float(totals.get("spoken_rate") or 0) - 125 / 170) < 1e-9, "趋势比率按总量计算")
        check(len(buckets) == 2, "两天范围补齐两个日桶", len(buckets))
        check(sum(int(bucket["sessions"]) for bucket in buckets) == counts["matched_sessions"], "桶场次数与总计对账")
        check(buckets[0]["day"] < buckets[1]["day"], "日桶按时间升序")
        check(buckets[1]["sessions"] == 2, "今天包含两场")
        check(buckets[1]["real_received"] == 150, "今天收到量")
        check(result.get("quality", {}).get("short_sessions") == 0, "正常样本不被标短场")

        filtered = store.trend_sessions(yesterday.timestamp(), tomorrow.timestamp(), query="今天 A")
        check(filtered.get("counts", {}).get("matched_sessions") == 1, "趋势复用标题搜索")
        check(filtered.get("totals", {}).get("real_received") == 100, "趋势搜索后总量")

        empty = store.trend_sessions(
            (today - timedelta(days=5)).timestamp(),
            (today - timedelta(days=4)).timestamp(),
        )
        check(empty.get("ok") and empty["counts"]["matched_sessions"] == 0, "空范围正常返回")
        check(empty.get("buckets") and empty["buckets"][0]["has_data"] is False, "空桶不是 0% 数据")
        check(empty["totals"]["spoken_rate"] is None, "空范围比率使用 null")

        invalid = store.trend_sessions(tomorrow.timestamp(), today.timestamp())
        check(not invalid.get("ok") and invalid.get("error_code") == "invalid_range", "倒置范围错误码")
        too_large = store.trend_sessions(
            (today - timedelta(days=400)).timestamp(),
            today.timestamp(),
        )
        check(not too_large.get("ok") and too_large.get("error_code") == "range_too_large", "超长范围不截断")

        seed(store, "douyin-a", at(today, 12), 10, 5, 5, platform="douyin", room_id=0, room_key="dy:a", title="抖音场")
        store.flush(3.0)
        mixed_platforms = store.trend_sessions(yesterday.timestamp(), tomorrow.timestamp())
        check(not mixed_platforms.get("ok") and
              mixed_platforms.get("error_code") == "scope_required",
              "多直播间不得静默合并趋势", mixed_platforms.get("error_code"))
        check(len(mixed_platforms.get("rooms") or []) == 2,
              "多直播间返回可选范围", mixed_platforms.get("rooms"))
        check("totals" not in mixed_platforms and "buckets" not in mixed_platforms,
              "范围未确定时不返回聚合数据")

        bili_only = store.trend_sessions(
            yesterday.timestamp(), tomorrow.timestamp(),
            platform="bilibili", room_key="1",
        )
        check(bili_only.get("ok"), "指定直播间后趋势可用", bili_only.get("error_code"))
        check(bili_only.get("counts", {}).get("matched_sessions") == 3,
              "指定房间只聚合该房间", bili_only.get("counts", {}).get("matched_sessions"))
        check(bili_only.get("counts", {}).get("platform_count") == 1,
              "单房间趋势只含一个平台")
        check(bili_only.get("scope", {}).get("room_key") == "1",
              "趋势返回确定的房间口径", bili_only.get("scope"))
        check(bili_only.get("scope", {}).get("room_title") == "今天 B",
              "房间名称取范围内最近开播场次", bili_only.get("scope", {}).get("room_title"))
        check(bili_only.get("money", {}).get("comparable") is True,
              "单房间金额字段可比较", bili_only.get("money"))

        douyin_only = store.trend_sessions(
            yesterday.timestamp(), tomorrow.timestamp(),
            platform="douyin", room_key="dy:a",
        )
        check(douyin_only.get("ok") and
              douyin_only.get("counts", {}).get("matched_sessions") == 1,
              "其他平台按平台房间独立聚合", douyin_only.get("scope"))

        missing_room = store.trend_sessions(
            yesterday.timestamp(), tomorrow.timestamp(),
            platform="bilibili", room_key="not-found",
        )
        check(not missing_room.get("ok") and
              missing_room.get("error_code") == "scope_not_found",
              "不存在的房间 fail-closed", missing_room.get("error_code"))

        empty_room_day = today - timedelta(days=2)
        seed(
            store, "empty-room", at(empty_room_day, 10), 9, 3, 6,
            room_id=0, room_key="", title="缺少房间标识",
        )
        store.flush(3.0)
        valid_with_unscoped = store.trend_sessions(
            empty_room_day.timestamp(), tomorrow.timestamp(),
            platform="bilibili", room_key="1",
        )
        check(valid_with_unscoped.get("ok"), "存在空房间旧场次时仍可按房间趋势")
        check(valid_with_unscoped.get("quality", {}).get("unscoped_sessions") == 1,
              "范围内空房间显式标记且不静默遗漏",
              valid_with_unscoped.get("quality", {}).get("unscoped_sessions"))
        empty_only = store.trend_sessions(
            empty_room_day.timestamp(),
            (empty_room_day + timedelta(days=1)).timestamp(),
        )
        check(not empty_only.get("ok") and
              empty_only.get("error_code") == "scope_incomplete",
              "只有空房间标识时 fail-closed", empty_only.get("error_code"))
        check(empty_only.get("unscoped_sessions") == 1,
              "空房间数量显式返回", empty_only.get("unscoped_sessions"))

        store.start_session(
            "douyin-money", 0, "抖音金额隔离", started_at=at(today, 16),
            platform="douyin", room_key="dy:money",
        )
        store.record_message(
            "douyin-money", "gift", at(today, 16, 1), "u1",
            {"diamond_count": 100, "num": 2, "coin_type": "diamond"},
        )
        store.record_message(
            "douyin-money", "super_chat", at(today, 16, 2), "u2",
            {"price": 100},
        )
        store.finish_session("douyin-money", ended_at=at(today, 16, 30), reason="manual_disconnect")
        store.flush(3.0)
        money_session = store.get_session("douyin-money").get("session") or {}
        check(money_session.get("gift_cny") == 0 and
              money_session.get("super_chat_cny") == 0 and
              money_session.get("gift_diamond") == 200,
              "非 B 平台金额不按 B 站规则折算",
              {"gift_cny": money_session.get("gift_cny"),
               "gift_diamond": money_session.get("gift_diamond"),
               "super_chat_cny": money_session.get("super_chat_cny")})
        douyin_money = store.trend_sessions(
            today.timestamp(), tomorrow.timestamp(),
            platform="douyin", room_key="dy:money",
        )
        check(douyin_money.get("ok") and
              douyin_money.get("money", {}).get("comparable") is False,
              "未接入金额口径的平台 fail-closed", douyin_money.get("money"))
        check("钻石" in str(douyin_money.get("money", {}).get("note") or "") and
              "SC/舰长" in str(douyin_money.get("money", {}).get("note") or ""),
              "抖音趋势明确说明钻石与 SC/舰长边界",
              douyin_money.get("money", {}).get("note"))
        check(
            all(douyin_money.get("money", {}).get(key) is None
                for key in ("gift_cny", "gift_silver", "gift_unknown", "super_chat_cny")),
            "不可比平台 API 金额字段置空",
            douyin_money.get("money"),
        )
        check(douyin_money.get("money", {}).get("gift_diamond") == 200,
              "抖音趋势保留钻石流水",
              douyin_money.get("money"))

        huge = store.trend_sessions(0, 1e12)
        check(not huge.get("ok") and huge.get("error_code") == "range_too_large",
              "超大时间范围在任何 SQL 前快速失败", huge.get("error_code"))
        out_of_range = store.trend_sessions(1e12, 1e12 + 1)
        check(not out_of_range.get("ok") and
              out_of_range.get("error_code") == "invalid_range",
              "超出日期支持范围 fail-closed", out_of_range.get("error_code"))

        store.close()

        fresh_store = SessionStore(str(Path(tmp) / "async" / "history.sqlite3"))
        seed(fresh_store, "just-finished", at(today, 11), 12, 8, 4)
        fresh = fresh_store.trend_sessions(yesterday.timestamp(), tomorrow.timestamp())
        check(fresh.get("ok") and
              fresh.get("counts", {}).get("matched_sessions") == 1,
              "趋势读取前等待异步 writer 落盘", fresh.get("counts"))
        check(fresh.get("data_health", {}).get("flushed") is True and
              fresh.get("data_health", {}).get("pending_writes") == 0,
              "趋势返回写入屏障状态", fresh.get("data_health"))
        seed(fresh_store, "legacy-overlap", at(today, 12), 1, 1, 1)
        fresh_overlap = fresh_store.trend_sessions(yesterday.timestamp(), tomorrow.timestamp())
        check(fresh_overlap.get("quality", {}).get("inconsistent_sessions") == 1,
              "历史朗读/丢弃重叠会被质量标记",
              fresh_overlap.get("quality", {}).get("inconsistent_sessions"))
        fresh_store.close()

        week_store = SessionStore(str(Path(tmp) / "week" / "history.sqlite3"))
        week_base = datetime(2018, 12, 31, 0, 0, 0)  # Monday, ISO 2019-W01
        for date_value, expected in (
            (datetime(2018, 12, 31), "2019-W01"),
            (datetime(2020, 12, 28), "2020-W53"),
            (datetime(2021, 1, 4), "2021-W01"),
        ):
            check(_iso_week_label(_week_start(date_value.timestamp())) == expected,
                  "ISO 周跨年: " + expected)
        seed(week_store, "week-midnight", week_base.timestamp(), 10, 5, 5)
        seed(week_store, "week-a", at(week_base, 10), 100, 80, 20)
        seed(
            week_store,
            "week-cross-midnight",
            at(week_base + timedelta(days=6), 23, 59),
            30,
            20,
            10,
        )
        seed(week_store, "week-c", at(week_base + timedelta(days=14), 10), 40, 30, 10)
        week_store.flush(3.0)
        week_result = week_store.trend_sessions(
            week_base.timestamp(),
            (week_base + timedelta(days=21)).timestamp(),
            granularity="week",
        )
        check(week_result.get("ok") and week_result.get("granularity") == "week",
              "周趋势查询成功", week_result.get("granularity"))
        week_buckets = week_result.get("buckets") or []
        check(len(week_buckets) == 3 and week_result["range"]["bucket_count"] == 3,
              "21 天范围补齐 3 个自然周", week_result.get("range"))
        check(week_buckets[0].get("iso_week") == "2019-W01" and
              week_buckets[0].get("week_start_date") == "2018-12-31" and
              week_buckets[0].get("week_last_date") == "2019-01-06",
              "跨年周使用 ISO week-year", week_buckets[0])
        check("day" not in week_buckets[0] and "day_start" not in week_buckets[0],
              "周桶不伪造 day 字段")
        check(week_buckets[0].get("sessions") == 3 and
              week_buckets[0].get("real_received") == 140,
              "周日深夜场次归入开播周", week_buckets[0])
        check(week_buckets[1].get("sessions") == 0 and
              week_buckets[1].get("has_data") is False,
              "空周保留零桶", week_buckets[1])
        check(week_buckets[2].get("sessions") == 1,
              "下一周场次独立聚合", week_buckets[2])
        check(week_result["counts"]["non_empty_buckets"] == 2 and
              week_result["counts"]["empty_buckets"] == 1 and
              week_result["counts"]["partial_buckets"] == 0,
              "周桶计数与空桶统计", week_result.get("counts"))
        check(week_result.get("week_basis", {}).get("start_weekday") == "monday" and
              week_result.get("week_basis", {}).get("end_exclusive") is True,
              "周口径显式声明", week_result.get("week_basis"))
        week_day_totals = week_store.trend_sessions(
            week_base.timestamp(),
            (week_base + timedelta(days=21)).timestamp(),
            granularity="day",
        ).get("totals")
        check(week_day_totals == week_result.get("totals"),
              "日/周聚合 totals 对账一致",
              {"day": week_day_totals, "week": week_result.get("totals")})
        partial_week = week_store.trend_sessions(
            week_base.timestamp() + 86400,
            (week_base + timedelta(days=20)).timestamp(),
            granularity="week",
        )
        check(partial_week["range"]["first_bucket_partial"] is True and
              partial_week["range"]["last_bucket_partial"] is True,
              "首尾不完整周显式标记", partial_week.get("range"))
        partial_first = (partial_week.get("buckets") or [{}])[0]
        check(partial_first.get("effective_start") == week_base.timestamp() + 86400 and
              partial_first.get("effective_end") == _week_start(week_base.timestamp()) + 7 * 86400,
              "不完整周记录实际生效边界", partial_first)
        invalid_granularity = week_store.trend_sessions(
            week_base.timestamp(),
            (week_base + timedelta(days=7)).timestamp(),
            granularity="month",
        )
        check(not invalid_granularity.get("ok") and
              invalid_granularity.get("error_code") == "unsupported_granularity",
              "未知趋势粒度 fail-closed", invalid_granularity.get("error_code"))
        long_week = week_store.trend_sessions(
            week_base.timestamp(),
            (week_base + timedelta(days=366)).timestamp(),
            granularity="week",
        )
        check(long_week.get("ok") and long_week["range"]["days"] == 366 and
              1 <= long_week["range"]["bucket_count"] <= 54,
              "366 天周范围最多 54 个桶", long_week.get("range"))
        day_still = week_store.trend_sessions(
            week_base.timestamp(),
            (week_base + timedelta(days=2)).timestamp(),
            granularity="day",
        )
        check(day_still.get("ok") and day_still.get("granularity") == "day" and
              "day" in (day_still.get("buckets") or [{}])[0],
              "日粒度契约保持", day_still.get("granularity"))
        week_store.close()

        hour_store = SessionStore(str(Path(tmp) / "hour" / "history.sqlite3"))
        hour_base = datetime(2026, 1, 5, 10, 0)
        seed(hour_store, "hour-a", at(hour_base, 0, 5), 100, 80, 20)
        seed(hour_store, "hour-b", at(hour_base, 0, 50), 20, 10, 10)
        seed(hour_store, "hour-c", at(hour_base, 1, 15), 30, 20, 10)
        seed(hour_store, "hour-d", at(hour_base, 3, 0), 40, 30, 10)
        hour_store.flush(3.0)
        hour_result = hour_store.trend_sessions(
            hour_base.timestamp(),
            (hour_base + timedelta(hours=4)).timestamp(),
            granularity="hour",
        )
        hour_buckets = hour_result.get("buckets") or []
        check(hour_result.get("ok") and hour_result.get("granularity") == "hour",
              "小时趋势查询成功", hour_result.get("error_code"))
        check(hour_result.get("range", {}).get("hours") == 4 and
              len(hour_buckets) == 4 and
              hour_result.get("range", {}).get("bucket_count") == 4,
              "四小时范围补齐四个小时桶", hour_result.get("range"))
        check(hour_buckets[0].get("hour") == "2026-01-05 10:00" and
              hour_buckets[0].get("sessions") == 2 and
              hour_buckets[0].get("real_received") == 120,
              "同一小时场次聚合", hour_buckets[0])
        check("day" not in hour_buckets[0] and "day_start" not in hour_buckets[0],
              "小时桶不伪造 day 字段")
        check(hour_buckets[2].get("sessions") == 0 and
              hour_buckets[2].get("has_data") is False,
              "空小时保留零桶")
        check(hour_result.get("hour_basis", {}).get("max_hours") == 168,
              "小时趋势显式声明 7 天上限", hour_result.get("hour_basis"))
        hour_day = hour_store.trend_sessions(
            hour_base.timestamp(),
            (hour_base + timedelta(hours=4)).timestamp(),
            granularity="day",
        )
        check(hour_day.get("totals") == hour_result.get("totals"),
              "小时/日聚合 totals 对账一致")
        partial_hour = hour_store.trend_sessions(
            (hour_base + timedelta(minutes=30)).timestamp(),
            (hour_base + timedelta(hours=3, minutes=30)).timestamp(),
            granularity="hour",
        )
        check(partial_hour.get("range", {}).get("first_bucket_partial") is True and
              partial_hour.get("range", {}).get("last_bucket_partial") is True,
              "首尾不完整小时显式标记", partial_hour.get("range"))
        too_long_hour = hour_store.trend_sessions(
            hour_base.timestamp(),
            (hour_base + timedelta(days=8)).timestamp(),
            granularity="hour",
        )
        check(not too_long_hour.get("ok") and
              too_long_hour.get("error_code") == "range_too_large",
              "小时趋势超过 7 天 fail-closed", too_long_hour.get("error_code"))
        hour_store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
