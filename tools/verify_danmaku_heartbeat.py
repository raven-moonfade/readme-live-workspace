#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证 B 站首心跳失败时 open() 不会误报连接成功。"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.danmaku import DanmakuConnection  # noqa: E402

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


async def run() -> None:
    states = []
    errors = []
    connection = DanmakuConnection(
        lambda *_args: None,
        lambda *args: states.append(args),
        lambda *args: errors.append(args),
    )

    async def fake_fetch_info(attempts: int = 3):
        return {
            "ok": True,
            "fatal": False,
            "room_id": 123,
            "title": "心跳超时测试",
            "live_status": 1,
        }

    async def fake_wait_connected(_timeout: float):
        return False

    connection._fetch_info = fake_fetch_info
    connection._start_client = lambda: None
    connection._wait_connected = fake_wait_connected

    try:
        result = await connection.open(123)
        check(result.get("ok") is False, "首心跳超时返回失败", result)
        check(result.get("connected") is False, "失败结果明确 connected=false", result)
        check("心跳超时" in str(result.get("error") or ""), "失败原因可读", result)
        check(connection._refresh_task is None, "首心跳失败不启动刷新任务")
        check(any(item[0] == "connecting" for item in states), "连接前发出连接中状态", states)
        check(not any(item[0] == "connected" for item in states), "超时不会伪造已连接状态", states)
    finally:
        await connection.close()


def main() -> int:
    asyncio.run(run())
    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
