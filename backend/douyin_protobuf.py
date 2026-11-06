# -*- coding: utf-8 -*-
"""抖音直播消息的最小 protobuf 解码器。

抖音网页端当前通过 ``/webcast/im/fetch/`` 返回 protobuf。这里只解析
ReadMe 需要的字段，避免把完整生成的 protobuf 模型和额外运行时依赖带进项目。
字段编号来自公开的 webcast proto 定义；协议新增字段会被安全忽略。
"""

from __future__ import annotations

import gzip
from typing import Any, Dict, Iterable, List, Optional, Tuple

WIRE_VARINT = 0
WIRE_FIXED64 = 1
WIRE_LENGTH = 2
WIRE_FIXED32 = 5

Field = Tuple[int, int, Any]


def _read_varint(data: bytes, offset: int) -> Tuple[int, int]:
    value = 0
    shift = 0
    size = len(data)
    while offset < size:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
        if shift > 70:
            break
    raise ValueError("protobuf varint 越界")


def parse_fields(data: bytes) -> List[Field]:
    """解析一层 protobuf 字段；保留未知字段，供上层按字段号读取。"""
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("protobuf 数据必须是 bytes")
    raw = bytes(data)
    offset = 0
    fields: List[Field] = []
    while offset < len(raw):
        key, offset = _read_varint(raw, offset)
        number = key >> 3
        wire = key & 0x07
        if number <= 0:
            raise ValueError("protobuf 字段号非法")
        if wire == WIRE_VARINT:
            value, offset = _read_varint(raw, offset)
        elif wire == WIRE_FIXED64:
            if offset + 8 > len(raw):
                raise ValueError("protobuf fixed64 越界")
            value = raw[offset:offset + 8]
            offset += 8
        elif wire == WIRE_LENGTH:
            length, offset = _read_varint(raw, offset)
            if length < 0 or offset + length > len(raw):
                raise ValueError("protobuf length-delimited 越界")
            value = raw[offset:offset + length]
            offset += length
        elif wire == WIRE_FIXED32:
            if offset + 4 > len(raw):
                raise ValueError("protobuf fixed32 越界")
            value = raw[offset:offset + 4]
            offset += 4
        else:
            raise ValueError("不支持的 protobuf wire type: %d" % wire)
        fields.append((number, wire, value))
    return fields


def first(fields: Iterable[Field], number: int, default: Any = None) -> Any:
    for field_number, _wire, value in fields:
        if field_number == number:
            return value
    return default


def all_values(fields: Iterable[Field], number: int) -> List[Any]:
    return [value for field_number, _wire, value in fields if field_number == number]


def as_text(value: Any, default: str = "") -> str:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", "replace")
    if value is None:
        return default
    return str(value)


def as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, (bytes, bytearray)):
        try:
            return int(bytes(value).decode("ascii"))
        except (TypeError, ValueError, UnicodeDecodeError):
            return default
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _image_url(value: Any) -> str:
    if not isinstance(value, (bytes, bytearray)):
        return ""
    try:
        fields = parse_fields(bytes(value))
    except (TypeError, ValueError):
        return ""
    for item in all_values(fields, 1):
        text = as_text(item).strip()
        if text:
            return text
    return ""


def _compound(value: Any) -> List[Field]:
    if not isinstance(value, (bytes, bytearray)):
        return []
    try:
        return parse_fields(bytes(value))
    except (TypeError, ValueError):
        return []


def parse_user(value: Any) -> Dict[str, Any]:
    fields = _compound(value)
    if not fields:
        return {}
    avatar = _image_url(first(fields, 9))
    return {
        "uid": as_int(first(fields, 1)),
        "short_id": as_int(first(fields, 2)),
        "nickname": as_text(first(fields, 3)).strip(),
        "avatar": avatar,
        "sec_uid": as_text(first(fields, 46)).strip(),
    }


def parse_common(value: Any) -> Dict[str, Any]:
    fields = _compound(value)
    if not fields:
        return {}
    return {
        "message_id": as_int(first(fields, 2)),
        "room_id": as_int(first(fields, 3)),
        "create_time": as_int(first(fields, 4)),
    }


def parse_response(data: bytes) -> Dict[str, Any]:
    """解析 IM fetch 响应；兼容 gzip 与裸 ``PushFrame`` 包装。"""
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("protobuf 数据必须是 bytes")
    raw = bytes(data)
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    fields = parse_fields(raw)

    # 有些接口返回 PushFrame：payload 在字段 8，真正响应在 payload 中。
    payload = first(fields, 8)
    if isinstance(payload, (bytes, bytearray)) and not all_values(fields, 1):
        inner = bytes(payload)
        if inner[:2] == b"\x1f\x8b":
            inner = gzip.decompress(inner)
        fields = parse_fields(inner)

    messages: List[Dict[str, Any]] = []
    for item in all_values(fields, 1):
        message_fields = _compound(item)
        if not message_fields:
            continue
        messages.append(
            {
                "method": as_text(first(message_fields, 1)),
                "payload": bytes(first(message_fields, 2, b"") or b""),
                "message_id": as_int(first(message_fields, 3)),
            }
        )
    return {
        "messages": messages,
        "cursor": as_text(first(fields, 2)),
        "fetch_interval": as_int(first(fields, 3)),
        "internal_ext": as_text(first(fields, 5)),
        "need_ack": bool(first(fields, 9, 0)),
        "heartbeat_duration": as_int(first(fields, 8)),
    }


def normalize_message(method: str, payload: bytes, message_id: int = 0) -> Optional[Tuple[str, Dict[str, Any]]]:
    """把 webcast 消息映射成 ReadMe 的规范化消息。"""
    if not method or not isinstance(payload, (bytes, bytearray)):
        return None
    fields = _compound(payload)
    if not fields:
        return None

    common = parse_common(first(fields, 1))
    meta_common = {
        "platform": "douyin",
        "native_type": method,
        "message_id": int(message_id or common.get("message_id") or 0),
    }

    if method == "WebcastChatMessage":
        user = parse_user(first(fields, 2))
        text = as_text(first(fields, 3)).strip()
        if not user or not text:
            return None
        return (
            "danmaku",
            {
                "user": user.get("nickname") or "",
                "uid": user.get("uid") or 0,
                "text": text,
                "meta": {
                    **meta_common,
                    "avatar": user.get("avatar") or "",
                    "sec_uid": user.get("sec_uid") or "",
                    "event_time": as_int(first(fields, 15)),
                },
            },
        )

    if method == "WebcastGiftMessage":
        user = parse_user(first(fields, 7))
        gift = _compound(first(fields, 15))
        gift_name = as_text(first(gift, 16)).strip() or "礼物"
        diamond_count = as_int(first(gift, 12))
        num = (
            as_int(first(fields, 6))
            or as_int(first(fields, 5))
            or as_int(first(fields, 4))
            or as_int(first(fields, 29))
            or 1
        )
        return (
            "gift",
            {
                "user": user.get("nickname") or "",
                "uid": user.get("uid") or 0,
                "text": gift_name,
                "meta": {
                    **meta_common,
                    "avatar": user.get("avatar") or "",
                    "gift_name": gift_name,
                    "gift_id": as_int(first(gift, 5)),
                    "num": max(1, num),
                    "diamond_count": max(0, diamond_count),
                    "price": 0,
                    "total_coin": 0,
                    "coin_type": "diamond",
                },
            },
        )

    if method == "WebcastMemberMessage":
        user = parse_user(first(fields, 2))
        if not user:
            return None
        return (
            "enter",
            {
                "user": user.get("nickname") or "",
                "uid": user.get("uid") or 0,
                "text": "",
                "meta": {
                    **meta_common,
                    "avatar": user.get("avatar") or "",
                    "msg_type": 1,
                },
            },
        )

    if method == "WebcastSocialMessage":
        user = parse_user(first(fields, 2))
        if not user:
            return None
        action = as_int(first(fields, 4))
        share_type = as_int(first(fields, 3))
        text = "分享了直播间" if action == 2 or share_type else "关注了直播间"
        return (
            "social",
            {
                "user": user.get("nickname") or "",
                "uid": user.get("uid") or 0,
                "text": text,
                "meta": {
                    **meta_common,
                    "avatar": user.get("avatar") or "",
                    "social_action": text,
                    "social_share_type": share_type,
                    "follow_count": as_int(first(fields, 6)),
                },
            },
        )

    if method == "WebcastLikeMessage":
        user = parse_user(first(fields, 5)) or parse_user(first(fields, 2))
        if not user:
            return None
        count = max(1, as_int(first(fields, 2), 1))
        return (
            "like",
            {
                "user": user.get("nickname") or "",
                "uid": user.get("uid") or 0,
                "text": "点赞了直播间",
                "meta": {
                    **meta_common,
                    "avatar": user.get("avatar") or "",
                    "like_count": count,
                    "like_total": max(0, as_int(first(fields, 3))),
                },
            },
        )

    return None
