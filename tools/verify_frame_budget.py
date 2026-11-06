#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证浮窗自适应帧率的降档、滞回恢复与重置。"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import List

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from backend.frame_budget import (  # noqa: E402
    BASE_INTERVAL_MS,
    LOW_INTERVAL_MS,
    MID_INTERVAL_MS,
    FrameBudget,
)

PASS = 0
FAIL = 0
FAILURES: List[str] = []


def check(condition: bool, label: str, detail: object = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))
    else:
        FAIL += 1
        FAILURES.append(label)
        print("FAIL  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))


def run() -> None:
    print("verify_frame_budget · Python", sys.version.split()[0])
    budget = FrameBudget()
    check(budget.interval_ms == BASE_INTERVAL_MS == 16, "初始为 16ms")
    check(budget.observe(20, 10, 0.0) == 16, "正常帧保持 16ms")
    check(budget.observe(40, 10, 0.016) == 16, "单次慢帧不立即降档")
    check(budget.observe(40, 10, 0.032) == 16, "两次慢帧仍保持 16ms")
    check(budget.observe(40, 10, 0.048) == MID_INTERVAL_MS == 33,
          "连续三帧慢降为 33ms")

    check(budget.observe(33, 10, 3.0) == 33, "33ms 档正常帧开始恢复计时")
    check(budget.observe(33, 10, 4.9) == 33, "不足 2 秒不恢复")
    check(budget.observe(33, 10, 5.1) == BASE_INTERVAL_MS == 16,
          "33ms 档连续正常 2 秒回到 16ms")

    budget.reset()
    for index in range(7):
        budget.observe(80, 10, float(index) * 0.08)
    check(budget.interval_ms == 33, "慢帧 7 次仍为 33ms")
    check(budget.observe(80, 10, 0.56) == LOW_INTERVAL_MS == 50,
          "连续八帧慢降为 50ms")

    check(budget.observe(50, 10, 10.0) == 50, "50ms 档正常帧开始恢复计时")
    check(budget.observe(50, 10, 12.1) == 33, "50ms 档正常 2 秒恢复一档到 33ms")
    check(budget.observe(33, 10, 12.5) == 33, "33ms 档重新开始恢复计时")
    check(budget.observe(33, 10, 14.6) == 16, "再正常 2 秒回到 16ms")

    budget.reset()
    for index in range(3):
        budget.observe(10, 30, float(index) * 0.05)
    check(budget.interval_ms == 33, "绘制耗时 >=28ms 也可触发降档")

    budget.reset()
    check(budget.observe(-1, -1, 0.0) == 16, "非法负值按正常帧处理")
    check(budget.observe(float("nan"), None, 0.1) == 16, "NaN 按正常帧处理")
    budget.observe(40, None, 0.2)
    budget.observe(40, None, 0.3)
    budget.observe(40, None, 0.4)
    check(budget.interval_ms == 33, "缺失绘制耗时仍按帧间隔降档")
    budget.reset()
    check(budget.interval_ms == 16 and not budget.reduced, "reset 回到 16ms")

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))


def main() -> int:
    run()
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
