#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证全局朗读开关：默认开启、关闭后不上屏队列、试听/重播被拒绝。"""

from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.core import DanmakuTTSService  # noqa: E402

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


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-tts-switch-") as root:
        service = DanmakuTTSService(root)
        try:
            tts = service.config.get("tts", default={}) or {}
            check(tts.get("enabled") is True, "全局朗读默认开启", tts)

            disabled = service.update_config({"tts": {"enabled": False}})
            check(disabled.get("ok") is True and not disabled.get("rejected"),
                  "关闭全局朗读可持久化", disabled)

            result = service.inject_mock("danmaku", text="开关关闭时不朗读", speak=True)
            check(result.get("ok") is True and result.get("spoken") is False,
                  "关闭后模拟朗读不进入 TTS", result)
            check(result.get("filter") == "tts_disabled",
                  "关闭后标记为 tts_disabled", result)

            preview = service.preview("测试")
            check(preview.get("ok") is False and "朗读已关闭" in str(preview.get("error")),
                  "关闭后试听被拒绝", preview)

            replay = service.replay("missing-entry")
            check(replay.get("ok") is False and "朗读已关闭" in str(replay.get("error")),
                  "关闭后重播被拒绝", replay)

            enabled = service.update_config({"tts": {"enabled": True}})
            check(enabled.get("ok") is True and
                  ((enabled.get("config") or {}).get("tts") or {}).get("enabled") is True,
                  "重新开启后配置恢复", enabled.get("config", {}).get("tts"))

            display_only = service.inject_mock("danmaku", text="只上屏", speak=False)
            check(display_only.get("ok") is True and display_only.get("filter") == "mock_display_only",
                  "重新开启后调试消息恢复原有仅上屏语义", display_only)

            rejected = service.inject_mock("super_chat", speak=False, platform="douyin")
            check(rejected.get("ok") is False, "抖音模拟数据拒绝 SC", rejected)
            rejected = service.inject_mock("guard", speak=False, platform="douyin")
            check(rejected.get("ok") is False, "抖音模拟数据拒绝舰长", rejected)
            club = service.inject_mock("fansclub", speak=False, platform="douyin")
            check(club.get("ok") is True and club.get("user"),
                  "抖音粉丝团模拟数据带用户名", club)
            cursor = service.poll_events(0)["cursor"]
            service.inject_mock("gift", speak=False, platform="douyin")
            gift_events = service.poll_events(cursor)["events"]
            gift_event = next((e for e in gift_events if e.get("type") == "gift"), None)
            check(gift_event is not None and
                  gift_event.get("meta", {}).get("coin_type") == "diamond" and
                  int(gift_event.get("meta", {}).get("diamond_count") or 0) > 0,
                  "抖音礼物模拟数据使用钻石口径", gift_event)

            cursor = service.poll_events(0)["cursor"]
            service.inject_mock_burst(count=12, kind="mixed", speak=False, platform="douyin")
            events = service.poll_events(cursor)["events"]
            kinds = {event.get("type") for event in events
                     if event.get("type") != "log"}
            allowed = {"danmaku", "gift", "enter", "like", "social", "fansclub"}
            check(bool(kinds) and kinds <= allowed,
                  "抖音混合模拟只产生抖音消息类型", sorted(kinds))
            check(all(event.get("meta", {}).get("platform") == "douyin"
                      for event in events if event.get("type") != "log"),
                  "抖音模拟事件全部标记 platform=douyin")

            cursor = service.poll_events(0)["cursor"]
            service.mock_auto({
                "enabled": True,
                "platform": "douyin",
                "interval_ms": 200,
                "per_tick": 2,
                "speak": False,
                "types": {
                    "danmaku": True,
                    "gift": False,
                    "super_chat": True,
                    "guard": True,
                    "enter": False,
                    "like": False,
                    "social": False,
                    "fansclub": False,
                },
            })
            time.sleep(0.9)
            service.mock_auto({"enabled": False, "platform": "douyin"})
            time.sleep(0.2)
            auto_events = service.poll_events(cursor)["events"]
            auto_kinds = {
                event.get("type") for event in auto_events
                if event.get("type") not in ("log",)
            }
            check(auto_kinds == {"danmaku"},
                  "抖音自动模拟只发送抖音类型，不混入 SC/舰长", sorted(auto_kinds))
        finally:
            service.shutdown()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
