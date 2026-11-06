#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证对比/导出使用的 5 分钟峰值只计算完整窗口。"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.history_report import _session_metrics  # noqa: E402

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


def session(started: float, ended: float, minutes: list[tuple[int, int]]) -> dict:
    return {
        "started_at": started,
        "ended_at": ended,
        "real_received": sum(count for _minute, count in minutes),
        "real_spoken": 0,
        "real_dropped": 0,
        "unique_users": 0,
        "types": {},
        "minutes": [{"minute": minute, "count": count} for minute, count in minutes],
    }


def main() -> int:
    base = 1767225600.0
    short = session(base, base + 180, [(base // 60, 3), (base // 60 + 1, 4), (base // 60 + 2, 3)])
    check(_session_metrics(short)["peak_5m"] is None,
          "不足 5 分钟不返回峰值", _session_metrics(short)["peak_5m"])

    exact = session(
        base,
        base + 300,
        [(base // 60 + index, count) for index, count in enumerate((2, 3, 4, 1, 5))],
    )
    check(_session_metrics(exact)["peak_5m"] == 15,
          "正好 5 分钟计算完整窗口", _session_metrics(exact)["peak_5m"])

    six = session(
        base,
        base + 360,
        [(base // 60 + index, count) for index, count in enumerate((0, 1, 1, 1, 1, 9))],
    )
    check(_session_metrics(six)["peak_5m"] == 13,
          "6 分钟使用滚动完整窗口，包含末尾分钟", _session_metrics(six)["peak_5m"])

    empty = session(base, base + 360, [])
    check(_session_metrics(empty)["peak_5m"] is None,
          "没有分钟数据不返回峰值", _session_metrics(empty)["peak_5m"])

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
