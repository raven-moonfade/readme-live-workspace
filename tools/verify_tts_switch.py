#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证全局朗读开关：默认开启、关闭后不上屏队列、试听/重播被拒绝。"""

from __future__ import annotations

import sys
import tempfile
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
        finally:
            service.shutdown()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
