#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证 lane 预算、压缩、淘汰、lane cap 与滚动区下限。"""

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

from backend.config import DEFAULT_CONFIG  # noqa: E402
from backend.lanes import item_px_for_font, plan_lanes  # noqa: E402
from overlay_layout import (  # noqa: E402
    lane_height,
    lane_totals,
    next_fixed_eviction,
    next_scroll_action,
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


def default_pins() -> Dict[str, Any]:
    return copy.deepcopy(DEFAULT_CONFIG["overlay"]["pins"])


def items(counts: Dict[str, int]) -> Dict[str, List[Dict[str, Any]]]:
    prefixes = {"gift": "g", "sc": "s", "guard": "u"}
    return {
        lane: [{"id": "%s%d" % (prefixes[lane], index)} for index in range(count)]
        for lane, count in counts.items()
    }


def visible_ids(result: Dict[str, Any]) -> Dict[str, List[str]]:
    return {
        lane: [str(item.get("id")) for item in result["visible"][lane]]
        for lane in ("gift", "sc", "guard")
    }


def run() -> None:
    print("verify_lanes · Python", sys.version.split()[0])
    check(item_px_for_font(22) == 48, "font 22 -> item_px 48")
    check(item_px_for_font(48) == 83, "font 48 -> item_px 83")
    check(item_px_for_font(13) == 36, "font 13 -> item_px 36")
    check(abs(lane_height([44.1, 44.1], 8) - 96.2) < 0.01, "纯函数 lane 高度")
    check(
        lane_totals(
            {"gift": 98, "sc": 98, "guard": 0},
            {"gift": "bottom", "sc": "top", "guard": "top"},
        ) == (98, 98, 196),
        "纯函数上/下/固定总高",
    )
    check(next_fixed_eviction({"gift": 1, "sc": 0, "guard": 2}) == ("trim", "guard"),
          "纯函数固定区先 trim 最旧 lane")
    check(next_fixed_eviction({"gift": 1, "sc": 0, "guard": 0}) == ("clear", "gift"),
          "纯函数固定区再 clear lane")
    check(next_scroll_action(9, 0, 100, 3, 8) == "drop_oldest",
          "纯函数滚动超行数先丢最旧")
    check(next_scroll_action(1, 120, 100, 3, 8) == "compress_latest",
          "纯函数单条超高先压缩")
    check(next_scroll_action(1, 120, 100, 1, 8) == "drop_latest",
          "纯函数单条压缩到底后丢弃")
    check(next_scroll_action(1, 100, 100, 3, 8) == "none",
          "纯函数高度足够不动作")

    result = plan_lanes(620, default_pins(), items({"gift": 3, "sc": 2, "guard": 2}), font_size=22)
    check(
        (result["top_height"], result["bottom_height"], result["scroll_height"])
        == (258, 48, 314),
        "默认样例高度 258 / 48 / 314",
        repr((result["top_height"], result["bottom_height"], result["scroll_height"])),
    )
    check(result["fixed_height"] == 306, "默认样例固定区 306px")
    check(result["gap_px"] == 6, "默认样例选择 gap 6（淘汰次数优先）")
    check(
        result["lane_heights"] == {
            "gift": 156, "sc": 102, "guard": 48,
            "danmaku": 0, "enter": 0, "like": 0, "social": 0,
        },
        "默认样例 lane 高度",
        repr(result["lane_heights"]),
    )
    check(result["evicted"] == ["u0"], "默认样例淘汰最旧 guard", repr(result["evicted"]))
    check(
        visible_ids(result) == {"gift": ["g0", "g1", "g2"], "sc": ["s0", "s1"], "guard": ["u1"]},
        "默认样例可见项 FIFO",
    )
    check(
        result["scroll_height"] >= result["scroll_min"]
        and result["fixed_height"] + result["scroll_height"] == 620,
        "默认样例滚动区 >= 40% 且总高守恒",
    )
    check(
        all(height <= result["lane_cap"] for height in result["lane_heights"].values()),
        "默认样例单 lane <= 40%",
    )

    no_guard = default_pins()
    no_guard["guard"]["enabled"] = False
    r2 = plan_lanes(620, no_guard, items({"gift": 3, "sc": 2, "guard": 2}), font_size=22)
    check(
        (r2["top_height"], r2["bottom_height"], r2["scroll_height"], r2["gap_px"])
        == (264, 0, 356, 8),
        "关闭 guard 后 gap=8、固定 264 / 滚动 356",
        repr((r2["top_height"], r2["bottom_height"], r2["scroll_height"], r2["gap_px"])),
    )
    check(r2["evicted"] == ["u0", "u1"], "关闭的 lane 条目全部退出固定区", repr(r2["evicted"]))
    check(r2["visible"]["guard"] == [], "关闭的 lane 不显示")

    empty = plan_lanes(620, default_pins(), {"gift": [], "sc": [], "guard": []})
    check(
        (empty["top_height"], empty["bottom_height"], empty["scroll_height"]) == (0, 0, 620),
        "无固定项时滚动区占满",
    )

    overflow_pins = default_pins()
    overflow_pins["sc"]["enabled"] = False
    overflow_pins["guard"]["enabled"] = False
    overflow_pins["gift"]["max"] = 3
    overflow = plan_lanes(
        620,
        overflow_pins,
        items({"gift": 5, "sc": 0, "guard": 0}),
        font_size=22,
    )
    check(
        visible_ids(overflow)["gift"] == ["g2", "g3", "g4"],
        "同 lane 超 max 淘汰最旧、保留最新",
        repr(visible_ids(overflow)["gift"]),
    )
    check(overflow["evicted"] == ["g0", "g1"], "gift 淘汰 id 正确")

    edge = plan_lanes(200, default_pins(), items({"gift": 6, "sc": 6, "guard": 6}), font_size=48)
    check(
        (edge["fixed_height"], edge["scroll_height"]) == (0, 200),
        "50% 预算 < item_px 时全部抑制",
        repr((edge["fixed_height"], edge["scroll_height"])),
    )

    tall = plan_lanes(620, default_pins(), items({"gift": 6, "sc": 6, "guard": 6}), font_size=48)
    check(tall["item_px"] == 83, "大字模式 item_px=83")
    check(
        tall["capacity_rows"] == {
            "gift": 1, "sc": 1, "guard": 1,
            "danmaku": 0, "enter": 0, "like": 0, "social": 0,
        },
        "大字默认预算每 lane 1 行",
        repr(tall["capacity_rows"]),
    )
    check(
        (tall["top_height"], tall["bottom_height"], tall["scroll_height"])
        == (166, 83, 371),
        "大字默认高度 166 / 83 / 371",
    )
    check(
        all(height <= tall["lane_cap"] for height in tall["lane_heights"].values()),
        "大字模式单 lane <= 40%",
    )
    check(len(tall["evicted"]) == 15, "大字模式 15 条固定候选被淘汰", str(len(tall["evicted"])))

    sc_only = default_pins()
    sc_only["gift"]["enabled"] = False
    sc_only["guard"]["enabled"] = False
    cap = plan_lanes(620, sc_only, items({"gift": 0, "sc": 6, "guard": 0}), font_size=48)
    check(
        cap["capacity_rows"]["sc"] == 2 and cap["lane_heights"]["sc"] == 174,
        "单 lane cap 限制到 2 行 / 174px",
        repr((cap["capacity_rows"]["sc"], cap["lane_heights"]["sc"])),
    )
    check(cap["lane_heights"]["sc"] <= cap["lane_cap"], "单 lane <= 248px")
    check(visible_ids(cap)["sc"] == ["s4", "s5"], "受 cap 影响保留最新两条")

    split_pins = default_pins()
    split_pins["guard"]["position"] = "top"
    split_pins["gift"]["position"] = "bottom"
    split = plan_lanes(620, split_pins, items({"gift": 3, "sc": 2, "guard": 1}), font_size=22)
    check(
        split["top_height"] == split["lane_heights"]["sc"] + split["lane_heights"]["guard"],
        "top_height 按 lane position 聚合 SC + guard",
        str(split["top_height"]),
    )
    check(
        split["bottom_height"] == split["lane_heights"]["gift"],
        "bottom_height 按 lane position 聚合 gift",
        str(split["bottom_height"]),
    )
    check(
        split["fixed_height"] + split["scroll_height"] == 620,
        "position 改变后总高仍守恒",
    )

    flat_items = [
        {"type": "gift", "id": "fg0"},
        {"type": "gift", "id": "fg1"},
        {"type": "super_chat", "id": "fs0"},
    ]
    flat = plan_lanes(620, default_pins(), flat_items, font_size=22)
    check(
        visible_ids(flat)["gift"] == ["fg0", "fg1"] and visible_ids(flat)["sc"] == ["fs0"],
        "支持扁平条目列表并按 type 分组",
    )

    mixed = plan_lanes(
        620,
        default_pins(),
        items({"gift": 1, "sc": 1, "guard": 1}),
        item_px_by_lane={"gift": 100, "sc": 40, "guard": 60},
    )
    check(
        mixed["item_px_by_lane"] == {
            "gift": 100, "sc": 40, "guard": 60,
            "danmaku": 48, "enter": 48, "like": 48, "social": 48,
        },
        "支持 per-lane item height",
        mixed["item_px_by_lane"],
    )
    check(
        mixed["lane_heights"] == {
            "gift": 100, "sc": 40, "guard": 60,
            "danmaku": 0, "enter": 0, "like": 0, "social": 0,
        },
        "per-lane 高度独立计算",
        mixed["lane_heights"],
    )
    empty_lane = plan_lanes(
        620,
        default_pins(),
        items({"gift": 1, "sc": 0, "guard": 0}),
        item_px_by_lane={"gift": 100, "sc": 220, "guard": 220},
    )
    check(
        empty_lane["lane_heights"] == {
            "gift": 100, "sc": 0, "guard": 0,
            "danmaku": 0, "enter": 0, "like": 0, "social": 0,
        },
        "空 lane 不被其他 lane 的大字体拖累",
        empty_lane["lane_heights"],
    )
    exact_pins = default_pins()
    exact_pins["sc"]["enabled"] = False
    exact_pins["guard"]["enabled"] = False
    exact_pins["gift"]["max"] = 3
    exact = plan_lanes(
        620,
        exact_pins,
        items({"gift": 3, "sc": 0, "guard": 0}),
        item_px_by_lane={"gift": 100, "sc": 1, "guard": 1},
        item_heights_by_lane={"gift": [100, 20, 20]},
    )
    check(
        exact["capacity_rows"]["gift"] == 3,
        "逐条高度：长+短+短可全部保留",
        exact["capacity_rows"],
    )
    check(
        exact["lane_heights"]["gift"] == 156,
        "逐条高度：lane 高度按 100+20+20+2×8 计算",
        exact["lane_heights"],
    )
    check(
        visible_ids(exact)["gift"] == ["g0", "g1", "g2"],
        "逐条高度：FIFO 顺序不变",
        visible_ids(exact),
    )
    old_uniform = plan_lanes(
        620,
        exact_pins,
        items({"gift": 3, "sc": 0, "guard": 0}),
        item_px_by_lane={"gift": 100, "sc": 1, "guard": 1},
    )
    check(
        old_uniform["capacity_rows"]["gift"] == 2,
        "兼容旧路径：无逐条高度时仍按最大行高预算",
        old_uniform["capacity_rows"],
    )

    for height in (200, 300, 620, 1080):
        for font in (13, 22, 48):
            item = plan_lanes(height, default_pins(), items({"gift": 6, "sc": 6, "guard": 6}), font_size=font)
            ok = (
                item["scroll_height"] >= item["scroll_min"]
                and item["fixed_height"] + item["scroll_height"] == height
                and all(lane_height <= item["lane_cap"] + 0.001 for lane_height in item["lane_heights"].values())
            )
            check(ok, "边界矩阵 H=%d font=%d" % (height, font),
                  "scroll=%d min=%.1f" % (item["scroll_height"], item["scroll_min"]))

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))


def main() -> int:
    run()
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
