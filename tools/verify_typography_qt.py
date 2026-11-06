#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Qt 浮窗分类字体/行高/字距与缓存失效验证。"""

from __future__ import annotations

import copy
import os
import sys
from pathlib import Path
from typing import Any, Dict

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("DM_REDUCED_MOTION", "0")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
TOOLS = PROJECT_ROOT / "tools"
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from PySide6.QtWidgets import QApplication  # noqa: E402

from verify_motion_qt import item, make_window  # noqa: E402

PASS = 0
FAIL = 0
FAILURES = []


def check(condition: bool, label: str, detail: Any = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))
    else:
        FAIL += 1
        FAILURES.append(label)
        print("FAIL  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))


def typography() -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "global": {"font_family": "Arial", "line_height": 1.55, "letter_spacing": 0.0},
        "types": {
            "danmaku": {},
            "gift": {
                "font_family": "Consolas",
                "line_height": 2.2,
                "letter_spacing": 2.0,
            },
            "super_chat": {"font_family": None, "line_height": 1.8},
            "guard": {"letter_spacing": 1.0},
            "enter": {"line_height": 1.2},
        },
    }


def apply_typography(window: Any, value: Dict[str, Any]) -> None:
    raw = copy.deepcopy(window._raw)
    raw["typography"] = copy.deepcopy(value)
    raw.pop("resolved_typography", None)
    window._apply_config(raw)


def run() -> None:
    print("verify_typography_qt · Python", sys.version.split()[0])
    app = QApplication.instance() or QApplication([])
    window = make_window(app)
    apply_typography(window, typography())
    check(window._typography_for("gift")["font_family"] == "Consolas", "gift 字体解析")
    check(window._typography_for("gift")["line_height"] == 2.2, "gift 行高解析")
    check(
        window._font_resolvers.get("gift") is not window._font_resolvers.get("danmaku"),
        "gift 使用独立 resolver",
        (window._font_resolver_for("gift").family, window._font_resolver_for("danmaku").family),
    )
    check(window._typography_for("danmaku")["font_family"] == "Arial", "danmaku 继承 global")

    gift = window._normalize_item(item(1, "gift"))
    danmaku = window._normalize_item(item(2, "danmaku"))
    check(gift is not None and danmaku is not None, "样例消息创建")
    if gift is None or danmaku is None:
        window.shutdown()
        return
    gift_visual = window._build_visual(gift)
    danmaku_visual = window._build_visual(danmaku)
    check(gift_visual.font_size == 22, "视觉字号")
    check(gift_visual.line_height > danmaku_visual.line_height, "gift 行高生效",
          (gift_visual.line_height, danmaku_visual.line_height))
    check(gift_visual.height > danmaku_visual.height, "gift 气泡高度增加",
          (gift_visual.height, danmaku_visual.height))

    # 字距 2px 应改变文本行宽。
    text = window._normalize_item(item(3, "gift"))
    if text is not None:
        window._messages = [text]
        text.visual = None
        text.visual_key = None
        spaced = window._build_visual(text)
        no_space_typography = copy.deepcopy(typography())
        no_space_typography["types"]["gift"]["letter_spacing"] = 0.0
        apply_typography(window, no_space_typography)
        unspaced = window._build_visual(text)
        check(spaced.lines[0].width > unspaced.lines[0].width, "字距改变行宽",
              (spaced.lines[0].width, unspaced.lines[0].width))

    # typography 变化只失效对应 kind。
    window._clear_messages()
    apply_typography(window, typography())
    dm = window._normalize_item(item(4, "danmaku"))
    gf = window._normalize_item(item(5, "gift"))
    if dm is not None and gf is not None:
        window._messages = [dm, gf]
        dm.visual = window._build_visual(dm)
        dm.visual_key = window._visual_key(dm)
        gf.visual = window._build_visual(gf)
        gf.visual_key = window._visual_key(gf)
        dm_visual = dm.visual
        gf_visual = gf.visual
        changed = copy.deepcopy(typography())
        changed["types"]["gift"]["font_family"] = "Arial"
        apply_typography(window, changed)
        check(dm.visual is dm_visual, "排版变化保留未变类型 visual")
        check(gf.visual is not gf_visual, "排版变化重建目标类型 visual")

    # 固定区使用 per-kind 字体/行高；空 lane 不拖累其他 lane。
    window._clear_messages()
    apply_typography(window, typography())
    window._effective["pins"]["gift"]["enabled"] = True
    pin_msg = window._normalize_item(item(7, "gift"))
    if pin_msg is not None:
        pin_msg.meta["price"] = 100
        window._ingest([pin_msg])
        pin = window._pinned_messages[0] if window._pinned_messages else None
        check(pin is not None, "gift pin 创建")
        if pin is not None:
            window._relayout(snap_scroll=True)
            plan = window._plan or {}
            by_lane = plan.get("item_px_by_lane") or {}
            check(
                by_lane.get("gift", 0) >= 55 and by_lane.get("sc") == 1 and by_lane.get("guard") == 1,
                "gift pin 使用实际高度预算，空 lane 不拖累",
                by_lane,
            )
            check(len(window._messages) == 0, "pin 不进入滚动流")

    window._clear_messages()
    window.shutdown()
    app.processEvents()
    check(True, "清理无异常")


def main() -> int:
    run()
    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())

