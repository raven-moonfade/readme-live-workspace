#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证多基准场对比：数量、顺序、scope、重叠、错误和单基准隔离。"""

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
    ended_at: float | None = None,
    reason: str = "manual_disconnect",
    platform: str = "bilibili",
    room_key: str = "room:777",
    room_id: int = 777,
) -> None:
    store.start_session(
        session_id,
        room_id,
        session_id,
        started_at=started_at,
        platform=platform,
        room_key=room_key,
    )
    store.record_message(session_id, "danmaku", started_at + 1, "viewer", {})
    store.bump_session(session_id, "real", "received", 19)
    store.bump_session(session_id, "real", "spoken", 12)
    store.bump_session(session_id, "real", "dropped", 7)
    store.finish_session(
        session_id,
        ended_at=ended_at if ended_at is not None else started_at + 3600,
        reason=reason,
    )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-multi-compare-") as tmp:
        store = SessionStore(str(Path(tmp) / "data" / "history.sqlite3"))
        base = 1792944000.0
        seed(store, "target", base)
        seed(store, "earlier-near", base - 3600)
        seed(store, "later-near", base + 1800)
        seed(store, "earlier-mid", base - 7200)
        seed(store, "overlap-a", base + 7200)
        seed(store, "overlap-b", base + 8000)
        seed(store, "other-room", base - 1800, room_key="room:888", room_id=888)
        seed(
            store,
            "other-platform",
            base - 1800,
            platform="douyin",
            room_key="room:777",
        )
        seed(
            store,
            "invalid-time",
            base + 900,
            ended_at=base + 100,
        )
        store.start_session(
            "active",
            777,
            "active",
            started_at=base + 300,
            platform="bilibili",
            room_key="room:777",
        )
        store.flush(3.0)

        result = store.compare_multi_sessions(
            "target", ["earlier-near", "later-near", "earlier-mid"]
        )
        check(result.get("ok"), "多基准主路径成功", result.get("error_code"))
        check(result.get("baseline_count") == 3 and
              result.get("max_baselines") == 3 and
              result.get("ordering") == "requested",
              "多基准数量/上限/顺序契约", result)
        ids = [item.get("id") for item in result.get("baselines") or []]
        check(ids == ["earlier-near", "later-near", "earlier-mid"],
              "按请求顺序返回 B1/B2/B3", ids)
        check([item.get("index") for item in result.get("baselines") or []] == [1, 2, 3],
              "基准索引稳定")
        check((result.get("baselines") or [{}])[1].get("relation") == "later",
              "更晚基准关系正确")
        check((result.get("baselines") or [{}])[1].get("overlaps_target") is True,
              "与当前场重叠只标记不拒绝")
        check((result.get("baselines") or [{}])[0].get("overlaps_target") is False,
              "边界相接不误报重叠")

        overlap = store.compare_multi_sessions(
            "target", ["later-near", "overlap-a", "overlap-b"]
        )
        check(overlap.get("ok") and overlap.get("overlap_pairs"),
              "基准之间重叠写入 overlap_pairs", overlap.get("overlap_pairs"))
        check(any(pair.get("left") == "B2" and pair.get("right") == "B3"
                  for pair in overlap.get("overlap_pairs") or []),
              "基准间重叠对上账", overlap.get("overlap_pairs"))

        too_many = store.compare_multi_sessions(
            "target",
            ["earlier-near", "later-near", "earlier-mid", "overlap-a"],
        )
        check(too_many.get("error_code") == "too_many_baselines",
              "超过 3 个基准 fail-closed", too_many)
        empty = store.compare_multi_sessions("target", [])
        check(empty.get("error_code") == "invalid_argument",
              "空基准数组 fail-closed", empty)
        not_list = store.compare_multi_sessions("target", "later-near")
        check(not_list.get("error_code") == "invalid_argument",
              "非数组参数 fail-closed", not_list)
        duplicate = store.compare_multi_sessions(
            "target", ["earlier-near", "earlier-near"]
        )
        check(duplicate.get("error_code") == "duplicate_baseline" and
              duplicate.get("first_index") == 1 and
              duplicate.get("baseline_index") == 2,
              "重复基准带索引", duplicate)
        self_target = store.compare_multi_sessions("target", ["target", "earlier-near"])
        check(self_target.get("error_code") == "same_session" and
              self_target.get("baseline_index") == 1,
              "当前场不可作为基准", self_target)
        missing = store.compare_multi_sessions("target", ["earlier-near", "missing"])
        check(missing.get("error_code") == "baseline_not_found" and
              missing.get("baseline_index") == 2 and
              missing.get("baseline_id") == "missing",
              "缺失基准带索引 fail-closed", missing)
        active = store.compare_multi_sessions("target", ["active"])
        check(active.get("error_code") == "baseline_active",
              "活动基准 fail-closed", active)
        cross_room = store.compare_multi_sessions("target", ["other-room"])
        check(cross_room.get("error_code") == "scope_mismatch",
              "跨房间基准 fail-closed", cross_room)
        cross_platform = store.compare_multi_sessions("target", ["other-platform"])
        check(cross_platform.get("error_code") == "scope_mismatch",
              "跨平台基准 fail-closed", cross_platform)
        target_missing = store.compare_multi_sessions("missing", ["earlier-near"])
        check(target_missing.get("error_code") == "target_not_found",
              "目标场缺失 fail-closed", target_missing)

        single = store.compare_sessions("target", "later-near")
        check(single.get("ok") and single.get("baseline", {}).get("id") == "later-near" and
              "baselines" not in single,
              "单基准契约不被多基准改写")

        flushed = store.flush
        store.flush = lambda timeout=None: False  # type: ignore[assignment]
        stale = store.compare_multi_sessions("target", ["earlier-near", "later-near"])
        store.flush = flushed  # type: ignore[assignment]
        check(stale.get("ok") and stale.get("stale") is True and
              stale.get("data_health", {}).get("flushed") is False,
              "多基准 stale 仍返回数据并标记健康", stale)

        store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
