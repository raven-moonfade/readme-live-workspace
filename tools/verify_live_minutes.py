#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证本场分钟桶由后端快照提供，刷新页面不依赖前端累计。"""

from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.core import DanmakuTTSService  # noqa: E402

PASS = 0
FAIL = 0


def check(condition: bool, label: str, detail=None) -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  " + label)
    else:
        FAIL += 1
        print("FAIL  " + label + (("  " + repr(detail)) if detail is not None else ""))


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-live-minutes-") as root:
        service = DanmakuTTSService(root)
        try:
            service._begin_session(123)
            session_id = service._current_session_id()
            now = time.time()
            service._handle_room_message(
                "danmaku",
                {"user": "分钟用户", "uid": "u-minute", "text": "第一条", "meta": {}},
                speak=False,
            )
            service._handle_room_message(
                "danmaku",
                {"user": "分钟用户", "uid": "u-minute", "text": "第二条", "meta": {}},
                speak=False,
            )
            snapshot = service.get_state()
            session = snapshot.get("session") or {}
            minutes = session.get("minutes") or []
            total = sum(int(item.get("count") or 0) for item in minutes)
            check(session.get("id") == session_id, "快照返回当前场次", session.get("id"))
            check(total == 2, "快照包含后端分钟桶", minutes)
            check(bool(minutes) and abs(int(minutes[-1].get("minute")) - int(now // 60)) <= 1,
                  "分钟桶使用消息到达分钟", minutes)
            check(session.get("last_event_at") is not None, "快照包含最后消息时间")

            service._begin_session(124)
            reset = service.get_state().get("session") or {}
            check(not (reset.get("minutes") or []), "新场次分钟桶归零", reset.get("minutes"))
        finally:
            service.shutdown()
    print("SUMMARY PASS=%d FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
