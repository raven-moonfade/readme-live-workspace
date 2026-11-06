#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证 StyleResolver 的五类继承、主题叠加与覆盖优先级。"""

from __future__ import annotations

import copy
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

logging.disable(logging.CRITICAL)

from backend.styles import (  # noqa: E402
    OVERLAY_TYPES,
    STYLE_FIELDS,
    TYPE_BADGE_COLORS,
    StyleResolver,
)

PASS = 0
FAIL = 0
FAILURES: List[str] = []


def check(condition: bool, label: str, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + str(detail)) if detail else ""))
    else:
        FAIL += 1
        FAILURES.append(label)
        print("FAIL  %s%s" % (label, ("  " + str(detail)) if detail else ""))


def styles_doc(
    theme: str = "classic",
    global_style: Dict[str, Any] | None = None,
    type_styles: Dict[str, Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    return {
        "overlay": {
            "styles": {
                "theme": theme,
                "global": copy.deepcopy(global_style or {}),
                "types": {
                    kind: copy.deepcopy((type_styles or {}).get(kind, {}))
                    for kind in OVERLAY_TYPES
                },
            }
        }
    }


def run() -> None:
    print("verify_styles · Python", sys.version.split()[0])
    classic = StyleResolver(styles_doc()).resolve_all()
    check(set(classic) == set(OVERLAY_TYPES), "resolve_all 返回五类")
    check(
        all(
            set(resolved) == set(STYLE_FIELDS) | {"color"}
            and resolved["color"] == resolved["text_color"]
            for resolved in classic.values()
        ),
        "每类包含 12 字段 + color 别名",
    )
    check(
        all(
            resolved["font_size"] == 22
            and resolved["font_weight"] == 600
            and resolved["text_color"] == "#FFFFFF"
            and resolved["name_color"] == "#8FE3FF"
            and resolved["bg_color"] == "#000000"
            and resolved["bg_opacity"] == 22
            and resolved["opacity"] == 100
            and resolved["outline"] is True
            and resolved["outline_color"] == "#000000"
            and resolved["outline_width"] == 2
            and resolved["shadow"] is True
            for resolved in classic.values()
        ),
        "classic 主题 22/600/.22/1 与 Qt 一致",
    )
    check(
        {kind: classic[kind]["badge_color"] for kind in OVERLAY_TYPES} == TYPE_BADGE_COLORS,
        "五类徽标色按类型区分",
    )

    shortvideo = StyleResolver(styles_doc("shortvideo")).resolve("gift")
    check(
        (shortvideo["font_size"], shortvideo["font_weight"], shortvideo["name_color"],
         shortvideo["bg_opacity"], shortvideo["outline_width"])
        == (30, 800, "#FFD86B", 36, 3),
        "shortvideo 主题叠加",
    )
    minimal = StyleResolver(styles_doc("minimal")).resolve("gift")
    check(
        (minimal["font_size"], minimal["font_weight"], minimal["name_color"],
         minimal["bg_opacity"], minimal["opacity"], minimal["outline"],
         minimal["outline_width"], minimal["shadow"])
        == (20, 400, "#A8C7FA", 10, 96, False, 0, False),
        "minimal 主题叠加",
    )
    highcontrast = StyleResolver(styles_doc("highcontrast")).resolve("gift")
    check(
        (highcontrast["font_size"], highcontrast["font_weight"], highcontrast["name_color"],
         highcontrast["bg_opacity"])
        == (24, 700, "#00E5FF", 85),
        "highcontrast 主题叠加",
    )
    check(
        StyleResolver(styles_doc()).resolve("gift")["badge_color"] == TYPE_BADGE_COLORS["gift"],
        "主题不覆盖类型徽标色",
    )

    global_resolver = StyleResolver(
        styles_doc(
            "classic",
            {
                "font_size": 26,
                "text_color": "#123456",
                "bg_opacity": 50,
                "outline": False,
                "shadow": False,
                "badge_color": "#ABCDEF",
            },
        )
    )
    all_global = global_resolver.resolve_all()
    check(
        all(
            resolved["font_size"] == 26
            and resolved["text_color"] == "#123456"
            and resolved["bg_opacity"] == 50
            and resolved["outline"] is False
            and resolved["shadow"] is False
            and resolved["badge_color"] == "#ABCDEF"
            for resolved in all_global.values()
        ),
        "global 覆盖五类",
    )

    type_resolver = StyleResolver(
        styles_doc(
            "classic",
            {"font_size": 23},
            {
                "gift": {"font_size": 28, "name_color": "#FF0000", "badge_color": "#FF00AA"},
                "super_chat": {"bg_color": "#221133", "bg_opacity": 70},
                "guard": {"outline": False},
                "enter": {"font_size": None, "shadow": False},
            },
        )
    )
    gift = type_resolver.resolve("gift")
    danmaku = type_resolver.resolve("danmaku")
    sc = type_resolver.resolve("super_chat")
    guard = type_resolver.resolve("guard")
    enter = type_resolver.resolve("enter")
    check(
        gift["font_size"] == 28 and gift["name_color"] == "#FF0000"
        and gift["badge_color"] == "#FF00AA",
        "gift 类型覆盖只改 gift",
    )
    check(danmaku["font_size"] == 23 and danmaku["name_color"] == "#8FE3FF", "danmaku 继承 global")
    check(sc["bg_color"] == "#221133" and sc["bg_opacity"] == 70, "super_chat 类型覆盖背景")
    check(guard["outline"] is False and guard["font_size"] == 23, "guard 布尔 false 是有效覆盖")
    check(enter["font_size"] == 23, "类型字段 null 回退 global")
    check(enter["shadow"] is False, "类型字段非 null 覆盖 global")

    precedence = StyleResolver(
        styles_doc(
            "minimal",
            {"font_size": 22, "text_color": "#101010"},
            {"super_chat": {"font_size": 24, "name_color": "#FF7700"}},
        )
    ).resolve("sc")
    check(
        precedence["font_size"] == 24
        and precedence["name_color"] == "#FF7700"
        and precedence["text_color"] == "#101010"
        and precedence["font_weight"] == 400,
        "default -> theme -> global -> type 优先级",
    )

    cached = type_resolver.resolve("gift")
    cached["font_size"] = 99
    check(type_resolver.resolve("gift")["font_size"] == 28, "缓存结果返回副本，不被调用方污染")
    direct = StyleResolver(styles_doc()["overlay"]["styles"]).resolve("enter")
    check(direct["font_size"] == 22, "支持直接传入 styles 对象")

    raised = False
    try:
        type_resolver.resolve("unknown")
    except ValueError:
        raised = True
    check(raised, "未知类型抛 ValueError")

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))


def main() -> int:
    run()
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
