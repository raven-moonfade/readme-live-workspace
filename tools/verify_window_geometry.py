#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证窗口几何不会把隐藏监看窗放到主屏之外。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import _logical_work_area, _safe_window_geometry  # noqa: E402

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
    left, top, work_w, work_h = _logical_work_area()
    width = min(1707, work_w)
    height = min(889, work_h)
    x, y, w, h = _safe_window_geometry(left - work_w - 100, top, width, height)
    check(left <= x < left + work_w, "主屏外窗口回到主屏横坐标", (x, work_w))
    check(top <= y < top + work_h, "主屏外窗口回到主屏纵坐标", (y, work_h))
    check(w <= work_w and h <= work_h, "窗口尺寸不超过工作区", (w, h, work_w, work_h))

    inside = (left + 10, top + 10, min(800, work_w - 20), min(600, work_h - 20))
    check(
        _safe_window_geometry(*inside) == inside,
        "主屏内窗口保持原位置",
        _safe_window_geometry(*inside),
    )
    print("SUMMARY PASS=%d FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
