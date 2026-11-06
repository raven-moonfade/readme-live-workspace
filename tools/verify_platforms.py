#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证平台能力注册表和房间键规范化。"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.platforms import (  # noqa: E402
    money_comparable,
    normalize_platform,
    normalize_room_key,
    platform_profile,
)
from backend.core import _history_capabilities  # noqa: E402
from backend.sessions import SessionStore  # noqa: E402

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
    check(normalize_platform("B站") == "bilibili", "B站别名归一")
    check(normalize_platform("douyin") == "douyin", "douyin 保持小写")
    check(normalize_platform("") == "", "空平台保持空，不猜测平台")
    check(normalize_platform("unknown-room") == "unknown-room", "未知平台不被改名")

    check(platform_profile("bilibili").label == "B站", "B 站显示名")
    check(platform_profile("抖音").label == "抖音", "抖音显示名")
    check(platform_profile("douyin").gift_value_unit == "diamond",
          "抖音礼物单位为钻石")
    check(platform_profile("douyin").supports_super_chat is False and
          platform_profile("douyin").supports_guard is False,
          "抖音明确不支持 SC/舰长等价能力")
    check("SC/舰长" in platform_profile("douyin").money_note,
          "抖音金额边界有可读说明")
    check(money_comparable("bilibili") is True, "B 站金额可比")
    check(money_comparable("douyin") is False, "抖音金额不可比")
    check(money_comparable("unknown") is False, "未知平台金额默认不可比")

    check(normalize_room_key("", 777, "bilibili") == "777", "B 站数字房间回退")
    check(normalize_room_key("", 0, "douyin") == "", "抖音无房间号保持空")
    check(normalize_room_key("", 12345, "douyin") == "", "抖音不从数字 id 派生房间键")
    check(normalize_room_key(" room:777 ", 0, "bilibili") == "room:777", "房间键去空白")
    check(normalize_room_key("dy:42", 0, "douyin") == "dy:42", "抖音字符串房间键")
    check(
        normalize_room_key("", float("inf"), "bilibili") == "",
        "非有限 room_id 不抛异常",
    )

    profiles = _history_capabilities().get("platforms") or []
    check(
        any(item.get("key") == "bilibili" and item.get("money_comparable") is True
            for item in profiles),
        "历史能力暴露 B 站平台能力",
        profiles,
    )
    check(
        any(item.get("key") == "douyin" and item.get("money_comparable") is False
            for item in profiles),
        "历史能力暴露抖音金额不可比",
        profiles,
    )
    check(
        any(item.get("key") == "douyin" and
            item.get("gift_value_unit") == "diamond" and
            item.get("supports_super_chat") is False and
            item.get("supports_guard") is False
            for item in profiles),
        "历史能力暴露抖音礼物/SC/舰长边界",
        profiles,
    )

    with tempfile.TemporaryDirectory(prefix="mutai-platforms-") as tmp:
        store = SessionStore(str(Path(tmp) / "data" / "history.sqlite3"))
        try:
            store.start_session(
                "bili-alias",
                777,
                "B 站别名",
                started_at=1767225600,
                platform="B站",
                room_key="",
            )
            store.finish_session("bili-alias", ended_at=1767229200, reason="finished")
            store.start_session(
                "dy",
                0,
                "抖音",
                started_at=1767225601,
                platform="douyin",
                room_key="dy:42",
            )
            store.record_message(
                "dy", "gift", 1767225602, "dy-user",
                {"diamond_count": 10, "num": 3, "coin_type": "diamond"},
            )
            store.record_message(
                "dy", "super_chat", 1767225603, "dy-user",
                {"price": 30},
            )
            store.finish_session("dy", ended_at=1767229201, reason="finished")
            store.flush(2.0)
            listed = store.list_sessions(10)
            rows = {item["id"]: item for item in listed.get("sessions") or []}
            check(
                rows.get("bili-alias", {}).get("platform") == "bilibili" and
                rows.get("bili-alias", {}).get("room_key") == "777",
                "B站别名写入归一",
                rows.get("bili-alias"),
            )
            check(
                rows.get("dy", {}).get("platform") == "douyin" and
                rows.get("dy", {}).get("room_key") == "dy:42",
                "抖音房间键写入",
                rows.get("dy"),
            )
            dy_detail = store.get_session("dy").get("session") or {}
            check(
                dy_detail.get("gift_cny") == 0 and
                dy_detail.get("gift_silver") == 0 and
                dy_detail.get("gift_unknown") == 0 and
                dy_detail.get("gift_diamond") == 30 and
                dy_detail.get("super_chat_cny") == 0 and
                (dy_detail.get("types") or {}).get("gift") == 1 and
                (dy_detail.get("types") or {}).get("super_chat") == 1,
                "抖音礼物/SC 只记类型不累计 B 站金额",
                dy_detail,
            )
            alias_filtered = store.list_sessions(10, 0, platform="B站")
            check(
                alias_filtered.get("total") == 1 and
                (alias_filtered.get("sessions") or [{}])[0].get("id") == "bili-alias",
                "平台别名过滤归一",
                alias_filtered,
            )
            check(
                store.start_session(
                    "bad-room",
                    float("inf"),
                    "bad",
                    started_at=1767225602,
                    platform="bilibili",
                ) is False,
                "非有限 room_id 写入返回 False",
            )
        finally:
            store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
