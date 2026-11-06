#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证结束/启动入队后，详情、上一场和单场导出不会被写入时序误伤。"""

from __future__ import annotations

import os
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
    started: float,
    *,
    ended: float,
    title: str,
) -> None:
    store.start_session(
        session_id,
        777,
        title,
        started_at=started,
        platform="bilibili",
        room_key="777",
    )
    store.record_message(session_id, "danmaku", started + 5, "viewer", {})
    store.finish_session(session_id, ended_at=ended, reason="finished")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-read-barrier-") as tmp:
        store = SessionStore(str(Path(tmp) / "data" / "history.sqlite3"))
        try:
            seed(store, "previous", 1767225600, ended=1767229200, title="上一场")
            seed(store, "target", 1767232800, ended=1767236400, title="当前场")

            # 不显式 flush，模拟 finish/start 入队后立刻读取。
            detail = store.get_session("target")
            check(detail.get("ok") is True, "结束入队后详情立即可读", detail)
            check(
                detail.get("session", {}).get("ended_at") == 1767236400,
                "详情带已落盘的结束时间",
                detail.get("session", {}).get("ended_at"),
            )

            previous = store.get_previous_session("target")
            check(
                previous.get("ok") is True and
                previous.get("status") == "found" and
                previous.get("previous", {}).get("id") == "previous",
                "结束入队后上一场立即可查",
                previous,
            )

            export_dir = str(Path(tmp) / "exports")
            exported = store.export_session("target", fmt="json", output_dir=export_dir)
            check(exported.get("ok") is True, "结束入队后单场导出立即可用", exported)
            check(
                exported.get("path") and os.path.exists(exported["path"]),
                "单场导出文件已写入",
                exported.get("path"),
            )

            original_flush = store.flush
            store.flush = lambda timeout=None: False  # type: ignore[assignment]
            stale_detail = store.get_session("target")
            stale_previous = store.get_previous_session("target")
            store.flush = original_flush  # type: ignore[assignment]
            check(
                stale_detail.get("error_code") == "data_stale",
                "详情在写入未落盘时 fail-closed",
                stale_detail,
            )
            check(
                stale_previous.get("status") == "data_stale",
                "上一场在写入未落盘时 fail-closed",
                stale_previous,
            )
        finally:
            store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
