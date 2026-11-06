# -*- coding: utf-8 -*-
"""平台能力的最小注册表。

这里只描述“这个平台在本机记录里如何解释”，不负责建立连接，也不引入
平台专属 UI。未来新增平台时先补 profile，再让 adapter 输出规范化字段。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict


@dataclass(frozen=True)
class PlatformProfile:
    key: str
    label: str
    money_comparable: bool
    derive_room_key_from_id: bool = True
    gift_value_unit: str = "CNY"
    supports_super_chat: bool = True
    supports_guard: bool = True
    money_note: str = ""


_ALIASES = {
    "b站": "bilibili",
    "bili": "bilibili",
    "bilibili": "bilibili",
    "抖音": "douyin",
    "douyin": "douyin",
}

_PROFILES: Dict[str, PlatformProfile] = {
    "bilibili": PlatformProfile("bilibili", "B站", True),
    "douyin": PlatformProfile(
        "douyin",
        "抖音",
        False,
        False,
        gift_value_unit="diamond",
        supports_super_chat=False,
        supports_guard=False,
        money_note="抖音礼物按单条钻石显示，不汇总人民币；平台未提供 SC/舰长等价能力",
    ),
}


def normalize_platform(value: object) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    return _ALIASES.get(raw, raw)


def platform_profile(value: object) -> PlatformProfile:
    key = normalize_platform(value)
    return _PROFILES.get(
        key,
        PlatformProfile(key, key, False),
    )


def platform_profiles() -> tuple[PlatformProfile, ...]:
    return tuple(_PROFILES.values())


def money_comparable(value: object) -> bool:
    return bool(platform_profile(value).money_comparable)


def money_note(value: object) -> str:
    profile = platform_profile(value)
    return profile.money_note or "该平台金额口径未接入"


def normalize_room_key(value: object, room_id: object = 0, platform: object = "bilibili") -> str:
    text = str(value or "").strip()
    try:
        numeric_id = int(room_id or 0)
    except (TypeError, ValueError, OverflowError):
        numeric_id = 0
    if not text and numeric_id > 0 and platform_profile(platform).derive_room_key_from_id:
        return str(numeric_id)
    return text
