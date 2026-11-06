#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证同平台同房间任意基准场候选、分页和显式对比。"""

from __future__ import annotations

import sys
import tempfile
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
    started_at: float,
    *,
    platform: str = "bilibili",
    room_id: int = 777,
    room_key: str = "room:777",
    title: str = "同房间场次",
    ended_at: float | None = None,
    reason: str = "manual_disconnect",
    real_received: int = 10,
) -> None:
    store.start_session(
        session_id,
        room_id,
        title,
        started_at=started_at,
        platform=platform,
        room_key=room_key,
    )
    store.record_message(session_id, "danmaku", started_at + 1, "user", {})
    store.bump_session(session_id, "real", "received", max(0, real_received - 1))
    store.bump_session(session_id, "real", "spoken", 5)
    store.bump_session(session_id, "real", "dropped", 2)
    store.finish_session(
        session_id,
        ended_at=ended_at if ended_at is not None else started_at + 3600,
        reason=reason,
    )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-compare-") as tmp:
        store = SessionStore(str(Path(tmp) / "data" / "history.sqlite3"))
        base = 1792944000.0
        seed(store, "target", base, title="当前场")
        seed(store, "later-near", base + 1800, title="更近后场")
        seed(store, "earlier-near", base - 3600, title="更近前场")
        seed(store, "earlier-mid", base - 7200, title="较早场")
        seed(store, "tie-mid", base - 7200, title="同开播时间场")
        seed(store, "later-far", base + 3 * 86400, title="很远后场")
        seed(
            store, "other-room", base - 1800,
            room_id=888, room_key="room:888", title="其他房间",
        )
        seed(
            store, "other-platform", base - 1800,
            platform="douyin", room_id=0, room_key="room:777", title="其他平台",
        )
        seed(
            store, "empty-key", base - 1800,
            room_id=0, room_key="", title="空房间键",
        )
        seed(
            store, "lonely", base - 1800,
            room_id=999, room_key="room:999", title="独立房间",
        )
        seed(
            store, "invalid-time", base + 900,
            ended_at=base + 100, title="时间异常",
        )
        seed(
            store, "invalid-past", base - 100,
            ended_at=base - 200, title="非法上一场",
        )
        store.flush(3.0)

        candidates = store.list_baseline_candidates("target", 2)
        check(candidates.get("ok"), "候选首页成功", candidates)
        check(candidates.get("total") == 5, "只统计同房间合法候选", candidates.get("total"))
        ids = [item["id"] for item in candidates.get("candidates") or []]
        check(ids == ["later-near", "earlier-near"], "nearest-first 首页顺序", ids)
        check(all("types" not in item and "minutes" not in item for item in candidates["candidates"]),
              "候选只返回轻量摘要")
        check(candidates.get("has_more") is True, "候选首页标记更多")
        cursor = candidates.get("next_cursor") or {}
        check(cursor.get("target_id") == "target", "cursor 绑定目标场", cursor)
        check(cursor.get("distance_seconds") == 3600,
              "cursor 携带距离", cursor.get("distance_seconds"))

        second = store.list_baseline_candidates(
            "target",
            2,
            before_distance=cursor.get("distance_seconds"),
            before_started_at=cursor.get("started_at"),
            before_id=cursor.get("id"),
            before_target_id=cursor.get("target_id"),
        )
        second_ids = [item["id"] for item in second.get("candidates") or []]
        check(second.get("ok") and "earlier-near" not in second_ids,
              "候选第二页不重复", second_ids)
        check(second_ids[:2] == ["tie-mid", "earlier-mid"],
              "同距离按开播时间与 id 稳定排序", second_ids)

        wrong_target = store.list_baseline_candidates(
            "target",
            2,
            before_distance=cursor.get("distance_seconds"),
            before_started_at=cursor.get("started_at"),
            before_id=cursor.get("id"),
            before_target_id="other-target",
        )
        check(wrong_target.get("error_code") == "invalid_cursor",
              "cursor 不能跨目标场复用", wrong_target.get("error_code"))
        missing_cursor_target = store.list_baseline_candidates(
            "target",
            2,
            before_distance=cursor.get("distance_seconds"),
            before_started_at=cursor.get("started_at"),
            before_id=cursor.get("id"),
        )
        check(missing_cursor_target.get("error_code") == "invalid_cursor",
              "完整 cursor 必须携带目标场绑定",
              missing_cursor_target.get("error_code"))
        partial_cursor = store.list_baseline_candidates("target", 2, before_id="x")
        check(partial_cursor.get("error_code") == "invalid_cursor",
              "候选游标必须完整", partial_cursor.get("error_code"))
        target_only_cursor = store.list_baseline_candidates(
            "target", 2, before_target_id="target",
        )
        check(target_only_cursor.get("error_code") == "invalid_cursor",
              "只有目标 id 不构成完整游标", target_only_cursor.get("error_code"))

        duplicate_tie = store.compare_sessions("target", "tie-mid")
        check(duplicate_tie.get("ok") and duplicate_tie.get("baseline", {}).get("id") == "tie-mid",
              "同开播时间可由用户显式选择", duplicate_tie.get("error_code"))
        check(bool((duplicate_tie.get("target") or {}).get("types")),
              "对比返回目标完整详情")
        check(bool((duplicate_tie.get("baseline") or {}).get("minutes")),
              "对比返回基准完整详情")

        later = store.compare_sessions("target", "later-near")
        check(later.get("ok"), "允许基准晚于当前场", later.get("error_code"))
        check(later.get("scope") == {"platform": "bilibili", "room_key": "room:777"},
              "对比返回确定的 scope", later.get("scope"))
        previous = store.get_previous_session("target")
        check(previous.get("ok") and
              (previous.get("previous") or {}).get("id") == "earlier-near",
              "上一场路径跳过非法时间场次", previous.get("previous"))

        same = store.compare_sessions("target", "target")
        check(same.get("error_code") == "same_session", "当前场不能作为自己的基准")
        missing = store.compare_sessions("target", "missing")
        check(missing.get("error_code") == "baseline_not_found",
              "缺失基准场 fail-closed", missing.get("error_code"))
        cross_room = store.compare_sessions("target", "other-room")
        check(cross_room.get("error_code") == "scope_mismatch",
              "跨房间对比被拒绝", cross_room.get("error_code"))
        cross_platform = store.compare_sessions("target", "other-platform")
        check(cross_platform.get("error_code") == "scope_mismatch",
              "跨平台对比被拒绝", cross_platform.get("error_code"))
        invalid_baseline = store.compare_sessions("target", "invalid-time")
        check(invalid_baseline.get("error_code") == "baseline_invalid_time",
              "非法基准时间 fail-closed", invalid_baseline.get("error_code"))

        empty_target = store.list_baseline_candidates("empty-key")
        check(empty_target.get("error_code") == "target_incomplete",
              "空 room_key 不能作为候选目标", empty_target.get("error_code"))
        missing_target = store.list_baseline_candidates("missing-target")
        check(missing_target.get("error_code") == "target_not_found",
              "缺失目标场 fail-closed", missing_target.get("error_code"))
        lonely = store.list_baseline_candidates("lonely")
        check(lonely.get("ok") and lonely.get("total") == 0 and
              lonely.get("candidates") == [],
              "房间没有其他场次返回成功空候选", lonely)

        store.start_session(
            "active-target", 777, "进行中",
            started_at=base + 4 * 86400,
            platform="bilibili",
            room_key="room:777",
        )
        store.flush(3.0)
        active_target = store.list_baseline_candidates("active-target")
        check(active_target.get("error_code") == "target_active",
              "进行中场次不能作为候选目标", active_target.get("error_code"))
        active_baseline = store.compare_sessions("target", "active-target")
        check(active_baseline.get("error_code") == "baseline_active",
              "进行中场次不能作为基准", active_baseline.get("error_code"))
        store.finish_session("active-target", ended_at=base + 4 * 86400 + 60)
        store.flush(3.0)

        store.start_session(
            "target-invalid", 777, "目标时间异常",
            started_at=base + 5 * 86400,
            platform="bilibili",
            room_key="room:777",
        )
        store.finish_session("target-invalid", ended_at=base + 5 * 86400 - 10)
        store.flush(3.0)
        invalid_target = store.list_baseline_candidates("target-invalid")
        check(invalid_target.get("error_code") == "target_invalid_time",
              "目标时间异常 fail-closed", invalid_target.get("error_code"))
        invalid_previous_target = store.get_previous_session("target-invalid")
        check(invalid_previous_target.get("status") == "target_incomplete",
              "上一场路径拒绝目标时间异常", invalid_previous_target.get("status"))
        check(not store.start_session(
            "nonfinite", 777, "非有限时间", started_at=float("inf"),
            platform="bilibili", room_key="room:777",
        ), "写入端拒绝非有限开始时间")
        check(not store.finish_session("nonfinite", ended_at=float("inf")),
              "写入端拒绝非有限结束时间")
        check(not store.record_message(
            "target", "danmaku", float("inf"), "u", {},
        ), "写入端拒绝非有限消息时间")
        store.start_session(
            "normalized-scope", 0, "规范化场次",
            started_at=base + 6 * 86400,
            platform=" BILIBILI ",
            room_key=" room:space ",
        )
        store.finish_session(
            "normalized-scope",
            ended_at=base + 6 * 86400 + 60,
            reason="manual_disconnect",
        )
        store.flush(3.0)
        normalized = store.get_session("normalized-scope").get("session") or {}
        check(normalized.get("platform") == "bilibili" and
              normalized.get("room_key") == "room:space",
              "platform/room_key 写入端规范化",
              {"platform": normalized.get("platform"),
               "room_key": normalized.get("room_key")})

        store.delete_session("later-near")
        store.flush(3.0)
        deleted_baseline = store.compare_sessions("target", "later-near")
        check(deleted_baseline.get("error_code") == "baseline_not_found",
              "候选删除后按 id 对比失败", deleted_baseline.get("error_code"))
        store.delete_session("target")
        store.flush(3.0)
        deleted_target = store.compare_sessions("target", "earlier-near")
        check(deleted_target.get("error_code") == "target_not_found",
              "目标删除后显式对比失败", deleted_target.get("error_code"))

        store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
