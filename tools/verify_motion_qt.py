#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Qt 浮窗动效快照、滚动退场队列与固定项立即移除的离屏验证。"""

from __future__ import annotations

import copy
import math
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("DM_REDUCED_MOTION", "0")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from PySide6.QtCore import QObject, Signal  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

import overlay_qt  # noqa: E402
from overlay_render import build_bubble_pixmap  # noqa: E402
from backend.config import DEFAULT_CONFIG  # noqa: E402
from backend.motion import MOTION_DEFAULTS, sample_enter, sample_exit  # noqa: E402
from backend.styles import StyleResolver  # noqa: E402

PASS = 0
FAIL = 0
FAILURES: List[str] = []


def check(condition: bool, label: str, detail: Any = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))
    else:
        FAIL += 1
        FAILURES.append(label)
        print("FAIL  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))


class DummyIpc(QObject):
    config_received = Signal(object)
    items_received = Signal(object)
    geometry_saved = Signal(object)
    connection_changed = Signal(str)

    def request_config(self) -> None:
        return

    def request_items(self, _cursor: int) -> None:
        return

    def save_geometry(self, _x: int, _y: int, _w: int, _h: int) -> None:
        return

    def stop(self) -> None:
        return


def motions() -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for kind in ("danmaku", "gift", "super_chat", "guard", "enter"):
        out[kind] = dict(MOTION_DEFAULTS)
    out["danmaku"].update({"enter_anim": "slide", "enter_dir": "right", "enter_ms": 220})
    out["gift"].update({"enter_anim": "scale", "enter_scale": 80, "enter_opacity": 20, "enter_ms": 300})
    out["super_chat"].update({"enter_anim": "slide", "enter_dir": "left"})
    out["guard"].update({"enter_anim": "fade", "enter_ms": 240})
    out["enter"].update({"enter_anim": "none", "enter_ms": 0, "exit_anim": "none", "exit_ms": 0})
    return out


def make_window(app: QApplication) -> overlay_qt.OverlayWindow:
    snapshot = copy.deepcopy(DEFAULT_CONFIG)
    snapshot["overlay"]["enabled"] = True
    snapshot["overlay"]["styles"]["theme"] = "classic"
    resolved = StyleResolver(snapshot).resolve_all()
    pins = {
        "gift": {"enabled": False, "position": "bottom", "duration_ms": 8000, "max": 2, "min_price": 0},
        "sc": {"enabled": False, "position": "top", "duration_ms": 12000, "max": 2},
        "guard": {"enabled": False, "position": "bottom", "duration_ms": 6000, "max": 2},
    }
    raw = {
        "enabled": True,
        "x": 40,
        "y": 40,
        "width": 520,
        "height": 620,
        "font_family": "Microsoft YaHei UI",
        "font_size": 22,
        "font_weight": 600,
        "line_height": 1.55,
        "color": "#FFFFFF",
        "name_color": "#8FE3FF",
        "name_sep": "：",
        "show_name": True,
        "name_max_len": 12,
        "text_max_len": 80,
        "outline": True,
        "outline_color": "#000000",
        "outline_width": 2,
        "shadow": True,
        "bg_color": "#000000",
        "bg_opacity": 0.22,
        "opacity": 1.0,
        "align": "left",
        "max_lines": 8,
        "animation": "slide",
        "dwell_ms": 60000,
        "gap": 8,
        "types": {"danmaku": True, "gift": True, "super_chat": True, "guard": True, "enter": True},
        "click_through": True,
        "always_on_top": True,
        "show_avatar": False,
        "theme": "classic",
        "resolved": resolved,
        "resolved_motion": motions(),
        "pins": pins,
    }
    window = overlay_qt.OverlayWindow(PROJECT_ROOT, DummyIpc())
    window.resize(520, 620)
    window._apply_config(raw)
    return window


def item(seq: int, kind: str = "danmaku") -> Dict[str, Any]:
    return {
        "seq": seq,
        "type": kind,
        "user": "测试用户",
        "uid": 1000 + seq,
        "text": "测试动效消息 %d" % seq,
        "ts": 1,
        "meta": {
            "gift_name": "小心心",
            "num": 1,
            "price": 1,
            "guard_level": 1,
            "message": "",
        },
    }


def run() -> None:
    print("verify_motion_qt · Python", sys.version.split()[0])
    app = QApplication.instance() or QApplication([])
    window = make_window(app)

    check(
        all(window._motions[kind]["enter_anim"] for kind in window._motions),
        "五类动效已从 resolved_motion 解析",
        {k: v["enter_anim"] for k, v in window._motions.items()},
    )
    check(window._motions["gift"]["enter_anim"] == "scale", "gift 使用 scale")
    check(window._motions["enter"]["enter_anim"] == "none", "enter 使用 none")
    window._reduced_motion = True
    reduced = window._motion_for("danmaku", "enter")
    check(reduced["enter_anim"] == "fade" and reduced["enter_ms"] == 80, "系统减少动态效果降级", reduced)
    window._reduced_motion = False

    first = window._normalize_item(item(1))
    check(first is not None and first.enter_motion is not None, "消息带入场快照")
    window._ingest([first])
    check(len(window._messages) == 1, "滚动消息进入列表")
    check(first.entering is True, "非 none 消息进入动画中")
    time.sleep(0.02)
    mid = window._message_motion(first, time.perf_counter())
    check(mid["dx"] > 0 and mid["opacity"] < 1.0, "入场滑入有偏移与透明度", mid)

    window._start_leave(first)
    check(first not in window._messages and first in window._exiting, "滚动退场移入 _exiting")
    first.leave_started = time.perf_counter() - 0.09
    leave_mid = window._message_motion(first, time.perf_counter())
    check(leave_mid["dy"] < 0, "旧淡出仍有 4px 上移趋势", leave_mid)
    first.leave_started = time.perf_counter() - 1.0
    window._animation_tick()
    check(first not in window._exiting, "退场结束后移出 _exiting")

    # 无入场动画：直接进入，不退场。
    enter_msg = window._normalize_item(item(2, "enter"))
    window._ingest([enter_msg])
    check(enter_msg.entering is False, "enter 类型 none 直接完成入场")
    window._start_leave(enter_msg)
    check(enter_msg not in window._messages and enter_msg not in window._exiting, "none 退场立即移除")

    # 固定项：到期立即让出 lane，不进入 _exiting。
    window._clear_messages()
    window._effective["pins"]["gift"]["enabled"] = True
    gift_msg = window._normalize_item(item(3, "gift"))
    window._ingest([gift_msg])
    pins = window._pinned_messages
    check(len(pins) == 1, "礼物进入固定 lane", len(pins))
    if pins:
        exiting_before = len(window._exiting)
        window._start_leave(pins[0])
        check(len(window._pinned_messages) == 0, "固定项到期立即移出 lane")
        check(len(window._exiting) == exiting_before, "固定项不进入退场队列")

    # 抖音钻石礼物不套用人民币固定区门槛。
    window._clear_messages()
    window._effective["pins"]["gift"]["enabled"] = True
    window._effective["pins"]["gift"]["min_price"] = 100
    diamond_item = item(41, "gift")
    diamond_item["meta"].update({"price": 0, "total_coin": 0,
                                 "coin_type": "diamond", "diamond_count": 88})
    window._ingest([window._normalize_item(diamond_item)])
    check(len(window._pinned_messages) == 1, "抖音钻石礼物不受人民币门槛过滤")
    cny_item = item(42, "gift")
    cny_item["user"] = "人民币用户"
    cny_item["meta"].update({"price": 1, "coin_type": "gold"})
    window._ingest([window._normalize_item(cny_item)])
    check(len(window._pinned_messages) == 1, "人民币礼物仍受固定区门槛约束")
    window._effective["pins"]["gift"]["min_price"] = 0

    # 固定项自然到期：独立残影，不占 lane，不进入 _exiting。
    window._clear_messages()
    window._effective["pins"]["gift"]["enabled"] = True
    gift_pin_msg = window._normalize_item(item(5, "gift"))
    window._ingest([gift_pin_msg])
    pin = window._pinned_messages[0] if window._pinned_messages else None
    check(pin is not None, "固定项残影测试准备 pin")
    if pin is not None:
        window._pin_expired(pin)
        check(pin not in window._pinned_messages and pin in window._pin_fading, "固定项到期进入独立残影")
        check(len(window._exiting) == 0, "固定项残影不进入滚动退场队列")
        check(pin.exit_motion["exit_anim"] == "fade" and pin.exit_motion["exit_ms"] <= 120,
              "固定项残影为 ≤120ms 纯淡出", pin.exit_motion)
        pin.leave_started = time.perf_counter() - 1.0
        window._animation_tick()
        check(pin not in window._pin_fading, "固定项残影结束后移除")

    # 残影期间同 pin_key 新消息：取消 ghost，新 pin 从 1 开始。
    window._clear_messages()
    window._effective["pins"]["gift"]["enabled"] = True
    first_gift = window._normalize_item(item(6, "gift"))
    window._ingest([first_gift])
    first_pin = window._pinned_messages[0] if window._pinned_messages else None
    if first_pin is not None:
        window._pin_expired(first_pin)
        check(len(window._pin_fading) == 1, "旧固定项处于残影")
        second_gift = window._normalize_item(item(7, "gift"))
        window._ingest([second_gift])
        check(len(window._pin_fading) == 0, "同 key 新消息取消残影")
        check(len(window._pinned_messages) == 1 and window._pinned_messages[0].pin_count == 1,
              "残影取消后新 pin 从 1 开始")

    # 高密度：滚动消息降级，固定项不降级；显式 none 保持 none。
    window._clear_messages()
    window._motions["danmaku"] = dict(MOTION_DEFAULTS)
    window._effective["pins"]["gift"]["enabled"] = False
    dense_batch = [window._normalize_item(item(20 + i)) for i in range(8)]
    window._ingest([m for m in dense_batch if m is not None])
    check(window._density_active() is True, "单批 max_lines 触发高密度")
    check(window._messages and window._messages[0].enter_motion["enter_anim"] == "fade"
          and window._messages[0].enter_motion["enter_ms"] <= 80,
          "高密度滚动消息降为 ≤80ms 淡入", window._messages[0].enter_motion if window._messages else None)
    scroll_msg = window._messages[0]
    window._start_leave(scroll_msg)
    check(scroll_msg.exit_motion["exit_anim"] == "fade" and scroll_msg.exit_motion["exit_ms"] <= 80,
          "高密度退场同样降级", scroll_msg.exit_motion)

    window._clear_messages()
    window._motions["danmaku"] = dict(MOTION_DEFAULTS, enter_anim="none", enter_ms=0)
    window._effective["pins"]["gift"]["enabled"] = False
    none_batch = [window._normalize_item(item(30 + i)) for i in range(8)]
    window._ingest([m for m in none_batch if m is not None])
    check(window._density_active() is True, "none 场景也可进入高密度")
    check(all(not m.entering for m in window._messages), "高密度不覆盖显式 none")

    window._clear_messages()
    window._motions["danmaku"] = dict(MOTION_DEFAULTS)
    window._effective["pins"]["gift"]["enabled"] = False
    normal_after = window._normalize_item(item(40))
    window._ingest([normal_after])
    check(normal_after.enter_motion["enter_anim"] == "slide", "恢复后新消息使用用户动效")

    # 在途消息快照不受后续配置影响。
    window._clear_messages()
    window._effective["pins"]["gift"]["enabled"] = False
    snapshot_msg = window._normalize_item(item(4))
    window._ingest([snapshot_msg])
    snap = dict(window._motions["danmaku"])
    window._motions["danmaku"]["enter_ms"] = 999
    check(window._messages and window._messages[0].enter_motion["enter_ms"] == snap["enter_ms"],
          "在途消息保留入场快照")
    check(window._should_snap_scroll() is False, "存在非 none 入场时不 snap")

    # MAX_EXITING 上限。
    window._effective["pins"]["gift"]["enabled"] = False
    window._effective["max_lines"] = 30
    window.resize(520, 2000)
    batch = [window._normalize_item(item(10 + i)) for i in range(15)]
    window._ingest([m for m in batch if m is not None])
    check(len(window._messages) >= 13, "批量消息保留足够样本", len(window._messages))
    for message in list(window._messages):
        window._start_leave(message)
    check(len(window._exiting) == overlay_qt.MAX_EXITING, "退场队列达到 12 上限", len(window._exiting))
    check(len(window._exiting) <= overlay_qt.MAX_EXITING, "退场队列不超过 MAX_EXITING", len(window._exiting))

    window._motions = {kind: dict(MOTION_DEFAULTS, enter_anim="none", exit_anim="none") for kind in overlay_qt.OVERLAY_TYPES}
    probe = window._normalize_item(item(99))
    window._ingest([probe])
    if window._messages:
        window._messages[0].enter_motion = dict(window._motions["danmaku"])
    check(window._should_snap_scroll() is True, "全部 none 时 snap")

    window._clear_messages()
    window._anim_timer.stop()
    window._start_animations_if_needed()
    check(window._anim_timer.isActive() is False, "无消息/无动画时动画泵保持停止")

    # 布局 characterization：固定区预算、lane cap、滚动压缩/丢弃顺序。
    window._clear_messages()
    window.resize(520, 620)
    window._effective["max_lines"] = 8
    for lane in window._effective["pins"].values():
        lane["enabled"] = True
    layout_batch = []
    for kind in ("gift", "super_chat", "guard"):
        for index in range(10):
            message = window._normalize_item(item(1000 + len(layout_batch), kind))
            if message is None:
                continue
            message.user = "%s%d" % (kind, index)
            message.meta["price"] = 1
            layout_batch.append(message)
    window._ingest(layout_batch)
    window._relayout(snap_scroll=True)
    check({lane: len(window._pins.get(lane, [])) for lane in ("gift", "sc", "guard")} ==
          {"gift": 2, "sc": 2, "guard": 2}, "布局：固定 lane 各保留 2 条",
          {lane: len(items) for lane, items in window._pins.items()})
    check(abs(window._plan.get("fixed_height") - 288.6) < 0.01
          and abs(window._plan.get("scroll_height") - 331.4) < 0.01,
          "布局：固定 288.6 / 滚动 331.4", window._plan.get("fixed_height"))
    check(window._plan.get("lane_heights") == {
              "gift": 96.2, "sc": 96.2, "guard": 96.2,
              "danmaku": 0, "enter": 0, "like": 0, "social": 0,
          },
          "布局：每 lane 按真实高度 96.2", window._plan.get("lane_heights"))
    check(window._plan.get("lane_cap") == 248 and window._plan.get("item_px") == 45,
          "布局：40% cap=248 / item_px=45",
          (window._plan.get("lane_cap"), window._plan.get("item_px"),
           window._plan.get("item_px_by_lane")))

    window._clear_messages()
    for lane in window._effective["pins"].values():
        lane["enabled"] = False
    long_batch = []
    for index in range(20):
        message = window._normalize_item(item(2000 + index, "danmaku"))
        if message is None:
            continue
        message.user = "long%d" % index
        message.text = "长文本测试 " * 8
        long_batch.append(message)
    window._ingest(long_batch)
    window._relayout(snap_scroll=True)
    check(len(window._messages) == 5 and len(window._scroll_visible_ids) == 5,
          "布局：长文本压缩到 5 条", len(window._messages))
    check(all(message.line_limit == 3 for message in window._messages),
          "布局：长文本保留 3 行")
    check(all(abs(message.visual.height - 112.3) < 0.2 for message in window._messages if message.visual),
          "布局：长文本每条 112.3px")
    check(abs(window._scroll_clip_rect.height() - 594.0) < 0.2,
          "布局：无固定区滚动高度 594")

    window._clear_messages()
    short_batch = []
    for index in range(30):
        message = window._normalize_item(item(3000 + index, "danmaku"))
        if message is None:
            continue
        message.user = "short%d" % index
        message.text = "短消息"
        short_batch.append(message)
    window._ingest(short_batch)
    window._relayout(snap_scroll=True)
    check(len(window._messages) == 8 and len(window._scroll_visible_ids) == 8,
          "布局：滚动区最多 8 条", len(window._messages))
    check([message.user for message in window._messages] ==
          ["short%d" % index for index in range(22, 30)],
          "布局：丢弃最旧、保留最新 8 条")
    check(all(abs(message.visual.height - 44.1) < 0.2 for message in window._messages if message.visual),
          "布局：短消息每条 44.1px")

    # 渲染 characterization：气泡几何、文本段、位图生成。
    window._clear_messages()
    for lane in window._effective["pins"].values():
        lane["enabled"] = False
    render_message = window._normalize_item(item(4000, "gift"))
    if render_message is not None:
        render_message.meta["price"] = 1
        visual = window._build_visual(render_message)
        check(visual.width > 0 and visual.height > 0, "渲染：气泡宽高为正",
              (visual.width, visual.height))
        check(len(visual.lines) >= 1 and len(visual.lines[0].segments) >= 1,
              "渲染：文本行/段非空",
              (len(visual.lines), len(visual.lines[0].segments) if visual.lines else 0))
        key = window._visual_key(render_message)
        check(bool(key), "渲染：visual key 非空", key)
        context = window._render_context()
        check(context.width == window.width() and context.kinds.keys() == set(overlay_qt.OVERLAY_TYPES),
              "渲染：RenderContext 宽度/五类齐备",
              (context.width, sorted(context.kinds.keys())))
        window._effective["font_size"] = 23
        check(window._visual_key(render_message) != key, "渲染：visual key 跟随全局字号")
        window._effective["font_size"] = 22
        check(window._visual_key(render_message) == key, "渲染：visual key 恢复后一致")
        window._build_bubble_pixmap(visual)
        check(visual.pixmap is not None and not visual.pixmap.isNull()
              and visual.pixmap.width() > 0 and visual.pixmap.height() > 0,
              "渲染：气泡位图生成",
              None if visual.pixmap is None else (visual.pixmap.width(), visual.pixmap.height()))
        dpr = max(1.0, float(window.devicePixelRatioF()))
        if visual.pixmap is not None:
            check(abs(visual.pixmap.devicePixelRatio() - dpr) < 0.001,
                  "渲染：pixmap DPR", visual.pixmap.devicePixelRatio())
            check(visual.pixmap.width() == int(math.ceil((visual.width + visual.pixmap_pad * 2) * dpr)),
                  "渲染：pixmap 物理宽度", (visual.pixmap.width(), visual.width, dpr))
            image = visual.pixmap.toImage()
            alphas = {
                image.pixelColor(x, y).alpha()
                for x in range(0, image.width(), max(1, image.width() // 12))
                for y in range(0, image.height(), max(1, image.height() // 8))
            }
            check(0 in alphas and max(alphas) > 0, "渲染：pixmap 透明角/非空内容", sorted(alphas))
            for scale in (1.25, 1.5, 2.0):
                dpr_pixmap = build_bubble_pixmap(visual, scale, window._font_resolver)
                check(abs(dpr_pixmap.devicePixelRatio() - scale) < 0.001
                      and dpr_pixmap.width() == int(math.ceil((visual.width + visual.pixmap_pad * 2) * scale)),
                      "渲染：DPR %.2f 物理尺寸" % scale,
                      (dpr_pixmap.width(), dpr_pixmap.devicePixelRatio()))
        check([badge[0] for badge in window._header_badges(render_message, 22, 600)] == ["礼物"],
              "渲染：礼物类型徽标")
        sc_message = window._normalize_item(item(4001, "super_chat"))
        if sc_message is not None:
            sc_message.meta["price"] = 30
            check([badge[0] for badge in window._header_badges(sc_message, 22, 600)] ==
                  ["醒目留言", "¥ 30"], "渲染：SC 类型/价格徽标")
        check(window._guard_title({"guard_level": 1}) == "总督", "渲染：舰长等级标题")
        check(window._parse_badge_bg("rgba(1,2,3,0.5)").alpha() == 127,
              "渲染：rgba 徽标底色")

    window.shutdown()
    app.processEvents()
    check(True, "清理与关闭无异常")


def main() -> int:
    try:
        run()
    except Exception as exc:  # noqa: BLE001
        print("FAIL  未捕获异常：%r" % (exc,))
        import traceback
        traceback.print_exc()
        return 1
    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())

