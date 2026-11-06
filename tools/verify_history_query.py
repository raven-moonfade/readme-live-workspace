#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证历史查询：搜索转义、日期边界、平台过滤和 cursor 分页。"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import time
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
    room_id: int,
    title: str,
    started_at: float,
    platform: str = "bilibili",
    room_key: str = "",
) -> None:
    store.start_session(session_id, room_id, title, started_at=started_at, platform=platform, room_key=room_key)
    store.record_message(session_id, "danmaku", started_at, 1, {})
    store.finish_session(session_id, ended_at=started_at + 600, reason="manual_disconnect")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-query-") as tmp:
        path = str(Path(tmp) / "data" / "history.sqlite3")
        store = SessionStore(path)
        check(store.available, "查询测试库可用", store.error)
        base = 1767225600.0  # 2026-01-01 12:00:00 UTC 附近
        seed(store, "alpha", 1001, "Alpha 电台", base)
        seed(store, "beta", 2002, "Beta 电台", base + 86400)
        seed(store, "percent", 3003, "100% 电台", base + 2 * 86400)
        seed(store, "underscore", 4004, "under_score", base + 3 * 86400)
        seed(store, "alpha-2", 5005, "Alpha 电台 复播", base + 4 * 86400)
        seed(store, "douyin", 9009, "另一个平台", base + 5 * 86400, platform="douyin")
        check(store.flush(3.0), "查询种子写入完成")

        all_rows = store.list_sessions(100)
        check(all_rows.get("ok") and all_rows.get("total") == 6, "全量过滤不丢场次", all_rows.get("total"))
        check(all_rows.get("all_total") == 6, "all_total 与全量一致")
        check(all_rows.get("has_more") is False, "全量一页完成")

        alpha = store.list_sessions(100, query="Alpha")
        check(alpha.get("total") == 2, "标题包含搜索", alpha.get("total"))
        check([row["id"] for row in alpha.get("sessions", [])] == ["alpha-2", "alpha"], "搜索结果按开播时间倒序")

        room = store.list_sessions(100, query="2002")
        check(room.get("total") == 1 and room["sessions"][0]["id"] == "beta", "房间号搜索")

        percent = store.list_sessions(100, query="100%")
        check(percent.get("total") == 1 and percent["sessions"][0]["id"] == "percent", "LIKE 百分号按字面匹配")
        underscore = store.list_sessions(100, query="under_score")
        check(underscore.get("total") == 1 and underscore["sessions"][0]["id"] == "underscore", "LIKE 下划线按字面匹配")
        empty = store.list_sessions(100, query="不存在的标题")
        check(empty.get("total") == 0 and empty.get("all_total") == 6, "无匹配时保留全量计数", empty.get("all_total"))

        from_ts = base + 2 * 86400
        to_ts = base + 4 * 86400
        dated = store.list_sessions(100, started_from=from_ts, started_to=to_ts)
        check(dated.get("total") == 2, "日期范围按 started_at 半开区间", dated.get("total"))
        check(
            [row["id"] for row in dated.get("sessions", [])] == ["underscore", "percent"],
            "日期边界包含起点、排除终点",
        )
        invalid_range = store.list_sessions(100, started_from=to_ts, started_to=from_ts)
        check(not invalid_range.get("ok"), "倒置日期范围被拒绝", invalid_range)

        douyin = store.list_sessions(100, platform="douyin")
        check(douyin.get("total") == 1 and douyin["sessions"][0]["id"] == "douyin", "平台过滤")

        first = store.list_sessions(2)
        check(first.get("total") == 6 and first.get("has_more") is True, "cursor 首页标记更多")
        cursor = first.get("next_cursor") or {}
        check(cursor.get("id") == "alpha-2", "首页 cursor 指向最后一行", cursor)
        second = store.list_sessions(2, before_started_at=cursor.get("started_at"), before_id=cursor.get("id"))
        second_ids = [row["id"] for row in second.get("sessions", [])]
        check(second_ids == ["underscore", "percent"], "cursor 第二页正确", second_ids)

        # 首页后插入新场次，继续使用旧 cursor 不应重复或回退。
        seed(store, "newest", 7777, "新结束场次", base + 6 * 86400)
        store.flush(3.0)
        after_insert = store.list_sessions(2, before_started_at=cursor.get("started_at"), before_id=cursor.get("id"))
        after_ids = [row["id"] for row in after_insert.get("sessions", [])]
        check(after_ids == ["underscore", "percent"], "旧 cursor 不受新插入影响", after_ids)
        check(after_insert.get("total") == 7, "过滤总数随新场次更新", after_insert.get("total"))
        store.start_session("string-uid", 6001, "字符串 UID 场次", started_at=base - 86400)
        store.record_message("string-uid", "danmaku", base - 86400, "viewer-α", {})
        store.finish_session("string-uid", ended_at=base - 80000, reason="manual_disconnect")
        store.flush(3.0)
        string_uid = store.get_session("string-uid").get("session") or {}
        check(string_uid.get("unique_users") == 1, "字符串 UID 能去重计数", string_uid.get("unique_users"))
        store.start_session("short-room", 123, "短号场次", started_at=base - 70000)
        store.flush(3.0)
        store.update_session_meta("short-room", 456789, "真实房间号")
        store.finish_session("short-room", ended_at=base - 60000, reason="manual_disconnect")
        store.flush(3.0)
        short_room = store.get_session("short-room").get("session") or {}
        check(short_room.get("room_key") == "456789", "短号更新真实房间号后同步 room_key", short_room.get("room_key"))
        store.close()

        previous_store = SessionStore(str(Path(tmp) / "previous" / "data" / "history.sqlite3"))
        seed(previous_store, "older", 777, "最早一场", base - 86400)
        seed(previous_store, "other-platform", 777, "同房间其他平台", base - 7200, platform="douyin")
        seed(previous_store, "middle", 777, "上一场", base - 3600)
        seed(previous_store, "current", 777, "当前场", base)
        seed(previous_store, "other-room", 888, "其他房间", base + 3600)
        previous_store.flush(3.0)
        previous = previous_store.get_previous_session("current")
        check(previous.get("ok") and previous.get("status") == "found" and previous.get("has_previous"), "同房间上一场可定位", previous)
        check((previous.get("previous") or {}).get("id") == "middle", "上一场优先最近一场", previous.get("previous"))
        check((previous.get("target") or {}).get("id") == "current", "对比返回目标场快照")
        check(bool((previous.get("previous") or {}).get("types")), "上一场返回完整详情")
        no_previous = previous_store.get_previous_session("older")
        check(no_previous.get("ok") and no_previous.get("status") == "no_previous" and not no_previous.get("has_previous"), "首场没有上一场", no_previous)
        previous_store.start_session("active", 777, "进行中", started_at=base + 100)
        previous_store.flush(3.0)
        active_previous = previous_store.get_previous_session("active")
        check(not active_previous.get("ok") and active_previous.get("status") == "target_active", "进行中场次不允许对比", active_previous)
        previous_store.finish_session("active", ended_at=base + 200, reason="manual_disconnect")
        seed(previous_store, "zero-room", 0, "无房间号", base + 300)
        previous_store.flush(3.0)
        zero_room = previous_store.get_previous_session("zero-room")
        check(not zero_room.get("ok") and zero_room.get("status") == "target_incomplete", "无有效房间号 fail-closed", zero_room)
        seed(previous_store, "empty-platform", 777, "空平台", base + 400, platform="")
        previous_store.flush(3.0)
        empty_platform = previous_store.get_previous_session("empty-platform")
        check(not empty_platform.get("ok") and empty_platform.get("status") == "target_incomplete", "空平台 fail-closed", empty_platform)
        missing_previous = previous_store.get_previous_session("missing")
        check(not missing_previous.get("ok") and missing_previous.get("status") == "target_not_found", "不存在场次对比返回失败", missing_previous)
        previous_store.close()

        tie_store = SessionStore(str(Path(tmp) / "tie" / "data" / "history.sqlite3"))
        seed(tie_store, "tie-a", 999, "并列 A", base - 500)
        seed(tie_store, "tie-b", 999, "并列 B", base - 500)
        seed(tie_store, "tie-current", 999, "并列当前", base)
        tie_store.flush(3.0)
        ambiguous = tie_store.get_previous_session("tie-current")
        check(not ambiguous.get("ok") and ambiguous.get("status") == "ambiguous_tie", "同开播时间上一场不静默选 UUID", ambiguous)
        tie_store.close()

        legacy_path = str(Path(tmp) / "legacy-v2" / "history.sqlite3")
        Path(legacy_path).parent.mkdir(parents=True)
        conn = sqlite3.connect(legacy_path)
        try:
            conn.executescript(
                """
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY, platform TEXT NOT NULL DEFAULT 'bilibili',
                    room_id INTEGER NOT NULL DEFAULT 0, room_title TEXT NOT NULL DEFAULT '',
                    started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
                    last_event_at REAL, updated_at REAL NOT NULL,
                    real_received INTEGER NOT NULL DEFAULT 0,
                    real_spoken INTEGER NOT NULL DEFAULT 0,
                    real_dropped INTEGER NOT NULL DEFAULT 0,
                    mock_received INTEGER NOT NULL DEFAULT 0,
                    mock_spoken INTEGER NOT NULL DEFAULT 0,
                    mock_dropped INTEGER NOT NULL DEFAULT 0,
                    unique_users INTEGER NOT NULL DEFAULT 0,
                    gift_cny REAL NOT NULL DEFAULT 0, gift_silver INTEGER NOT NULL DEFAULT 0,
                    gift_unknown INTEGER NOT NULL DEFAULT 0, super_chat_cny REAL NOT NULL DEFAULT 0
                );
                CREATE TABLE session_types (
                    session_id TEXT NOT NULL, type TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(session_id, type)
                );
                CREATE TABLE session_minutes (
                    session_id TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(session_id, minute)
                );
                INSERT INTO sessions
                    (id, platform, room_id, room_title, started_at, ended_at, updated_at, real_received)
                VALUES ('legacy', 'bilibili', 424242, '旧库场次', 100, 200, 200, 1);
                INSERT INTO sessions
                    (id, platform, room_id, room_title, started_at, ended_at, updated_at, real_received)
                VALUES ('legacy-douyin', 'douyin', 123, '旧库抖音场次', 100, 200, 200, 1);
                INSERT INTO session_types(session_id, type, count) VALUES ('legacy', 'danmaku', 1);
                PRAGMA user_version=2;
                """
            )
            conn.commit()
        finally:
            conn.close()
        legacy_store = SessionStore(legacy_path)
        legacy_detail = legacy_store.get_session("legacy").get("session") or {}
        legacy_douyin = legacy_store.get_session("legacy-douyin").get("session") or {}
        check(legacy_store.available and legacy_detail.get("room_key") == "424242", "v2 历史库回填 room_key", legacy_detail.get("room_key"))
        check(legacy_douyin.get("room_key") == "", "迁移不回填非 B 平台房间键", legacy_douyin.get("room_key"))
        legacy_previous = legacy_store.get_previous_session("legacy-douyin")
        check(not legacy_previous.get("ok") and legacy_previous.get("status") == "target_incomplete", "旧非 B 平台无 room_key 不猜测", legacy_previous)
        check(
            bool(legacy_store._migration_backup_path) and Path(legacy_store._migration_backup_path).is_file(),
            "v2 迁移前生成备份",
            legacy_store._migration_backup_path,
        )
        legacy_check = sqlite3.connect(legacy_path)
        try:
            legacy_version = int(legacy_check.execute("PRAGMA user_version").fetchone()[0])
        finally:
            legacy_check.close()
        check(legacy_version == 5, "v2 历史库升级到 v5", legacy_version)
        legacy_store.close()

        key_store = SessionStore(str(Path(tmp) / "room-key" / "data" / "history.sqlite3"))
        seed(key_store, "dy-old", 0, "抖音旧场", base - 3000, platform="douyin", room_key="dy:abc")
        seed(key_store, "dy-current", 0, "抖音当前", base, platform="douyin", room_key="dy:abc")
        seed(key_store, "dy-other", 0, "抖音其他房", base - 2000, platform="douyin", room_key="dy:other")
        key_store.flush(3.0)
        key_previous = key_store.get_previous_session("dy-current")
        check(key_previous.get("ok") and (key_previous.get("previous") or {}).get("id") == "dy-old", "字符串 room_key 可用于上一场", key_previous.get("previous"))
        check(not key_store.start_session("too-long", 0, "长 key", room_key="x" * 257), "超长 room_key 被拒绝")
        key_store.close()

        future_path = str(Path(tmp) / "future" / "history.sqlite3")
        Path(future_path).parent.mkdir(parents=True)
        conn = sqlite3.connect(future_path)
        try:
            conn.execute("PRAGMA user_version=6")
            conn.commit()
        finally:
            conn.close()
        future_store = SessionStore(future_path)
        check(not future_store.available, "未来 schema 版本 fail-closed")
        check("版本" in (future_store.error or ""), "未来 schema 错误可读", future_store.error)
        future_store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
