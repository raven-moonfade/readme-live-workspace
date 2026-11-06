#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证滚动区高密度保护状态机。"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import List

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from backend.density import DensityMeter  # noqa: E402

PASS = 0
FAIL = 0
FAILURES: List[str] = []


def check(condition: bool, label: str, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + detail) if detail else ""))
    else:
        FAIL += 1
        FAILURES.append(label)
        print("FAIL  %s%s" % (label, ("  " + detail) if detail else ""))


def feed(meter: DensityMeter, start: float, rate: float, duration: float) -> bool:
    """按 250ms 批次喂入消息，返回最后一次 update 的切换标记。"""
    changed = False
    step = 0.25
    count = int(round(rate * step))
    now = start
    while now <= start + duration + 0.001:
        for _ in range(count):
            meter.add(now)
        changed = meter.update(now, batch_count=count) or changed
        now += step
    return changed


def run() -> None:
    print("verify_density · Python", sys.version.split()[0])

    burst = DensityMeter()
    changed = burst.update(0.0, batch_count=8)
    check(changed and burst.dense, "单批达到 max_lines 立即进入保护", str(burst.rate))

    meter = DensityMeter()
    feed(meter, 0.0, 30.0, 1.5)
    check(meter.dense, "30 条/秒持续 1 秒进入保护", "rate=%.1f" % meter.rate)

    low = DensityMeter()
    feed(low, 0.0, 20.0, 2.0)
    check(not low.dense, "20 条/秒不触发保护", "rate=%.1f" % low.rate)

    recover = DensityMeter()
    recover.update(0.0, batch_count=8)
    check(recover.dense, "应急触发后处于保护")
    # 4 秒最短保持期内，即使无消息也保持。
    check(not recover.update(3.9, batch_count=0) and recover.dense, "保护至少保持 4 秒")
    # 超过保持期后，低速率需要连续 3 秒。
    recover.update(4.1, batch_count=0)
    check(not recover.update(6.9, batch_count=0) and recover.dense, "低速未满 3 秒不恢复")
    changed = recover.update(7.1, batch_count=0)
    check(changed and not recover.dense, "低于 8 条/秒稳定 3 秒恢复")

    reset = DensityMeter()
    reset.update(0.0, batch_count=8)
    reset.reset()
    check(not reset.dense and reset.rate == 0, "reset 清空模式与窗口")

    gap = DensityMeter()
    gap.add(0.0)
    gap.update(0.0, batch_count=8)
    check(gap.dense, "长间隔测试先进入保护")
    check(gap.update(6.0, batch_count=0) and not gap.dense, "超过 5 秒空场自动恢复")
    gap.add(0.0)
    gap.update(0.0, batch_count=8)
    gap.add(6.0)
    check(not gap.dense and gap.rate == 0, "新消息到达前也能识别长空场")

    sparse = DensityMeter()
    for i in range(5):
        sparse.add(float(i))
        sparse.update(float(i), batch_count=1)
    check(not sparse.dense, "稀疏消息不触发")

    edge = DensityMeter()
    edge.add(0.0)
    edge.update(0.0, batch_count=1)
    edge.add(1.01)
    edge.update(1.01, batch_count=1)
    check(not edge.dense, "时间窗外的消息被移除")


def main() -> int:
    run()
    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())

